import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { WebLogin } from '@shared/types'
import { hostOf, matchesWords } from '@shared/browser'
import { useStore } from '../../store'
import { Icon } from '../icons'
import { Favicon } from './parts'

const FILLED: Record<string, string> = { username: 'username', password: 'password', code: 'one-time code' }

/**
 * Fill from 1Password: the logins saved for this page's site first, the rest by search. Picking one asks main to type
 * it into the page; the secrets never come to this window.
 */
export default function OnePassword({ pageUrl, webContentsId, onDone }: { pageUrl: string; webContentsId: number; onDone: () => void }): ReactElement {
  const toast = useStore((s) => s.toast)
  const stayApproved = useStore((s) => s.settings?.onePasswordStayApproved ?? true)
  const [logins, setLogins] = useState<WebLogin[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [filling, setFilling] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const load = (refresh = false): void => {
    setError(null)
    setLogins(null)
    window.api.invoke('browser:logins', pageUrl, refresh).then(setLogins, (e: Error) => setError(e.message))
  }
  useEffect(() => { load(); input.current?.focus() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setSel(0), [query])

  const list = useMemo(() => {
    if (!logins) return []
    const q = query.trim()
    const hit = (l: WebLogin): boolean => matchesWords(q, l.title, l.username, l.vault, ...l.urls)
    return [...logins.filter((l) => l.matches && hit(l)), ...(q ? logins.filter((l) => !l.matches && hit(l)).slice(0, 40) : [])]
  }, [logins, query])

  const fill = async (l: WebLogin | undefined): Promise<void> => {
    if (!l || filling) return
    if (!l.matches && !window.confirm(`"${l.title}" is saved for ${l.urls.map(hostOf).join(', ') || 'no website'}, not ${hostOf(pageUrl)}. Fill it into this page anyway?`)) return
    setFilling(l.id)
    try {
      const filled = await window.api.invoke('browser:fill', webContentsId, l.account, l.id, !l.matches)
      if (filled.length) toast('success', `Filled the ${filled.map((f) => FILLED[f] ?? f).join(' and ')} from 1Password`)
      else toast('info', 'No login fields on this page yet. Click into the login form and try again.')
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setFilling(null)
    }
  }

  return (
    <div className="op">
      <div className="op-head">
        <span className="op-logo"><Icon.key /></span>
        <span className="flex-1 font-semibold">1Password</span>
        <button type="button" className="web-ico sm" title="Reload the list from 1Password" aria-label="Reload logins" onClick={() => load(true)}><Icon.refresh /></button>
      </div>
      <div className="op-search">
        <Icon.search />
        <input
          ref={input}
          value={query}
          placeholder="Search all logins"
          aria-label="Search 1Password logins"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(i + 1, list.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)) }
            else if (e.key === 'Enter') { e.preventDefault(); void fill(list[sel]) }
          }}
        />
      </div>
      {error && <div className="op-msg error">{error}</div>}
      {!logins && !error && <div className="op-msg"><span className="web-spinner" /> Asking 1Password for your logins… approve once for each 1Password account if it asks.</div>}
      {logins && !list.length && !error && (
        <div className="op-msg muted">{query.trim() ? 'No login matches.' : `No login saved for ${hostOf(pageUrl)}. Search to pick another one.`}</div>
      )}
      <div className="op-list">
        {list.map((l, i) => (
          <button
            key={`${l.account}/${l.id}`}
            type="button"
            className={`op-row ${i === sel ? 'on' : ''}`}
            onMouseMove={() => { if (sel !== i) setSel(i) }}
            onClick={() => void fill(l)}
            disabled={!!filling}
          >
            <Favicon url={l.urls[0] ?? ''} size={18} />
            <span className="min-w-0 flex-1">
              <span className="op-title">{l.title}</span>
              <span className="op-sub">{[l.username, l.vault].filter(Boolean).join(' · ')}{l.matches ? '' : ` · ${hostOf(l.urls[0] ?? '') || 'no website'}`}</span>
            </span>
            {filling === l.id ? <span className="web-spinner" /> : i === sel && <span className="cmdbar-hint">Fill ↩</span>}
          </button>
        ))}
      </div>
      {/* 1Password lets an approval lapse after ten idle minutes; this keeps the ones given in this run (main/onepassword.ts). */}
      <label className="op-foot" title="1Password's CLI forgets an approval after ten minutes without use. With this on, the app keeps the approvals you give while it is open, so you are asked once per 1Password account each time the app starts (up to 12 hours).">
        <input type="checkbox" checked={stayApproved} onChange={(e) => void useStore.getState().saveSettings({ onePasswordStayApproved: e.target.checked })} />
        <span>Stay approved while the app is open <span className="muted">· ask once per account</span></span>
      </label>
    </div>
  )
}
