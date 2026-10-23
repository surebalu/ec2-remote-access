import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import type { AppHotkey, Settings } from '@shared/types'
import { checkGlobalCombo, comboOf, formatCombo } from '@shared/keyCombos'
import { cleanAppHotkey, otherGlobalKeys } from '@shared/hotkeys'
import { GROUP_ABOUT, LAYOUT_GROUPS, SUGGESTED_WINDOW_KEYS, WINDOW_LAYOUTS, type WindowLayout } from '@shared/windowLayouts'
import type { LauncherApp } from '@shared/launcher'
import { useStore } from '../store'
import { voice } from '../voice'
import LayoutGlyph from './LayoutGlyph'
import { Icon } from './icons'

/**
 * Settings → Windows (Mac app only): keys that work in every app, as Raycast's and Rectangle's do. One for any window
 * layout (src/shared/windowLayouts.ts: halves, thirds, fourths, sixths, ninths… for a large display) and one for any
 * app, which opens it or hides it when it is already in front. Changes apply at once (main/desktopKeys.ts) and go into
 * the draft too, so Save keeps them. Moving windows needs the Accessibility permission; the keys themselves do not.
 */

type Status = { helper: boolean; accessibility: boolean; keys: { id: string; combo: string; registered: boolean }[] }

const heldMods = (e: KeyboardEvent): string => `${e.ctrlKey ? '⌃' : ''}${e.altKey ? '⌥' : ''}${e.shiftKey ? '⇧' : ''}${e.metaKey ? '⌘' : ''}`

function Group({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }): ReactElement {
  return (
    <section className="set-group">
      <h3 className="set-group-title">{title}</h3>
      {hint && <p className="set-group-hint">{hint}</p>}
      <div className="set-card">{children}</div>
    </section>
  )
}

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }): ReactElement {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-label">{label}</div>
        {hint && <div className="set-hint">{hint}</div>}
      </div>
      {children !== undefined && <div className="set-control">{children}</div>}
    </div>
  )
}

export default function WindowSettings({ draft, onPatch }: { draft: Settings; onPatch: (patch: Partial<Settings>) => Promise<void> }): ReactElement {
  const toast = useStore((s) => s.toast)
  const [st, setSt] = useState<Status | null>(null)
  /** 'window:<layout>' or 'app:<id>' while its key is being recorded. */
  const [recording, setRecording] = useState<string | null>(null)
  const [held, setHeld] = useState('')
  const [notice, setNotice] = useState<{ id: string; text: string; error?: boolean } | null>(null)
  const [apps, setApps] = useState<LauncherApp[] | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [icons, setIcons] = useState<Record<string, string>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({ Halves: true, Thirds: true })

  const windowKeys = draft.windowKeys ?? {}
  const appHotkeys = draft.appHotkeys ?? []

  const refresh = (): void => void window.api.invoke('wm:status').then((x) => setSt({ helper: x.helper, accessibility: x.accessibility, keys: x.keys }), () => undefined)
  useEffect(refresh, [])
  // Back from System Settings with the permission changed: show it without reopening the dialog.
  useEffect(() => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  useEffect(() => {
    const paths = appHotkeys.map((h) => h.path).filter((p) => icons[p] === undefined)
    if (paths.length) void window.api.invoke('launcher:icons', paths).then((found) => setIcons((cur) => ({ ...cur, ...Object.fromEntries(paths.map((p) => [p, found[p] ?? ''])) })), () => undefined)
  }, [appHotkeys.map((h) => h.path).join('\n')]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = (patch: Partial<Settings>): void => { void onPatch(patch).then(refresh, (e: Error) => toast('error', e.message)) }
  const setWindowKey = (id: string, combo: string): void => {
    const next = { ...windowKeys }
    if (combo) next[id] = combo
    else delete next[id]
    save({ windowKeys: next })
  }
  const setAppKey = (id: string, combo: string): void => save({ appHotkeys: appHotkeys.map((h) => (h.id === id ? cleanAppHotkey({ ...h, combo }) : h)) })

  const stop = (): void => {
    setRecording(null)
    setHeld('')
  }

  // While a key is recorded every key that works from any app is let go, or pressing it would do its job instead.
  useEffect(() => {
    if (!recording) return
    void window.api.invoke('launcher:pause', true).catch(() => undefined)
    return () => void window.api.invoke('launcher:pause', false).then(refresh, () => undefined)
  }, [!!recording]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!recording) return
    const apply = (combo: string): void => {
      if (recording.startsWith('window:')) setWindowKey(recording.slice(7), combo)
      else setAppKey(recording.slice(4), combo)
    }
    const down = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
      if (plain && e.key === 'Escape') return stop()
      if (plain && (e.key === 'Backspace' || e.key === 'Delete')) {
        apply('')
        setNotice(null)
        return stop()
      }
      const combo = comboOf({ code: e.code, key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey })
      if (!combo) return setHeld(heldMods(e))
      voice.cancel()
      if (e.repeat) return
      const check = checkGlobalCombo(combo, draft.shortcuts, { others: otherGlobalKeys(draft, recording) })
      if (!check.ok) {
        setHeld('')
        setNotice({ id: recording, text: check.reason, error: true })
        return
      }
      apply(combo)
      setNotice(check.notes.length ? { id: recording, text: check.notes.join(' ') } : null)
      stop()
    }
    const up = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
      setHeld(heldMods(e))
    }
    const away = (e: MouseEvent): void => {
      if (!(e.target instanceof Element && e.target.closest('.key-field.recording'))) stop()
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('mousedown', away, true)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('mousedown', away, true)
    }
  }, [recording, draft]) // eslint-disable-line react-hooks/exhaustive-deps

  const taken = (id: string): boolean => !!st?.keys.some((k) => k.id === id && !k.registered)
  const field = (id: string, name: string, value: string): ReactElement => {
    const rec = recording === id
    return (
      <div className="flex items-center gap-1" data-shortcut-row={id}>
        <button type="button" className={`key-field ${rec ? 'recording' : ''} ${value ? '' : 'empty'}`} aria-label={`Key for ${name}`}
          title={rec ? 'Press the keys; Esc stops, ⌫ removes the key' : 'Click, then press the keys'}
          onClick={() => { setNotice(null); if (rec) stop(); else { setHeld(''); setRecording(id) } }}>
          {rec ? (held ? <kbd className="kbd">{held}</kbd> : <span>Press keys…</span>) : value ? <kbd className="kbd">{formatCombo(value)}</kbd> : <span>None</span>}
        </button>
        <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`Remove the key for ${name}`} title="Remove" disabled={!value || rec}
          onClick={() => { setNotice(null); if (id.startsWith('window:')) setWindowKey(id.slice(7), ''); else setAppKey(id.slice(4), '') }}><Icon.x /></button>
      </div>
    )
  }
  const hintFor = (id: string, normal?: ReactNode, combo?: string): ReactNode => {
    if (notice?.id === id) return <span className={notice.error ? 'set-key-error' : 'set-key-note'}>{notice.text}</span>
    if (combo && taken(id)) return <span className="set-key-error">macOS did not give the app {formatCombo(combo)}: another app (Raycast, Rectangle?) holds it. Free it there, or pick another key.</span>
    return normal
  }

  const suggest = (): void => {
    const next = { ...windowKeys }
    const skipped: string[] = []
    for (const [id, combo] of Object.entries(SUGGESTED_WINDOW_KEYS)) {
      if (next[id]) continue
      const check = checkGlobalCombo(combo, draft.shortcuts, { others: otherGlobalKeys({ ...draft, windowKeys: next }, `window:${id}`) })
      if (check.ok) next[id] = combo
      else skipped.push(formatCombo(combo))
    }
    save({ windowKeys: next })
    if (skipped.length) toast('info', `Left out ${skipped.join(', ')}: already used by another key.`)
  }

  const layoutRow = (l: WindowLayout): ReactElement => {
    const id = `window:${l.id}`
    return (
      <Row key={l.id} label={<span className="flex items-center gap-2"><LayoutGlyph layout={l} size={22} />{l.name}</span>} hint={hintFor(id, undefined, windowKeys[l.id])}>
        {field(id, l.name, windowKeys[l.id] ?? '')}
      </Row>
    )
  }

  const addApp = (a: LauncherApp): void => {
    if (appHotkeys.some((h) => h.path === a.path)) { setAdding(null); return }
    const h: AppHotkey = { id: `app-${Date.now().toString(36)}`, path: a.path, name: a.name, combo: '' }
    save({ appHotkeys: [...appHotkeys, h] })
    setAdding(null)
    setNotice(null)
    setRecording(`app:${h.id}`)
  }
  const matches = useMemo(() => {
    if (adding === null || !apps) return []
    const q = adding.trim().toLowerCase()
    return apps.filter((a) => !appHotkeys.some((h) => h.path === a.path) && (!q || a.name.toLowerCase().includes(q))).slice(0, 8)
  }, [adding, apps, appHotkeys])

  const keyCount = Object.values(windowKeys).filter(Boolean).length
  const access: ReactNode = !st ? 'Checking…'
    : !st.helper ? <span className="set-key-error">This build has no window helper. Run scripts/build-native.sh (it needs Xcode’s Swift compiler) and restart the app.</span>
      : st.accessibility ? 'Allowed: the keys and the launcher’s Window Management commands move the window in front.'
        : <span className="set-key-error">Not allowed yet. macOS lets an app move other apps’ windows only once it is on in Privacy & Security → Accessibility.</span>

  return (
    <>
      <Group title="Window control">
        <Row label={<span className="flex items-center gap-2"><Icon.shield className="set-key-icon" />Accessibility</span>} hint={access}>
          {st?.helper && !st.accessibility && (
            <div className="flex items-center gap-2">
              <button className="btn btn-primary" onClick={() => void window.api.invoke('wm:askAccess').then((ok) => { refresh(); if (!ok) void window.api.invoke('wm:openPrivacy', 'accessibility') }, (e: Error) => toast('error', e.message))}>Allow…</button>
              <button className="btn btn-ghost" onClick={() => void window.api.invoke('wm:openPrivacy', 'accessibility')}>Open Privacy Settings</button>
            </div>
          )}
        </Row>
        <Row label="Gap between windows" hint="Points left between windows placed side by side and around the screen’s edge. 0 fills the screen exactly.">
          <div className="flex items-center gap-2">
            <input type="range" min={0} max={40} step={2} value={draft.windowGap ?? 0} aria-label="Gap between windows" onChange={(e) => save({ windowGap: Number(e.target.value) })} />
            <span className="mono w-10 text-right text-[12px]">{draft.windowGap ?? 0} pt</span>
          </div>
        </Row>
        <Row label="Keys" hint={`${keyCount} of ${WINDOW_LAYOUTS.length} layouts have a key. Suggested keys are Rectangle’s: ⌃⌥ with ← → ↑ ↓ for halves, U I J K for corners, D F G E T for thirds, ↩ to maximize, ⌃⌥⌘ ← → between displays.`}>
          <div className="flex items-center gap-2">
            <button className="btn" onClick={suggest}>Use suggested keys</button>
            <button className="btn btn-ghost" disabled={!keyCount} onClick={() => { if (window.confirm('Remove every window layout key?')) save({ windowKeys: {} }) }}>Remove all</button>
          </div>
        </Row>
      </Group>

      {LAYOUT_GROUPS.map((g) => {
        const list = WINDOW_LAYOUTS.filter((l) => l.group === g)
        const set = list.filter((l) => windowKeys[l.id]).length
        const shown = open[g] || recording?.startsWith('window:') && list.some((l) => `window:${l.id}` === recording)
        return (
          <section key={g} className="set-group" data-layout-group={g}>
            <button type="button" className="set-group-title set-group-toggle" aria-expanded={!!shown} onClick={() => setOpen((o) => ({ ...o, [g]: !o[g] }))}>
              <Icon.chevron open={!!shown} />{g}<span className="muted">{set ? ` · ${set} with keys` : ''}</span>
            </button>
            <p className="set-group-hint">{GROUP_ABOUT[g]}</p>
            {shown && <div className="set-card">{list.map(layoutRow)}</div>}
          </section>
        )
      })}

      <Group title="App hotkeys" hint="A key that opens an app from anywhere, or hides it when it is already in front, as Raycast’s app hotkeys do.">
        {appHotkeys.map((h) => (
          <Row key={h.id} label={<span className="flex items-center gap-2">{icons[h.path] ? <img className="set-app-icon" src={icons[h.path]} alt="" /> : <Icon.apps className="set-key-icon" />}{h.name}</span>}
            hint={hintFor(`app:${h.id}`, <span className="mono">{h.path}</span>, h.combo)}>
            <div className="flex items-center gap-1">
              {field(`app:${h.id}`, h.name, h.combo)}
              <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${h.name}`} onClick={() => save({ appHotkeys: appHotkeys.filter((x) => x.id !== h.id) })}>Remove</button>
            </div>
          </Row>
        ))}
        <div className="set-row stack">
          {adding === null ? (
            <button type="button" className="btn" onClick={() => { setAdding(''); if (!apps) void window.api.invoke('launcher:apps').then(setApps, () => setApps([])) }}><Icon.plus /> Add an app…</button>
          ) : (
            <div className="set-app-pick">
              <input className="input" autoFocus placeholder="Type an app’s name: Slack, Warp, Safari…" aria-label="Find an app" value={adding}
                onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setAdding(null); if (e.key === 'Enter' && matches[0]) addApp(matches[0]) }} />
              <div className="set-app-list" role="listbox" aria-label="Apps">
                {!apps && <span className="muted">Reading the apps on this Mac…</span>}
                {matches.map((a) => <button key={a.path} type="button" role="option" aria-selected={false} onClick={() => addApp(a)}>{a.name}<span className="muted">{a.path.replace(/\/[^/]+$/, '')}</span></button>)}
                {apps && !matches.length && <span className="muted">No app by that name.</span>}
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(null)}>Cancel</button>
            </div>
          )}
        </div>
      </Group>
    </>
  )
}
