import type { ReactElement, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons'

export interface Suggestion {
  id: string
  /** Heading of the group it is listed under ("Tabs", "AWS", "History"). */
  group: string
  title: string
  subtitle?: string
  icon: ReactNode
  /** Short label on the right ("Switch", "Open"). */
  hint?: string
  /** `newTab` is true for ⌘↩ (or when the bar was opened for a new tab). */
  run: (newTab: boolean) => void
}

/**
 * The browser's command bar (⌘T, ⌘L): an address field whose suggestions mix open tabs, the AWS console of every
 * account, history, spaces and browser actions, all reachable from the keyboard. `inline` renders it in the start
 * page instead of floating over the page.
 */
export default function CommandBar({ initial, newTab, suggest, onClose, inline = false, focusKey }: {
  initial: string
  newTab: boolean
  suggest: (query: string) => Suggestion[]
  onClose: () => void
  inline?: boolean
  /** Changing it focuses the field again (⌘T while the start page shows the inline bar). */
  focusKey?: number
}): ReactElement {
  const [query, setQuery] = useState(initial)
  const [sel, setSel] = useState(0)
  const [open, setOpen] = useState(!inline)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // Inline (start page) suggestions appear once something is typed, so the page's own tiles stay visible.
  const items = useMemo(() => (open && (!inline || query.trim()) ? suggest(query) : []), [open, inline, query, suggest])

  useEffect(() => {
    if (inline && focusKey === undefined) return
    const el = input.current
    if (!el) return
    el.focus()
    el.select()
  }, [inline, focusKey])
  useEffect(() => setSel(0), [query])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const run = (s: Suggestion | undefined, toNew: boolean): void => {
    if (!s) return
    onClose()
    if (inline) {
      setQuery('')
      setOpen(false)
    }
    s.run(toNew)
  }
  const close = (): void => {
    if (inline) {
      setOpen(false)
      setQuery('')
      input.current?.blur()
    }
    onClose()
  }

  let lastGroup = ''
  const body = (
    <div className={`cmdbar ${inline ? 'inline' : 'floating'} ${items.length ? 'has-items' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
      <div className="cmdbar-field">
        <Icon.search />
        <input
          ref={input}
          value={query}
          spellCheck={false}
          placeholder="Search or enter address"
          aria-label="Search or enter address"
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(i + 1, items.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)) }
            else if (e.key === 'Enter') { e.preventDefault(); run(items[sel], newTab || e.metaKey) }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
          }}
        />
        {!inline && <kbd className="cmdbar-kbd">esc</kbd>}
      </div>
      {items.length > 0 && (
        <div ref={list} className="cmdbar-list" role="listbox">
          {items.map((s, i) => {
            const head = s.group !== lastGroup ? s.group : ''
            lastGroup = s.group
            return (
              <div key={s.id}>
                {head && <div className="cmdbar-group">{head}</div>}
                <button
                  type="button"
                  data-i={i}
                  role="option"
                  aria-selected={i === sel}
                  className={`cmdbar-item ${i === sel ? 'on' : ''}`}
                  onMouseMove={() => { if (sel !== i) setSel(i) }}
                  onClick={(e) => run(s, newTab || e.metaKey)}
                >
                  <span className="cmdbar-icon">{s.icon}</span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="cmdbar-title">{s.title}</span>
                    {s.subtitle && <span className="cmdbar-sub">{s.subtitle}</span>}
                  </span>
                  {i === sel && <span className="cmdbar-hint">{s.hint ?? 'Open'} ↩</span>}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
  if (inline) return body
  return (
    <div className="cmdbar-backdrop" onMouseDown={close}>
      {body}
    </div>
  )
}
