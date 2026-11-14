/**
 * The MCP surface at POST /mcp: JSON-RPC 2.0 over Streamable HTTP, speaking
 * both the modern 2026-07-28 era (server/discover, no handshake) and the
 * legacy initialize era. Ten tools act on the same store as the REST and
 * GraphQL surfaces: the six the suite requires (create_repo, get_repo,
 * create_issue, list_issues, create_pull_request, merge_pull_request) plus
 * get_issue, list_pull_requests, get_file_contents and add_issue_comment.
 */

import { parseCommit, treeDirEntries, treePathEntry } from './git-objects.ts';
import { attemptMerge } from './rest.ts';
import {
  branchTip,
  commentJson,
  isValidRepoName,
  issueJson,
  pullAsIssueJson,
  pullJson,
  repoJson,
  resolveRef,
  type ForgeStore,
  type RepoState,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// the tool catalogue: built once, never mutated, so two tools/list calls answer
// byte-identically
// ---------------------------------------------------------------------------------------------

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { readonly type: string; readonly description: string }>;
    readonly required: string[];
  };
}

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue (or pull request, as an issue) by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_file_contents',
    description: 'Read a file (or list a directory) from a repository at a ref.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        path: { type: 'string', description: 'The file path inside the repository.' },
        ref: { type: 'string', description: 'The branch, tag or commit; the default branch when omitted.' },
      },
      required: ['owner', 'repo', 'path'],
    },
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue or pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue or pull request number.' },
        body: { type: 'string', description: 'The comment body.' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
  },
];

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------------------------------------------------------------------------------------
// tool execution
// ---------------------------------------------------------------------------------------------

/** A tool argument that is missing or of the wrong shape: a JSON-RPC -32602. */
class InvalidParams extends Error {}

/** A tool that ran but whose operation failed: an isError result, not a protocol error. */
class ToolFailure extends Error {}

function needString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value === '') throw new InvalidParams(`argument "${field}" is required`);
  return value;
}

function optString(args: Record<string, unknown>, field: string, fallback: string): string {
  const value = args[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new InvalidParams(`argument "${field}" must be a string`);
  return value;
}

function optBool(args: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = args[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new InvalidParams(`argument "${field}" must be a boolean`);
  return value;
}

function needPullNumber(args: Record<string, unknown>): number {
  const value = args.pull_number;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new InvalidParams('argument "pull_number" must be a positive integer');
}

function needPositiveInt(args: Record<string, unknown>, field: string): number {
  const value = args[field];
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new InvalidParams(`argument "${field}" must be a positive integer`);
}

function needRepo(store: ForgeStore, owner: string, name: string): RepoState {
  if (owner !== store.viewerLogin) throw new ToolFailure('Repository not found');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) throw new ToolFailure('Repository not found');
  return repo;
}

function callTool(
  store: ForgeStore,
  baseUrl: string,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = needString(args, 'name');
      if (!isValidRepoName(repoName)) throw new ToolFailure('name is not a valid repository name');
      const repo = store.createRepo(store.viewerLogin, repoName, {
        private: optBool(args, 'private', false),
        description: optString(args, 'description', ''),
      });
      if (repo === null) throw new ToolFailure('Repository already exists');
      return { ...repoJson(store, repo, baseUrl), full_name: `${repo.owner}/${repo.name}` };
    }
    case 'get_repo': {
      const owner = needString(args, 'owner');
      const repoName = needString(args, 'repo');
      const repo = needRepo(store, owner, repoName);
      return { ...repoJson(store, repo, baseUrl), full_name: `${repo.owner}/${repo.name}` };
    }
    case 'create_issue': {
      const owner = needString(args, 'owner');
      const repoName = needString(args, 'repo');
      const title = needString(args, 'title');
      const repo = needRepo(store, owner, repoName);
      const issue = store.createIssue(repo, title, optString(args, 'body', ''), []);
      return issueJson(store, repo, issue, baseUrl);
    }
    case 'list_issues': {
      const owner = needString(args, 'owner');
      const repoName = needString(args, 'repo');
      const state = optString(args, 'state', 'open');
      if (state !== 'open' && state !== 'closed' && state !== 'all') {
        throw new InvalidParams('argument "state" must be open, closed or all');
      }
      const repo = needRepo(store, owner, repoName);
      const entries: unknown[] = [];
      for (const issue of repo.issues.values()) {
        if (state === 'all' || issue.state === state) entries.push(issueJson(store, repo, issue, baseUrl));
      }
      for (const pull of repo.pulls.values()) {
        if (state === 'all' || pull.state === state) entries.push(pullAsIssueJson(store, repo, pull, baseUrl));
      }
      entries.sort(
        (a, b) =>
          (a as { number: number }).number - (b as { number: number }).number,
      );
      return { issues: entries };
    }
    case 'create_pull_request': {
      const owner = needString(args, 'owner');
      const repoName = needString(args, 'repo');
      const title = needString(args, 'title');
      const head = needString(args, 'head');
      const base = needString(args, 'base');
      const repo = needRepo(store, owner, repoName);
      const headTip = branchTip(repo, head);
      const baseTip = branchTip(repo, base);
      if (headTip === null) throw new ToolFailure(`head branch does not exist: ${head}`);
      if (baseTip === null) throw new ToolFailure(`base branch does not exist: ${base}`);
      if (head === base) throw new ToolFailure('head and base name the same branch');
      if (headTip === baseTip) throw new ToolFailure('No commits between the head and the base');
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          throw new ToolFailure('A pull request already exists for these branches');
        }
      }
      const pull = store.createPullRequest(repo, title, optString(args, 'body', ''), head, base, headTip, baseTip);
      return pullJson(store, repo, pull, baseUrl);
    }
    case 'merge_pull_request': {
      const owner = needString(args, 'owner');
      const repoName = needString(args, 'repo');
      const number = needPullNumber(args);
      const repo = needRepo(store, owner, repoName);
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new ToolFailure('Pull request not found');
      const attempt = attemptMerge(store, repo, pull, 'squash');
      if (!attempt.ok) {
        if (attempt.reason === 'conflict') {
          throw new ToolFailure(`Pull Request is not mergeable: conflicting files: ${attempt.conflicts.join(', ')}`);
        }
        throw new ToolFailure('Pull Request is not mergeable');
      }
      return { sha: attempt.sha, merged: true, message: 'Pull Request successfully merged', number };
    }
    case 'get_issue': {
      const owner = needString(args, 'owner');
      const repoName = needString(args, 'repo');
      const number = needPositiveInt(args, 'issue_number');
      const repo = needRepo(store, owner, repoName);
      const issue = repo.issues.get(number);
      if (issue !== undefined) return issueJson(store, repo, issue, baseUrl);
      const pull = repo.pulls.get(number);
      if (pull !== undefined) return pullAsIssueJson(store, repo, pull, baseUrl);
      throw new ToolFailure('Issue not found');
    }
    case 'list_pull_requests': {
      const owner = needString(args, 'owner');
      const repoName = needString(args, 'repo');
      const state = optString(args, 'state', 'open');
      if (state !== 'open' && state !== 'closed' && state !== 'all') {
        throw new InvalidParams('argument "state" must be open, closed or all');
      }
      const repo = needRepo(store, owner, repoName);
      const entries: unknown[] = [];
      for (const pull of repo.pulls.values()) {
        if (state === 'all' || pull.state === state) entries.push(pullJson(store, repo, pull, baseUrl));
      }
      entries.sort((a, b) => (a as { number: number }).number - (b as { number: number }).number);
      return { pull_requests: entries };
    }
    case 'get_file_contents': {
      const owner = needString(args, 'owner');
      const repoName = needString(args, 'repo');
      const rawPath = needString(args, 'path');
      const repo = needRepo(store, owner, repoName);
      const segments = rawPath.split('/').filter((segment) => segment !== '');
      if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
        throw new InvalidParams('argument "path" must name a file or directory inside the repository');
      }
      const refish = optString(args, 'ref', repo.defaultBranch);
      const tip = resolveRef(repo, refish);
      if (tip === null) throw new ToolFailure('No commit found for the given ref');
      const tipObject = repo.objects.get(tip);
      if (tipObject === undefined) throw new ToolFailure('No commit found for the given ref');
      const lookup = (oid: string): import('./git-objects.ts').GitObject | undefined => repo.objects.get(oid);
      const rootTree = parseCommit(tipObject.data).tree;
      const entry = treePathEntry(rootTree, segments, lookup);
      if (entry === null) throw new ToolFailure('Not Found');
      const filePath = segments.join('/');
      if (entry.mode === '40000') {
        const children = treeDirEntries(rootTree, segments, lookup);
        if (children === null) throw new ToolFailure('Not Found');
        return {
          type: 'dir',
          path: filePath,
          entries: children.map((child) => ({
            type: child.mode === '40000' ? 'dir' : 'file',
            name: child.name,
            path: `${filePath}/${child.name}`,
            sha: child.oid,
            size: child.mode === '40000' ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0),
          })),
        };
      }
      const blob = repo.objects.get(entry.oid);
      if (blob === undefined || blob.type !== 'blob') throw new ToolFailure('Not Found');
      return {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: segments[segments.length - 1],
        path: filePath,
        content: blob.data.toString('base64'),
        sha: entry.oid,
      };
    }
    case 'add_issue_comment': {
      const owner = needString(args, 'owner');
      const repoName = needString(args, 'repo');
      const number = needPositiveInt(args, 'issue_number');
      const body = needString(args, 'body');
      const repo = needRepo(store, owner, repoName);
      const target = repo.issues.get(number) ?? repo.pulls.get(number);
      if (target === undefined) throw new ToolFailure('Issue not found');
      return commentJson(store, store.addComment(target, body));
    }
    default:
      throw new InvalidParams(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------------------------

export interface McpContext {
  readonly store: ForgeStore;
  readonly baseUrl: string;
  readonly rawBody: Buffer;
  readonly protocolVersionHeader?: string;
}

export interface McpReply {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

type JsonRpcId = string | number | null;

function resultReply(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function errorReply(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function dispatchOne(
  store: ForgeStore,
  baseUrl: string,
  request: Record<string, unknown>,
): Record<string, unknown> | null {
  const hasId = 'id' in request;
  const id = (request.id ?? null) as JsonRpcId;
  const method = request.method;
  if (typeof method !== 'string') {
    // A request without a method is invalid; a notification without one is dropped.
    return hasId ? errorReply(id, -32600, 'Invalid Request: method is required') : null;
  }
  const params =
    typeof request.params === 'object' && request.params !== null && !Array.isArray(request.params)
      ? (request.params as Record<string, unknown>)
      : {};
  const isNotification = !hasId;

  if (method.startsWith('notifications/')) return null;

  switch (method) {
    case 'server/discover': {
      if (isNotification) return null;
      return resultReply(id, {
        protocolVersion: '2026-07-28',
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        supportedVersions: SUPPORTED_VERSIONS,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/serverInfo': SERVER_INFO,
        },
      });
    }
    case 'initialize': {
      if (isNotification) return null;
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return resultReply(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping': {
      if (isNotification) return null;
      return resultReply(id, {});
    }
    case 'tools/list': {
      if (isNotification) return null;
      return resultReply(id, { tools: TOOLS });
    }
    case 'tools/call': {
      if (isNotification) return null;
      const toolName = params.name;
      if (typeof toolName !== 'string' || toolName === '') {
        return errorReply(id, -32602, 'Invalid params: tool name is required');
      }
      const args =
        typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const payload = callTool(store, baseUrl, toolName, args);
        const text = JSON.stringify(payload);
        return resultReply(id, {
          content: [{ type: 'text', text }],
          structuredContent: payload,
          isError: false,
        });
      } catch (error) {
        if (error instanceof InvalidParams) return errorReply(id, -32602, `Invalid params: ${error.message}`);
        if (error instanceof ToolFailure) {
          return resultReply(id, {
            content: [{ type: 'text', text: error.message }],
            structuredContent: { error: error.message },
            isError: true,
          });
        }
        throw error;
      }
    }
    default: {
      if (isNotification) return null;
      return errorReply(id, -32601, `Method not found: ${method}`);
    }
  }
}

export function handleMcp(ctx: McpContext): McpReply {
  const headers: Record<string, string> = {};
  if (ctx.protocolVersionHeader !== undefined && ctx.protocolVersionHeader !== '') {
    headers['MCP-Protocol-Version'] = ctx.protocolVersionHeader;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.rawBody.toString('utf8')) as unknown;
  } catch {
    return { status: 400, body: errorReply(null, -32700, 'Parse error: the body is not valid JSON'), headers };
  }
  if (Array.isArray(parsed)) {
    const replies: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        replies.push(errorReply(null, -32600, 'Invalid Request'));
        continue;
      }
      const reply = dispatchOne(ctx.store, ctx.baseUrl, entry as Record<string, unknown>);
      if (reply !== null) replies.push(reply);
    }
    if (replies.length === 0) return { status: 202, headers };
    return { status: 200, body: replies, headers };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 200, body: errorReply(null, -32600, 'Invalid Request'), headers };
  }
  const reply = dispatchOne(ctx.store, ctx.baseUrl, parsed as Record<string, unknown>);
  if (reply === null) return { status: 202, headers };
  return { status: 200, body: reply, headers };
}
