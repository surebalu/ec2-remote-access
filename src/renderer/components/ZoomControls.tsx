import { useEffect, useState, type ReactElement } from 'react'
import { useStore } from '../store'
import { stepZoom, zoomLabel, ZOOM_SECTIONS, type ZoomSection } from '../sectionZoom'

const EVENT = 'ec2ra:section-zoom'

/** Changes a section's text size one step and flashes the new size over it. */
export function zoomSection(section: ZoomSection, dir: 1 | -1 | 0): void {
  const st = useStore.getState()
  const cur = st.settings?.sectionZoom?.[section] ?? 1
  const next = dir === 0 ? 1 : stepZoom(cur, dir)
  void st.setSectionZoom(section, next)
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { section, zoom: next } }))
}

/** − 100% + for one section; the percentage resets it. */
export function ZoomStepper({ section }: { section: ZoomSection }): ReactElement {
  const zoom = useStore((s) => s.settings?.sectionZoom?.[section] ?? 1)
  const name = ZOOM_SECTIONS.find((x) => x.id === section)?.label ?? section
  return (
    <span className="zoom-stepper" role="group" aria-label={`${name} text size`}>
      <button type="button" aria-label={`Smaller ${name.toLowerCase()} text`} title="Smaller (⌘− with the pointer over it)" onClick={() => zoomSection(section, -1)}>−</button>
      <button type="button" className="zoom-stepper-value" title="Back to 100%" onClick={() => zoomSection(section, 0)}>{zoomLabel(zoom)}</button>
      <button type="button" aria-label={`Larger ${name.toLowerCase()} text`} title="Larger (⌘+ with the pointer over it)" onClick={() => zoomSection(section, 1)}>+</button>
    </span>
  )
}

/** The size a section was just set to, shown over it for a moment. */
export function ZoomBadge(): ReactElement | null {
  const [flash, setFlash] = useState<{ section: ZoomSection; zoom: number; box: DOMRect } | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const on = (e: Event): void => {
      const { section, zoom } = (e as CustomEvent<{ section: ZoomSection; zoom: number }>).detail
      const el = document.querySelector(`[data-zoom-section="${section}"]`)
      if (!el || !el.getClientRects().length) return
      setFlash({ section, zoom, box: el.getBoundingClientRect() })
      clearTimeout(timer)
      timer = setTimeout(() => setFlash(null), 900)
    }
    window.addEventListener(EVENT, on)
    return () => { window.removeEventListener(EVENT, on); clearTimeout(timer) }
  }, [])
  if (!flash) return null
  const name = ZOOM_SECTIONS.find((x) => x.id === flash.section)?.label ?? ''
  return (
    <div className="zoom-badge" role="status" style={{ left: flash.box.left + flash.box.width / 2, top: flash.box.top + 56 }}>
      {name} {zoomLabel(flash.zoom)}
    </div>
  )
}
