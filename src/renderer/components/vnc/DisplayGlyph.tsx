import type { ReactElement } from 'react'
import type { DisplayRegion } from '@shared/displays'

/**
 * The displays' arrangement in miniature for the Displays menu: every display as a bar, the one an item stands for (or
 * all of them, for All displays) coloured, so the list says which is which without reading sizes.
 */
export default function DisplayGlyph({ displays, picture, on }: { displays: DisplayRegion[]; picture: { width: number; height: number }; on: number | 'all' }): ReactElement {
  const W = 40
  const H = 14
  const k = Math.min(W / picture.width, H / picture.height)
  const ox = (W - picture.width * k) / 2
  const oy = (H - picture.height * k) / 2
  return (
    <svg className="vt-glyph-displays" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {displays.map((d) => (
        <rect
          key={d.id}
          x={ox + d.x * k + 0.5}
          y={oy + d.y * k + 0.5}
          width={Math.max(2, d.width * k - 1)}
          height={Math.max(2, d.height * k - 1)}
          rx={1}
          className={on === 'all' || on === d.id ? 'on' : ''}
        />
      ))}
    </svg>
  )
}
