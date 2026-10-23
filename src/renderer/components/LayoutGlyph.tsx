import type { ReactElement } from 'react'
import type { Rect, WindowLayout } from '@shared/windowLayouts'

/** Where an operation without an area of its own leaves a window, drawn the same way (the screen with the window in it). */
const OP_AREAS: Partial<Record<NonNullable<WindowLayout['op']>, Rect>> = {
  maximize: { x: 0, y: 0, w: 1, h: 1 }, almostMaximize: { x: 0.06, y: 0.08, w: 0.88, h: 0.84 }, maximizeHeight: { x: 0.34, y: 0, w: 0.32, h: 1 },
  maximizeWidth: { x: 0, y: 0.32, w: 1, h: 0.36 }, center: { x: 0.3, y: 0.27, w: 0.4, h: 0.46 }, reasonable: { x: 0.2, y: 0.125, w: 0.6, h: 0.75 },
  larger: { x: 0.12, y: 0.12, w: 0.76, h: 0.76 }, smaller: { x: 0.33, y: 0.3, w: 0.34, h: 0.4 }, moveLeft: { x: 0, y: 0.25, w: 0.42, h: 0.5 },
  moveRight: { x: 0.58, y: 0.25, w: 0.42, h: 0.5 }, moveUp: { x: 0.29, y: 0, w: 0.42, h: 0.5 }, moveDown: { x: 0.29, y: 0.5, w: 0.42, h: 0.5 },
  restore: { x: 0.18, y: 0.18, w: 0.5, h: 0.5 }, fullscreen: { x: 0, y: 0, w: 1, h: 1 }, minimize: { x: 0.36, y: 0.78, w: 0.28, h: 0.22 }
}

/** A small picture of a window layout: the screen's outline with the window's place filled in. */
export default function LayoutGlyph({ layout, size = 18 }: { layout: WindowLayout; size?: number }): ReactElement {
  const W = 20
  const H = 14
  const a = layout.area ?? (layout.op ? OP_AREAS[layout.op] : undefined)
  const display = layout.op === 'nextDisplay' || layout.op === 'previousDisplay'
  return (
    <svg className="layout-glyph" width={size} height={(size * H) / W} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <rect x={0.5} y={0.5} width={W - 1} height={H - 1} rx={2} fill="none" stroke="currentColor" strokeOpacity={0.55} />
      {a && <rect x={1.75 + a.x * (W - 3.5)} y={1.75 + a.y * (H - 3.5)} width={Math.max(1, a.w * (W - 3.5))} height={Math.max(1, a.h * (H - 3.5))} rx={0.8} fill="currentColor" />}
      {display && <path d={layout.op === 'nextDisplay' ? 'M6 7h8m-3-3 3 3-3 3' : 'M14 7H6m3-3L6 7l3 3'} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  )
}
