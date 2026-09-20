/** Minimal DER encoder/decoder, just enough for the IronRDP RDCleanPath PDU. */

export interface Tlv {
  tag: number
  value: Buffer
}

function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  let v = n
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

export function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value])
}

export const der = {
  integer(n: number): Buffer {
    const bytes: number[] = []
    let v = n
    do {
      bytes.unshift(v & 0xff)
      v = Math.floor(v / 256)
    } while (v > 0)
    if (bytes[0] & 0x80) bytes.unshift(0)
    return tlv(0x02, Buffer.from(bytes))
  },
  utf8(s: string): Buffer {
    return tlv(0x0c, Buffer.from(s, 'utf8'))
  },
  octets(b: Buffer): Buffer {
    return tlv(0x04, b)
  },
  sequence(...items: Buffer[]): Buffer {
    return tlv(0x30, Buffer.concat(items))
  },
  /** EXPLICIT context-specific tag [n] wrapping an already-encoded TLV. */
  ctx(n: number, inner: Buffer): Buffer {
    return tlv(0xa0 | n, inner)
  }
}

/** Reads one TLV at offset. Returns null when the buffer does not yet hold the full element. */
export function readTlv(buf: Buffer, offset = 0): { tlv: Tlv; end: number } | null {
  if (buf.length < offset + 2) return null
  const tag = buf[offset]
  let len = buf[offset + 1]
  let pos = offset + 2
  if (len & 0x80) {
    const count = len & 0x7f
    if (buf.length < pos + count) return null
    len = 0
    for (let i = 0; i < count; i++) len = len * 256 + buf[pos + i]
    pos += count
  }
  if (buf.length < pos + len) return null
  return { tlv: { tag, value: buf.subarray(pos, pos + len) }, end: pos + len }
}

export function readAll(buf: Buffer): Tlv[] {
  const out: Tlv[] = []
  let off = 0
  while (off < buf.length) {
    const r = readTlv(buf, off)
    if (!r) throw new Error('Truncated DER')
    out.push(r.tlv)
    off = r.end
  }
  return out
}

export function decodeInteger(v: Buffer): number {
  let n = 0
  for (const b of v) n = n * 256 + b
  return n
}
