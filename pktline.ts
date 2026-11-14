/**
 * The git pkt-line codec: the framing every smart-HTTP exchange uses.
 *
 * A data packet is 4 lowercase hex digits holding the packet length (payload
 * plus the 4 header bytes) followed by the payload. Three control packets
 * exist: `0000` (flush), `0001` (delim) and `0002` (response-end). No packet
 * may exceed 65520 bytes including its header (git's LARGE_PACKET_MAX).
 */

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte header. */
export const PKT_LINE_MAX = 65520;

/** The largest payload a data packet may carry (length minus the header). */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

const HEX4 = /^[0-9a-fA-F]{4}$/;

function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** One decoded packet. `raw` is the exact framed bytes, when a caller needs them. */
export type PktPacket =
  | { readonly kind: 'data'; readonly payload: Buffer; readonly raw: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/** Encode one data packet: a 4-hex length header plus the payload. */
export function pktLine(payload: string | Uint8Array): Buffer {
  const data = asBuffer(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

/** The flush packet, `0000`. */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim packet, `0001`. */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** The response-end packet, `0002`. */
export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export type PktItem = string | Uint8Array | 'flush' | 'delim' | 'response-end';

/** Encode a mixed sequence; the strings 'flush'/'delim'/'response-end' are control packets. */
export function pktLines(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else if (item === 'response-end') parts.push(pktResponseEnd());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode a complete buffer into packets. `allowTrailing` stops before bytes
 * that do not look like a pkt-line header (the raw packfile that follows a
 * receive-pack command list) and reports how many bytes the packets consumed.
 */
export function decodePktLines(
  bytes: Uint8Array,
  options: { allowTrailing?: boolean } = {},
): { packets: PktPacket[]; consumed: number } {
  const buffer = asBuffer(bytes);
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) {
      throw new Error(`truncated pkt-line: ${buffer.length - offset} trailing byte(s)`);
    }
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) {
      if (options.allowTrailing === true) break;
      throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    if (offset + length > buffer.length) {
      throw new Error(`truncated pkt-line: ${length} announced, ${buffer.length - offset} available`);
    }
    const raw = buffer.subarray(offset, offset + length);
    packets.push({ kind: 'data', payload: raw.subarray(4), raw: Buffer.from(raw) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** The decoded text of every data packet, control packets dropped. */
export function packetLines(packets: readonly PktPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}
