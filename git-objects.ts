/**
 * The git object model: hashing, commit/tree/tag parsing and building,
 * packfile reading (with OFS_DELTA/REF_DELTA resolution, including thin packs)
 * and writing, reachability, fetch planning (haves, shallow, deepen),
 * merge-base, tree diffs and three-way merges.
 *
 * Everything here is pure computation over an object lookup; the store in
 * store.ts owns the maps. No I/O, no clock, no randomness.
 */

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The four object types git stores. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** A git object: its type and its exact byte content (no header). */
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** The all-zero object id: an unborn branch's old/new value. */
export const ZERO_OID = '0'.repeat(40);

/** The object id of the empty tree. */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const HEX40 = /^[0-9a-f]{40}$/;

/** True for a lowercase 40-hex object id. */
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** A lookup from object id to object. */
export type ObjectLookup = (oid: string) => GitObject | undefined;

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The loose-object header `<type> <size>\0` that prefixes the hashed bytes. */
export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

/** A parsed tree entry. `mode` is git's ASCII mode (`100644`, `40000`, `160000`, ...). */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new Error(`tree entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------------------------

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse a commit object; refuses a malformed header layout. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  for (const parent of parents) {
    if (!isObjectId(parent)) throw new Error('commit has a bad parent id');
  }
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** A parsed ident line: `Name <email> 1700000000 +0000`. */
export interface IdentView {
  readonly name: string;
  readonly email: string;
  readonly timestamp: number;
  readonly timezone: string;
}

const IDENT_PATTERN = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/;

/** Parse an author/committer/tagger line, or null when it does not parse. */
export function parseIdent(line: string): IdentView | null {
  const match = IDENT_PATTERN.exec(line);
  if (match === null) return null;
  return {
    name: match[1] ?? '',
    email: match[2] ?? '',
    timestamp: Number(match[3]),
    timezone: match[4] ?? '+0000',
  };
}

/** Format an ident line from its parts. */
export function formatIdent(name: string, email: string, timestamp: number, timezone = '+0000'): string {
  return `${name} <${email}> ${timestamp} ${timezone}`;
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author: string;
  readonly committer: string;
}

/** Build a commit object's bytes from complete author/committer ident lines. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  if (!isObjectId(fields.tree)) throw new Error('buildCommit needs a valid tree id');
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new Error('buildCommit needs valid parent ids');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger: string;
}): Buffer {
  if (!isObjectId(fields.object)) throw new Error('buildTag needs a valid object id');
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/**
 * Every object reachable from `roots`: commit → tree + parents, tree → entries
 * (gitlinks skipped), tag → its target, blob → nothing. Throws on a missing
 * object unless `allowMissing` is set.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Every commit reachable from `root` by following parents (the root included). */
export function collectAncestors(root: string, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` by following parents (or equal to it). */
export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** Peel a tag (repeatedly) to the first non-tag object it names, or the oid itself. */
export function peelToNonTag(oid: string, lookup: ObjectLookup): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const object = lookup(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
}

/**
 * The merge base of two commits: the common ancestor closest to `b` (a
 * breadth-first walk from `b` over the ancestor set of `a`). Null when the
 * histories share nothing.
 */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const ancestorsOfA = collectAncestors(a, lookup);
  if (ancestorsOfA.size === 0) return null;
  const seen = new Set<string>();
  const queue = [b];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++]!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// packfile reading
// ---------------------------------------------------------------------------------------------

/** A packfile that failed to parse. */
export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackError';
  }
}

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new PackError('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new PackError('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new PackError('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new PackError('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new PackError('ofs-delta base offset is truncated');
    byte = buffer[offset++]!;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

interface InflateInfoResult {
  buffer: Buffer;
  engine: { bytesWritten: number };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: InflateInfoResult;
  try {
    result = inflateSync(view, { info: true } as never) as unknown as InflateInfoResult;
  } catch (err) {
    throw new PackError(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new PackError(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new PackError('delta size varint is truncated');
      const byte = deltaBuffer[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new PackError('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) {
    throw new PackError(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new PackError('delta copy offset is truncated');
          copyOffset += deltaBuffer[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new PackError('delta copy size is truncated');
          copySize += deltaBuffer[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new PackError('delta copy is out of the base');
      if (written + copySize > targetSize) throw new PackError('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new PackError('delta insert is truncated');
      if (written + literal > targetSize) throw new PackError('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new PackError('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new PackError(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA entries. `resolveBase` supplies a base object a
 * thin pack leaves out. The trailer checksum is verified; any structural
 * problem throws PackError.
 */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new PackError(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new PackError('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new PackError('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new PackError(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new PackError('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new PackError(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new PackError(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new PackError(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new PackError(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    try {
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (!baseEntry) throw new PackError(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else if (entry.typeCode === 7) {
        const wanted = entry.baseOid!;
        const baseEntry = resolvedByOid.get(wanted);
        if (baseEntry) {
          const base = resolve(baseEntry);
          type = base.type;
          data = applyDelta(base.data, entry.data);
        } else {
          const external = options.resolveBase?.(wanted);
          if (!external) throw new PackError(`ref-delta base ${wanted} is neither in the pack nor held by the server`);
          type = external.type;
          data = applyDelta(external.data, entry.data);
        }
      } else {
        type = CODE_TYPE[entry.typeCode]!;
        data = entry.data;
      }
    } finally {
      resolving.delete(entry.offset);
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects, deltaCount };
}

// ---------------------------------------------------------------------------------------------
// packfile writing
// ---------------------------------------------------------------------------------------------

/** Encode one object's pack header: the type/size varint the pack format uses. */
function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  return writePackObjectHeaderCode(TYPE_CODE[type], size);
}

/** The same header, addressed by numeric type code (6 = OFS_DELTA). */
function writePackObjectHeaderCode(code: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------------------------
// delta encoding (packfile generation)
// ---------------------------------------------------------------------------------------------

/** Objects larger than this are always stored whole: delta work stops paying. */
const DELTA_MAX_OBJECT = 1 << 20;
/** Objects smaller than this never delta: the delta header alone costs more. */
const DELTA_MIN_OBJECT = 64;
/** Chunk length for the base index; also the shortest copy worth emitting. */
const DELTA_CHUNK = 4;
/** Positions kept per chunk hash, bounding work on highly repetitive content. */
const DELTA_MAX_POSITIONS = 8;

/**
 * Index a base object's 4-byte chunks: rolling hash (the raw 4 bytes) to the
 * positions where that chunk occurs. Matches are verified by byte comparison,
 * so hash collisions only cost time, never correctness.
 */
function indexChunks(base: Buffer): Map<number, number[]> {
  const index = new Map<number, number[]>();
  for (let i = 0; i + DELTA_CHUNK <= base.length; i += 1) {
    const key = base.readUInt32BE(i);
    const list = index.get(key);
    if (list === undefined) index.set(key, [i]);
    else if (list.length < DELTA_MAX_POSITIONS) list.push(i);
  }
  return index;
}

/** The delta header's size varint: 7-bit little-endian groups, MSB = continue. */
function encodeDeltaSizeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

/**
 * One copy instruction: opcode 0x80 plus offset/size presence bits, then the
 * offset bytes (little-endian, up to the highest non-zero byte) and the size
 * bytes the same way. A size of zero in the encoding means 0x10000, which
 * never arises here because copies are always at least DELTA_CHUNK long.
 */
function encodeCopyOp(offset: number, size: number): Buffer {
  let opcode = 0x80;
  const offsetBytes: number[] = [];
  let remainingOffset = offset;
  while (remainingOffset > 0) {
    offsetBytes.push(remainingOffset & 0xff);
    remainingOffset = Math.floor(remainingOffset / 256);
  }
  for (let i = 0; i < offsetBytes.length; i += 1) opcode |= 1 << i;
  const sizeBytes: number[] = [];
  let remainingSize = size;
  while (remainingSize > 0) {
    sizeBytes.push(remainingSize & 0xff);
    remainingSize = Math.floor(remainingSize / 256);
  }
  for (let i = 0; i < sizeBytes.length; i += 1) opcode |= 1 << (4 + i);
  return Buffer.from([opcode, ...offsetBytes, ...sizeBytes]);
}

/**
 * Encode `target` as a delta against `base`: source size, target size, then a
 * copy/insert instruction stream. Greedy longest-match scan over the base's
 * chunk index; every match is verified byte-for-byte, so the delta always
 * reconstructs the target exactly (see applyDelta).
 */
export function encodeDelta(base: Buffer, target: Buffer): Buffer {
  return encodeDeltaIndexed(base, target, indexChunks(base));
}

function encodeDeltaIndexed(base: Buffer, target: Buffer, index: Map<number, number[]>): Buffer {
  const ops: Buffer[] = [];
  let pos = 0;
  let literalStart = 0;
  const flushLiterals = (end: number): void => {
    let cursor = literalStart;
    while (cursor < end) {
      const length = Math.min(127, end - cursor);
      ops.push(Buffer.concat([Buffer.from([length]), target.subarray(cursor, cursor + length)]));
      cursor += length;
    }
    literalStart = end;
  };
  while (pos < target.length) {
    let bestLength = 0;
    let bestOffset = 0;
    if (pos + DELTA_CHUNK <= target.length) {
      const candidates = index.get(target.readUInt32BE(pos));
      if (candidates !== undefined) {
        for (const candidate of candidates) {
          const maxLength = Math.min(base.length - candidate, target.length - pos, 0xff_ffff);
          let length = DELTA_CHUNK;
          while (length < maxLength && base[candidate + length] === target[pos + length]) length += 1;
          if (length > bestLength) {
            bestLength = length;
            bestOffset = candidate;
          }
        }
      }
    }
    if (bestLength >= DELTA_CHUNK) {
      flushLiterals(pos);
      ops.push(encodeCopyOp(bestOffset, bestLength));
      pos += bestLength;
      literalStart = pos;
    } else {
      pos += 1;
    }
  }
  flushLiterals(target.length);
  return Buffer.concat([encodeDeltaSizeVarint(base.length), encodeDeltaSizeVarint(target.length), ...ops]);
}

/**
 * The OFS_DELTA base offset: the distance back to the base entry's start,
 * encoded with git's offset varint (the inverse of the reader's
 * `((offset + 1) << 7) | next` accumulation).
 */
function encodeOfsDeltaOffset(distance: number): Buffer {
  const bytes: number[] = [distance & 0x7f];
  let remaining = Math.floor(distance / 128);
  while (remaining > 0) {
    remaining -= 1;
    bytes.unshift(0x80 | (remaining & 0x7f));
    remaining = Math.floor(remaining / 128);
  }
  return Buffer.from(bytes);
}

export interface PackWriteOptions {
  /**
   * Sliding window of same-type entries considered as delta bases. 0 disables
   * deltas entirely (whole objects only). Default 16.
   */
  readonly deltaWindow?: number;
  /** Maximum delta chain depth. Default 10. */
  readonly maxDeltaDepth?: number;
}

const DELTA_TYPE_ORDER: Record<GitObjectType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };

/**
 * Build a packfile. Blobs and trees are delta-encoded against a sliding
 * window of previously emitted same-type objects (multi-level chains, capped
 * depth); a delta is kept only when its deflated form beats the whole object,
 * so packs never grow. Commits and tags are stored whole. The entry order is
 * deterministic (type, then size descending, stable) and the trailer is SHA-1
 * over everything before it.
 */
export function writePack(objects: Iterable<GitObject>, options: PackWriteOptions = {}): Buffer {
  const windowSize = options.deltaWindow ?? 16;
  const maxDepth = options.maxDeltaDepth ?? 10;
  const list = [...objects];
  const ordered =
    windowSize > 0
      ? [...list].sort(
          (a, b) => DELTA_TYPE_ORDER[a.type] - DELTA_TYPE_ORDER[b.type] || b.data.length - a.data.length,
        )
      : list;
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(ordered.length, 8);
  parts.push(header);

  interface WindowEntry {
    start: number;
    type: GitObjectType;
    data: Buffer;
    depth: number;
    chunks: Map<number, number[]> | null;
  }
  const window: WindowEntry[] = [];
  let position = 12;

  for (const object of ordered) {
    const whole = deflateSync(object.data);
    let best: { base: WindowEntry; delta: Buffer; deflated: Buffer } | null = null;
    const eligible =
      windowSize > 0 &&
      (object.type === 'blob' || object.type === 'tree') &&
      object.data.length >= DELTA_MIN_OBJECT &&
      object.data.length <= DELTA_MAX_OBJECT;
    if (eligible) {
      for (const base of window) {
        if (base.type !== object.type || base.depth >= maxDepth || base.data.length > DELTA_MAX_OBJECT) continue;
        if (base.chunks === null) base.chunks = indexChunks(base.data);
        const delta = encodeDeltaIndexed(base.data, object.data, base.chunks);
        const deflated = deflateSync(delta);
        if (deflated.length < whole.length && (best === null || deflated.length < best.deflated.length)) {
          best = { base, delta, deflated };
        }
      }
    }

    let depth = 0;
    const entryStart = position;
    if (best !== null) {
      const entryHeader = writePackObjectHeaderCode(6, best.delta.length);
      const offsetBytes = encodeOfsDeltaOffset(position - best.base.start);
      parts.push(entryHeader, offsetBytes, best.deflated);
      position += entryHeader.length + offsetBytes.length + best.deflated.length;
      depth = best.base.depth + 1;
    } else {
      const entryHeader = writePackObjectHeader(object.type, object.data.length);
      parts.push(entryHeader, whole);
      position += entryHeader.length + whole.length;
    }
    if (windowSize > 0) {
      window.push({ start: entryStart, type: object.type, data: object.data, depth, chunks: null });
      if (window.length > windowSize) window.shift();
    }
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** The objects the pack must carry, in emission order. */
  readonly objects: GitObject[];
  /** The new shallow boundary: commits whose parents the client still lacks. */
  readonly shallow: string[];
  /** Commits that were shallow and now have all their parents. */
  readonly unshallow: string[];
}

export interface FetchPlanOptions {
  /**
   * `deepen-since` cutoff (unix seconds): commits with an older committer
   * timestamp are cut, like a depth boundary. Null disables it.
   */
  readonly deepenSince?: number | null;
  /** `deepen-not` oids: these commits and their ancestors are never sent. */
  readonly excludeOids?: readonly string[];
}

/**
 * Plan a fetch: which objects to send for `wants`, given the commits the
 * client already holds (`haves`), its current shallow boundary (`shallow`)
 * and an optional `depth` limit (generations from the wants; 1 means the
 * wants alone).
 *
 * A have's closure is known to the client except past a shallow boundary: a
 * shallow commit's parents are NOT held even though the commit is. The walk
 * from the wants traverses held commits (their parents may still be wanted
 * past a shallow boundary, as in a deepen fetch) but never re-sends them,
 * and stops at the depth boundary. The pack carries the included commits'
 * closures minus everything the client holds.
 *
 * `deepenRelative` (the protocol's `deepen-relative` line) makes `depth`
 * relative: the effective depth is the shallowest sent boundary's generation
 * from the wants, plus one, plus `depth` — the client's current depth plus
 * the requested extension. Without the flag, `depth` is absolute.
 */
export function planFetch(
  lookup: ObjectLookup,
  wants: readonly string[],
  haves: readonly string[],
  shallow: readonly string[],
  depth: number | null,
  deepenRelative = false,
  planOptions: FetchPlanOptions = {},
): FetchPlan {
  const shallowSet = new Set(shallow.filter(isObjectId));
  const deepenSince = planOptions.deepenSince ?? null;

  // `deepen-not`: the excluded commits and their ancestors are never sent
  // and never traversed. Tags are peeled to their targets first.
  const excluded = new Set<string>();
  for (const oid of planOptions.excludeOids ?? []) {
    if (!isObjectId(oid)) continue;
    const target = peelToNonTag(oid, lookup) ?? oid;
    for (const ancestor of collectAncestors(target, lookup)) excluded.add(ancestor);
  }

  let effectiveDepth = depth;
  if (depth !== null && deepenRelative && shallowSet.size > 0) {
    // Find the shallowest sent boundary reachable from the wants.
    const seenBoundary = new Set<string>();
    const boundaryQueue: Array<{ oid: string; gen: number }> = [];
    for (const want of wants) {
      if (isObjectId(want)) boundaryQueue.push({ oid: want, gen: 0 });
    }
    let boundaryHead = 0;
    let boundaryGen: number | null = null;
    while (boundaryHead < boundaryQueue.length) {
      const { oid, gen } = boundaryQueue[boundaryHead++]!;
      if (seenBoundary.has(oid)) continue;
      seenBoundary.add(oid);
      const object = lookup(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        boundaryQueue.push({ oid: parseTag(object.data).object, gen });
        continue;
      }
      if (object.type !== 'commit') continue;
      if (shallowSet.has(oid)) {
        boundaryGen = gen;
        break;
      }
      for (const parent of parseCommit(object.data).parents) {
        boundaryQueue.push({ oid: parent, gen: gen + 1 });
      }
    }
    if (boundaryGen !== null) effectiveDepth = boundaryGen + 1 + depth;
  }

  // The commits the client holds: the ancestors of the haves, not descending
  // past a shallow boundary (its parents are missing on the client).
  const knownCommits = new Set<string>();
  {
    const queue: string[] = [];
    for (const have of haves) if (isObjectId(have)) queue.push(have);
    while (queue.length) {
      const oid = queue.pop()!;
      if (knownCommits.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
        continue;
      }
      if (object.type !== 'commit') continue;
      knownCommits.add(oid);
      if (shallowSet.has(oid)) continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  }

  // Everything the client holds as objects: the known commits themselves
  // plus their tree closures. (A shallow commit's closure is its own tree
  // only: its parents' objects are NOT held, so the walk below never follows
  // a commit's parents, only its trees.)
  const knownObjects = new Set<string>();
  for (const oid of knownCommits) {
    knownObjects.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const treeOid = parseCommit(object.data).tree;
    const treeQueue = [treeOid];
    while (treeQueue.length) {
      const tree = treeQueue.pop()!;
      if (knownObjects.has(tree)) continue;
      const treeObject = lookup(tree);
      if (!treeObject) continue;
      knownObjects.add(tree);
      if (treeObject.type === 'tree') {
        for (const entry of parseTree(treeObject.data)) {
          if (entry.mode === '160000') continue;
          treeQueue.push(entry.oid);
        }
      }
    }
  }
  // Haves that are not commits (a tag, a lone tree/blob): their closures are held too.
  for (const have of haves) {
    if (!isObjectId(have) || knownCommits.has(have)) continue;
    for (const reachable of collectReachable([have], lookup, { allowMissing: true })) {
      knownObjects.add(reachable);
    }
  }

  // The inclusion walk: breadth-first from the wants, tracking the smallest
  // generation each commit is reached at.
  const included = new Set<string>();
  const includedTags = new Set<string>();
  const directObjects = new Set<string>();
  const seenGen = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];

  const enqueueWant = (oid: string): void => {
    const object = lookup(oid);
    if (!object) return;
    if (object.type === 'tag') {
      includedTags.add(oid);
      enqueueWant(parseTag(object.data).object);
      return;
    }
    if (object.type === 'commit') {
      if (!seenGen.has(oid)) {
        seenGen.set(oid, 0);
        queue.push({ oid, gen: 0 });
      }
      return;
    }
    directObjects.add(oid);
  };
  for (const want of wants) if (isObjectId(want)) enqueueWant(want);

  let walkHead = 0;
  while (walkHead < queue.length) {
    const { oid, gen } = queue[walkHead++]!;
    if (effectiveDepth !== null && gen >= effectiveDepth) continue;
    if (excluded.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    // `deepen-since`: commits older than the cutoff are cut, like a depth
    // boundary; their children become shallow via the boundary logic below.
    if (deepenSince !== null) {
      const stamped = parseIdent(commit.committer)?.timestamp ?? 0;
      if (stamped < deepenSince) continue;
    }
    // Held commits are traversed but never re-sent: a deepen fetch's wanted
    // parents lie below held commits, past the shallow boundary. Only commits
    // the client does not hold join the pack.
    if (!knownCommits.has(oid)) included.add(oid);
    for (const parent of commit.parents) {
      const previous = seenGen.get(parent);
      if (previous !== undefined && previous <= gen + 1) continue;
      seenGen.set(parent, gen + 1);
      queue.push({ oid: parent, gen: gen + 1 });
    }
  }

  // The pack: included commits, included tags, direct wants, and the tree
  // closures of the included commits — minus everything the client holds.
  const packOids = new Set<string>();
  const packObjects: GitObject[] = [];
  const emit = (oid: string): void => {
    if (packOids.has(oid) || knownObjects.has(oid)) return;
    const object = lookup(oid);
    if (!object) return;
    packOids.add(oid);
    packObjects.push(object);
  };
  for (const oid of included) emit(oid);
  for (const oid of includedTags) emit(oid);
  for (const oid of directObjects) {
    for (const reachable of collectReachable([oid], lookup, { allowMissing: true })) emit(reachable);
  }
  for (const oid of included) {
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const treeOid = parseCommit(object.data).tree;
    const treeQueue = [treeOid];
    const seenTree = new Set<string>();
    while (treeQueue.length) {
      const current = treeQueue.pop()!;
      if (seenTree.has(current)) continue;
      seenTree.add(current);
      emit(current);
      const currentObject = lookup(current);
      if (currentObject && currentObject.type === 'tree') {
        for (const entry of parseTree(currentObject.data)) {
          if (entry.mode === '160000') continue;
          treeQueue.push(entry.oid);
        }
      }
    }
  }
  // A tag want's target commit closure is covered by the inclusion walk when
  // the target is a commit; when it is a tree or blob, cover it here.
  for (const oid of includedTags) {
    const object = lookup(oid);
    if (!object || object.type !== 'tag') continue;
    const target = parseTag(object.data).object;
    const targetObject = lookup(target);
    if (targetObject && targetObject.type !== 'commit' && targetObject.type !== 'tag') {
      for (const reachable of collectReachable([target], lookup, { allowMissing: true })) emit(reachable);
    }
  }

  // The shallow-info section.
  const sentOrKnown = new Set<string>([...included, ...knownCommits]);
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  const boundaryCandidates = new Set<string>([...included]);
  for (const oid of shallowSet) if (sentOrKnown.has(oid)) boundaryCandidates.add(oid);
  for (const oid of boundaryCandidates) {
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    if (parents.some((parent) => !sentOrKnown.has(parent))) shallowOut.push(oid);
  }
  for (const oid of shallowSet) {
    if (!sentOrKnown.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => sentOrKnown.has(parent))) unshallowOut.push(oid);
  }
  shallowOut.sort();
  unshallowOut.sort();
  return { objects: packObjects, shallow: shallowOut, unshallow: unshallowOut };
}

// ---------------------------------------------------------------------------------------------
// tree paths, diffs and merges
// ---------------------------------------------------------------------------------------------

/** One flattened tree entry: a path and the object it names. */
export interface FlatEntry {
  readonly mode: string;
  readonly oid: string;
}

/** Flatten a tree (recursively) into path → entry. Gitlinks are kept as entries. */
export function flattenTree(rootOid: string, lookup: ObjectLookup): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (treeOid: string, prefix: string): void => {
    const object = lookup(treeOid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(rootOid, '');
  return out;
}

/** The entry at `segments` in the tree rooted at `rootOid`, or null. */
export function treePathEntry(
  rootOid: string,
  segments: readonly string[],
  lookup: ObjectLookup,
): FlatEntry | null {
  let current = rootOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = lookup(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) return { mode: entry.mode, oid: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** The entries of the directory at `segments` in the tree, or null when it is not a directory. */
export function treeDirEntries(
  rootOid: string,
  segments: readonly string[],
  lookup: ObjectLookup,
): TreeEntry[] | null {
  let current = rootOid;
  for (const segment of segments) {
    const object = lookup(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  const object = lookup(current);
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data);
}

/** Store an object and answer its id. */
export type PutObject = (type: GitObjectType, data: Buffer) => string;

/**
 * Build a tree from a flattened path map, storing every tree object. Returns
 * the root tree's id.
 */
export function buildTreeFromMap(entries: ReadonlyMap<string, FlatEntry>, put: PutObject): string {
  interface DirNode {
    files: TreeEntry[];
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: [], dirs: new Map() };
  for (const [path, entry] of entries) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      let child = node.dirs.get(segment);
      if (!child) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.push({ mode: entry.mode, name: segments[segments.length - 1]!, oid: entry.oid });
  }
  const build = (node: DirNode): string => {
    const all: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) {
      all.push({ mode: '40000', name, oid: build(child) });
    }
    return put('tree', buildTree(all));
  };
  return build(root);
}

/**
 * Set (`blobOid` given) or delete (`blobOid` null) the path `segments` in the
 * tree rooted at `rootOid` (null for an empty tree), storing new tree objects.
 * Directories left empty by a delete are pruned. Returns the new root tree id.
 */
export function setTreePath(
  rootOid: string | null,
  segments: readonly string[],
  blobOid: string | null,
  mode: string,
  lookup: ObjectLookup,
  put: PutObject,
): string {
  const head = segments[0]!;
  const rest = segments.slice(1);
  const entries: TreeEntry[] =
    rootOid === null ? [] : (() => {
      const object = lookup(rootOid);
      if (!object || object.type !== 'tree') throw new Error(`tree ${rootOid} is not a tree`);
      return parseTree(object.data);
    })();
  const kept = entries.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    if (blobOid !== null) kept.push({ mode, name: head, oid: blobOid });
  } else {
    const existing = entries.find((entry) => entry.name === head);
    if (existing && existing.mode !== '40000') {
      throw new Error(`path segment ${head} is a file, not a directory`);
    }
    const childOid = setTreePath(existing?.oid ?? null, rest, blobOid, mode, lookup, put);
    const childObject = lookup(childOid);
    const childEmpty = childObject !== undefined && childObject.type === 'tree' && childObject.data.length === 0;
    if (!childEmpty) kept.push({ mode: '40000', name: head, oid: childOid });
  }
  return put('tree', buildTree(kept));
}

export interface TreeDiffEntry {
  readonly path: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly oldOid: string | null;
  readonly newOid: string | null;
  readonly oldMode: string | null;
  readonly newMode: string | null;
}

/** The paths that differ between two trees, sorted by path. */
export function diffTrees(baseOid: string, headOid: string, lookup: ObjectLookup): TreeDiffEntry[] {
  const base = flattenTree(baseOid, lookup);
  const head = flattenTree(headOid, lookup);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: TreeDiffEntry[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null, oldMode: b.mode, newMode: null });
    else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid, oldMode: null, newMode: h.mode });
    else if (b && h && (b.oid !== h.oid || b.mode !== h.mode)) {
      out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid, oldMode: b.mode, newMode: h.mode });
    }
  }
  return out;
}

/** Split blob bytes into lines (a trailing newline does not make an empty last line). */
function splitLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Added/removed line counts between two blob versions, via longest-common-
 * subsequence on lines. Binary contents count 0/0; very large inputs fall
 * back to whole-file counts.
 */
export function diffLineCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  if (oldData !== null && oldData.includes(0)) return { additions: 0, deletions: 0 };
  if (newData !== null && newData.includes(0)) return { additions: 0, deletions: 0 };
  const oldLines = oldData === null ? [] : splitLines(oldData);
  const newLines = newData === null ? [] : splitLines(newData);
  if (oldLines.length * newLines.length > 200_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  // LCS lengths, one row at a time.
  let previous = new Array<number>(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    const current = new Array<number>(newLines.length + 1).fill(0);
    for (let j = 1; j <= newLines.length; j += 1) {
      current[j] =
        oldLines[i - 1] === newLines[j - 1]
          ? previous[j - 1]! + 1
          : Math.max(previous[j]!, current[j - 1]!);
    }
    previous = current;
  }
  const common = previous[newLines.length]!;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

export type MergeResult =
  | { readonly ok: true; readonly merged: Map<string, FlatEntry> }
  | { readonly ok: false; readonly conflicts: string[] };

/**
 * A file-level three-way merge: for each path, take the side that changed,
 * take either when both agree, and conflict when both changed differently
 * (including delete-vs-modify). Returns the merged flat map or the
 * conflicting paths, sorted.
 */
export function threeWayMerge(
  baseOid: string,
  oursOid: string,
  theirsOid: string,
  lookup: ObjectLookup,
): MergeResult {
  const base = flattenTree(baseOid, lookup);
  const ours = flattenTree(oursOid, lookup);
  const theirs = flattenTree(theirsOid, lookup);
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const same = (a: FlatEntry | undefined, b: FlatEntry | undefined): boolean => {
    if (a === undefined || b === undefined) return a === b;
    return a.oid === b.oid && a.mode === b.mode;
  };
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o) merged.set(path, o);
    } else if (same(b, o)) {
      if (t) merged.set(path, t);
    } else if (same(b, t)) {
      if (o) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  conflicts.sort();
  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, merged };
}
