/**
 * Git smart HTTP: the wire the suite's git client and real git speak.
 *
 *   GET  /<owner>/<repo>.git/info/refs?service=<service>
 *        the ref/capability advertisement: protocol v2 when the request asks
 *        for it (upload-pack), v0 otherwise (receive-pack is v0 only).
 *   POST /<owner>/<repo>.git/git-upload-pack
 *        ls-refs and fetch, protocol v2 (a `command=` first packet) or v0
 *        (want/have lines), shallow and deepen included.
 *   POST /<owner>/<repo>.git/git-receive-pack
 *        pushes: a command list plus a packfile, answered with a per-ref
 *        report-status stream. Every update must fast-forward.
 *
 * A missing repository is 404 on every git route, and the server stays up.
 */

import {
  ZERO_OID,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  peelToNonTag,
  planFetch,
  readPack,
  writePack,
  PackError,
  type GitObject,
} from './git-objects.ts';
import {
  PKT_LINE_MAX_PAYLOAD,
  decodePktLines,
  pktDelim,
  pktFlush,
  pktLine,
  pktLines,
  type PktPacket,
} from './pktline.ts';
import { DEFAULT_BRANCH, type ForgeStore, type RepoState } from './store.ts';

/** The agent string this forge advertises. */
export const FORGE_AGENT = 'forge/1.0';

/** One git reply: an HTTP status, a content type and the body bytes. */
export interface GitReply {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

function jsonReply(status: number, message: string): GitReply {
  return {
    status,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ message }), 'utf8'),
  };
}

function gitReply(contentType: string, body: Buffer): GitReply {
  return { status: 200, contentType, body };
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

/** The refs of a repository, sorted by name, with peeled ids for annotated tags. */
function advertisedRefs(repo: RepoState): Array<{ oid: string; name: string; peeled?: string }> {
  const names = [...repo.refs.keys()].sort();
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const peeled = peelToNonTag(oid, (id) => repo.objects.get(id));
      out.push(peeled === oid ? { oid, name } : { oid, name, peeled });
    } else {
      out.push({ oid, name });
    }
  }
  return out;
}

/** The protocol v2 capability advertisement: `version 2` plus capability lines. */
function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    `agent=${FORGE_AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/**
 * A protocol v0 advertisement: the `# service=...` preamble, a flush, the ref
 * lines (the first carrying the capabilities after a NUL), and a flush. An
 * empty repository advertises the `capabilities^{}` pseudo-ref.
 */
function v0Advertisement(repo: RepoState, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const capabilities =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow multi_ack multi_ack_detailed no-progress include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want symref=HEAD:refs/heads/${DEFAULT_BRANCH} agent=${FORGE_AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${FORGE_AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`));
  } else {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
    parts.push(pktLine(`${headTip} HEAD\u0000${capabilities}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Answer GET /info/refs for a service. */
export function handleInfoRefs(
  store: ForgeStore,
  owner: string,
  repoName: string,
  service: string | null,
  gitProtocol: string | null,
): GitReply {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return jsonReply(404, 'Repository not found');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return jsonReply(400, 'a service parameter naming git-upload-pack or git-receive-pack is required');
  }
  const wantsV2 = service === 'git-upload-pack' && gitProtocol !== null && gitProtocol.includes('version=2');
  if (wantsV2) {
    return gitReply('application/x-git-upload-pack-advertisement', v2Advertisement());
  }
  return gitReply(`application/x-${service}-advertisement`, v0Advertisement(repo, service));
}

// ---------------------------------------------------------------------------------------------
// sideband framing
// ---------------------------------------------------------------------------------------------

/** Wrap bytes in sideband packets of one band, chunked under the pkt-line limit. */
function sideband(band: 1 | 2, data: Buffer): Buffer[] {
  const chunkSize = PKT_LINE_MAX_PAYLOAD - 1;
  const out: Buffer[] = [];
  if (data.length === 0) {
    out.push(pktLine(Buffer.from([band])));
    return out;
  }
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, offset + chunkSize);
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: readonly string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

function lsRefsReply(repo: RepoState, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const includeHead = args.prefixes.length === 0 || args.prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (includeHead) {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const symref = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    if (headTip !== undefined) lines.push(`${headTip} HEAD${symref}\n`);
    else if (args.unborn) lines.push(`unborn HEAD${symref}\n`);
  }
  for (const ref of advertisedRefs(repo)) {
    if (args.prefixes.length > 0 && !args.prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  const parts = lines.map((line) => pktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// fetch (protocols v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallows: string[];
  depth: number | null;
  /** The client sent `deepen-relative`: `depth` extends the current boundary. */
  deepenRelative: boolean;
  /** `deepen-since` cutoff (unix seconds), or null when absent. */
  deepenSince: number | null;
  /** `deepen-not` ref names, resolved to oids by the reply functions. */
  deepenNot: string[];
  /** The client sent `done`: negotiation is over, the pack may follow. */
  done: boolean;
  /** The client asked for tags pointing at the delivered commits. */
  includeTag: boolean;
}

function parseV2FetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallows: [], depth: null, deepenRelative: false, deepenSince: null, deepenNot: [], done: false, includeTag: false };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isObjectId(oid)) args.shallows.push(oid);
    } else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isInteger(depth) && depth >= 0) args.depth = depth;
    } else if (line === 'deepen-relative') {
      args.deepenRelative = true;
    } else if (line.startsWith('deepen-since ')) {
      const since = Number.parseInt(line.slice(13).trim(), 10);
      if (Number.isInteger(since) && since >= 0) args.deepenSince = since;
    } else if (line.startsWith('deepen-not ')) {
      const ref = line.slice(11).trim();
      if (ref !== '') args.deepenNot.push(ref);
    } else if (line === 'done') {
      args.done = true;
    } else if (line === 'include-tag') {
      args.includeTag = true;
    }
  }
  return args;
}

function parseV0FetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallows: [], depth: null, deepenRelative: false, deepenSince: null, deepenNot: [], done: false, includeTag: false };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0]!;
      if (isObjectId(oid)) args.wants.push(oid);
      if (line.includes('include-tag')) args.includeTag = true;
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isObjectId(oid)) args.shallows.push(oid);
    } else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isInteger(depth) && depth >= 0) args.depth = depth;
    } else if (line === 'deepen-relative') {
      args.deepenRelative = true;
    } else if (line.startsWith('deepen-since ')) {
      const since = Number.parseInt(line.slice(13).trim(), 10);
      if (Number.isInteger(since) && since >= 0) args.deepenSince = since;
    } else if (line.startsWith('deepen-not ')) {
      const ref = line.slice(11).trim();
      if (ref !== '') args.deepenNot.push(ref);
    } else if (line === 'done') {
      args.done = true;
    }
  }
  return args;
}

/**
 * Resolve a revision expression the way upload-pack does for `deepen-not`:
 * a ref name or oid, optionally followed by `~N` (N first-parent steps) and
 * `^N` (the Nth parent, one step) suffixes, chained. Tags are peeled to
 * commits before traversal. Unresolvable expressions yield undefined.
 */
function resolveRevToOid(repo: RepoState, rev: string): string | undefined {
  const suffixes: Array<{ op: '~' | '^'; n: number }> = [];
  let base = rev;
  for (;;) {
    const match = /([~^])(\d*)$/.exec(base);
    if (match === null) break;
    suffixes.unshift({ op: match[1] as '~' | '^', n: match[2] === '' ? 1 : Number.parseInt(match[2]!, 10) });
    base = base.slice(0, match.index);
  }
  let current: string | undefined;
  if (isObjectId(base)) current = base;
  else {
    current =
      repo.refs.get(base) ?? repo.refs.get(`refs/heads/${base}`) ?? repo.refs.get(`refs/tags/${base}`);
  }
  if (current === undefined) return undefined;
  current = peelToNonTag(current, (oid) => repo.objects.get(oid));
  for (const { op, n } of suffixes) {
    if (op === '~') {
      for (let step = 0; step < n; step += 1) {
        const object = repo.objects.get(current);
        if (!object || object.type !== 'commit') return undefined;
        const parents = parseCommit(object.data).parents;
        if (parents.length === 0) return undefined;
        current = parents[0]!;
      }
    } else if (n > 0) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'commit') return undefined;
      const parents = parseCommit(object.data).parents;
      if (parents.length < n) return undefined;
      current = parents[n - 1]!;
    }
    // `^0` and `~0` are no-ops (the commit itself, already peeled).
  }
  return current;
}

/** Resolve `deepen-not` ref names to the oids planFetch excludes. */
function resolveExcludeOids(repo: RepoState, refs: readonly string[]): string[] {
  const oids: string[] = [];
  for (const ref of refs) {
    const oid = resolveRevToOid(repo, ref);
    if (oid !== undefined) oids.push(oid);
  }
  return oids;
}

/** The acknowledgment lines for a fetch: ACK for each held have, else NAK. */
function acknowledgments(repo: RepoState, haves: readonly string[]): string[] {
  const acks: string[] = [];
  for (const have of haves) {
    if (repo.objects.has(have)) acks.push(`ACK ${have}\n`);
  }
  return acks.length > 0 ? acks : ['NAK\n'];
}

/** Tag objects pointing at delivered objects, for `include-tag` requests. */
function withIncludedTags(repo: RepoState, objects: readonly GitObject[]): GitObject[] {
  const delivered = new Set<string>();
  for (const object of objects) delivered.add(hashObject(object.type, object.data));
  const extra: GitObject[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const [ref, oid] of repo.refs) {
      if (!ref.startsWith('refs/tags/') || delivered.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tag') continue;
      if (!delivered.has(parseTag(object.data).object)) continue;
      delivered.add(oid);
      extra.push(object);
      grew = true;
    }
  }
  return [...objects, ...extra];
}

function fetchV2Reply(repo: RepoState, args: FetchArgs): Buffer {
  const plan = planFetch(
    (oid) => repo.objects.get(oid),
    args.wants,
    args.haves,
    args.shallows,
    args.depth,
    args.deepenRelative,
    { deepenSince: args.deepenSince, excludeOids: resolveExcludeOids(repo, args.deepenNot) },
  );
  const parts: Buffer[] = [];
  if (args.haves.length > 0 && !args.done) {
    // A negotiation round: the acknowledgments section alone, ending with
    // FLUSH. The client returns with more haves or `done`. (Ending this
    // section with a DELIM would be a protocol error: git's fetch-pack
    // expects FLUSH when no `ready` was sent, and dies otherwise.)
    parts.push(pktLine('acknowledgments\n'));
    for (const line of acknowledgments(repo, args.haves)) parts.push(pktLine(line));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  // `done` was sent (or no haves at all): the client skips acknowledgment
  // processing entirely and expects the shallow-info section, if any, then
  // the packfile section. No acknowledgments section is sent here.
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  const objects = args.includeTag ? withIncludedTags(repo, plan.objects) : plan.objects;
  const pack = writePack(objects);
  for (const packet of sideband(1, pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchV0Reply(repo: RepoState, args: FetchArgs): Buffer {
  const plan = planFetch(
    (oid) => repo.objects.get(oid),
    args.wants,
    args.haves,
    args.shallows,
    args.depth,
    args.deepenRelative,
    { deepenSince: args.deepenSince, excludeOids: resolveExcludeOids(repo, args.deepenNot) },
  );
  const parts: Buffer[] = [];
  const shallowSection = args.depth !== null || args.shallows.length > 0;
  if (!args.done && args.haves.length === 0 && shallowSection) {
    // A wants-only deepen request: the pre-negotiation shallow list alone.
    // The client reads it, then returns with haves and `done`.
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  if (shallowSection) {
    // The shallow list precedes the acknowledgments, terminated by a flush:
    // a stateless client reads exactly this before the ACK phase.
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  // multi_ack_detailed acknowledgments, as a real server sends them: one
  // `ACK <oid> common` per held have, then a final plain ACK that ends the
  // negotiation; a lone NAK when nothing is held.
  const held = args.haves.filter((have) => repo.objects.has(have));
  if (held.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const oid of held) parts.push(pktLine(`ACK ${oid} common\n`));
    parts.push(pktLine(`ACK ${held[held.length - 1]}\n`));
  }
  const objects = args.includeTag ? withIncludedTags(repo, plan.objects) : plan.objects;
  const pack = writePack(objects);
  for (const packet of sideband(1, pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The argument lines of a v2 request: the data lines after the delim packet. */
function v2ArgumentLines(packets: readonly PktPacket[]): string[] {
  const lines: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    if (pastDelim) lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

/** Answer POST /git-upload-pack: ls-refs or fetch, v2 or v0 by request shape. */
export function handleUploadPack(store: ForgeStore, owner: string, repoName: string, body: Buffer): GitReply {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return jsonReply(404, 'Repository not found');
  let packets: PktPacket[];
  try {
    packets = decodePktLines(body).packets;
  } catch {
    return jsonReply(400, 'the request body is not a pkt-line stream');
  }
  const first = packets.find((packet) => packet.kind === 'data');
  const firstLine = first && first.kind === 'data' ? first.payload.toString('utf8') : '';
  const contentType = 'application/x-git-upload-pack-result';
  if (firstLine.startsWith('command=')) {
    const command = firstLine.slice('command='.length).replace(/\n$/, '').trim();
    const args = v2ArgumentLines(packets);
    if (command === 'ls-refs') {
      return gitReply(contentType, lsRefsReply(repo, parseLsRefsArgs(args)));
    }
    if (command === 'fetch') {
      return gitReply(contentType, fetchV2Reply(repo, parseV2FetchArgs(args)));
    }
    return gitReply(contentType, pktLines([`ERR unknown command ${command}\n`, 'flush']));
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return gitReply(contentType, fetchV0Reply(repo, parseV0FetchArgs(lines)));
}

// ---------------------------------------------------------------------------------------------
// receive-pack (protocol v0)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

interface PushOutcome {
  readonly ref: string;
  readonly ok: boolean;
  readonly reason: string;
}

function parsePushCommands(packets: readonly PktPacket[]): { commands: PushCommand[]; sideband: boolean } | null {
  const commands: PushCommand[] = [];
  let sideband = false;
  let seenFirst = false;
  let seenData = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    seenData = true;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    const commandText = nul >= 0 ? text.slice(0, nul) : text;
    const capsText = nul >= 0 ? text.slice(nul + 1) : '';
    if (!seenFirst && capsText !== '') {
      seenFirst = true;
      for (const token of capsText.split(' ')) {
        if (token === 'side-band-64k') sideband = true;
      }
    }
    const parts = commandText.split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || ref === '') return null;
    commands.push({ oldOid, newOid, ref });
  }
  // An empty command list with no data packets at all is git's chunked-push
  // probe: answer `unpack ok` with no ref lines, exactly like receive-pack
  // does for a no-op update. Data packets that parse to nothing are malformed.
  if (commands.length === 0 && seenData) return null;
  return { commands, sideband };
}

/** Apply one push command; the ref moves only when the update is legal. */
function applyPushCommand(repo: RepoState, command: PushCommand): PushOutcome {
  const { oldOid, newOid, ref } = command;
  const fail = (reason: string): PushOutcome => ({ ref, ok: false, reason });
  if (!ref.startsWith('refs/') || /[\s\u0000-\u001f]/.test(ref) || ref.includes('..')) {
    return fail('invalid ref name');
  }
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (oldOid !== current) return fail('old oid does not match the ref');
  if (newOid === ZERO_OID) {
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }
  const target = repo.objects.get(newOid);
  if (target === undefined) return fail('the new object is not in the repository');
  if (oldOid === ZERO_OID) {
    repo.refs.set(ref, newOid);
    return { ref, ok: true, reason: '' };
  }
  if (newOid === oldOid) return { ref, ok: true, reason: '' };
  if (target.type === 'commit' && isAncestor(oldOid, newOid, (oid) => repo.objects.get(oid))) {
    repo.refs.set(ref, newOid);
    return { ref, ok: true, reason: '' };
  }
  return fail('non-fast-forward');
}

/** Answer POST /git-receive-pack: unpack the pack, apply the commands, report per ref. */
export function handleReceivePack(store: ForgeStore, owner: string, repoName: string, body: Buffer): GitReply {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return jsonReply(404, 'Repository not found');
  const contentType = 'application/x-git-receive-pack-result';
  let decoded: { packets: PktPacket[]; consumed: number };
  try {
    decoded = decodePktLines(body, { allowTrailing: true });
  } catch {
    return jsonReply(400, 'the request body is not a pkt-line stream');
  }
  const parsed = parsePushCommands(decoded.packets);
  if (parsed === null) return jsonReply(400, 'the push command list does not parse');
  const { commands, sideband: useSideband } = parsed;
  const packBytes = body.subarray(decoded.consumed);

  const report = (unpackLine: string, outcomes: readonly PushOutcome[]): Buffer => {
    const inner: Buffer[] = [pktLine(unpackLine)];
    for (const outcome of outcomes) {
      inner.push(pktLine(outcome.ok ? `ok ${outcome.ref}\n` : `ng ${outcome.ref} ${outcome.reason}\n`));
    }
    inner.push(pktFlush());
    const stream = Buffer.concat(inner);
    if (!useSideband) return stream;
    return Buffer.concat([...sideband(1, stream), pktFlush()]);
  };

  let unpacked: Map<string, GitObject> | null = null;
  if (packBytes.length > 0) {
    try {
      unpacked = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) }).objects;
    } catch (err) {
      const detail = err instanceof PackError ? err.message : 'pack parse failed';
      return gitReply(contentType, report(`unpack ${detail}\n`, []));
    }
  }
  if (unpacked !== null) {
    for (const [oid, object] of unpacked) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  const outcomes = commands.map((command) => applyPushCommand(repo, command));
  return gitReply(contentType, report('unpack ok\n', outcomes));
}
