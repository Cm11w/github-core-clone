/**
 * The REST v3 surface: repositories, branches, git refs, commits, contents,
 * labels, issues, comments and pull requests, under /api/v3.
 *
 * Every reply is JSON with an X-GitHub-Request-Id header (added by the app
 * layer). Errors carry a JSON body with a string `message`. A repository
 * belongs to the token owner: any other owner name answers 404, never 403.
 * Lists paginate with `page`/`per_page` and a `Link` header carrying
 * rel="next" when another page follows; without `per_page` the whole list is
 * returned.
 */

import {
  EMPTY_TREE_OID,
  buildCommit,
  buildTreeFromMap,
  diffLineCounts,
  diffTrees,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  setTreePath,
  threeWayMerge,
  treeDirEntries,
  treePathEntry,
} from './git-objects.ts';
import {
  FORGE_EPOCH_ISO,
  FORGE_EPOCH_SEC,
  branchTip,
  commentJson,
  commitJson,
  isValidRefName,
  isValidRepoName,
  issueJson,
  labelJson,
  listBranches,
  listHistory,
  pullAsIssueJson,
  pullJson,
  repoJson,
  resolveRef,
  type ForgeStore,
  type Issue,
  type JsonRecord,
  type PullRequest,
  type RepoState,
} from './store.ts';

/** An HTTP error: the dispatcher turns it into a JSON error reply. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** What a REST handler answers: a status, an optional JSON body, extra headers. */
export interface ApiReply {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/** The request context a REST handler works with. */
export interface RestContext {
  readonly store: ForgeStore;
  readonly baseUrl: string;
  readonly method: string;
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly rawBody: Buffer;
  readonly path: string;
}

function notFound(what = 'Not Found'): HttpError {
  return new HttpError(404, what);
}

function unprocessable(message: string): HttpError {
  return new HttpError(422, message);
}

function conflict(message: string): HttpError {
  return new HttpError(409, message);
}

/** Parse the request body as a JSON object ({} when absent); 400 on malformed JSON. */
function bodyObject(ctx: RestContext): Record<string, unknown> {
  const text = ctx.rawBody.toString('utf8');
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'the request body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'the request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function reqString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value === '') throw unprocessable(`${field} is required`);
  return value;
}

function optString(body: Record<string, unknown>, field: string, fallback: string): string {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw unprocessable(`${field} must be a string`);
  return value;
}

function optBool(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw unprocessable(`${field} must be a boolean`);
  return value;
}

/** The repository a route names, or a 404 (a foreign owner is a 404 too). */
function needRepo(ctx: RestContext, owner: string, name: string): RepoState {
  if (owner !== ctx.store.viewerLogin) throw notFound('Repository not found');
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) throw notFound('Repository not found');
  return repo;
}

/** Parse a positive integer path segment (an issue or pull-request number). */
function needNumber(segment: string): number {
  if (!/^\d+$/.test(segment)) throw notFound('Not Found');
  const number = Number(segment);
  if (!Number.isSafeInteger(number) || number < 1) throw notFound('Not Found');
  return number;
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

interface PageResult<T> {
  readonly items: T[];
  readonly headers: Record<string, string>;
}

/**
 * Slice a list per `page`/`per_page`. Without `per_page` the whole list is
 * returned with no Link header; with it, the page plus a Link header carrying
 * the neighbouring relations (rel="next" exactly when a page follows).
 */
function paginate<T>(ctx: RestContext, items: readonly T[]): PageResult<T> {
  const perPageRaw = ctx.query.get('per_page');
  if (perPageRaw === null) return { items: [...items], headers: {} };
  const parsedPerPage = Number.parseInt(perPageRaw, 10);
  const perPage = Number.isInteger(parsedPerPage) ? Math.min(100, Math.max(1, parsedPerPage)) : 30;
  const parsedPage = Number.parseInt(ctx.query.get('page') ?? '1', 10);
  const page = Number.isInteger(parsedPage) ? Math.max(1, parsedPage) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const linkFor = (target: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('page', String(target));
    params.set('per_page', String(perPage));
    return `<${ctx.baseUrl}${ctx.path}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (page > 1) {
    links.push(`${linkFor(1)}; rel="first"`);
    links.push(`${linkFor(page - 1)}; rel="prev"`);
  }
  if (page < totalPages) links.push(`${linkFor(page + 1)}; rel="next"`);
  if (totalPages > 1) links.push(`${linkFor(totalPages)}; rel="last"`);
  return { items: pageItems, headers: links.length > 0 ? { Link: links.join(', ') } : {} };
}

// ---------------------------------------------------------------------------------------------
// shared git operations (also used by the GraphQL and MCP surfaces)
// ---------------------------------------------------------------------------------------------

/** The ident line every commit this forge creates carries. */
export function serverIdent(store: ForgeStore): string {
  return `${store.viewerLogin} <${store.viewerLogin}@users.noreply.github.com> ${FORGE_EPOCH_SEC} +0000`;
}

export type MergeMethod = 'squash' | 'merge';

export type MergeAttempt =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly reason: 'conflict' | 'not-open' | 'missing-branch' | 'no-base'; readonly conflicts: string[] };

/**
 * Merge a pull request for real: a file-level three-way merge of the head
 * into the base at their merge base, landing one commit (squash) or a merge
 * commit (merge) on the base branch. A conflict merges nothing.
 */
export function attemptMerge(
  store: ForgeStore,
  repo: RepoState,
  pull: PullRequest,
  method: MergeMethod,
  commitTitle?: string,
): MergeAttempt {
  if (pull.state !== 'open' || pull.merged) {
    return { ok: false, reason: 'not-open', conflicts: [] };
  }
  const headTip = branchTip(repo, pull.headRef) ?? pull.headShaAtCreation;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreation;
  const headCommit = resolveRef(repo, headTip);
  const baseCommit = resolveRef(repo, baseTip);
  if (headCommit === null || baseCommit === null) {
    return { ok: false, reason: 'missing-branch', conflicts: [] };
  }
  const lookup = (oid: string): import('./git-objects.ts').GitObject | undefined => repo.objects.get(oid);
  const base = mergeBase(baseCommit, headCommit, lookup);
  const baseTree = base === null ? EMPTY_TREE_OID : parseCommit(repo.objects.get(base)!.data).tree;
  const oursTree = parseCommit(repo.objects.get(baseCommit)!.data).tree;
  const theirsTree = parseCommit(repo.objects.get(headCommit)!.data).tree;
  const merged = threeWayMerge(baseTree, oursTree, theirsTree, lookup);
  if (!merged.ok) return { ok: false, reason: 'conflict', conflicts: merged.conflicts };
  const treeOid = buildTreeFromMap(merged.merged, (type, data) => store.putObject(repo, type, data));
  const ident = serverIdent(store);
  const title =
    commitTitle ??
    (method === 'squash' ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`);
  const commitData = buildCommit({
    tree: treeOid,
    parents: method === 'squash' ? [baseCommit] : [baseCommit, headCommit],
    message: `${title}\n`,
    author: ident,
    committer: ident,
  });
  const sha = store.putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FORGE_EPOCH_ISO;
  pull.mergeCommitSha = sha;
  pull.updatedSeq = store.nextSeq();
  return { ok: true, sha };
}

export interface PullFileEntry {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly sha: string;
}

/** The changed files of a pull request: merge-base tree versus head tree, with line counts. */
export function pullFiles(repo: RepoState, pull: PullRequest): PullFileEntry[] {
  const headTip = branchTip(repo, pull.headRef) ?? pull.headShaAtCreation;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreation;
  const headCommit = resolveRef(repo, headTip);
  const baseCommit = resolveRef(repo, baseTip);
  if (headCommit === null || baseCommit === null) return [];
  const lookup = (oid: string): import('./git-objects.ts').GitObject | undefined => repo.objects.get(oid);
  const base = mergeBase(baseCommit, headCommit, lookup);
  const baseTree = base === null ? EMPTY_TREE_OID : parseCommit(repo.objects.get(base)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headCommit)!.data).tree;
  const out: PullFileEntry[] = [];
  for (const entry of diffTrees(baseTree, headTree, lookup)) {
    const oldData = entry.oldOid === null ? null : (repo.objects.get(entry.oldOid)?.data ?? null);
    const newData = entry.newOid === null ? null : (repo.objects.get(entry.newOid)?.data ?? null);
    const counts = diffLineCounts(oldData, newData);
    out.push({
      filename: entry.path,
      status: entry.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: entry.newOid ?? entry.oldOid ?? '',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------------------------

function handleRoot(ctx: RestContext): ApiReply {
  return {
    status: 200,
    body: {
      current_user_url: `${ctx.baseUrl}/api/v3/user`,
      current_user_repos_url: `${ctx.baseUrl}/api/v3/user/repos`,
      repository_url: `${ctx.baseUrl}/api/v3/repos/{owner}/{repo}`,
    },
  };
}

function handleMeta(): ApiReply {
  return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: false } };
}

function handleUser(ctx: RestContext): ApiReply {
  return {
    status: 200,
    body: { login: ctx.store.viewerLogin, id: ctx.store.viewerId, type: 'User', site_admin: false },
  };
}

function handleCreateRepo(ctx: RestContext): ApiReply {
  const body = bodyObject(ctx);
  const name = reqString(body, 'name');
  if (!isValidRepoName(name)) throw unprocessable('name is not a valid repository name');
  const repo = ctx.store.createRepo(ctx.store.viewerLogin, name, {
    private: optBool(body, 'private', false),
    description: optString(body, 'description', ''),
  });
  if (repo === null) throw unprocessable('Repository already exists');
  return { status: 201, body: repoJson(ctx.store, repo, ctx.baseUrl) };
}

function handleListUserRepos(ctx: RestContext): ApiReply {
  const repos = ctx.store.listRepos(ctx.store.viewerLogin);
  const page = paginate(ctx, repos);
  return {
    status: 200,
    body: page.items.map((repo) => repoJson(ctx.store, repo, ctx.baseUrl)),
    headers: page.headers,
  };
}

function handleGetRepo(ctx: RestContext, owner: string, name: string): ApiReply {
  return { status: 200, body: repoJson(ctx.store, needRepo(ctx, owner, name), ctx.baseUrl) };
}

function handlePatchRepo(ctx: RestContext, owner: string, name: string): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const body = bodyObject(ctx);
  if (body.description !== undefined) repo.description = optString(body, 'description', repo.description);
  if (body.private !== undefined) repo.private = optBool(body, 'private', repo.private);
  if (body.default_branch !== undefined) {
    const branch = optString(body, 'default_branch', repo.defaultBranch);
    if (branch !== '') repo.defaultBranch = branch;
  }
  return { status: 200, body: repoJson(ctx.store, repo, ctx.baseUrl) };
}

function handleDeleteRepo(ctx: RestContext, owner: string, name: string): ApiReply {
  needRepo(ctx, owner, name);
  ctx.store.deleteRepo(owner, name);
  return { status: 204 };
}

function handleListBranches(ctx: RestContext, owner: string, name: string): ApiReply {
  const repo = needRepo(ctx, owner, name);
  return {
    status: 200,
    body: listBranches(repo).map((branch) => ({
      name: branch,
      commit: { sha: branchTip(repo, branch)! },
      protected: false,
    })),
  };
}

function handleGetBranch(ctx: RestContext, owner: string, name: string, branch: string): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const tip = branchTip(repo, branch);
  if (tip === null) throw notFound('Branch not found');
  const commit = commitJson(repo, tip);
  return {
    status: 200,
    body: { name: branch, commit: commit ?? { sha: tip }, protected: false },
  };
}

function handleCreateRef(ctx: RestContext, owner: string, name: string): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const body = bodyObject(ctx);
  const ref = reqString(body, 'ref');
  const sha = reqString(body, 'sha');
  if (!isValidRefName(ref)) throw unprocessable('ref must name a ref under refs/');
  if (!isObjectId(sha) || !repo.objects.has(sha)) throw unprocessable('sha does not name an object in the repository');
  if (repo.refs.has(ref)) throw unprocessable('Reference already exists');
  repo.refs.set(ref, sha);
  const object = repo.objects.get(sha)!;
  return { status: 201, body: { ref, object: { sha, type: object.type } } };
}

function handleGetRef(ctx: RestContext, owner: string, name: string, refPath: string[]): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const ref = `refs/${refPath.join('/')}`;
  const oid = repo.refs.get(ref);
  if (oid !== undefined) {
    const object = repo.objects.get(oid)!;
    return { status: 200, body: { ref, object: { sha: oid, type: object.type } } };
  }
  const prefix = `${ref}/`;
  const matches = [...repo.refs.keys()].filter((candidate) => candidate.startsWith(prefix)).sort();
  if (matches.length === 0) throw notFound('Reference not found');
  return {
    status: 200,
    body: matches.map((candidate) => {
      const candidateOid = repo.refs.get(candidate)!;
      return { ref: candidate, object: { sha: candidateOid, type: repo.objects.get(candidateOid)!.type } };
    }),
  };
}

function handlePatchRef(ctx: RestContext, owner: string, name: string, refPath: string[]): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const ref = `refs/${refPath.join('/')}`;
  const current = repo.refs.get(ref);
  if (current === undefined) throw notFound('Reference not found');
  const body = bodyObject(ctx);
  const sha = reqString(body, 'sha');
  if (!isObjectId(sha) || !repo.objects.has(sha)) throw unprocessable('sha does not name an object in the repository');
  const force = optBool(body, 'force', false);
  if (!force && sha !== current) {
    const target = repo.objects.get(sha)!;
    if (target.type !== 'commit' || !isAncestor(current, sha, (oid) => repo.objects.get(oid))) {
      throw unprocessable('Update is not a fast forward');
    }
  }
  repo.refs.set(ref, sha);
  const object = repo.objects.get(sha)!;
  return { status: 200, body: { ref, object: { sha, type: object.type } } };
}

function handleDeleteRef(ctx: RestContext, owner: string, name: string, refPath: string[]): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const ref = `refs/${refPath.join('/')}`;
  if (!repo.refs.has(ref)) throw notFound('Reference not found');
  repo.refs.delete(ref);
  return { status: 204 };
}

function handleListCommits(ctx: RestContext, owner: string, name: string): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const refish = ctx.query.get('sha') ?? repo.defaultBranch;
  const tip = resolveRef(repo, refish);
  if (tip === null) throw notFound('No commit found for the given ref');
  const history = listHistory(repo, tip);
  const page = paginate(ctx, history);
  const body: unknown[] = [];
  for (const sha of page.items) {
    const rendered = commitJson(repo, sha);
    if (rendered !== null) body.push(rendered);
  }
  return { status: 200, body, headers: page.headers };
}

function handleGetCommit(ctx: RestContext, owner: string, name: string, sha: string): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const resolved = resolveRef(repo, sha);
  if (resolved === null) throw notFound('No commit found for SHA');
  const rendered = commitJson(repo, resolved);
  if (rendered === null) throw notFound('No commit found for SHA');
  return { status: 200, body: rendered };
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function contentsPathSegments(segments: string[]): string[] {
  // Segments arrive URL-decoded, so an encoded slash (%2F) lands inside one
  // segment. Split those too: a path is a path however it was encoded, and a
  // tree entry must never carry a slash in its name (real git forbids it).
  const path: string[] = [];
  for (const segment of segments) {
    for (const piece of segment.split('/')) {
      if (piece === '') continue;
      if (piece === '.' || piece === '..') throw unprocessable('the path has an unusable segment');
      path.push(piece);
    }
  }
  return path;
}

function contentsIdent(store: ForgeStore): string {
  return serverIdent(store);
}

function handlePutContents(ctx: RestContext, owner: string, name: string, segments: string[]): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const path = contentsPathSegments(segments);
  if (path.length === 0) throw unprocessable('a file path is required');
  const body = bodyObject(ctx);
  const message = optString(body, 'message', `Update ${path.join('/')}`);
  const content = body.content;
  if (typeof content !== 'string' || content === '') throw unprocessable('content is required');
  const bytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
  const branch = optString(body, 'branch', repo.defaultBranch);
  if (branch === '') throw unprocessable('branch must not be empty');
  const refName = `refs/heads/${branch}`;
  // A write to a missing branch starts it at the default branch's tip. The
  // tip is peeled to a commit, so a tag-valued ref never breaks the write.
  const rawTip = repo.refs.get(refName) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const tip = rawTip === undefined ? undefined : (resolveRef(repo, rawTip) ?? undefined);
  const lookup = (oid: string): import('./git-objects.ts').GitObject | undefined => repo.objects.get(oid);
  const rootTree = tip === undefined ? null : parseCommit(repo.objects.get(tip)!.data).tree;
  const existing = rootTree === null ? null : treePathEntry(rootTree, path, lookup);
  let isCreate = true;
  if (existing !== null) {
    if (existing.mode === '40000') throw unprocessable('the path names a directory');
    isCreate = false;
    const givenSha = body.sha;
    if (givenSha === undefined) throw unprocessable('sha is required to update a file');
    if (givenSha !== existing.oid) throw conflict('the file changed since the given sha');
  }
  const blobOid = ctx.store.putObject(repo, 'blob', bytes);
  const newTree = setTreePath(rootTree, path, blobOid, '100644', lookup, (type, data) =>
    ctx.store.putObject(repo, type, data),
  );
  const ident = contentsIdent(ctx.store);
  const commitData = buildCommit({
    tree: newTree,
    parents: tip === undefined ? [] : [tip],
    message: message.endsWith('\n') ? message : `${message}\n`,
    author: ident,
    committer: ident,
  });
  const commitSha = ctx.store.putObject(repo, 'commit', commitData);
  repo.refs.set(refName, commitSha);
  const filePath = path.join('/');
  return {
    status: isCreate ? 201 : 200,
    body: {
      content: {
        name: path[path.length - 1],
        path: filePath,
        sha: blobOid,
        size: bytes.length,
        type: 'file',
        encoding: 'base64',
        content: bytes.toString('base64'),
      },
      commit: { sha: commitSha, message },
    },
  };
}

function handleGetContents(ctx: RestContext, owner: string, name: string, segments: string[]): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const path = contentsPathSegments(segments);
  const refish = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = resolveRef(repo, refish);
  if (tip === null) throw notFound('No commit found for the given ref');
  const lookup = (oid: string): import('./git-objects.ts').GitObject | undefined => repo.objects.get(oid);
  const rootTree = parseCommit(repo.objects.get(tip)!.data).tree;
  if (path.length === 0) {
    const entries = treeDirEntries(rootTree, [], lookup);
    if (entries === null) throw notFound('Not Found');
    return { status: 200, body: entries.map((entry) => dirEntryJson(repo, entry, '')) };
  }
  const entry = treePathEntry(rootTree, path, lookup);
  if (entry === null) throw notFound('Not Found');
  const filePath = path.join('/');
  if (entry.mode === '40000') {
    const entries = treeDirEntries(rootTree, path, lookup);
    if (entries === null) throw notFound('Not Found');
    return { status: 200, body: entries.map((child) => dirEntryJson(repo, child, filePath)) };
  }
  const blob = repo.objects.get(entry.oid);
  if (!blob || blob.type !== 'blob') throw notFound('Not Found');
  return {
    status: 200,
    body: {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: path[path.length - 1],
      path: filePath,
      content: blob.data.toString('base64'),
      sha: entry.oid,
    },
  };
}

function dirEntryJson(repo: RepoState, entry: { mode: string; name: string; oid: string }, parent: string): JsonRecord {
  const isDir = entry.mode === '40000';
  const object = repo.objects.get(entry.oid);
  return {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path: parent === '' ? entry.name : `${parent}/${entry.name}`,
    sha: entry.oid,
    size: isDir ? 0 : (object?.data.length ?? 0),
  };
}

function handleDeleteContents(ctx: RestContext, owner: string, name: string, segments: string[]): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const path = contentsPathSegments(segments);
  if (path.length === 0) throw unprocessable('a file path is required');
  const body = bodyObject(ctx);
  const message = optString(body, 'message', `Delete ${path.join('/')}`);
  const branch = optString(body, 'branch', repo.defaultBranch);
  const refName = `refs/heads/${branch}`;
  const rawTip = repo.refs.get(refName);
  if (rawTip === undefined) throw notFound('Branch not found');
  const tip = resolveRef(repo, rawTip);
  if (tip === null) throw notFound('Branch not found');
  const lookup = (oid: string): import('./git-objects.ts').GitObject | undefined => repo.objects.get(oid);
  const rootTree = parseCommit(repo.objects.get(tip)!.data).tree;
  const existing = treePathEntry(rootTree, path, lookup);
  if (existing === null || existing.mode === '40000') throw notFound('Not Found');
  const givenSha = body.sha;
  if (givenSha === undefined) throw unprocessable('sha is required to delete a file');
  if (givenSha !== existing.oid) throw conflict('the file changed since the given sha');
  const newTree = setTreePath(rootTree, path, null, '100644', lookup, (type, data) =>
    ctx.store.putObject(repo, type, data),
  );
  const ident = contentsIdent(ctx.store);
  const commitData = buildCommit({
    tree: newTree,
    parents: [tip],
    message: message.endsWith('\n') ? message : `${message}\n`,
    author: ident,
    committer: ident,
  });
  const commitSha = ctx.store.putObject(repo, 'commit', commitData);
  repo.refs.set(refName, commitSha);
  return { status: 200, body: { commit: { sha: commitSha, message }, content: null } };
}

// ---------------------------------------------------------------------------------------------
// labels, issues, comments
// ---------------------------------------------------------------------------------------------

function handleCreateLabel(ctx: RestContext, owner: string, name: string): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const body = bodyObject(ctx);
  const labelName = reqString(body, 'name');
  const color = optString(body, 'color', 'ededed');
  const description = optString(body, 'description', '');
  const label = ctx.store.createLabel(repo, labelName, color, description);
  if (label === null) throw unprocessable('Label already exists');
  return { status: 201, body: labelJson(label) };
}

function handleListLabels(ctx: RestContext, owner: string, name: string): ApiReply {
  const repo = needRepo(ctx, owner, name);
  return { status: 200, body: [...repo.labels.values()].map(labelJson) };
}

function labelNamesOf(body: Record<string, unknown>, repo: RepoState): string[] {
  const raw = body.labels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw unprocessable('labels must be an array');
  const names: string[] = [];
  for (const entry of raw) {
    const labelName = typeof entry === 'string' ? entry : (entry as Record<string, unknown> | null)?.name;
    if (typeof labelName !== 'string' || labelName === '') throw unprocessable('labels must name labels');
    if (!repo.labels.has(labelName)) throw unprocessable(`Label does not exist: ${labelName}`);
    names.push(labelName);
  }
  return names;
}

function handleCreateIssue(ctx: RestContext, owner: string, name: string): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const body = bodyObject(ctx);
  const title = reqString(body, 'title');
  const issueBody = optString(body, 'body', '');
  const labels = labelNamesOf(body, repo);
  const issue = ctx.store.createIssue(repo, title, issueBody, labels);
  return { status: 201, body: issueJson(ctx.store, repo, issue, ctx.baseUrl) };
}

interface Listable {
  readonly createdSeq: number;
  readonly updatedSeq: number;
  readonly state: string;
  readonly comments: readonly unknown[];
  readonly number: number;
}

function handleListIssues(ctx: RestContext, owner: string, name: string): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const state = ctx.query.get('state') ?? 'open';
  if (state !== 'open' && state !== 'closed' && state !== 'all') throw unprocessable('state must be open, closed or all');
  const sort = ctx.query.get('sort') ?? 'created';
  if (sort !== 'created' && sort !== 'updated' && sort !== 'comments') throw unprocessable('sort must be created, updated or comments');
  const direction = ctx.query.get('direction') ?? 'desc';
  if (direction !== 'asc' && direction !== 'desc') throw unprocessable('direction must be asc or desc');
  const entries: Array<{ item: Listable; json: JsonRecord }> = [];
  for (const issue of repo.issues.values()) {
    entries.push({ item: issue, json: issueJson(ctx.store, repo, issue, ctx.baseUrl) });
  }
  for (const pull of repo.pulls.values()) {
    entries.push({ item: pull, json: pullAsIssueJson(ctx.store, repo, pull, ctx.baseUrl) });
  }
  const filtered = entries.filter(({ item }) => state === 'all' || item.state === state);
  const keyOf = (item: Listable): number =>
    sort === 'updated' ? item.updatedSeq : sort === 'comments' ? item.comments.length : item.createdSeq;
  filtered.sort((a, b) => {
    const diff = keyOf(a.item) - keyOf(b.item);
    if (diff !== 0) return direction === 'asc' ? diff : -diff;
    return direction === 'asc' ? a.item.number - b.item.number : b.item.number - a.item.number;
  });
  const page = paginate(ctx, filtered);
  return { status: 200, body: page.items.map(({ json }) => json), headers: page.headers };
}

function issueOrPull(repo: RepoState, number: number): { issue?: Issue; pull?: PullRequest } {
  const issue = repo.issues.get(number);
  if (issue !== undefined) return { issue };
  const pull = repo.pulls.get(number);
  if (pull !== undefined) return { pull };
  return {};
}

function handleGetIssue(ctx: RestContext, owner: string, name: string, number: number): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const found = issueOrPull(repo, number);
  if (found.issue) return { status: 200, body: issueJson(ctx.store, repo, found.issue, ctx.baseUrl) };
  if (found.pull) return { status: 200, body: pullAsIssueJson(ctx.store, repo, found.pull, ctx.baseUrl) };
  throw notFound('Issue not found');
}

function handlePatchIssue(ctx: RestContext, owner: string, name: string, number: number): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const found = issueOrPull(repo, number);
  const body = bodyObject(ctx);
  const target = found.issue ?? found.pull;
  if (target === undefined) throw notFound('Issue not found');
  if (body.state !== undefined) {
    const state = body.state;
    if (state !== 'open' && state !== 'closed') throw unprocessable('state must be open or closed');
    target.state = state;
  }
  if (body.title !== undefined) target.title = optString(body, 'title', target.title);
  if (body.body !== undefined) target.body = optString(body, 'body', target.body);
  if (found.issue !== undefined && body.labels !== undefined) {
    found.issue.labelNames = labelNamesOf(body, repo);
  }
  target.updatedSeq = ctx.store.nextSeq();
  if (found.issue) return { status: 200, body: issueJson(ctx.store, repo, found.issue, ctx.baseUrl) };
  return { status: 200, body: pullAsIssueJson(ctx.store, repo, found.pull!, ctx.baseUrl) };
}

function handleCreateComment(ctx: RestContext, owner: string, name: string, number: number): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const found = issueOrPull(repo, number);
  const target = found.issue ?? found.pull;
  if (target === undefined) throw notFound('Issue not found');
  const body = bodyObject(ctx);
  const text = reqString(body, 'body');
  const comment = ctx.store.addComment(target, text);
  return { status: 201, body: commentJson(ctx.store, comment) };
}

function handleListComments(ctx: RestContext, owner: string, name: string, number: number): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const found = issueOrPull(repo, number);
  const target = found.issue ?? found.pull;
  if (target === undefined) throw notFound('Issue not found');
  const page = paginate(ctx, target.comments);
  return { status: 200, body: page.items.map((comment) => commentJson(ctx.store, comment)), headers: page.headers };
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function stripOwnerPrefix(ref: string): string {
  const colon = ref.lastIndexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

function handleCreatePull(ctx: RestContext, owner: string, name: string): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const body = bodyObject(ctx);
  const title = reqString(body, 'title');
  const pullBody = optString(body, 'body', '');
  const headRaw = reqString(body, 'head');
  const baseRaw = reqString(body, 'base');
  const head = stripOwnerPrefix(headRaw);
  const base = stripOwnerPrefix(baseRaw);
  const headTip = branchTip(repo, head);
  const baseTip = branchTip(repo, base);
  if (headTip === null) throw unprocessable(`head branch does not exist: ${head}`);
  if (baseTip === null) throw unprocessable(`base branch does not exist: ${base}`);
  if (head === base) throw unprocessable('head and base name the same branch');
  if (headTip === baseTip) throw unprocessable('No commits between the head and the base');
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      throw unprocessable('A pull request already exists for these branches');
    }
  }
  const pull = ctx.store.createPullRequest(repo, title, pullBody, head, base, headTip, baseTip);
  return { status: 201, body: pullJson(ctx.store, repo, pull, ctx.baseUrl) };
}

function handleListPulls(ctx: RestContext, owner: string, name: string): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const state = ctx.query.get('state') ?? 'open';
  if (state !== 'open' && state !== 'closed' && state !== 'all') throw unprocessable('state must be open, closed or all');
  const pulls = [...repo.pulls.values()]
    .filter((pull) => state === 'all' || pull.state === state)
    .sort((a, b) => b.createdSeq - a.createdSeq);
  const page = paginate(ctx, pulls);
  return { status: 200, body: page.items.map((pull) => pullJson(ctx.store, repo, pull, ctx.baseUrl)), headers: page.headers };
}

function handleGetPull(ctx: RestContext, owner: string, name: string, number: number): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw notFound('Pull request not found');
  return { status: 200, body: pullJson(ctx.store, repo, pull, ctx.baseUrl) };
}

function handleListPullFiles(ctx: RestContext, owner: string, name: string, number: number): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw notFound('Pull request not found');
  return { status: 200, body: pullFiles(repo, pull) };
}

function handleMergePull(ctx: RestContext, owner: string, name: string, number: number): ApiReply {
  const repo = needRepo(ctx, owner, name);
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw notFound('Pull request not found');
  const body = bodyObject(ctx);
  const methodRaw = optString(body, 'merge_method', 'merge').toLowerCase();
  if (methodRaw !== 'squash' && methodRaw !== 'merge') {
    throw unprocessable(`merge_method ${methodRaw} is not supported`);
  }
  const commitTitle = typeof body.commit_title === 'string' ? body.commit_title : undefined;
  const attempt = attemptMerge(ctx.store, repo, pull, methodRaw, commitTitle);
  if (!attempt.ok) {
    if (attempt.reason === 'conflict') {
      throw new HttpError(405, `Pull Request is not mergeable: conflicting files: ${attempt.conflicts.join(', ')}`);
    }
    if (attempt.reason === 'not-open') {
      throw new HttpError(405, 'Pull Request is not mergeable: it is already closed');
    }
    throw unprocessable('Pull Request cannot be merged: a branch is missing');
  }
  return { status: 200, body: { sha: attempt.sha, merged: true, message: 'Pull Request successfully merged' } };
}

// ---------------------------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------------------------

/** Route a request under /api/v3 to its handler. */
export function handleRest(ctx: RestContext): ApiReply {
  const segments = ctx.segments;
  const method = ctx.method;

  if (segments.length === 0) {
    if (method === 'GET') return handleRoot(ctx);
    throw notFound();
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') return handleMeta();
    throw notFound();
  }
  if (segments[0] === 'user') {
    if (segments.length === 1 && method === 'GET') return handleUser(ctx);
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'POST') return handleCreateRepo(ctx);
      if (method === 'GET') return handleListUserRepos(ctx);
    }
    throw notFound();
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1]!;
    const name = segments[2]!;
    const rest = segments.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') return handleGetRepo(ctx, owner, name);
      if (method === 'PATCH') return handlePatchRepo(ctx, owner, name);
      if (method === 'DELETE') return handleDeleteRepo(ctx, owner, name);
      throw notFound();
    }
    const head = rest[0]!;
    if (head === 'branches') {
      if (rest.length === 1 && method === 'GET') return handleListBranches(ctx, owner, name);
      if (rest.length >= 2 && method === 'GET') return handleGetBranch(ctx, owner, name, rest.slice(1).join('/'));
      throw notFound();
    }
    if (head === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') return handleCreateRef(ctx, owner, name);
      if (rest.length >= 3) {
        if (method === 'GET') return handleGetRef(ctx, owner, name, rest.slice(2));
        if (method === 'PATCH') return handlePatchRef(ctx, owner, name, rest.slice(2));
        if (method === 'DELETE') return handleDeleteRef(ctx, owner, name, rest.slice(2));
      }
      throw notFound();
    }
    if (head === 'commits') {
      if (rest.length === 1 && method === 'GET') return handleListCommits(ctx, owner, name);
      if (rest.length === 2 && method === 'GET') return handleGetCommit(ctx, owner, name, rest[1]!);
      throw notFound();
    }
    if (head === 'contents') {
      if (method === 'PUT') return handlePutContents(ctx, owner, name, rest.slice(1));
      if (method === 'GET') return handleGetContents(ctx, owner, name, rest.slice(1));
      if (method === 'DELETE') return handleDeleteContents(ctx, owner, name, rest.slice(1));
      throw notFound();
    }
    if (head === 'labels') {
      if (rest.length === 1) {
        if (method === 'POST') return handleCreateLabel(ctx, owner, name);
        if (method === 'GET') return handleListLabels(ctx, owner, name);
      }
      throw notFound();
    }
    if (head === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') return handleCreateIssue(ctx, owner, name);
        if (method === 'GET') return handleListIssues(ctx, owner, name);
      }
      if (rest.length >= 2) {
        const number = needNumber(rest[1]!);
        if (rest.length === 2) {
          if (method === 'GET') return handleGetIssue(ctx, owner, name, number);
          if (method === 'PATCH') return handlePatchIssue(ctx, owner, name, number);
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (method === 'POST') return handleCreateComment(ctx, owner, name, number);
          if (method === 'GET') return handleListComments(ctx, owner, name, number);
        }
      }
      throw notFound();
    }
    if (head === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') return handleCreatePull(ctx, owner, name);
        if (method === 'GET') return handleListPulls(ctx, owner, name);
      }
      if (rest.length >= 2) {
        const number = needNumber(rest[1]!);
        if (rest.length === 2 && method === 'GET') return handleGetPull(ctx, owner, name, number);
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          return handleListPullFiles(ctx, owner, name, number);
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          return handleMergePull(ctx, owner, name, number);
        }
      }
      throw notFound();
    }
  }
  throw notFound();
}
