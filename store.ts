/**
 * The forge store: one in-memory home for every repository, its git objects
 * and refs, and its issues, pull requests, labels and comments. Every surface
 * (git smart HTTP, REST, GraphQL, MCP) reads and writes this same store, so a
 * repository created over one surface is the same object over the others.
 *
 * All timestamps the store emits are fixed: no wall clock is read, so a given
 * request sequence always yields the same responses.
 */

import {
  hashObject,
  isObjectId,
  mergeBase,
  parseCommit,
  parseIdent,
  parseTag,
  threeWayMerge,
  type GitObject,
  type GitObjectType,
} from './git-objects.ts';

/** The fixed epoch every timestamp the forge emits derives from (Unix seconds). */
export const FORGE_EPOCH_SEC = 1_700_000_000;

/** The fixed ISO timestamp every created_at/updated_at/merged_at carries. */
export const FORGE_EPOCH_ISO = '2023-11-14T22:13:20Z';

/** The default branch every repository is created with. */
export const DEFAULT_BRANCH = 'main';

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly authorLogin: string;
  readonly createdSeq: number;
}

export type IssueState = 'open' | 'closed';

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: IssueState;
  labelNames: string[];
  readonly comments: Comment[];
  readonly createdSeq: number;
  updatedSeq: number;
  readonly authorLogin: string;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: IssueState;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headShaAtCreation: string;
  readonly baseShaAtCreation: string;
  readonly comments: Comment[];
  readonly createdSeq: number;
  updatedSeq: number;
  readonly authorLogin: string;
}

export interface RepoState {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  readonly createdSeq: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  readonly labels: Map<string, Label>;
  nextNumber: number;
}

/** Whether a repository name is acceptable (GitHub's shape, leniently). */
export function isValidRepoName(name: string): boolean {
  if (name.length === 0 || name.length > 100) return false;
  if (/[\s/\\]/.test(name)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  return true;
}

/** Whether a ref name is acceptable for a push or a ref creation. */
export function isValidRefName(ref: string): boolean {
  if (!ref.startsWith('refs/')) return false;
  if (ref.length > 200) return false;
  if (/[\s\u0000-\u001f]/.test(ref)) return false;
  if (ref.includes('..') || ref.includes('//') || ref.endsWith('/')) return false;
  return true;
}

/**
 * The forge store. One instance per server process; a trial is one process,
 * so nothing here needs to survive a restart.
 */
export class ForgeStore {
  readonly viewerLogin: string;
  readonly viewerId = 1000;
  private readonly repos = new Map<string, RepoState>();
  private nextIdValue = 1;
  private seqValue = 0;

  constructor(viewerLogin: string) {
    this.viewerLogin = viewerLogin;
  }

  /** Every repository in the store, in creation order. */
  allRepos(): RepoState[] {
    return [...this.repos.values()];
  }

  /** The next globally unique numeric id (repos, issues, pulls, labels, comments). */
  nextId(): number {
    const id = this.nextIdValue;
    this.nextIdValue += 1;
    return id;
  }

  /** The next ordering sequence number (creation/update order within the store). */
  nextSeq(): number {
    this.seqValue += 1;
    return this.seqValue;
  }

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** Create a repository, or null when one with that name already exists. */
  createRepo(
    owner: string,
    name: string,
    options: { private?: boolean; description?: string; defaultBranch?: string } = {},
  ): RepoState | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    const repo: RepoState = {
      id: this.nextId(),
      name,
      owner,
      private: options.private ?? false,
      description: options.description ?? '',
      defaultBranch: options.defaultBranch ?? DEFAULT_BRANCH,
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoState | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Every repository owned by `owner`, in creation order. */
  listRepos(owner: string): RepoState[] {
    const out: RepoState[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  /** Store an object (idempotent) and answer its id. */
  putObject(repo: RepoState, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Create an issue, taking the next shared issue/pull-request number. */
  createIssue(repo: RepoState, title: string, body: string, labelNames: string[]): Issue {
    const issue: Issue = {
      id: this.nextId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labelNames: [...labelNames],
      comments: [],
      createdSeq: this.nextSeq(),
      updatedSeq: this.seqValue,
      authorLogin: this.viewerLogin,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  /** Create a pull request, taking the next shared issue/pull-request number. */
  createPullRequest(
    repo: RepoState,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
    headSha: string,
    baseSha: string,
  ): PullRequest {
    const pull: PullRequest = {
      id: this.nextId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headShaAtCreation: headSha,
      baseShaAtCreation: baseSha,
      comments: [],
      createdSeq: this.nextSeq(),
      updatedSeq: this.seqValue,
      authorLogin: this.viewerLogin,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** Add a comment to an issue or pull request. */
  addComment(target: Issue | PullRequest, body: string): Comment {
    const comment: Comment = {
      id: this.nextId(),
      body,
      authorLogin: this.viewerLogin,
      createdSeq: this.nextSeq(),
    };
    target.comments.push(comment);
    target.updatedSeq = this.seqValue;
    return comment;
  }

  /** Create a label, or null when one with that name already exists. */
  createLabel(repo: RepoState, name: string, color: string, description: string): Label | null {
    if (repo.labels.has(name)) return null;
    const label: Label = { id: this.nextId(), name, color, description };
    repo.labels.set(name, label);
    return label;
  }
}

// ---------------------------------------------------------------------------------------------
// ref resolution and history
// ---------------------------------------------------------------------------------------------

/**
 * Resolve a ref-ish to a commit id: a full ref, a branch or tag name, HEAD,
 * or an object id that names a commit (tags are peeled). Null when nothing
 * matches.
 */
export function resolveRef(repo: RepoState, refish: string): string | null {
  if (refish === 'HEAD') {
    const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return head ?? null;
  }
  if (isObjectId(refish)) {
    const object = repo.objects.get(refish);
    if (!object) return null;
    if (object.type === 'commit') return refish;
    if (object.type === 'tag') {
      let current = parseTag(object.data).object;
      const seen = new Set<string>([refish]);
      while (!seen.has(current)) {
        seen.add(current);
        const next = repo.objects.get(current);
        if (!next) return null;
        if (next.type === 'commit') return current;
        if (next.type !== 'tag') return null;
        current = parseTag(next.data).object;
      }
      return null;
    }
    return null;
  }
  const direct = repo.refs.get(refish);
  if (direct !== undefined) return peelToCommit(repo, direct);
  const head = repo.refs.get(`refs/heads/${refish}`);
  if (head !== undefined) return peelToCommit(repo, head);
  const tag = repo.refs.get(`refs/tags/${refish}`);
  if (tag !== undefined) return peelToCommit(repo, tag);
  return null;
}

/** Peel an oid to a commit when it names a tag chain, else itself when a commit. */
export function peelToCommit(repo: RepoState, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

/** The tip a branch ref currently points at, or null when the branch is missing. */
export function branchTip(repo: RepoState, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Every branch name in the repository, sorted. */
export function listBranches(repo: RepoState): string[] {
  const names: string[] = [];
  for (const ref of repo.refs.keys()) {
    if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
  }
  names.sort();
  return names;
}

/**
 * A branch's history, newest first: a breadth-first walk from the tip over
 * parents (generation order, which is chain order for linear histories).
 */
export function listHistory(repo: RepoState, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++]!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

/** Whether a pull request's head can merge into its base without conflicts. */
export function pullMergeable(repo: RepoState, pull: PullRequest): boolean | null {
  if (pull.state !== 'open') return false;
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return null;
  const headCommit = peelToCommit(repo, headTip);
  const baseCommit = peelToCommit(repo, baseTip);
  if (headCommit === null || baseCommit === null) return null;
  const base = mergeBase(baseCommit, headCommit, (oid) => repo.objects.get(oid));
  if (base === null) return null;
  const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
  const oursTree = parseCommit(repo.objects.get(baseCommit)!.data).tree;
  const theirsTree = parseCommit(repo.objects.get(headCommit)!.data).tree;
  const merged = threeWayMerge(baseTree, oursTree, theirsTree, (oid) => repo.objects.get(oid));
  return merged.ok;
}

// ---------------------------------------------------------------------------------------------
// GraphQL global ids: opaque, stable, decodable.
// ---------------------------------------------------------------------------------------------

function encodeGlobalId(kind: string, rest: string): string {
  return Buffer.from(`${kind}:${rest}`, 'utf8').toString('base64');
}

export function repoGlobalId(owner: string, name: string): string {
  return encodeGlobalId('Repository', `${owner}/${name}`);
}

export function issueGlobalId(owner: string, name: string, number: number): string {
  return encodeGlobalId('Issue', `${owner}/${name}#${number}`);
}

export function pullGlobalId(owner: string, name: string, number: number): string {
  return encodeGlobalId('PullRequest', `${owner}/${name}#${number}`);
}

export function commentGlobalId(owner: string, name: string, number: number, commentId: number): string {
  return encodeGlobalId('IssueComment', `${owner}/${name}#${number}:${commentId}`);
}

export type DecodedGlobalId =
  | { readonly kind: 'Repository'; readonly owner: string; readonly name: string }
  | { readonly kind: 'Issue'; readonly owner: string; readonly name: string; readonly number: number }
  | { readonly kind: 'PullRequest'; readonly owner: string; readonly name: string; readonly number: number }
  | { readonly kind: 'IssueComment'; readonly owner: string; readonly name: string; readonly number: number; readonly commentId: number };

/** Decode a global id, or null when it is not one of this forge's ids. */
export function decodeGlobalId(id: string): DecodedGlobalId | null {
  if (typeof id !== 'string' || id === '' || !/^[A-Za-z0-9+/=]+$/.test(id)) return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  const kind = text.slice(0, colon);
  const rest = text.slice(colon + 1);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const owner = rest.slice(0, slash);
  const afterSlash = rest.slice(slash + 1);
  if (kind === 'Repository') {
    if (afterSlash === '' || afterSlash.includes('#') || afterSlash.includes(':')) return null;
    return { kind, owner, name: afterSlash };
  }
  const hash = afterSlash.indexOf('#');
  if (hash <= 0) return null;
  const name = afterSlash.slice(0, hash);
  const tail = afterSlash.slice(hash + 1);
  if (kind === 'Issue' || kind === 'PullRequest') {
    if (!/^\d+$/.test(tail)) return null;
    return { kind, owner, name, number: Number(tail) };
  }
  if (kind === 'IssueComment') {
    const parts = tail.split(':');
    if (parts.length !== 2 || !/^\d+$/.test(parts[0]!) || !/^\d+$/.test(parts[1]!)) return null;
    return { kind, owner, name, number: Number(parts[0]), commentId: Number(parts[1]) };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------------------------

export interface JsonRecord {
  [key: string]: unknown;
}

function userJson(store: ForgeStore, login: string): JsonRecord {
  return { login, id: login === store.viewerLogin ? store.viewerId : 0, type: 'User' };
}

export function repoJson(store: ForgeStore, repo: RepoState, baseUrl: string): JsonRecord {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(store, repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FORGE_EPOCH_ISO,
    updated_at: FORGE_EPOCH_ISO,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${baseUrl}/${repo.owner}/${repo.name}.git`,
  };
}

export function labelJson(label: Label): JsonRecord {
  return { id: label.id, name: label.name, color: label.color, description: label.description };
}

export function issueJson(store: ForgeStore, repo: RepoState, issue: Issue, baseUrl: string): JsonRecord {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(store, issue.authorLogin),
    labels: issue.labelNames
      .map((name) => repo.labels.get(name))
      .filter((label): label is Label => label !== undefined)
      .map(labelJson),
    comments: issue.comments.length,
    created_at: FORGE_EPOCH_ISO,
    updated_at: FORGE_EPOCH_ISO,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** A pull request rendered as an issue (GitHub's issues list includes pull requests). */
export function pullAsIssueJson(store: ForgeStore, repo: RepoState, pull: PullRequest, baseUrl: string): JsonRecord {
  const record = issueJson(
    store,
    repo,
    {
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      labelNames: [],
      comments: pull.comments,
      createdSeq: pull.createdSeq,
      updatedSeq: pull.updatedSeq,
      authorLogin: pull.authorLogin,
    },
    baseUrl,
  );
  record.pull_request = {
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
  };
  return record;
}

export function pullJson(store: ForgeStore, repo: RepoState, pull: PullRequest, baseUrl: string): JsonRecord {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headShaAtCreation;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreation;
  const refJson = (ref: string, sha: string): JsonRecord => ({
    ref,
    sha,
    label: `${repo.owner}:${ref}`,
    user: userJson(store, repo.owner),
    repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
  });
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullMergeable(repo, pull),
    head: refJson(pull.headRef, headSha),
    base: refJson(pull.baseRef, baseSha),
    user: userJson(store, pull.authorLogin),
    created_at: FORGE_EPOCH_ISO,
    updated_at: FORGE_EPOCH_ISO,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function commentJson(store: ForgeStore, comment: Comment): JsonRecord {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(store, comment.authorLogin),
    created_at: FORGE_EPOCH_ISO,
    updated_at: FORGE_EPOCH_ISO,
  };
}

/** A commit rendered the way the commits API renders it. */
export function commitJson(repo: RepoState, sha: string): JsonRecord | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const identJson = (line: string): JsonRecord => {
    const ident = parseIdent(line);
    if (ident === null) return { name: line, email: '', date: FORGE_EPOCH_ISO };
    return { name: ident.name, email: ident.email, date: new Date(ident.timestamp * 1000).toISOString() };
  };
  return {
    sha,
    commit: {
      // GitHub serves the message without its trailing newline(s).
      message: commit.message.replace(/[\r\n]+$/, ''),
      author: identJson(commit.author),
      committer: identJson(commit.committer),
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    author: null,
    committer: null,
  };
}
