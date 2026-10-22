import { useEffect, useRef, useState, type ReactElement } from 'react'
import { storeIdOf, type ExtensionInfo } from '@shared/extensions'
import { useStore } from '../../store'
import { Icon } from '../icons'

/**
 * The Browser's extensions (the puzzle button): what is installed, on or off, each one's popup shown here in the space
 * it runs in, its options page, and adding one from the Chrome Web Store (a link, or the store page open in this
 * Browser) or a folder. Choosing one is Chrome's toolbar click: main asks the extension for its popup, and one with
 * none set gets the click instead and the panel closes (1Password, signed out, opens its sign-in page in a tab).
 * main/extensions.ts loads them; src/shared/extensions.ts says what Electron lets them do.
 */

type View = { kind: 'list' } | { kind: 'page'; ext: ExtensionInfo; url: string; title: string; wide: boolean }

export default function Extensions({ partition, pageUrl, tabId, open, onBrowseStore, onWidth, onClose }: {
  partition: string
  pageUrl: string
  /** Start on this extension's popup (it asked for it, action.openPopup). */
  open?: { id: string; url: string }
  /** The page on screen (its webContents id), handed to an extension that takes the click itself. */
  tabId: number | null
  onBrowseStore: () => void
  onWidth: (px: number | null) => void
  onClose: () => void
}): ReactElement {
  const toast = useStore((s) => s.toast)
  const [list, setList] = useState<ExtensionInfo[] | null>(null)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const storePage = storeIdOf(pageUrl)

  useEffect(() => { void window.api.invoke('ext:list').then(setList, (e: Error) => setError(e.message)) }, [])
  useEffect(() => {
    const x = open && list?.find((e) => e.id === open.id && e.enabled)
    if (x && open) setView({ kind: 'page', ext: x, url: open.url, title: x.name, wide: false })
  }, [open, list])
  useEffect(() => { if (view.kind === 'list') onWidth(null) }, [view.kind]) // eslint-disable-line react-hooks/exhaustive-deps

  const install = async (what: string): Promise<void> => {
    setBusy('install')
    setError(null)
    try {
      const x = await window.api.invoke('ext:install', what)
      setList(await window.api.invoke('ext:list'))
      setInput('')
      toast('success', `${x.name} ${x.version} is installed in every Browser space. Reload a page for it to take effect there.`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const addFolder = async (): Promise<void> => {
    setError(null)
    try {
      const x = await window.api.invoke('ext:addFolder')
      if (x) { setList(await window.api.invoke('ext:list')); toast('success', `${x.name} is loaded from its folder.`) }
    } catch (e) { setError((e as Error).message) }
  }
  const toggle = async (x: ExtensionInfo): Promise<void> => {
    try { setList(await window.api.invoke('ext:setEnabled', x.id, !x.enabled)) } catch (e) { setError((e as Error).message) }
  }
  const press = async (x: ExtensionInfo): Promise<void> => {
    setError(null)
    setBusy(x.id)
    try {
      const url = await window.api.invoke('ext:action', x.id, partition, tabId)
      if (url) setView({ kind: 'page', ext: x, url, title: x.name, wide: false })
      else onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const remove = async (x: ExtensionInfo): Promise<void> => {
    if (!window.confirm(`Remove ${x.name}? Its settings in every space go with it.`)) return
    try { setList(await window.api.invoke('ext:remove', x.id)) } catch (e) { setError((e as Error).message) }
  }

  if (view.kind === 'page') {
    return (
      <div className="ext">
        <div className="ext-head">
          <button type="button" className="web-ico sm" aria-label="Back to extensions" onClick={() => setView({ kind: 'list' })}><Icon.back /></button>
          {view.ext.icon ? <img className="ext-icon" src={view.ext.icon} alt="" /> : <Icon.puzzle />}
          <span className="min-w-0 flex-1 truncate font-semibold">{view.title}</span>
        </div>
        <ExtensionPage partition={partition} url={view.url} wide={view.wide} onWidth={onWidth} onClosed={view.wide ? () => setView({ kind: 'list' }) : onClose} />
      </div>
    )
  }

  const already = storePage ? list?.find((x) => x.id === storePage) : undefined
  return (
    <div className="ext">
      <div className="ext-head">
        <span className="ext-logo"><Icon.puzzle /></span>
        <span className="flex-1 font-semibold">Extensions</span>
      </div>
      {storePage && (
        <div className="ext-store">
          <span className="min-w-0 flex-1">{already ? `${already.name} is installed. Update it to the store's latest version?` : 'Add the extension on this Chrome Web Store page?'}</span>
          <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => void install(pageUrl)}>{busy === 'install' ? 'Installing…' : already ? 'Update' : 'Add'}</button>
        </div>
      )}
      {error && <div className="op-msg error">{error}</div>}
      {list === null && !error && <div className="op-msg"><span className="web-spinner" /> Reading your extensions…</div>}
      {list && !list.length && <div className="op-msg muted">No extensions yet. Add one from the Chrome Web Store below: those that work on the page (dark mode, ad blocking, JSON viewers) work here.</div>}
      <div className="ext-list">
        {list?.map((x) => (
          <div key={x.id} className={`ext-row ${x.enabled ? '' : 'off'}`}>
            {x.icon ? <img className="ext-icon" src={x.icon} alt="" /> : <span className="ext-icon blank"><Icon.puzzle /></span>}
            <button type="button" className="ext-main" disabled={!x.enabled || !(x.popup || x.worker) || !x.runtimeId || !!busy} title={x.popup || x.worker ? `Open ${x.name}` : `${x.name} has no popup; it works on the pages themselves`}
              onClick={() => void press(x)}>
              <span className="op-title">{x.name} <span className="muted">{x.version}</span></span>
              <span className="op-sub" title={x.missing.length ? `Electron does not give extensions: ${x.missing.join(', ')}` : undefined}>
                {x.access.all ? 'Reads and changes every site' : x.access.hosts.length ? `Reads and changes ${x.access.hosts.slice(0, 2).join(', ')}${x.access.hosts.length > 2 ? ` and ${x.access.hosts.length - 2} more` : ''}` : 'No site access'}
                {x.source === 'folder' ? ' · from a folder' : ''}{x.missing.length ? ` · no ${x.missing[0]}${x.missing.length > 1 ? '…' : ''}` : ''}
              </span>
            </button>
            {x.options && x.enabled && x.runtimeId && <button type="button" className="web-ico sm" title="Options" aria-label={`${x.name} options`} onClick={() => setView({ kind: 'page', ext: x, url: `chrome-extension://${x.runtimeId}/${x.options!.replace(/^\//, '')}`, title: `${x.name} options`, wide: true })}><Icon.settings /></button>}
            <label className="ext-switch" title={x.enabled ? 'On in every space' : 'Off'}>
              <input type="checkbox" checked={x.enabled} aria-label={`${x.name} on`} onChange={() => void toggle(x)} />
            </label>
            <button type="button" className="web-ico sm" title="Remove" aria-label={`Remove ${x.name}`} onClick={() => void remove(x)}><Icon.x /></button>
          </div>
        ))}
      </div>
      <form className="ext-add" onSubmit={(e) => { e.preventDefault(); if (input.trim()) void install(input) }}>
        <input className="input" value={input} placeholder="Chrome Web Store link or extension id" aria-label="Chrome Web Store link or extension id" spellCheck={false} onChange={(e) => setInput(e.target.value)} />
        <button type="submit" className="btn btn-sm" disabled={!input.trim() || !!busy}>{busy === 'install' ? 'Adding…' : 'Add'}</button>
      </form>
      <div className="ext-foot">
        <button type="button" className="hp-link" onClick={onBrowseStore}><Icon.globe /> Browse the Chrome Web Store</button>
        <button type="button" className="hp-link" onClick={() => void addFolder()}><Icon.folder /> Load a folder…</button>
      </div>
    </div>
  )
}

/** An extension's popup or options page, in a webview of the space's own session (where the extension runs). */
function ExtensionPage({ partition, url, wide, onWidth, onClosed }: { partition: string; url: string; wide: boolean; onWidth: (px: number) => void; onClosed: () => void }): ReactElement {
  const closed = useRef(onClosed)
  closed.current = onClosed
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: wide ? 520 : 340, h: wide ? 460 : 280 })
  useEffect(() => {
    const el = document.createElement('webview') as HTMLElement & { executeJavaScript: (code: string) => Promise<unknown> }
    el.setAttribute('partition', partition)
    el.setAttribute('src', url)
    el.className = 'ext-view'
    // A popup sizes itself to its content, as Chrome's do (within Chrome's own 800 × 600).
    const fit = (): void => {
      void el.executeJavaScript('[document.documentElement.scrollWidth, document.documentElement.scrollHeight]').then((v) => {
        const [w, h] = v as [number, number]
        if (!wide && w && h) setSize({ w: Math.max(240, Math.min(420, w)), h: Math.max(120, Math.min(560, h)) })
      }, () => undefined)
    }
    el.addEventListener('dom-ready', () => { fit(); setTimeout(fit, 400) })
    // window.close() in the page: Chrome closes a popup that does it (1Password's, once it is unlocked and used).
    el.addEventListener('close', () => closed.current())
    box.current?.appendChild(el)
    return () => { el.remove() }
  }, [partition, url, wide])
  // The popover takes the page's width (the margins included).
  useEffect(() => onWidth(size.w + 12), [size.w]) // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="ext-view-box" ref={box} style={{ width: size.w, height: size.h }} />
}
