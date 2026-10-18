// Draws the menu-bar icon (a terminal window with a prompt) as macOS template PNGs: black with alpha, 16 pt at 1x
// and 2x. Run with `node scripts/make-tray-icon.mjs`; the output goes to resources/ and is checked in.
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}
function png(size, alphaAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4
      raw[o] = raw[o + 1] = raw[o + 2] = 0
      raw[o + 3] = Math.round(255 * Math.max(0, Math.min(1, alphaAt(x, y))))
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// Shapes in a 16-unit box; coverage by 4x4 supersampling.
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}
const roundRectDist = (px, py, x0, y0, x1, y1, r) => {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r
  const qx = Math.abs(px - cx) - hx, qy = Math.abs(py - cy) - hy
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const inside = (u, v) => {
  const frame = Math.abs(roundRectDist(u, v, 1.2, 2.2, 14.8, 13.8, 2.4)) <= 0.75
  const chevron = segDist(u, v, 4.3, 6, 6.8, 8.2) <= 0.8 || segDist(u, v, 6.8, 8.2, 4.3, 10.4) <= 0.8
  const cursor = segDist(u, v, 8.4, 10.4, 11.6, 10.4) <= 0.8
  return frame || chevron || cursor
}
for (const [scale, name] of [[1, 'trayTemplate.png'], [2, 'trayTemplate@2x.png']]) {
  const size = 16 * scale
  const n = 4
  const out = png(size, (x, y) => {
    let hit = 0
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (inside(((x + (i + 0.5) / n) / size) * 16, ((y + (j + 0.5) / n) / size) * 16)) hit++
    return hit / (n * n)
  })
  writeFileSync(new URL(`../resources/${name}`, import.meta.url), out)
  console.log('wrote resources/' + name)
}
