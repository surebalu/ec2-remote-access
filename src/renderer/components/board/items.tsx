import type { ReactElement } from 'react'
import { getStroke } from 'perfect-freehand'
import type { BoardItem } from '@shared/types'
import { arrowHead, outlinePath, wrapText, type Box } from '../../boardGeometry'

/** How whiteboard items look (SVG, in board units). The same elements are serialised for PNG export. */

export const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
export const LINE_HEIGHT = 1.3
export const NOTE_PAD = 14
export const NOTE_FONT = 18

let ctx: CanvasRenderingContext2D | null = null
/** Text width in board units, for wrapping notes and sizing text boxes. */
export function measure(text: string, size: number): number {
  ctx ??= document.createElement('canvas').getContext('2d')
  if (!ctx) return text.length * size * 0.55
  ctx.font = `${size}px ${FONT}`
  return ctx.measureText(text).width
}

export const noteLines = (it: BoardItem): string[] => wrapText(it.text ?? '', Math.max(10, it.w - 2 * NOTE_PAD), (s) => measure(s, it.fontSize ?? NOTE_FONT))

/** Size of a text item from its lines. */
export function textSize(text: string, fontSize: number): { w: number; h: number } {
  const lines = text.split('\n')
  return { w: Math.max(fontSize, ...lines.map((l) => measure(l, fontSize))) + 4, h: lines.length * fontSize * LINE_HEIGHT }
}

/** A paint for SVG: 'ink' follows the theme (exported as its current colour), 'gradient' is the item's own gradient. */
export const paint = (it: BoardItem): string => (it.color === 'ink' ? 'var(--board-ink)' : it.color === 'gradient' ? `url(#grad-${it.id})` : it.color)

export const GRADIENT = ['#8b5cf6', '#0ea5e9', '#10b981']

export function GradientDef({ it }: { it: BoardItem }): ReactElement | null {
  if (it.color !== 'gradient') return null
  return (
    <linearGradient id={`grad-${it.id}`} gradientUnits="userSpaceOnUse" x1={it.x} y1={it.y} x2={it.x + Math.max(it.w, 1)} y2={it.y + Math.max(it.h, 1)}>
      {GRADIENT.map((c, i) => <stop key={c} offset={i / (GRADIENT.length - 1)} stopColor={c} />)}
    </linearGradient>
  )
}

/** Freehand ink as a filled outline (perfect-freehand): pressure from a pencil, simulated from speed for a mouse. */
export function inkPath(it: BoardItem): string {
  const pts = it.points ?? []
  const pressured = pts.some((p) => p[2] !== undefined && p[2] !== 0.5)
  const highlighter = it.type === 'highlighter'
  return outlinePath(getStroke(pts.map(([x, y, p]) => [x, y, p ?? 0.5]), {
    size: highlighter ? it.width * 4 : it.width * 1.7,
    thinning: highlighter ? 0 : 0.55,
    smoothing: 0.55,
    streamline: 0.45,
    simulatePressure: !pressured && !highlighter,
    last: true
  }))
}

const fillOf = (it: BoardItem): { fill: string; fillOpacity?: number } =>
  !it.fill || it.fill === 'none' ? { fill: 'none' } : { fill: paint(it), fillOpacity: it.fill === 'tint' ? 0.16 : 1 }

const strokeOf = (it: BoardItem): Record<string, string | number> => ({
  stroke: paint(it),
  strokeWidth: it.width,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  ...(it.dashed ? { strokeDasharray: `${it.width * 2.5} ${it.width * 2.5}` } : {})
})

export function ItemView({ it, opacity = 1 }: { it: BoardItem; opacity?: number }): ReactElement | null {
  const common = { 'data-id': it.id, opacity }
  switch (it.type) {
    case 'pen':
      return <path {...common} d={inkPath(it)} fill={paint(it)} />
    case 'highlighter':
      return <path {...common} d={inkPath(it)} fill={paint(it)} opacity={0.38 * opacity} />
    case 'line':
    case 'arrow': {
      const [a, b] = it.points ?? [[it.x, it.y], [it.x + it.w, it.y + it.h]]
      const head = it.type === 'arrow' ? arrowHead({ x: a[0], y: a[1] }, { x: b[0], y: b[1] }, it.width) : null
      // The line stops short of the tip so a thick stroke does not poke through the arrowhead.
      const short = head ? Math.min(it.width * 2, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2) : 0
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0])
      return (
        <g {...common}>
          <line x1={a[0]} y1={a[1]} x2={b[0] - Math.cos(ang) * short} y2={b[1] - Math.sin(ang) * short} {...strokeOf(it)} />
          {head && <polygon points={head.map((p) => `${p.x},${p.y}`).join(' ')} fill={paint(it)} stroke={paint(it)} strokeWidth={it.width / 2} strokeLinejoin="round" />}
        </g>
      )
    }
    case 'rect':
      return <rect {...common} x={it.x} y={it.y} width={it.w} height={it.h} rx={Math.min(10, it.w / 4, it.h / 4)} {...strokeOf(it)} {...fillOf(it)} />
    case 'ellipse':
      return <ellipse {...common} cx={it.x + it.w / 2} cy={it.y + it.h / 2} rx={it.w / 2} ry={it.h / 2} {...strokeOf(it)} {...fillOf(it)} />
    case 'diamond': {
      const pts = `${it.x + it.w / 2},${it.y} ${it.x + it.w},${it.y + it.h / 2} ${it.x + it.w / 2},${it.y + it.h} ${it.x},${it.y + it.h / 2}`
      return <polygon {...common} points={pts} {...strokeOf(it)} {...fillOf(it)} />
    }
    case 'text': {
      const fs = it.fontSize ?? 24
      return (
        <text {...common} x={it.x} y={it.y} fontSize={fs} fill={paint(it)} style={{ fontFamily: FONT, whiteSpace: 'pre' }}>
          {(it.text ?? '').split('\n').map((line, i) => <tspan key={i} x={it.x} dy={i ? fs * LINE_HEIGHT : fs * 0.95}>{line || ' '}</tspan>)}
        </text>
      )
    }
    case 'note': {
      const fs = it.fontSize ?? NOTE_FONT
      const tone = it.color === 'ink' || it.color === 'gradient' ? '#facc15' : it.color
      return (
        <g {...common} className="board-note">
          <rect x={it.x} y={it.y} width={it.w} height={it.h} rx={6} style={{ fill: `color-mix(in srgb, ${tone} 34%, var(--board-paper))`, stroke: `color-mix(in srgb, ${tone} 55%, var(--board-paper))` }} strokeWidth={1} />
          <text x={it.x + NOTE_PAD} y={it.y + NOTE_PAD} fontSize={fs} fill="var(--board-ink)" style={{ fontFamily: FONT, whiteSpace: 'pre' }}>
            {noteLines(it).map((line, i) => <tspan key={i} x={it.x + NOTE_PAD} dy={i ? fs * LINE_HEIGHT : fs * 0.95}>{line || ' '}</tspan>)}
          </text>
        </g>
      )
    }
    case 'image':
      return <image {...common} href={it.src} x={it.x} y={it.y} width={it.w} height={it.h} preserveAspectRatio="none" />
  }
}

/**
 * The board (or part of it) as a PNG data URL: the drawn items' SVG with the theme colours written in, on the
 * board's paper, at `scale` × size. Text is SVG text (no foreignObject), so the canvas stays exportable.
 */
export async function exportPng(itemsGroup: SVGGElement, defs: SVGDefsElement | null, box: Box, colors: { ink: string; paper: string }, scale = 2): Promise<string> {
  const pad = 32
  const w = Math.ceil(box.w + pad * 2)
  const h = Math.ceil(box.h + pad * 2)
  const ser = new XMLSerializer()
  const inner = (defs ? ser.serializeToString(defs) : '') + ser.serializeToString(itemsGroup)
  const body = inner.replaceAll('var(--board-ink)', colors.ink).replaceAll('var(--board-paper)', colors.paper)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${box.x - pad} ${box.y - pad} ${w} ${h}"><rect x="${box.x - pad}" y="${box.y - pad}" width="${w}" height="${h}" fill="${colors.paper}"/>${body}</svg>`
  const img = new Image()
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.min(8000, w * scale)
  canvas.height = Math.min(8000, h * scale)
  const c = canvas.getContext('2d')!
  c.scale(canvas.width / w, canvas.height / h)
  c.drawImage(img, 0, 0, w, h)
  return canvas.toDataURL('image/png')
}
