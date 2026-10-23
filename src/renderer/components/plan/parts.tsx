import { useEffect, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { ymd } from '@shared/naturalDate'
import { newRecordId } from '@shared/records'
import { hasBrowser } from '../../quickConnect'
import { Icon } from '../icons'

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

/** A set of ids remembered in this browser (the folders left open), with a toggle. */
export function useLocalSet(key: string): [Set<string>, (id: string) => void, (ids: string[]) => void] {
  const [set, setSet] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]) } catch { return new Set() }
  })
  const save = (next: Set<string>): void => {
    setSet(next)
    try { localStorage.setItem(key, JSON.stringify([...next])) } catch { /* private window */ }
  }
  return [set, (id) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); save(n) }, (ids) => save(new Set(ids))]
}

export function NavItem({ icon, label, count, alert, on, onClick, onContextMenu, color, depth = 0, title, tree }: {
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
  /** A row of a tree: a chevron that opens or folds it (→ and ← do too), or a spacer for a row with nothing below. */
  tree?: { open: boolean; hasChildren: boolean; onToggle: () => void }
}): ReactElement {
  return (
    <button type="button" className="plan-nav" aria-current={on ? 'page' : undefined} onClick={onClick} onContextMenu={onContextMenu} title={title ?? label}
      aria-expanded={tree?.hasChildren ? tree.open : undefined} style={depth || tree ? { paddingLeft: (tree ? 2 : 9) + depth * 14 } : undefined}
      onKeyDown={(e) => {
        if (!tree?.hasChildren) return
        if ((e.key === 'ArrowRight' && !tree.open) || (e.key === 'ArrowLeft' && tree.open)) { e.preventDefault(); e.stopPropagation(); tree.onToggle() }
      }}>
      {tree && (
        <span className={`plan-chev ${tree.hasChildren ? '' : 'leaf'} ${tree.open ? 'open' : ''}`} aria-hidden="true"
          onClick={(e) => { if (!tree.hasChildren) return; e.stopPropagation(); tree.onToggle() }}>
          {tree.hasChildren && <Icon.forward />}
        </span>
      )}
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

/** A colour per kind of file, for the badge shown where Finder's icon is not available (phones). */
const TYPE_COLORS: [RegExp, string][] = [
  [/^pdf$/, '#e5484d'], [/^(docx?|pages|rtf|odt)$/, '#2b7cd3'], [/^(xlsx?|numbers|csv|tsv|ods)$/, '#1f9d55'], [/^(pptx?|key|odp)$/, '#e8702a'],
  [/^(png|jpe?g|gif|heic|webp|svg|tiff?|bmp)$/, '#8e4ec6'], [/^(zip|gz|tgz|tar|7z|rar|dmg)$/, '#a16207'], [/^(md|txt|log|rtfd)$/, '#64748b'],
  [/^(js|ts|tsx|jsx|py|sh|json|ya?ml|xml|html?|css|java|go|rb|sql|c|cpp|h|swift|kt|rs|ps1|bat)$/, '#0e7490']
]
export const typeColor = (ext: string): string => TYPE_COLORS.find(([re]) => re.test(ext))?.[1] ?? '#6b7280'

/** Finder's icon for each file's type (Mac app only), fetched once per path for the page. */
const fileIcons = new Map<string, string>()
export function useFileIcons(paths: string[]): Map<string, string> {
  const [, setTick] = useState(0)
  const want = paths.filter((p) => !fileIcons.has(p)).slice(0, 400)
  const key = want.join('\u0000')
  useEffect(() => {
    if (!want.length || !hasBrowser()) return
    for (const p of want) fileIcons.set(p, '')
    void window.api.invoke('launcher:icons', want).then((icons) => {
      for (const [p, url] of Object.entries(icons)) fileIcons.set(p, url)
      setTick((n) => n + 1)
    }, () => undefined)
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return fileIcons
}
