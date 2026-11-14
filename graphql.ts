/**
 * The GraphQL surface at POST /api/graphql: a small purpose-built parser and
 * executor for the query shapes a GitHub-compatible client sends — viewer and
 * repository reads, issue and pull-request connections with cursor paging,
 * the __type introspection probes, node() id round-trips, batching, and the
 * five mutations (createIssue, closeIssue, createPullRequest,
 * mergePullRequest, addComment). Unknown fields answer HTTP 200 with an
 * `errors` array naming the field, as the protocol requires.
 */

import { parseCommit } from './git-objects.ts';
import { attemptMerge, pullFiles, type MergeMethod } from './rest.ts';
import {
  FORGE_EPOCH_ISO,
  FORGE_EPOCH_SEC,
  branchTip,
  commentGlobalId,
  decodeGlobalId,
  issueGlobalId,
  pullGlobalId,
  pullMergeable,
  repoGlobalId,
  resolveRef,
  type Comment,
  type ForgeStore,
  type Issue,
  type Label,
  type PullRequest,
  type RepoState,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { readonly kind: 'punct'; readonly value: string }
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number };

class ParseError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!@$=&|?'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new ParseError('unterminated block string');
        let value = source.slice(i + 3, end);
        if (value.startsWith('\n')) value = value.slice(1);
        if (value.endsWith('\n')) value = value.slice(0, -1);
        tokens.push({ kind: 'string', value });
        i = end + 3;
        continue;
      }
      let value = '';
      i += 1;
      for (;;) {
        if (i >= source.length) throw new ParseError('unterminated string');
        const c = source[i]!;
        if (c === '"') {
          i += 1;
          break;
        }
        if (c === '\n') throw new ParseError('unterminated string');
        if (c === '\\') {
          const esc = source[i + 1];
          if (esc === undefined) throw new ParseError('unterminated string');
          const simple: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          if (esc === 'u') {
            const hex = source.slice(i + 2, i + 6);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new ParseError('bad unicode escape');
            value += String.fromCharCode(Number.parseInt(hex, 16));
            i += 6;
            continue;
          }
          const mapped = simple[esc];
          if (mapped === undefined) throw new ParseError(`bad escape \\${esc}`);
          value += mapped;
          i += 2;
          continue;
        }
        value += c;
        i += 1;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const match = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (!match) throw new ParseError(`bad number at offset ${i}`);
      const text = match[0];
      if (match[1] !== undefined || match[2] !== undefined) {
        tokens.push({ kind: 'float', value: Number.parseFloat(text) });
      } else {
        tokens.push({ kind: 'int', value: Number.parseInt(text, 10) });
      }
      i += text.length;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

export type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: ValueNode[] }
  | { readonly kind: 'object'; readonly fields: Array<{ readonly name: string; readonly value: ValueNode }> };

export interface FieldNode {
  readonly kind: 'field';
  readonly alias?: string;
  readonly name: string;
  readonly args: Array<{ readonly name: string; readonly value: ValueNode }>;
  readonly selections: SelectionNode[];
}

export interface InlineFragmentNode {
  readonly kind: 'inlineFragment';
  readonly typeCondition?: string;
  readonly selections: SelectionNode[];
}

export interface FragmentSpreadNode {
  readonly kind: 'fragmentSpread';
  readonly name: string;
}

export type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

export interface VariableDefinition {
  readonly name: string;
  readonly defaultValue?: ValueNode;
}

export interface OperationNode {
  readonly kind: 'operation';
  readonly operation: 'query' | 'mutation' | 'subscription';
  readonly name?: string;
  readonly variables: VariableDefinition[];
  readonly selections: SelectionNode[];
}

export interface FragmentNode {
  readonly kind: 'fragment';
  readonly name: string;
  readonly typeCondition: string;
  readonly selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new ParseError('unexpected end of query');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new ParseError(`expected "${value}" but found ${token.kind === 'punct' ? token.value : token.kind}`);
    }
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new ParseError(`expected ${what}`);
    return token.value;
  }

  private acceptName(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'name' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Array<OperationNode | FragmentNode> {
    const definitions: Array<OperationNode | FragmentNode> = [];
    while (this.peek() !== undefined) definitions.push(this.parseDefinition());
    if (definitions.length === 0) throw new ParseError('the query document is empty');
    return definitions;
  }

  private parseDefinition(): OperationNode | FragmentNode {
    const token = this.peek()!;
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', variables: [], selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName('a fragment name');
      if (name === 'on') throw new ParseError('a fragment cannot be named "on"');
      if (!this.acceptName('on')) throw new ParseError('expected "on" after a fragment name');
      const typeCondition = this.expectName('a type condition');
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = token.value;
      this.next();
      let name: string | undefined;
      const next = this.peek();
      if (next?.kind === 'name') name = this.expectName('an operation name');
      const variables = this.parseVariableDefinitions();
      this.skipDirectives();
      return { kind: 'operation', operation, name, variables, selections: this.parseSelectionSet() };
    }
    throw new ParseError('expected an operation or fragment definition');
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    if (!this.acceptPunct('(')) return [];
    const definitions: VariableDefinition[] = [];
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.acceptPunct('=')) defaultValue = this.parseValue(true);
      this.skipDirectives();
      definitions.push({ name, defaultValue });
    }
    return definitions;
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    this.acceptPunct('!');
  }

  private skipDirectives(): void {
    while (this.acceptPunct('@')) {
      this.expectName('a directive name');
      if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek()!;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value !== 'on') {
        const name = this.expectName('a fragment name');
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      let typeCondition: string | undefined;
      if (this.acceptName('on')) typeCondition = this.expectName('a type condition');
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
    }
    let name = this.expectName('a field name');
    let alias: string | undefined;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName('a field name');
    }
    const args = this.parseArguments();
    this.skipDirectives();
    const selections =
      this.peek()?.kind === 'punct' && this.peek()!.value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    if (!this.acceptPunct('(')) return [];
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!this.acceptPunct(')')) {
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    return args;
  }

  private parseValue(constValue: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$' && !constValue) {
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ']')) values.push(this.parseValue(constValue));
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(constValue) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new ParseError('expected a value');
  }
}

// ---------------------------------------------------------------------------------------------
// values and cursors
// ---------------------------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function resolveValueNode(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => resolveValueNode(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValueNode(field.value, variables);
      return out;
    }
  }
}

function argValues(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValueNode(arg.value, variables);
  return out;
}

function encodeCursor(tag: string, key: string): string {
  return Buffer.from(`${tag}:${key}`).toString('base64');
}

function decodeCursor(cursor: unknown, tag: string): string | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const prefix = `${tag}:`;
  if (!text.startsWith(prefix)) return null;
  return text.slice(prefix.length);
}

function pageOf<T>(
  items: readonly T[],
  args: Record<string, unknown>,
  tag: string,
  keyOf: (item: T) => string,
): { page: T[]; hasNextPage: boolean; endCursor: string | null } {
  const afterKey = decodeCursor(args.after, tag);
  let start = 0;
  if (afterKey !== null) {
    const index = items.findIndex((item) => keyOf(item) === afterKey);
    start = index < 0 ? 0 : index + 1;
  }
  const first = typeof args.first === 'number' && Number.isInteger(args.first) && args.first >= 0 ? args.first : items.length;
  const page = items.slice(start, start + first);
  const hasNextPage = start + page.length < items.length;
  const endCursor = page.length === 0 ? null : encodeCursor(tag, keyOf(page[page.length - 1]!));
  return { page, hasNextPage, endCursor };
}

// ---------------------------------------------------------------------------------------------
// introspection tables
// ---------------------------------------------------------------------------------------------

interface TypeInfo {
  readonly kind: 'OBJECT' | 'ENUM';
  readonly fields: string[];
  readonly enumValues: string[];
}

const TYPE_TABLE: Record<string, TypeInfo> = {
  Query: {
    kind: 'OBJECT',
    fields: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
    enumValues: [],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
    enumValues: [],
  },
  User: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'login', 'name', 'url', 'avatarUrl', 'repositories', 'issues'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id',
      'databaseId',
      'name',
      'nameWithOwner',
      'owner',
      'description',
      'isPrivate',
      'url',
      'defaultBranchRef',
      'viewerPermission',
      'hasIssuesEnabled',
      'issue',
      'issues',
      'pullRequest',
      'pullRequests',
      'labels',
      'createdAt',
      'updatedAt',
      'forkCount',
      'stargazerCount',
    ],
    enumValues: [],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      'id',
      'databaseId',
      'number',
      'title',
      'state',
      'body',
      'url',
      'createdAt',
      'updatedAt',
      'closedAt',
      'author',
      'repository',
      'labels',
      'comments',
    ],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id',
      'databaseId',
      'number',
      'title',
      'state',
      'body',
      'headRefName',
      'baseRefName',
      'headRef',
      'baseRef',
      'mergeable',
      'merged',
      'mergedAt',
      'mergeCommit',
      'files',
      'isDraft',
      'additions',
      'deletions',
      'changedFiles',
      'url',
      'createdAt',
      'updatedAt',
      'closedAt',
      'author',
      'repository',
      'labels',
      'comments',
    ],
    enumValues: [],
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
    enumValues: [],
  },
  Ref: {
    kind: 'OBJECT',
    fields: ['id', 'name', 'target', 'repository'],
    enumValues: [],
  },
  Commit: {
    kind: 'OBJECT',
    fields: ['id', 'oid', 'message', 'abbreviatedOid', 'committedDate', 'author'],
    enumValues: [],
  },
  Label: {
    kind: 'OBJECT',
    fields: ['id', 'name', 'color', 'description'],
    enumValues: [],
  },
  RateLimit: {
    kind: 'OBJECT',
    fields: ['limit', 'cost', 'remaining', 'resetAt', 'nodeCount', 'used'],
    enumValues: [],
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
    enumValues: [],
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'totalCount', 'pageInfo'],
    enumValues: [],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'totalCount', 'pageInfo'],
    enumValues: [],
  },
  LabelConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'totalCount', 'pageInfo'],
    enumValues: [],
  },
  IssueCommentConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'totalCount', 'pageInfo'],
    enumValues: [],
  },
  RepositoryConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'totalCount', 'pageInfo'],
    enumValues: [],
  },
  SearchResultItemConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'totalCount', 'pageInfo'],
    enumValues: [],
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'totalCount', 'pageInfo'],
    enumValues: [],
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: ['path', 'additions', 'deletions', 'changeType'],
    enumValues: [],
  },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  MergeMethod: { kind: 'ENUM', fields: [], enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
};

// ---------------------------------------------------------------------------------------------
// resolved nodes
// ---------------------------------------------------------------------------------------------

interface Page {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

type GqlNode =
  | { readonly __typename: 'Query' | 'Mutation'; readonly kind: 'root'; readonly operation: 'query' | 'mutation' }
  | { readonly __typename: 'User'; readonly kind: 'user'; readonly login: string; readonly databaseId: number }
  | { readonly __typename: 'Repository'; readonly kind: 'repository'; readonly repo: RepoState }
  | { readonly __typename: 'Issue'; readonly kind: 'issue'; readonly repo: RepoState; readonly issue: Issue }
  | { readonly __typename: 'PullRequest'; readonly kind: 'pullRequest'; readonly repo: RepoState; readonly pull: PullRequest }
  | { readonly __typename: 'IssueComment'; readonly kind: 'comment'; readonly repo: RepoState; readonly issueNumber: number; readonly comment: Comment }
  | { readonly __typename: 'Ref'; readonly kind: 'ref'; readonly repo: RepoState; readonly name: string; readonly oid: string }
  | { readonly __typename: 'Commit'; readonly kind: 'commit'; readonly repo: RepoState; readonly oid: string }
  | { readonly __typename: 'IssueConnection'; readonly kind: 'issueConnection'; readonly repo: RepoState; readonly issues: Issue[]; readonly page: Page }
  | { readonly __typename: 'PullRequestConnection'; readonly kind: 'pullConnection'; readonly repo: RepoState; readonly pulls: PullRequest[]; readonly page: Page }
  | { readonly __typename: 'PullRequestChangedFileConnection'; readonly kind: 'fileConnection'; readonly files: ReturnType<typeof pullFiles>; readonly page: Page }
  | { readonly __typename: 'PullRequestChangedFile'; readonly kind: 'changedFile'; readonly file: ReturnType<typeof pullFiles>[number] }
  | { readonly __typename: 'Label'; readonly kind: 'label'; readonly repo: RepoState; readonly label: Label }
  | { readonly __typename: 'LabelConnection'; readonly kind: 'labelConnection'; readonly repo: RepoState; readonly labels: Label[]; readonly total: number; readonly page: Page }
  | { readonly __typename: 'IssueCommentConnection'; readonly kind: 'commentConnection'; readonly repo: RepoState; readonly issueNumber: number; readonly comments: Comment[]; readonly total: number; readonly page: Page }
  | { readonly __typename: 'RepositoryConnection'; readonly kind: 'repoConnection'; readonly repos: RepoState[]; readonly total: number; readonly page: Page }
  | { readonly __typename: 'IssueConnection'; readonly kind: 'issueListConnection'; readonly items: Array<{ repo: RepoState; issue: Issue }>; readonly total: number; readonly page: Page }
  | { readonly __typename: 'SearchResultItemConnection'; readonly kind: 'searchConnection'; readonly items: GqlNode[]; readonly total: number; readonly page: Page }
  | { readonly __typename: 'RateLimit'; readonly kind: 'rateLimit' }
  | { readonly __typename: 'PageInfo'; readonly kind: 'pageInfo'; readonly page: Page }
  | { readonly __typename: '__Type'; readonly kind: 'gqlType'; readonly name: string }
  | { readonly __typename: '__Field'; readonly kind: 'gqlField'; readonly name: string }
  | { readonly __typename: '__EnumValue'; readonly kind: 'gqlEnumValue'; readonly name: string }
  | { readonly __typename: 'IssueCommentEdge'; readonly kind: 'commentEdge'; readonly repo: RepoState; readonly issueNumber: number; readonly comment: Comment }
  | { readonly __typename: 'CreateIssuePayload'; readonly kind: 'createIssuePayload'; readonly repo: RepoState; readonly issue: Issue; readonly clientMutationId: string | null }
  | { readonly __typename: 'CloseIssuePayload'; readonly kind: 'closeIssuePayload'; readonly repo: RepoState; readonly issue: Issue; readonly clientMutationId: string | null }
  | { readonly __typename: 'CreatePullRequestPayload'; readonly kind: 'createPullRequestPayload'; readonly repo: RepoState; readonly pull: PullRequest; readonly clientMutationId: string | null }
  | { readonly __typename: 'MergePullRequestPayload'; readonly kind: 'mergePullRequestPayload'; readonly repo: RepoState; readonly pull: PullRequest; readonly merged: boolean; readonly clientMutationId: string | null }
  | { readonly __typename: 'AddCommentPayload'; readonly kind: 'addCommentPayload'; readonly repo: RepoState; readonly issueNumber: number; readonly comment: Comment; readonly clientMutationId: string | null };

class FieldError extends Error {}

interface ExecContext {
  readonly store: ForgeStore;
  readonly baseUrl: string;
  readonly variables: Variables;
  readonly fragments: Map<string, FragmentNode>;
  readonly errors: Array<{ message: string; path: Array<string | number> }>;
}

function userNode(store: ForgeStore, login: string): GqlNode {
  return {
    __typename: 'User',
    kind: 'user',
    login,
    databaseId: login === store.viewerLogin ? store.viewerId : 0,
  };
}

function repoNodeOf(store: ForgeStore, owner: string, name: string): GqlNode | null {
  if (owner !== store.viewerLogin) return null;
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return null;
  return { __typename: 'Repository', kind: 'repository', repo };
}

function nodeByGlobalId(store: ForgeStore, id: unknown): GqlNode | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.owner !== store.viewerLogin) return null;
  const repo = store.getRepo(decoded.owner, decoded.name);
  if (repo === undefined) return null;
  if (decoded.kind === 'Repository') return { __typename: 'Repository', kind: 'repository', repo };
  if (decoded.kind === 'Issue') {
    const issue = repo.issues.get(decoded.number!);
    return issue === undefined ? null : { __typename: 'Issue', kind: 'issue', repo, issue };
  }
  if (decoded.kind === 'PullRequest') {
    const pull = repo.pulls.get(decoded.number!);
    return pull === undefined ? null : { __typename: 'PullRequest', kind: 'pullRequest', repo, pull };
  }
  if (decoded.kind === 'IssueComment') {
    const target = repo.issues.get(decoded.number!) ?? repo.pulls.get(decoded.number!);
    const comment = target?.comments.find((candidate) => candidate.id === decoded.commentId);
    if (target === undefined || comment === undefined) return null;
    return { __typename: 'IssueComment', kind: 'comment', repo, issueNumber: decoded.number!, comment };
  }
  return null;
}

function issueStateEnum(issue: Issue): 'OPEN' | 'CLOSED' {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateEnum(pull: PullRequest): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function mergeableEnum(repo: RepoState, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const value = pullMergeable(repo, pull);
  if (value === true) return 'MERGEABLE';
  if (value === false) return 'CONFLICTING';
  return 'UNKNOWN';
}

function commitMessage(repo: RepoState, oid: string): string {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return '';
  return parseCommit(object.data).message.replace(/[\r\n]+$/, '');
}

function refNode(repo: RepoState, name: string): GqlNode | null {
  const tip = branchTip(repo, name);
  if (tip === null) return null;
  const commit = resolveRef(repo, tip);
  if (commit === null) return null;
  return { __typename: 'Ref', kind: 'ref', repo, name, oid: commit };
}

function sortedIssues(repo: RepoState, args: Record<string, unknown>): Issue[] {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    issues = issues.filter((issue) => wanted.has(issueStateEnum(issue)));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = String(orderBy.field ?? 'CREATED_AT');
  const direction = String(orderBy.direction ?? 'ASC');
  const keyOf = (issue: Issue): number => (field === 'UPDATED_AT' ? issue.updatedSeq : issue.createdSeq);
  issues.sort((a, b) => {
    const diff = keyOf(a) - keyOf(b);
    if (diff !== 0) return direction === 'DESC' ? -diff : diff;
    return direction === 'DESC' ? b.number - a.number : a.number - b.number;
  });
  return issues;
}

function sortedPulls(repo: RepoState, args: Record<string, unknown>): PullRequest[] {
  let pulls = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    pulls = pulls.filter((pull) => wanted.has(pullStateEnum(pull)));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = String(orderBy.field ?? 'CREATED_AT');
  const direction = String(orderBy.direction ?? 'ASC');
  const keyOf = (pull: PullRequest): number => (field === 'UPDATED_AT' ? pull.updatedSeq : pull.createdSeq);
  pulls.sort((a, b) => {
    const diff = keyOf(a) - keyOf(b);
    if (diff !== 0) return direction === 'DESC' ? -diff : diff;
    return direction === 'DESC' ? b.number - a.number : a.number - b.number;
  });
  return pulls;
}

// ---------------------------------------------------------------------------------------------
// field resolution
// ---------------------------------------------------------------------------------------------

function unknownField(node: GqlNode, field: string): FieldError {
  return new FieldError(`Cannot query field "${field}" on type "${node.__typename}".`);
}

function resolveField(ctx: ExecContext, node: GqlNode, field: FieldNode): unknown {
  const args = argValues(field, ctx.variables);
  if (field.name === '__typename') return node.__typename;

  switch (node.kind) {
    case 'root': {
      if (node.operation === 'query') return resolveRootQuery(ctx, field, args);
      return resolveRootMutation(ctx, field, args);
    }
    case 'user': {
      switch (field.name) {
        case 'login':
          return node.login;
        case 'id':
          return Buffer.from(`User:${node.login}`).toString('base64');
        case 'databaseId':
          return node.databaseId;
        case 'name':
          return node.login;
        case 'url':
          return `${ctx.baseUrl}/${node.login}`;
        case 'avatarUrl':
          return `${ctx.baseUrl}/avatars/${node.login}`;
        case 'repositories': {
          const ordered = ctx.store.listRepos(node.login);
          const sliced = pageOf(ordered, args, 'repo', (repo) => repo.name);
          return {
            __typename: 'RepositoryConnection',
            kind: 'repoConnection',
            repos: sliced.page,
            total: ordered.length,
            page: { hasNextPage: sliced.hasNextPage, endCursor: sliced.endCursor },
          };
        }
        case 'issues': {
          const items: Array<{ repo: RepoState; issue: Issue }> = [];
          for (const repo of ctx.store.listRepos(node.login)) {
            for (const issue of repo.issues.values()) items.push({ repo, issue });
          }
          items.sort((a, b) => a.issue.createdSeq - b.issue.createdSeq);
          const sliced = pageOf(items, args, 'userissue', (item) => `${item.repo.owner}/${item.repo.name}#${item.issue.number}`);
          return {
            __typename: 'IssueConnection',
            kind: 'issueListConnection',
            items: sliced.page,
            total: items.length,
            page: { hasNextPage: sliced.hasNextPage, endCursor: sliced.endCursor },
          };
        }
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'repository': {
      const repo = node.repo;
      switch (field.name) {
        case 'id':
          return repoGlobalId(repo.owner, repo.name);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return userNode(ctx.store, repo.owner);
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.private;
        case 'url':
          return `${ctx.baseUrl}/${repo.owner}/${repo.name}`;
        case 'createdAt':
        case 'updatedAt':
          return FORGE_EPOCH_ISO;
        case 'defaultBranchRef':
          return refNode(repo, repo.defaultBranch);
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'forkCount':
        case 'stargazerCount':
          return 0;
        case 'issue': {
          const number = args.number;
          if (typeof number !== 'number') throw new FieldError('issue requires a number argument');
          const issue = repo.issues.get(number);
          return issue === undefined ? null : { __typename: 'Issue', kind: 'issue', repo, issue };
        }
        case 'issues': {
          const ordered = sortedIssues(repo, args);
          const sliced = pageOf(ordered, args, 'issue', (issue) => String(issue.number));
          return {
            __typename: 'IssueConnection',
            kind: 'issueConnection',
            repo,
            issues: sliced.page,
            page: { hasNextPage: sliced.hasNextPage, endCursor: sliced.endCursor },
          };
        }
        case 'pullRequest': {
          const number = args.number;
          if (typeof number !== 'number') throw new FieldError('pullRequest requires a number argument');
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : { __typename: 'PullRequest', kind: 'pullRequest', repo, pull };
        }
        case 'pullRequests': {
          const ordered = sortedPulls(repo, args);
          const sliced = pageOf(ordered, args, 'pull', (pull) => String(pull.number));
          return {
            __typename: 'PullRequestConnection',
            kind: 'pullConnection',
            repo,
            pulls: sliced.page,
            page: { hasNextPage: sliced.hasNextPage, endCursor: sliced.endCursor },
          };
        }
        case 'labels': {
          const ordered = [...repo.labels.values()];
          const sliced = pageOf(ordered, args, 'label', (label) => label.name);
          return {
            __typename: 'LabelConnection',
            kind: 'labelConnection',
            repo,
            labels: sliced.page,
            total: ordered.length,
            page: { hasNextPage: sliced.hasNextPage, endCursor: sliced.endCursor },
          };
        }
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'issue': {
      const { repo, issue } = node;
      switch (field.name) {
        case 'id':
          return issueGlobalId(repo.owner, repo.name, issue.number);
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issueStateEnum(issue);
        case 'url':
          return `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'createdAt':
        case 'updatedAt':
          return FORGE_EPOCH_ISO;
        case 'closedAt':
          return issue.state === 'closed' ? FORGE_EPOCH_ISO : null;
        case 'author':
          return userNode(ctx.store, issue.authorLogin);
        case 'repository':
          return { __typename: 'Repository', kind: 'repository', repo };
        case 'labels': {
          const ordered: Label[] = [];
          for (const name of issue.labelNames) {
            const label = repo.labels.get(name);
            if (label !== undefined) ordered.push(label);
          }
          const sliced = pageOf(ordered, args, 'label', (label) => label.name);
          return {
            __typename: 'LabelConnection',
            kind: 'labelConnection',
            repo,
            labels: sliced.page,
            total: ordered.length,
            page: { hasNextPage: sliced.hasNextPage, endCursor: sliced.endCursor },
          };
        }
        case 'comments': {
          const sliced = pageOf(issue.comments, args, 'comment', (comment) => String(comment.id));
          return {
            __typename: 'IssueCommentConnection',
            kind: 'commentConnection',
            repo,
            issueNumber: issue.number,
            comments: sliced.page,
            total: issue.comments.length,
            page: { hasNextPage: sliced.hasNextPage, endCursor: sliced.endCursor },
          };
        }
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'pullRequest': {
      const { repo, pull } = node;
      switch (field.name) {
        case 'id':
          return pullGlobalId(repo.owner, repo.name, pull.number);
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullStateEnum(pull);
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return mergeableEnum(repo, pull);
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRef':
          return refNode(repo, pull.headRef);
        case 'baseRef':
          return refNode(repo, pull.baseRef);
        case 'mergedAt':
          return pull.mergedAt;
        case 'mergeCommit': {
          if (pull.mergeCommitSha === null) return null;
          return { __typename: 'Commit', kind: 'commit', repo, oid: pull.mergeCommitSha };
        }
        case 'files': {
          const files = pullFiles(repo, pull);
          const sliced = pageOf(files, args, 'file', (file) => file.filename);
          return {
            __typename: 'PullRequestChangedFileConnection',
            kind: 'fileConnection',
            files: sliced.page,
            page: { hasNextPage: sliced.hasNextPage, endCursor: sliced.endCursor },
          };
        }
        case 'isDraft':
          return false;
        case 'additions':
        case 'deletions':
        case 'changedFiles': {
          const files = pullFiles(repo, pull);
          if (field.name === 'additions') return files.reduce((sum, file) => sum + file.additions, 0);
          if (field.name === 'deletions') return files.reduce((sum, file) => sum + file.deletions, 0);
          return files.length;
        }
        case 'url':
          return `${ctx.baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'createdAt':
        case 'updatedAt':
          return FORGE_EPOCH_ISO;
        case 'closedAt':
          return pull.state === 'closed' ? FORGE_EPOCH_ISO : null;
        case 'author':
          return userNode(ctx.store, pull.authorLogin);
        case 'repository':
          return { __typename: 'Repository', kind: 'repository', repo };
        case 'labels':
          // Pull requests carry no labels in this store: an empty connection,
          // honestly, rather than an invented one.
          return {
            __typename: 'LabelConnection',
            kind: 'labelConnection',
            repo,
            labels: [],
            total: 0,
            page: { hasNextPage: false, endCursor: null },
          };
        case 'comments': {
          const sliced = pageOf(pull.comments, args, 'comment', (comment) => String(comment.id));
          return {
            __typename: 'IssueCommentConnection',
            kind: 'commentConnection',
            repo,
            issueNumber: pull.number,
            comments: sliced.page,
            total: pull.comments.length,
            page: { hasNextPage: sliced.hasNextPage, endCursor: sliced.endCursor },
          };
        }
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'comment': {
      const { repo, issueNumber, comment } = node;
      switch (field.name) {
        case 'id':
          return commentGlobalId(repo.owner, repo.name, issueNumber, comment.id);
        case 'databaseId':
          return comment.id;
        case 'body':
          return comment.body;
        case 'author':
          return userNode(ctx.store, comment.authorLogin);
        case 'createdAt':
        case 'updatedAt':
          return FORGE_EPOCH_ISO;
        case 'url':
          return `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`;
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'ref': {
      switch (field.name) {
        case 'id':
          return Buffer.from(`Ref:${node.repo.owner}/${node.repo.name}:${node.name}`).toString('base64');
        case 'name':
          return node.name;
        case 'target':
          return { __typename: 'Commit', kind: 'commit', repo: node.repo, oid: node.oid };
        case 'repository':
          return { __typename: 'Repository', kind: 'repository', repo: node.repo };
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'commit': {
      switch (field.name) {
        case 'id':
        case 'oid':
          return node.oid;
        case 'message':
          return commitMessage(node.repo, node.oid);
        case 'abbreviatedOid':
          return node.oid.slice(0, 7);
        case 'committedDate':
          return FORGE_EPOCH_ISO;
        case 'author':
          return userNode(ctx.store, ctx.store.viewerLogin);
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'issueConnection': {
      switch (field.name) {
        case 'nodes':
          return node.issues.map((issue) => ({ __typename: 'Issue', kind: 'issue', repo: node.repo, issue }));
        case 'totalCount':
          return node.repo.issues.size;
        case 'pageInfo':
          return { __typename: 'PageInfo', kind: 'pageInfo', page: node.page };
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'pullConnection': {
      switch (field.name) {
        case 'nodes':
          return node.pulls.map((pull) => ({ __typename: 'PullRequest', kind: 'pullRequest', repo: node.repo, pull }));
        case 'totalCount':
          return node.repo.pulls.size;
        case 'pageInfo':
          return { __typename: 'PageInfo', kind: 'pageInfo', page: node.page };
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'fileConnection': {
      switch (field.name) {
        case 'nodes':
          return node.files.map((file) => ({ __typename: 'PullRequestChangedFile', kind: 'changedFile', file }));
        case 'totalCount':
          return node.files.length;
        case 'pageInfo':
          return { __typename: 'PageInfo', kind: 'pageInfo', page: node.page };
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'changedFile': {
      switch (field.name) {
        case 'path':
          return node.file.filename;
        case 'additions':
          return node.file.additions;
        case 'deletions':
          return node.file.deletions;
        case 'changeType':
          return node.file.status === 'added' ? 'ADDED' : node.file.status === 'removed' ? 'DELETED' : 'MODIFIED';
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'label': {
      switch (field.name) {
        case 'id':
          return Buffer.from(`Label:${node.repo.owner}/${node.repo.name}:${node.label.name}`).toString('base64');
        case 'databaseId':
          return node.label.id;
        case 'name':
          return node.label.name;
        case 'color':
          return node.label.color;
        case 'description':
          return node.label.description === '' ? null : node.label.description;
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'labelConnection': {
      switch (field.name) {
        case 'nodes':
          return node.labels.map((label) => ({ __typename: 'Label', kind: 'label', repo: node.repo, label }));
        case 'totalCount':
          return node.total;
        case 'pageInfo':
          return { __typename: 'PageInfo', kind: 'pageInfo', page: node.page };
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'commentConnection': {
      switch (field.name) {
        case 'nodes':
          return node.comments.map((comment) => ({
            __typename: 'IssueComment',
            kind: 'comment',
            repo: node.repo,
            issueNumber: node.issueNumber,
            comment,
          }));
        case 'totalCount':
          return node.total;
        case 'pageInfo':
          return { __typename: 'PageInfo', kind: 'pageInfo', page: node.page };
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'repoConnection': {
      switch (field.name) {
        case 'nodes':
          return node.repos.map((repo) => ({ __typename: 'Repository', kind: 'repository', repo }));
        case 'totalCount':
          return node.total;
        case 'pageInfo':
          return { __typename: 'PageInfo', kind: 'pageInfo', page: node.page };
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'issueListConnection': {
      switch (field.name) {
        case 'nodes':
          return node.items.map((item) => ({ __typename: 'Issue', kind: 'issue', repo: item.repo, issue: item.issue }));
        case 'totalCount':
          return node.total;
        case 'pageInfo':
          return { __typename: 'PageInfo', kind: 'pageInfo', page: node.page };
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'searchConnection': {
      switch (field.name) {
        case 'nodes':
          return node.items;
        case 'totalCount':
          return node.total;
        case 'pageInfo':
          return { __typename: 'PageInfo', kind: 'pageInfo', page: node.page };
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'rateLimit': {
      switch (field.name) {
        case 'limit':
          return 5000;
        case 'cost':
          return 1;
        case 'remaining':
          return 5000;
        case 'resetAt':
          return new Date((FORGE_EPOCH_SEC + 3600) * 1000).toISOString();
        case 'nodeCount':
          return 0;
        case 'used':
          return 0;
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'pageInfo': {
      switch (field.name) {
        case 'hasNextPage':
          return node.page.hasNextPage;
        case 'hasPreviousPage':
          return false;
        case 'endCursor':
          return node.page.endCursor;
        case 'startCursor':
          return null;
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'gqlType': {
      const info = TYPE_TABLE[node.name];
      switch (field.name) {
        case 'name':
          return node.name;
        case 'kind':
          return info?.kind ?? 'OBJECT';
        case 'description':
          return null;
        case 'fields':
          return (info?.fields ?? []).map((name) => ({ __typename: '__Field', kind: 'gqlField', name }));
        case 'enumValues':
          return (info?.enumValues ?? []).map((name) => ({ __typename: '__EnumValue', kind: 'gqlEnumValue', name }));
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'gqlField': {
      switch (field.name) {
        case 'name':
          return node.name;
        case 'description':
          return null;
        case 'isDeprecated':
          return false;
        case 'deprecationReason':
          return null;
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'gqlEnumValue': {
      switch (field.name) {
        case 'name':
          return node.name;
        case 'description':
          return null;
        case 'isDeprecated':
          return false;
        case 'deprecationReason':
          return null;
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'commentEdge': {
      switch (field.name) {
        case 'node':
          return { __typename: 'IssueComment', kind: 'comment', repo: node.repo, issueNumber: node.issueNumber, comment: node.comment };
        case 'cursor':
          return encodeCursor('comment', String(node.comment.id));
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'createIssuePayload':
    case 'closeIssuePayload': {
      switch (field.name) {
        case 'issue':
          return { __typename: 'Issue', kind: 'issue', repo: node.repo, issue: node.issue };
        case 'clientMutationId':
          return node.clientMutationId;
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'createPullRequestPayload': {
      switch (field.name) {
        case 'pullRequest':
          return { __typename: 'PullRequest', kind: 'pullRequest', repo: node.repo, pull: node.pull };
        case 'clientMutationId':
          return node.clientMutationId;
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'mergePullRequestPayload': {
      switch (field.name) {
        case 'pullRequest':
          return { __typename: 'PullRequest', kind: 'pullRequest', repo: node.repo, pull: node.pull };
        case 'merged':
          return node.merged;
        case 'clientMutationId':
          return node.clientMutationId;
        default:
          throw unknownField(node, field.name);
      }
    }
    case 'addCommentPayload': {
      switch (field.name) {
        case 'commentEdge':
          return { __typename: 'IssueCommentEdge', kind: 'commentEdge', repo: node.repo, issueNumber: node.issueNumber, comment: node.comment };
        case 'comment':
          return { __typename: 'IssueComment', kind: 'comment', repo: node.repo, issueNumber: node.issueNumber, comment: node.comment };
        case 'subject':
          return nodeByGlobalId(ctx.store, issueGlobalId(node.repo.owner, node.repo.name, node.issueNumber)) ??
            nodeByGlobalId(ctx.store, pullGlobalId(node.repo.owner, node.repo.name, node.issueNumber));
        case 'clientMutationId':
          return node.clientMutationId;
        default:
          throw unknownField(node, field.name);
      }
    }
  }
}

/** Substring search over the store: issues/pull requests, repositories, or users. */
function searchItems(store: ForgeStore, query: string, type: string): GqlNode[] {
  const needle = query.toLowerCase();
  if (needle === '') return [];
  const items: GqlNode[] = [];
  if (type === 'REPOSITORY') {
    for (const repo of store.allRepos()) {
      if (repo.name.toLowerCase().includes(needle) || repo.description.toLowerCase().includes(needle)) {
        items.push({ __typename: 'Repository', kind: 'repository', repo });
      }
    }
    return items;
  }
  if (type === 'USER') {
    const logins = new Set<string>([store.viewerLogin]);
    for (const repo of store.allRepos()) {
      logins.add(repo.owner);
      for (const issue of repo.issues.values()) logins.add(issue.authorLogin);
      for (const pull of repo.pulls.values()) logins.add(pull.authorLogin);
    }
    for (const login of logins) {
      if (login.toLowerCase().includes(needle)) items.push(userNode(store, login));
    }
    return items;
  }
  // ISSUE: issues and pull requests by title or body, like GitHub's search.
  for (const repo of store.allRepos()) {
    for (const issue of repo.issues.values()) {
      if (issue.title.toLowerCase().includes(needle) || issue.body.toLowerCase().includes(needle)) {
        items.push({ __typename: 'Issue', kind: 'issue', repo, issue });
      }
    }
    for (const pull of repo.pulls.values()) {
      if (pull.title.toLowerCase().includes(needle) || pull.body.toLowerCase().includes(needle)) {
        items.push({ __typename: 'PullRequest', kind: 'pullRequest', repo, pull });
      }
    }
  }
  return items;
}

function resolveRootQuery(ctx: ExecContext, field: FieldNode, args: Record<string, unknown>): unknown {
  switch (field.name) {
    case 'viewer':
      return userNode(ctx.store, ctx.store.viewerLogin);
    case 'repository': {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') {
        throw new FieldError('repository requires owner and name arguments');
      }
      return repoNodeOf(ctx.store, owner, name);
    }
    case 'node':
      return nodeByGlobalId(ctx.store, args.id);
    case 'search': {
      const query = args.query;
      if (typeof query !== 'string') throw new FieldError('search requires a query argument');
      const type = typeof args.type === 'string' ? args.type : 'ISSUE';
      const found = searchItems(ctx.store, query, type);
      const entries = found.map((node, index) => ({ key: String(index), node }));
      const sliced = pageOf(entries, args, 'search', (entry) => entry.key);
      return {
        __typename: 'SearchResultItemConnection',
        kind: 'searchConnection',
        items: sliced.page.map((entry) => entry.node),
        total: found.length,
        page: { hasNextPage: sliced.hasNextPage, endCursor: sliced.endCursor },
      };
    }
    case 'rateLimit':
      return { __typename: 'RateLimit', kind: 'rateLimit' };
    case '__type': {
      const name = args.name;
      if (typeof name !== 'string') throw new FieldError('__type requires a name argument');
      if (TYPE_TABLE[name] === undefined) return null;
      return { __typename: '__Type', kind: 'gqlType', name };
    }
    default:
      throw new FieldError(`Cannot query field "${field.name}" on type "Query".`);
  }
}

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new FieldError('the mutation requires an input object');
  }
  return input as Record<string, unknown>;
}

function clientMutationIdOf(input: Record<string, unknown>): string | null {
  return typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
}

function repoFromGlobalId(ctx: ExecContext, id: unknown): RepoState {
  if (typeof id !== 'string') throw new FieldError('a repository id is required');
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository' || decoded.owner !== ctx.store.viewerLogin) {
    throw new FieldError('no repository matches the given id');
  }
  const repo = ctx.store.getRepo(decoded.owner, decoded.name);
  if (repo === undefined) throw new FieldError('no repository matches the given id');
  return repo;
}

function resolveRootMutation(ctx: ExecContext, field: FieldNode, args: Record<string, unknown>): unknown {
  switch (field.name) {
    case 'createIssue': {
      const input = inputOf(args);
      const repo = repoFromGlobalId(ctx, input.repositoryId);
      const title = input.title;
      if (typeof title !== 'string' || title === '') throw new FieldError('title is required');
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = ctx.store.createIssue(repo, title, body, []);
      return {
        __typename: 'CreateIssuePayload',
        kind: 'createIssuePayload',
        repo,
        issue,
        clientMutationId: clientMutationIdOf(input),
      };
    }
    case 'closeIssue': {
      const input = inputOf(args);
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      if (decoded === null || decoded.kind !== 'Issue' || decoded.owner !== ctx.store.viewerLogin) {
        throw new FieldError('no issue matches the given id');
      }
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      const issue = repo?.issues.get(decoded.number!);
      if (repo === undefined || issue === undefined) throw new FieldError('no issue matches the given id');
      issue.state = 'closed';
      issue.updatedSeq = ctx.store.nextSeq();
      return {
        __typename: 'CloseIssuePayload',
        kind: 'closeIssuePayload',
        repo,
        issue,
        clientMutationId: clientMutationIdOf(input),
      };
    }
    case 'createPullRequest': {
      const input = inputOf(args);
      const repo = repoFromGlobalId(ctx, input.repositoryId);
      const title = input.title;
      if (typeof title !== 'string' || title === '') throw new FieldError('title is required');
      const head = input.headRefName;
      const base = input.baseRefName;
      if (typeof head !== 'string' || typeof base !== 'string') {
        throw new FieldError('headRefName and baseRefName are required');
      }
      const headTip = branchTip(repo, head);
      const baseTip = branchTip(repo, base);
      if (headTip === null) throw new FieldError(`head branch does not exist: ${head}`);
      if (baseTip === null) throw new FieldError(`base branch does not exist: ${base}`);
      if (head === base) throw new FieldError('head and base name the same branch');
      if (headTip === baseTip) throw new FieldError('No commits between the head and the base');
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          throw new FieldError('A pull request already exists for these branches');
        }
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const pull = ctx.store.createPullRequest(repo, title, body, head, base, headTip, baseTip);
      return {
        __typename: 'CreatePullRequestPayload',
        kind: 'createPullRequestPayload',
        repo,
        pull,
        clientMutationId: clientMutationIdOf(input),
      };
    }
    case 'mergePullRequest': {
      const input = inputOf(args);
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      if (decoded === null || decoded.kind !== 'PullRequest' || decoded.owner !== ctx.store.viewerLogin) {
        throw new FieldError('no pull request matches the given id');
      }
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      const pull = repo?.pulls.get(decoded.number!);
      if (repo === undefined || pull === undefined) throw new FieldError('no pull request matches the given id');
      const methodRaw = String(input.mergeMethod ?? 'MERGE').toUpperCase();
      if (methodRaw !== 'SQUASH' && methodRaw !== 'MERGE') {
        throw new FieldError(`mergeMethod ${methodRaw} is not supported`);
      }
      const method: MergeMethod = methodRaw === 'SQUASH' ? 'squash' : 'merge';
      const title = typeof input.commitHeadline === 'string' ? input.commitHeadline : undefined;
      const attempt = attemptMerge(ctx.store, repo, pull, method, title);
      if (!attempt.ok) {
        if (attempt.reason === 'conflict') throw new FieldError(`Pull Request is not mergeable: conflicting files: ${attempt.conflicts.join(', ')}`);
        throw new FieldError('Pull Request is not mergeable');
      }
      return {
        __typename: 'MergePullRequestPayload',
        kind: 'mergePullRequestPayload',
        repo,
        pull,
        merged: true,
        clientMutationId: clientMutationIdOf(input),
      };
    }
    case 'addComment': {
      const input = inputOf(args);
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      if (
        decoded === null ||
        (decoded.kind !== 'Issue' && decoded.kind !== 'PullRequest') ||
        decoded.owner !== ctx.store.viewerLogin
      ) {
        throw new FieldError('no subject matches the given id');
      }
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      const target = decoded.kind === 'Issue' ? repo?.issues.get(decoded.number!) : repo?.pulls.get(decoded.number!);
      if (repo === undefined || target === undefined) throw new FieldError('no subject matches the given id');
      const body = input.body;
      if (typeof body !== 'string' || body === '') throw new FieldError('body is required');
      const comment = ctx.store.addComment(target, body);
      return {
        __typename: 'AddCommentPayload',
        kind: 'addCommentPayload',
        repo,
        issueNumber: decoded.number!,
        comment,
        clientMutationId: clientMutationIdOf(input),
      };
    }
    default:
      throw new FieldError(`Cannot query field "${field.name}" on type "Mutation".`);
  }
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

function isNodeValue(value: unknown): value is GqlNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__typename' in value &&
    'kind' in value &&
    typeof (value as GqlNode).__typename === 'string'
  );
}

function executeSelections(
  ctx: ExecContext,
  selections: SelectionNode[],
  node: GqlNode,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== node.__typename) continue;
      Object.assign(out, executeSelections(ctx, selection.selections, node, path));
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".`, path: [...path] });
        continue;
      }
      if (fragment.typeCondition !== node.__typename) continue;
      Object.assign(out, executeSelections(ctx, fragment.selections, node, path));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const fieldPath = [...path, key];
    let value: unknown;
    try {
      value = resolveField(ctx, node, selection);
    } catch (error) {
      if (error instanceof FieldError) {
        ctx.errors.push({ message: error.message, path: fieldPath });
        out[key] = null;
        continue;
      }
      throw error;
    }
    if (selection.selections.length === 0) {
      out[key] = isNodeValue(value) ? null : value;
      continue;
    }
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item, index) =>
        isNodeValue(item) ? executeSelections(ctx, selection.selections, item, [...fieldPath, index]) : item,
      );
      continue;
    }
    if (isNodeValue(value)) {
      out[key] = executeSelections(ctx, selection.selections, value, fieldPath);
      continue;
    }
    ctx.errors.push({ message: `Field "${selection.name}" must not have a selection set.`, path: fieldPath });
    out[key] = null;
  }
  return out;
}

interface OperationRequest {
  readonly query?: unknown;
  readonly variables?: unknown;
  readonly operationName?: unknown;
}

function executeOperation(request: OperationRequest, store: ForgeStore, baseUrl: string): Record<string, unknown> {
  const query = request.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'a query string is required' }] };
  }
  let definitions: Array<OperationNode | FragmentNode>;
  try {
    definitions = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'the query could not be parsed';
    return { data: null, errors: [{ message }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  const operationName = typeof request.operationName === 'string' ? request.operationName : undefined;
  let operation: OperationNode | undefined = operations[0];
  if (operationName !== undefined) {
    operation = operations.find((candidate) => candidate.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  }
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'the document has no operation' }] };
  }
  const variables: Variables =
    typeof request.variables === 'object' && request.variables !== null && !Array.isArray(request.variables)
      ? { ...(request.variables as Variables) }
      : {};
  for (const definition of operation.variables) {
    if (variables[definition.name] === undefined && definition.defaultValue !== undefined) {
      variables[definition.name] = resolveValueNode(definition.defaultValue, variables);
    }
  }
  const ctx: ExecContext = { store, baseUrl, variables, fragments, errors: [] };
  const root: GqlNode = {
    __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query',
    kind: 'root',
    operation: operation.operation === 'mutation' ? 'mutation' : 'query',
  };
  let data: Record<string, unknown>;
  try {
    data = executeSelections(ctx, operation.selections, root, []);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'the query could not be executed';
    return { data: null, errors: [{ message }] };
  }
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export interface GraphqlContext {
  readonly store: ForgeStore;
  readonly baseUrl: string;
  readonly rawBody: Buffer;
}

export function handleGraphql(ctx: GraphqlContext): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.rawBody.toString('utf8')) as unknown;
  } catch {
    return { status: 400, body: { errors: [{ message: 'the request body is not valid JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return {
      status: 200,
      body: parsed.map((entry) =>
        typeof entry === 'object' && entry !== null
          ? executeOperation(entry as OperationRequest, ctx.store, ctx.baseUrl)
          : { data: null, errors: [{ message: 'each batch entry must be an object' }] },
      ),
    };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: { errors: [{ message: 'the request body must be a JSON object' }] } };
  }
  return { status: 200, body: executeOperation(parsed as OperationRequest, ctx.store, ctx.baseUrl) };
}
