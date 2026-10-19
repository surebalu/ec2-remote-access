/**
 * Text size per section of the hosts view, on top of the window's own zoom: the hosts sidebar and the hosts list
 * each scale by themselves (CSS `zoom` through --zoom-<section>), so one can be made smaller or larger than the other.
 * Steps go 75%–140%; 1 is the default size.
 */

export type ZoomSection = 'sidebar' | 'hosts'

export const ZOOM_SECTIONS: { id: ZoomSection; label: string }[] = [
  { id: 'sidebar', label: 'Sidebar' },
  { id: 'hosts', label: 'Hosts list' }
]

export const ZOOM_STEPS = [0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.1, 1.2, 1.3, 1.4]

/** The next step up or down from `cur` (which need not be a step itself); stays within the range. */
export function stepZoom(cur: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > cur + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
  return [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001) ?? ZOOM_STEPS[0]
}

export const zoomLabel = (z: number): string => `${Math.round(z * 100)}%`

/** Writes every section's zoom to <html> as --zoom-<section>. */
export function applySectionZoom(zoom: Partial<Record<ZoomSection, number>> | undefined): void {
  const root = document.documentElement
  for (const { id } of ZOOM_SECTIONS) root.style.setProperty(`--zoom-${id}`, String(zoom?.[id] ?? 1))
}
