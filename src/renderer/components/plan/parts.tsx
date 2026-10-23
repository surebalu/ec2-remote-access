import { useEffect, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { ymd } from '@shared/naturalDate'
import { newRecordId } from '@shared/records'

/** Pieces the Tasks, Calendar and Links tabs share (plan.css): sidebar items, today's date, an undo bar. */

export const newId = (): string => newRecordId()

/** Today as 'YYYY-MM-DD', moving on at midnight (checked each minute and when the window comes back). */
export function useToday(): string {
  const [today, setToday] = useState(() => ymd(new Date()))
  useEffect(() => {
    const tick = (): void => setToday(ymd(new Date()))
    const t = setInterval(tick, 60_000)
    window.addEventListener('focus', tick)
    return () => { clearInterval(t); window.removeEventListener('focus', tick) }
  }, [])
  return today
}

/** A value remembered in this browser (the view a tool was on), never required to be there. */
export function useLocal<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { return (localStorage.getItem(key) as T | null) ?? initial } catch { return initial }
  })
  const set = (next: T): void => {
    setV(next)
    try { localStorage.setItem(key, next) } catch { /* private window */ }
  }
  return [v, set]
}

export function NavItem({ icon, label, count, alert, on, onClick, onContextMenu, color, depth = 0, title }: {
  icon?: ReactNode
  label: string
  count?: number
  alert?: boolean
  on: boolean
  onClick: () => void
  onContextMenu?: (e: MouseEvent<HTMLButtonElement>) => void
  color?: string
  depth?: number
  title?: string
}): ReactElement {
  return (
    <button type="button" className="plan-nav" aria-current={on ? 'page' : undefined} onClick={onClick} onContextMenu={onContextMenu} title={title ?? label} style={depth ? { paddingLeft: 9 + depth * 14 } : undefined}>
      {color ? <span className="plan-dot" style={{ background: color }} /> : icon}
      <span className="plan-nav-label">{label}</span>
      {!!count && <span className={`plan-count ${alert ? 'alert' : ''}`}>{count}</span>}
    </button>
  )
}

/** "Deleted 3 tasks · Undo", for a few seconds after something is removed. */
export function UndoBar({ undo, onUndo, onDone }: { undo: { label: string; key: number } | null; onUndo: () => void; onDone: () => void }): ReactElement | null {
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    if (!undo) return
    const t = setTimeout(() => done.current(), 7000)
    return () => clearTimeout(t)
  }, [undo?.key]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!undo) return null
  return (
    <div className="plan-undo" role="status">
      <span>{undo.label}</span>
      <button type="button" onClick={onUndo}>Undo</button>
    </div>
  )
}

/** Whether a key event comes from somewhere the user is typing. */
export const typing = (e: KeyboardEvent): boolean => {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
}

/** Saves a text file through the browser's download (a save dialog on the Mac, the share sheet on an iPhone). */
export function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Asks for a file and reads it as text (null when cancelled). */
export function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept })
    input.addEventListener('change', () => {
      const f = input.files?.[0]
      if (!f) return resolve(null)
      if (f.size > 50 * 1024 * 1024) { resolve(null); return }
      void f.text().then((text) => resolve({ name: f.name, text }), () => resolve(null))
    })
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}
