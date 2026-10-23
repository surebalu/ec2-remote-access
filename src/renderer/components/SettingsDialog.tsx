import type { ReactElement, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import type { AppAbout, DataStatus, DictationKey, NotesInfo, Settings, VoicePermission, VoiceStatus } from '@shared/types'
import { agoLabel } from '@shared/dataFolder'
import { DEFAULT_SERVICES, isUnitName, type ServiceDef } from '@shared/services'
import { checkCombo, checkGlobalCombo, comboOf, DEFAULT_SHORTCUTS, formatCombo, RAIL_SECTIONS, SECTION_NAMES, SHORTCUT_TARGETS, sectionKeys, TARGET_NAMES, type RailSection, type ShortcutTarget } from '@shared/keyCombos'
import { CAN_DICTATE, voice } from '../voice'
import { useStore } from '../store'
import Modal from './Modal'
import { ACCENTS, metaFor } from '../colors'
import type { AccentColor } from '@shared/types'
import { TERMINAL_THEMES, TERMINAL_FONTS, COLOR_PROMPT_PRESET, resolveTerminalTheme, terminalBackdrop, terminalFontFamily, DEFAULT_TERMINAL_FONT_SIZE } from '../terminalThemes'
import { isDarkMode, MAC_TOOLS } from '../store'
import PhoneAccessSection from './PhoneAccessSection'
import QuicklinkSettings from './QuicklinkSettings'
import WindowSettings from './WindowSettings'
import { otherGlobalKeys } from '@shared/hotkeys'
import { APP_THEMES, effectiveScheme, type AppTheme } from '../appThemes'
import { DEFAULT_UI_FONT, UI_FONTS } from '../uiFont'
import { ZOOM_SECTIONS } from '../sectionZoom'
import { ZoomStepper } from './ZoomControls'
import { Icon } from './icons'

type SectionId = 'general' | 'accounts' | 'ssh' | 'terminal' | 'notes' | 'data' | 'keyboard' | 'windows' | 'launcher' | 'voice' | 'services' | 'phone' | 'requirements' | 'about'

const SECTIONS: { id: SectionId; label: string; blurb: string; icon: (p: { className?: string }) => ReactElement }[] = [
  { id: 'general', label: 'General', blurb: 'Appearance, how hosts are found and how connections are routed.', icon: Icon.settings },
  { id: 'accounts', label: 'Accounts', blurb: 'A name, a colour and SSH defaults for each AWS account.', icon: Icon.cloud },
  { id: 'ssh', label: 'SSH & RDP', blurb: 'Users, keys and the SSH agent used when a host has no settings of its own.', icon: Icon.key },
  { id: 'terminal', label: 'Terminal', blurb: 'How SSH tabs look, what runs when they connect, and recordings.', icon: Icon.terminal },
  { id: 'notes', label: 'Notes', blurb: 'Where your Markdown notes live.', icon: Icon.note },
  { id: 'data', label: 'Data', blurb: 'Where what you make in the app is kept, and a copy on your NAS.', icon: Icon.disk },
  { id: 'keyboard', label: 'Keyboard', blurb: 'Your own shortcut for each section down the left edge, Claude and ChatGPT included.', icon: Icon.keyboard },
  { id: 'windows', label: 'Windows', blurb: 'Keys that put the window in front on a half, a third or a ninth of the screen, and keys that open your apps, from any app.', icon: Icon.grid },
  { id: 'launcher', label: 'Launcher', blurb: 'Quicklinks: a word you type in the launcher to open a page. The launcher’s own key is under Keyboard.', icon: Icon.launcher },
  { id: 'voice', label: 'Voice', blurb: 'Talk instead of typing, wherever you type in the app.', icon: Icon.mic },
  { id: 'services', label: 'Services', blurb: 'The 3DEXPERIENCE services, and the systemd units service control starts, stops and restarts.', icon: Icon.layers },
  { id: 'phone', label: 'Phone & iPad', blurb: 'Use this Mac’s sessions from your iPhone or iPad.', icon: Icon.phone },
  { id: 'requirements', label: 'Requirements', blurb: 'The command-line tools the app uses, and where they are.', icon: Icon.plug },
  { id: 'about', label: 'About', blurb: 'Version, privacy and where your data is kept.', icon: Icon.info }
]

const LAST_SECTION = 'ui.settingsSection'
/** The Mac app itself, not a browser on the gateway (the menu-bar icon belongs to the Mac). */
const IN_ELECTRON = /\bElectron\//.test(navigator.userAgent)

/** A group of rows on a card, as in System Settings. */
function Group({ title, children }: { title?: string; children: ReactNode }): ReactElement {
  return (
    <section className="set-group">
      {title && <h3 className="set-group-title">{title}</h3>}
      <div className="set-card">{children}</div>
    </section>
  )
}

/** One setting: its name and an explanation on the left, the control on the right (or underneath with `stack`). */
function Row({ label, hint, children, stack = false }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; stack?: boolean }): ReactElement {
  return (
    <div className={`set-row ${stack ? 'stack' : ''}`}>
      <div className="set-text">
        <div className="set-label">{label}</div>
        {hint && <div className="set-hint">{hint}</div>}
      </div>
      {children !== undefined && <div className="set-control">{children}</div>}
    </div>
  )
}

/** The default look's tokens (styles.css), for the Default card while a colour theme repaints the real ones. */
const DEFAULT_LOOK = {
  light: { '--bg': '#f3f4f7', '--bg-elev': '#f9fafb', '--panel': '#ffffff', '--border': '#e5e7ec', '--text': '#0d1424', '--muted': '#6a7389', '--accent': '#5b5fd6' },
  dark: { '--bg': '#0a0b0f', '--bg-elev': '#0e1015', '--panel': '#12141a', '--border': '#22252e', '--text': '#e8eaf0', '--muted': '#737c90', '--accent': '#7c80f2' }
}

/** A miniature of the app in a colour theme: rail, sidebar with rows, a terminal with output, and a button. */
function ThemePreview({ theme, on, onPick, appDark }: { theme: AppTheme | null; on: boolean; onPick: () => void; appDark: boolean }): ReactElement {
  const k: Record<string, string> = theme?.tokens ?? DEFAULT_LOOK[appDark ? 'dark' : 'light']
  const scheme = theme ? TERMINAL_THEMES.find((x) => x.id === theme.scheme) : undefined
  const term = scheme?.theme ?? resolveTerminalTheme('auto', appDark)
  return (
    <button type="button" role="radio" aria-checked={on} className={`ctheme ${on ? 'on' : ''}`} data-color-theme-option={theme?.id ?? 'default'} title={theme ? theme.name : 'The standard colours, following Auto / Light / Dark'} onClick={onPick}>
      <span className="ctheme-preview" style={{ background: k['--bg'], borderColor: k['--border'] }}>
        <span className="ctheme-rail" style={{ background: k['--bg-elev'], borderColor: k['--border'] }}>
          <i style={{ background: k['--accent'] }} /><i style={{ background: k['--muted'] }} /><i style={{ background: k['--muted'] }} />
        </span>
        <span className="ctheme-side" style={{ background: k['--panel'], borderColor: k['--border'] }}>
          <i style={{ background: k['--text'], width: '70%' }} /><i style={{ background: k['--muted'], width: '50%' }} /><i style={{ background: k['--muted'], width: '62%' }} />
        </span>
        <span className="ctheme-main" style={{ background: scheme?.backdrop ?? term.background }}>
          <i style={{ background: term.green ?? term.foreground, width: '58%' }} /><i style={{ background: term.foreground, width: '40%' }} /><i style={{ background: term.blue ?? term.foreground, width: '48%' }} />
          <b style={{ background: k['--accent'] }} />
        </span>
      </span>
      <span className="ctheme-name">{theme ? theme.name : 'Default'}</span>
    </button>
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }): ReactElement {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track"><span className="switch-thumb" /></span>
    </label>
  )
}

const PERMISSION_TEXT: Record<VoicePermission, string> = {
  authorized: 'Allowed',
  denied: 'Off',
  restricted: 'Blocked by a policy',
  notDetermined: 'macOS asks the first time you dictate',
  unknown: 'Unknown'
}

function languageName(tag: string): string {
  try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(tag) ?? tag } catch { return tag }
}

/** Settings → Voice: the hold-to-talk key, the language, and what macOS allows, asked of the helper without prompting. */
function VoiceSettings({ draft, upd }: { draft: Settings; upd: <K extends keyof Settings>(k: K, v: Settings[K]) => void }): ReactElement {
  const [st, setSt] = useState<VoiceStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const locale = draft.dictationLocale ?? ''
  const refresh = (): void => {
    setError(null)
    void window.api.invoke('voice:status', { locale }).then(setSt, (e: Error) => setError(e.message))
  }
  useEffect(refresh, [locale]) // eslint-disable-line react-hooks/exhaustive-deps
  // Back from System Settings with the permission changed: show it without reopening the dialog.
  useEffect(() => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }) // eslint-disable-line react-hooks/exhaustive-deps
  const key = draft.dictationKey ?? 'AltRight'
  const permission = (p: VoicePermission | undefined, pane: 'microphone' | 'speech'): ReactElement => (
    <div className="flex items-center gap-2">
      <span className={`set-status ${!p ? '' : p === 'authorized' ? 'ok' : p === 'notDetermined' ? '' : 'warn'}`}>
        <span className="dot" />
        {p ? PERMISSION_TEXT[p] : 'Checking…'}
      </span>
      {(p === 'denied' || p === 'restricted') && (
        <button className="btn btn-sm" onClick={() => void window.api.invoke('voice:openPrivacy', pane).catch((e: Error) => useStore.getState().toast('error', e.message))}>Open Privacy Settings…</button>
      )}
    </div>
  )
  const systemLocale = st && !locale ? st.locale : ''
  return (
    <>
      <Group>
        <Row label="Hold to talk" hint={<>Hold the key by itself, speak, and let go to type what you said where the cursor is. Esc cancels. Combinations with the key keep working.</>}>
          <select className="input w-56" aria-label="Dictation key" value={key} onChange={(e) => upd('dictationKey', e.target.value as DictationKey)}>
            <option value="AltRight">Right Option (⌥)</option>
            <option value="MetaRight">Right Command (⌘)</option>
            <option value="Fn">Fn / Globe (if the keyboard reports it)</option>
            <option value="off">Off: mic buttons only</option>
          </select>
        </Row>
        <Row label="Language" hint={st?.onDevice ? 'Recognised on this Mac: the audio never leaves it.' : st ? 'Apple’s speech service recognises this language (macOS has no on-device model for it).' : 'What you speak.'}>
          <select className="input w-56" aria-label="Dictation language" value={locale} onChange={(e) => upd('dictationLocale', e.target.value)}>
            <option value="">Same as macOS{systemLocale ? ` (${languageName(systemLocale)})` : ''}</option>
            {(st?.locales ?? []).map((l) => <option key={l} value={l}>{languageName(l)} · {l}</option>)}
            {locale && !(st?.locales ?? []).includes(locale) && <option value={locale}>{locale}</option>}
          </select>
        </Row>
        <Row label="Mic buttons" hint="In the Notes toolbar, Run Command, SSH tabs and the Terminal: click to talk, click again (or Done) to insert." />
      </Group>
      <Group title="Permissions">
        {(error || (st && !st.available && st.message)) && (
          <div className="set-row"><div className="set-text"><div className="set-hint" style={{ color: 'var(--warn)' }}>{error ?? st?.message}</div></div></div>
        )}
        <Row label="Microphone" hint="Only on while you dictate.">{permission(st?.mic, 'microphone')}</Row>
        <Row label="Speech recognition" hint="Turns what you say into text.">{permission(st?.speech, 'speech')}</Row>
      </Group>
    </>
  )
}

const SECTION_ICONS: Record<RailSection, (p: { className?: string }) => ReactElement> = {
  devtools: Icon.code, tasks: Icon.tasks, calendar: Icon.calendar, links: Icon.bookmark, hosts: Icon.server, overview: Icon.grid, health: Icon.health, local: Icon.console, finder: Icon.finder, storage: Icon.storage, browser: Icon.globe, notes: Icon.note, board: Icon.board, claude: Icon.claude, chatgpt: Icon.chatgpt
}
const SECTION_HINTS: Record<RailSection, string> = {
  devtools: 'Local JSON, encoding, tokens, timestamps and hashes.',
  tasks: 'Today, upcoming and someday to-dos, with projects and tags.',
  calendar: 'Month, week and day, with your tasks and subscribed calendars.',
  links: 'Bookmarks and notes in folders and tags, imported from Anybox.',
  storage: 'Disk space, large files, junk and Recently Removed, as in Strata.',
  hosts: 'Every account’s hosts. ⌘1 always shows them too (Hosts is the first tab).',
  overview: 'Every open session on one page.',
  health: 'The 3DEXPERIENCE platform at a glance.',
  local: 'Shells on this Mac.',
  finder: 'The files on this Mac.',
  browser: 'AWS console spaces and web tabs.',
  notes: 'Your Markdown notes.',
  board: 'The scratch pad.',
  claude: IN_ELECTRON ? 'claude.ai in its own tab, signed in on its own.' : 'Opens claude.ai in a new browser tab.',
  chatgpt: IN_ELECTRON ? 'chatgpt.com in its own tab, signed in on its own.' : 'Opens chatgpt.com in a new browser tab.'
}

const heldMods = (e: KeyboardEvent): string => `${e.ctrlKey ? '⌃' : ''}${e.altKey ? '⌥' : ''}${e.shiftKey ? '⇧' : ''}${e.metaKey ? '⌘' : ''}`

/** What Settings → Keyboard records a key for: a rail section, or the launcher (a key in every app). */
type GlobalTarget = 'launcher' | 'linkSave' | 'linkFind'
type KeyTarget = ShortcutTarget | GlobalTarget
/** The keys that work from any app: the setting each is kept in, what it does there, and its default. */
const GLOBAL_KEYS: Record<GlobalTarget, { field: 'launcherKey' | 'linkSaveKey' | 'linkFindKey'; does: string; fallback: string }> = {
  launcher: { field: 'launcherKey', does: 'opens the launcher', fallback: '' },
  linkSave: { field: 'linkSaveKey', does: 'saves the page in front to Links', fallback: 'ctrl+s' },
  linkFind: { field: 'linkFindKey', does: 'searches Links', fallback: 'ctrl+f' }
}
const isGlobal = (t: KeyTarget | null): t is GlobalTarget => !!t && Object.hasOwn(GLOBAL_KEYS, t)

/**
 * Settings → Keyboard: the launcher's key, which works in every app, and a shortcut for each section of the app
 * rail, recorded by pressing them. Changes apply at once (and go into the draft, so Save keeps them). Only section
 * shortcuts that differ from the defaults are stored.
 */
/**
 * Settings → Data: where the app keeps what you make, and the data folder (main/dataFolder.ts), a share on a NAS that
 * Tasks, Calendar, Links and the whiteboards are merged into whenever it can be reached. Applies at once, outside the
 * Settings draft (Save leaves dataDir alone).
 */
function DataSettings(): ReactElement {
  const [st, setSt] = useState<DataStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, setTick] = useState(0)
  useEffect(() => {
    void window.api.invoke('data:status').then(setSt, () => undefined)
    const off = window.api.on('data:status', setSt)
    // "Synced 2 min ago" moves on by itself.
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => { off(); clearInterval(t) }
  }, [])
  const run = async (fn: () => Promise<DataStatus>): Promise<void> => {
    setError(null)
    setBusy(true)
    try { setSt(await fn()) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const choose = async (): Promise<void> => {
    const dir = await window.api.invoke('data:pickFolder').catch(() => null)
    if (dir) await run(() => window.api.invoke('data:setFolder', dir))
  }
  const stop = (): void => {
    if (window.confirm('Stop keeping a copy in the data folder? Nothing is deleted, there or on this Mac.')) void run(() => window.api.invoke('data:setFolder', ''))
  }
  const dir = st?.dir ?? ''
  const files = st?.linkFiles
  const state: ReactNode = !dir ? null
    : st?.syncing ? 'Syncing…'
      : st?.lastError ? <span className="set-key-error">{st.lastError}</span>
        : st?.lastSync ? `In step: synced ${agoLabel(st.lastSync)}. Syncs a moment after each change and every minute.`
          : 'Not synced yet.'
  return (
    <>
      <Group title="Data folder">
        <Row label={<span className="flex items-center gap-2"><Icon.disk className="set-key-icon" />Folder</span>}
          hint={dir ? <span className="mono">{dir}</span> : 'None. Choose a folder on your NAS (a mounted share, such as /Volumes/home/EC2 Remote Access) and Tasks, Calendar, Links and the whiteboards are kept there too, so another Mac can share them.'}>
          {IN_ELECTRON && (
            <div className="flex items-center gap-2">
              <button className="btn" disabled={busy} onClick={() => void choose()}>{dir ? 'Change…' : 'Choose…'}</button>
              {dir && <button className="btn btn-ghost" disabled={busy} onClick={stop}>Stop using</button>}
              {dir && <button className="btn btn-ghost" onClick={() => void window.api.invoke('data:reveal', 'folder')}>Show</button>}
            </div>
          )}
        </Row>
        {dir && (
          <Row label="State" hint={state}>
            <button className="btn" disabled={busy || st?.syncing} onClick={() => void run(() => window.api.invoke('data:sync'))}>Sync now</button>
          </Row>
        )}
        {dir && IN_ELECTRON && (
          <Row label="Links files" hint={files
            ? files.error ? <span className="set-key-error">{files.error}</span>
              : files.finished ? `Copied ${files.total} files to ${files.to}; the links open the copies. The originals are where they were: delete them once you have checked the copies.`
                : `Copying ${files.done} of ${files.total}…`
            : 'The files Links keeps (those Anybox had) are on this Mac. Copy them into the data folder and the links open the copies there; the originals stay until you delete them.'}>
            <button className="btn" disabled={!!files && !files.finished} onClick={() => void run(() => window.api.invoke('data:copyLinkFiles'))}>Copy to the data folder</button>
          </Row>
        )}
        {error && <div className="set-row"><span className="set-key-error">{error}</span></div>}
      </Group>
      <Group title="Where your data is">
        {(st?.places ?? []).map((p) => (
          <Row key={p.id} label={p.label} hint={<><span className="mono">{p.path}</span>{p.note && <><br />{p.note}</>}</>}>
            {IN_ELECTRON && <button className="btn btn-ghost" onClick={() => void window.api.invoke('data:reveal', p.id)}>Show in Finder</button>}
          </Row>
        ))}
      </Group>
      <Group title="How the data folder works">
        <div className="set-row stack">
          <ul className="set-list">
            <li><Icon.check /><span>This Mac always works from its own copy, so nothing waits on the network and nothing is lost while the NAS is away; they are merged as soon as it is back.</span></li>
            <li><Icon.check /><span>Lists merge item by item: a change made on another Mac and one made here both survive; for the same item, the later change wins (deleting counts as a change).</span></li>
            <li><Icon.check /><span>Whiteboards are copied whole; the later save wins.</span></li>
            <li><Icon.check /><span>Notes are Markdown files in their own folder: to keep them on the NAS, point Settings → Notes (or your Obsidian vault) at a folder there.</span></li>
            <li><Icon.check /><span>Settings, sign-ins and saved passwords stay on this Mac.</span></li>
          </ul>
        </div>
      </Group>
    </>
  )
}

function KeyboardSettings({ draft, onChange, onGlobal }: { draft: Settings; onChange: (shortcuts: Record<string, string>) => void; onGlobal: (field: 'launcherKey' | 'linkSaveKey' | 'linkFindKey', key: string) => Promise<void> }): ReactElement {
  const [recording, setRecording] = useState<KeyTarget | null>(null)
  const [held, setHeld] = useState('')
  const [notice, setNotice] = useState<{ section: KeyTarget; text: string; error?: boolean } | null>(null)
  const [status, setStatus] = useState<{ key: string; registered: boolean } | null>(null)
  const [linkStatus, setLinkStatus] = useState<Record<'save' | 'find', { key: string; registered: boolean }> | null>(null)
  const keys = sectionKeys(draft.shortcuts)
  const sections = RAIL_SECTIONS.filter((x) => IN_ELECTRON || !(MAC_TOOLS as readonly string[]).includes(x))
  const launcherKey = draft.launcherKey ?? ''
  const globalKey = (t: GlobalTarget): string => draft[GLOBAL_KEYS[t].field] ?? GLOBAL_KEYS[t].fallback
  // Every key that works from any app (window layouts' and app hotkeys' too), but the one being recorded.
  const globals = (except?: GlobalTarget): { combo: string; does: string }[] => otherGlobalKeys(draft, except ?? '')

  const refreshStatus = (): void => {
    if (!IN_ELECTRON) return
    void window.api.invoke('launcher:status').then(setStatus, () => undefined)
    void window.api.invoke('linksPanel:status').then(setLinkStatus, () => undefined)
  }
  useEffect(refreshStatus, [])
  const setGlobal = (t: GlobalTarget, key: string): void => { void onGlobal(GLOBAL_KEYS[t].field, key).then(refreshStatus) }

  const assign = (section: ShortcutTarget, combo: string, from?: ShortcutTarget): void => {
    const next = { ...(draft.shortcuts ?? {}) }
    const put = (sec: ShortcutTarget, value: string): void => {
      if (value === (DEFAULT_SHORTCUTS[sec] ?? '')) delete next[sec]
      else next[sec] = value
    }
    if (from) put(from, '')
    put(section, combo)
    onChange(next)
  }
  const stop = (): void => {
    setRecording(null)
    setHeld('')
  }

  // While any key is being recorded the launcher's key is let go, or pressing it would open the launcher instead.
  useEffect(() => {
    if (!recording || !IN_ELECTRON) return
    void window.api.invoke('launcher:pause', true).catch(() => undefined)
    return () => void window.api.invoke('launcher:pause', false).then(refreshStatus, () => undefined)
  }, [!!recording]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!recording) return
    // Window capture, so no app shortcut, dialog or the remote desktop sees the keys being recorded.
    const down = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
      if (plain && e.key === 'Escape') return stop()
      if (plain && (e.key === 'Backspace' || e.key === 'Delete')) {
        if (isGlobal(recording)) setGlobal(recording, '')
        else assign(recording, '')
        setNotice(null)
        return stop()
      }
      const combo = comboOf({ code: e.code, key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey })
      if (!combo) return setHeld(heldMods(e))
      // Holding Right Option a moment before the letter starts dictation; this was a shortcut instead.
      voice.cancel()
      if (e.repeat) return
      const check = isGlobal(recording)
        ? checkGlobalCombo(combo, draft.shortcuts, { others: globals(recording), controlLetters: recording !== 'launcher' })
        : checkCombo(combo, recording, draft.shortcuts, globals())
      if (!check.ok) {
        setHeld('')
        setNotice({ section: recording, text: check.reason, error: true })
        return
      }
      if (isGlobal(recording)) setGlobal(recording, combo)
      else assign(recording, combo, check.from)
      const notes = [...(check.from ? [`Moved from ${TARGET_NAMES[check.from]}, which has no shortcut now.`] : []), ...check.notes]
      setNotice(notes.length ? { section: recording, text: notes.join(' ') } : null)
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
    // Not the window's blur: that fires whenever focus moves into a web page (the Browser's, say), not only on leaving.
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('mousedown', away, true)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('mousedown', away, true)
    }
  }, [recording, draft.shortcuts, launcherKey, draft.linkSaveKey, draft.linkFindKey]) // eslint-disable-line react-hooks/exhaustive-deps

  /** The field that records a key, with Remove and (where there is a default) Restore. */
  const field = (target: KeyTarget, name: string, value: string, fallback: string): ReactElement => {
    const rec = recording === target
    return (
      <div className="flex items-center gap-1" data-shortcut-row={target}>
        <button
          type="button"
          className={`key-field ${rec ? 'recording' : ''} ${value ? '' : 'empty'}`}
          aria-label={`Shortcut for ${name}`}
          title={rec ? 'Press the keys; Esc stops, ⌫ removes the shortcut' : 'Click, then press the keys'}
          onClick={() => { setNotice(null); if (rec) stop(); else { setHeld(''); setRecording(target) } }}
        >
          {rec ? (held ? <kbd className="kbd">{held}</kbd> : <span>Press keys…</span>) : value ? <kbd className="kbd">{formatCombo(value)}</kbd> : <span>None</span>}
        </button>
        <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`Remove the shortcut for ${name}`} title="Remove" disabled={!value || rec}
          onClick={() => { setNotice(null); if (isGlobal(target)) setGlobal(target, ''); else assign(target, '') }}><Icon.x /></button>
        <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`Restore the shortcut for ${name}`} title={fallback ? `Back to ${formatCombo(fallback)}` : 'No shortcut by default'} disabled={!fallback || value === fallback || rec}
          onClick={() => { setNotice(null); if (isGlobal(target)) setGlobal(target, fallback); else assign(target, fallback) }}><Icon.refresh /></button>
      </div>
    )
  }
  const hintFor = (target: KeyTarget, normal: ReactNode): ReactNode => {
    const note = notice?.section === target ? notice : null
    return note ? <span className={note.error ? 'set-key-error' : 'set-key-note'}>{note.text}</span> : normal
  }
  const launcherHint = !launcherKey
    ? 'A search bar over any app, like Raycast: apps, files, your hosts, AWS consoles, the app’s sections, sums and web searches. Give it a key, for example ⌥Space.'
    : status && status.key === launcherKey && !status.registered
      ? <span className="set-key-error">macOS did not give the app {formatCombo(launcherKey)}: another app (Raycast, Alfred?) holds it. Free it there, or pick another key.</span>
      : `Press ${formatCombo(launcherKey)} in any app to search apps, files, hosts and more; press it again or Esc to put it away.`
  /** What a Links panel key does, or why it does not work (Anybox, say, still holds it). */
  const linkHint = (t: 'linkSave' | 'linkFind'): ReactNode => {
    const key = globalKey(t)
    const st = linkStatus?.[t === 'linkSave' ? 'save' : 'find']
    if (!key) return t === 'linkSave' ? 'Saves the page in front, in any browser, to Links with tags, a folder and a comment. Give it a key to use it.' : 'Searches Links, its tags and folders from any app. Give it a key to use it.'
    if (st && st.key === key && !st.registered) return <span className="set-key-error">macOS did not give the app {formatCombo(key)}: another app holds it (Anybox: turn its shortcut off in its settings). Free it there, or pick another key.</span>
    return t === 'linkSave'
      ? `Press ${formatCombo(key)} in any browser (Safari, Chrome, Arc, Dia, Brave, Edge, or this app's) to save its page to Links. macOS asks once per browser to let the app read its address.`
      : `Press ${formatCombo(key)} in any app to search Links: ↵ opens, a tag or folder narrows the search, ⌘↵ shows it in Links.`
  }

  const customised = Object.keys(draft.shortcuts ?? {}).length > 0
  return (
    <>
      {IN_ELECTRON && (
        <Group title="Anywhere on your Mac">
          <Row label={<span className="flex items-center gap-2"><Icon.launcher className="set-key-icon" />Launcher</span>} hint={hintFor('launcher', launcherHint)}>
            {field('launcher', 'the launcher', launcherKey, '')}
          </Row>
          <Row label={<span className="flex items-center gap-2"><Icon.bookmark className="set-key-icon" />Save to Links</span>} hint={hintFor('linkSave', linkHint('linkSave'))}>
            {field('linkSave', 'saving to Links', globalKey('linkSave'), GLOBAL_KEYS.linkSave.fallback)}
          </Row>
          <Row label={<span className="flex items-center gap-2"><Icon.search className="set-key-icon" />Search Links</span>} hint={hintFor('linkFind', linkHint('linkFind'))}>
            {field('linkFind', 'searching Links', globalKey('linkFind'), GLOBAL_KEYS.linkFind.fallback)}
          </Row>
        </Group>
      )}
      <Group title="Switch sections">
        <Row label={<span className="flex items-center gap-2"><Icon.radial className="set-key-icon" />Radial menu</span>}
          hint={hintFor('radial', keys.radial
            ? `Every section in a ring around the pointer. Hold ${formatCombo(keys.radial).replace(/[^⌃⌥⇧⌘]+$/, '') || 'the keys'} and tap ${formatCombo(keys.radial).replace(/^[⌃⌥⇧⌘]+/, '')} to step round, or point at one, then let go to switch; or tap it once and click.`
            : 'Every section in a ring around the pointer, to switch in one move. Give it a key to use it.')}>
          {field('radial', 'the radial menu', keys.radial, DEFAULT_SHORTCUTS.radial ?? '')}
        </Row>
      </Group>
      <Group title="App sections">
        {sections.map((sec) => {
          const SecIcon = SECTION_ICONS[sec]
          return (
            <Row key={sec} label={<span className="flex items-center gap-2"><SecIcon className="set-key-icon" />{SECTION_NAMES[sec]}</span>} hint={hintFor(sec, SECTION_HINTS[sec])}>
              {field(sec, SECTION_NAMES[sec], keys[sec], DEFAULT_SHORTCUTS[sec] ?? '')}
            </Row>
          )
        })}
        <Row label="Start over" hint={`Back to ${SHORTCUT_TARGETS.filter((x) => DEFAULT_SHORTCUTS[x]).map((x) => `${formatCombo(DEFAULT_SHORTCUTS[x]!)} ${TARGET_NAMES[x]}`).join(', ')}, and none for the rest.`}>
          <button type="button" className="btn" disabled={!customised} onClick={() => { setNotice(null); stop(); onChange({}) }}>Restore defaults</button>
        </Row>
      </Group>
      <Group title="How they work">
        <div className="set-row stack">
          <ul className="set-list">
            <li><Icon.check /><span>Click a shortcut, then press the keys: ⌘ or ⌃ with a letter, number or symbol (⌃⌘C, ⌥⌘1), or an F-key. Esc stops recording, ⌫ removes the shortcut.</span></li>
            <li><Icon.check /><span>They work all over the app, in terminals, remote desktops and web pages too. The launcher’s key works in every app on the Mac while this app is open.</span></li>
            <li><Icon.check /><span>Press one again while its section is in front to go back to where you were, say from Claude to the session you were in.</span></li>
            <li><Icon.check /><span>A tool keeps its own keys while it is in front: give ChatGPT ⌘L and the Browser still edits its address with it.</span></li>
          </ul>
        </div>
      </Group>
    </>
  )
}

export default function SettingsDialog(): ReactElement | null {
  const s = useStore()
  const [draft, setDraft] = useState<Settings | undefined>(s.settings)
  const [paths, setPaths] = useState<{ sessionManagerPlugin: string | null; awsCli: string | null; windowsApp: boolean } | null>(null)
  const [notesInfo, setNotesInfo] = useState<NotesInfo | null>(null)
  const [about, setAbout] = useState<AppAbout | null>(null)
  const [section, setSection] = useState<SectionId>(() => {
    try {
      const saved = localStorage.getItem(LAST_SECTION) as SectionId | null
      return saved && SECTIONS.some((x) => x.id === saved) && (saved !== 'voice' || CAN_DICTATE) && (saved !== 'windows' || IN_ELECTRON) ? saved : 'general'
    } catch { return 'general' }
  })
  const [themeFilter, setThemeFilter] = useState<'all' | 'dark' | 'light'>('all')
  useEffect(() => { void window.api.invoke('notes:info').then(setNotesInfo, () => undefined) }, [])
  useEffect(() => { void window.api.invoke('app:paths').then(setPaths) }, [])
  useEffect(() => { void window.api.invoke('app:about').then(setAbout, () => undefined) }, [])
  useEffect(() => { try { localStorage.setItem(LAST_SECTION, section) } catch { /* storage off */ } }, [section])
  if (!draft) return null
  const close = (): void => s.set({ settingsOpen: false })
  const upd = <K extends keyof Settings>(k: K, v: Settings[K]): void => setDraft({ ...draft, [k]: v })
  const pick = async (k: 'sshAgentSock' | 'defaultIdentityFile' | 'pemFile' | 'sessionManagerPluginPath' | 'awsCliPath'): Promise<void> => {
    const f = await window.api.invoke('dialog:pickFile', 'Choose file')
    if (f) upd(k, f)
  }
  const text = (k: keyof Settings, placeholder = '', pickable = false): ReactElement => (
    <div className="flex gap-1">
      <input className="input" placeholder={placeholder} value={String(draft[k] ?? '')} onChange={(e) => upd(k, e.target.value as never)} />
      {pickable && <button className="btn" title="Choose a file" onClick={() => void pick(k as never)}>Choose…</button>}
    </div>
  )
  const save = async (): Promise<void> => {
    // Snippets, port-forward presets and workspaces are edited in their own dialogs while this one is open;
    // writing the draft's copy back would undo those edits.
    // Quicklinks (the launcher adds them too) and the 1Password panel's switch are saved where they are changed.
    const { snippets: _sn, portForwards: _pf, workspaces: _ws, finderExtra: _fe, finderHidden: _fh, quicklinks: _ql, onePasswordStayApproved: _op, dataDir: _dd, ...rest } = draft
    await s.saveSettings(rest)
    await s.refreshProfiles()
    close()
    s.toast('success', 'Settings saved')
  }
  const sec = SECTIONS.find((x) => x.id === section) ?? SECTIONS[0]
  const status = (ok: boolean | null, yes: string, no: string): ReactElement => (
    <span className={`set-status ${ok === null ? '' : ok ? 'ok' : 'warn'}`}>
      <span className="dot" />
      {ok === null ? 'Checking…' : ok ? yes : no}
    </span>
  )

  const general = (
    <>
      <Group>
        <Row label="Appearance" hint={draft.colorTheme ? 'A colour theme picks light or dark itself; choose one here to go back to the default colours.' : 'Follows macOS by default.'}>
          <div className="seg w-64">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <button key={t} className={draft.theme === t && !draft.colorTheme ? 'on' : ''} onClick={() => { setDraft((d) => (d ? { ...d, theme: t, colorTheme: '', terminalTheme: 'auto' } : d)); void s.setTheme(t) }}>
                {t === 'system' ? 'Auto' : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Text size" hint="The hosts sidebar and the hosts list, each on its own. Point at either and press ⌘+ / ⌘− to change it there.">
          <div className="flex flex-col items-end gap-1.5">
            {ZOOM_SECTIONS.map((z) => (
              <span key={z.id} className="flex items-center gap-2 text-[12px]"><span className="muted">{z.label}</span><ZoomStepper section={z.id} /></span>
            ))}
          </div>
        </Row>
        <Row label="App font" hint="Geist, Manrope and Geist Mono are included and work offline. Notes and terminals have their own font settings." stack>
          <div className="font-choices" role="radiogroup" aria-label="App font">
            {UI_FONTS.map((f) => {
              const on = (draft.uiFont || DEFAULT_UI_FONT) === f.id
              return (
                <button key={f.id} type="button" role="radio" aria-checked={on} className={`font-choice ${on ? 'on' : ''}`} style={{ fontFamily: f.stack }} onClick={() => { upd('uiFont', f.id); void s.setUiFont(f.id) }}>
                  <span className="font-choice-sample">Aa</span>
                  <span className="font-choice-name">{f.label}</span>
                  <span className="font-choice-detail">{f.bundled ? 'Included · Variable' : 'System font'}</span>
                </button>
              )
            })}
          </div>
        </Row>
        {IN_ELECTRON && (
          <Row label="Show in the menu bar" hint="Your favorite hosts one click away, plus Find a host and Rescan.">
            <Toggle label="Show in the menu bar" checked={draft.menuBarIcon !== false} onChange={(v) => upd('menuBarIcon', v)} />
          </Row>
        )}
        <Row label="Open SSH in" hint="For “SSH in …” from a host’s menu.">
          <select className="input w-40" value={draft.externalTerminal} onChange={(e) => upd('externalTerminal', e.target.value as Settings['externalTerminal'])}>
            <option>Warp</option>
            <option>Terminal</option>
            <option>iTerm</option>
          </select>
        </Row>
      </Group>
      <Group title="Colour theme">
        <div className="set-row stack">
          <div className="set-hint !mt-0">Colours for the whole app, from the terminal schemes. Terminals switch to the same scheme; pick a different one under Terminal if you want them to differ.</div>
          <div className="theme-gallery-bar"><span>{APP_THEMES.length} curated palettes</span><div className="seg" role="group" aria-label="Filter themes">{(['all', 'dark', 'light'] as const).map((filter) => <button key={filter} aria-pressed={themeFilter === filter} className={themeFilter === filter ? 'on' : ''} onClick={() => setThemeFilter(filter)}>{filter === 'all' ? 'All' : filter === 'dark' ? 'Dark' : 'Light'}</button>)}</div></div>
          <div className="ctheme-grid" role="radiogroup" aria-label="Colour theme">
            {[null, ...APP_THEMES.filter((th) => themeFilter === 'all' || th.dark === (themeFilter === 'dark'))].map((th) => {
              const on = (draft.colorTheme ?? '') === (th?.id ?? '')
              const pick = (): void => { setDraft((d) => (d ? { ...d, colorTheme: th?.id ?? '', terminalTheme: 'auto' } : d)); void s.setColorTheme(th?.id ?? '') }
              return <ThemePreview key={th?.id ?? 'default'} theme={th} on={on} onPick={pick} appDark={draft.theme === 'dark' || (draft.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)} />
            })}
          </div>
        </div>
      </Group>
      <Group title="Finding hosts">
        <Row label="Scan every enabled region" hint="Slower. Each account’s own region is always scanned.">
          <Toggle label="Scan every enabled region" checked={draft.scanAllRegions} onChange={(v) => upd('scanAllRegions', v)} />
        </Row>
        <Row label="Extra regions" hint="Comma separated, e.g. us-east-1, eu-west-1." stack>
          <input className="input" placeholder="us-east-1, eu-west-1" disabled={draft.scanAllRegions} value={draft.extraRegions.join(', ')} onChange={(e) => upd('extraRegions', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} />
        </Row>
      </Group>
      <Group title="Connections">
        <Row label="Prefer public IP over SSM" hint="Off uses SSM Session Manager whenever the agent is online; public IPs often sit behind security groups that block you.">
          <Toggle label="Prefer public IP over SSM" checked={draft.preferDirect} onChange={(v) => upd('preferDirect', v)} />
        </Row>
        <Row label="Connect timeout" hint="Seconds to wait for a host before giving up.">
          <input className="input w-20" type="number" min={5} max={120} value={draft.connectTimeoutSec} onChange={(e) => upd('connectTimeoutSec', Number(e.target.value) || 20)} />
        </Row>
      </Group>
    </>
  )

  const accounts = (
    <>
      {s.profiles.length === 0 && (
        <Group>
          <Row label="No AWS accounts yet" hint="Add one with IAM Identity Center (SSO) or access keys.">
            <button className="btn btn-primary" onClick={() => s.set({ addAccountOpen: true })}><Icon.plus /> Add account</button>
          </Row>
        </Group>
      )}
      {s.profiles.map((p) => {
        const m = metaFor(p.name, draft)
        const setMeta = (patch: { label?: string; color?: AccentColor }): void =>
          upd('accountMeta', { ...(draft.accountMeta ?? {}), [p.name]: { ...(draft.accountMeta?.[p.name] ?? {}), ...patch } })
        const pd = (draft.profileDefaults ?? {})[p.name] ?? {}
        const setDefaults = (patch: Partial<typeof pd>): void => upd('profileDefaults', { ...(draft.profileDefaults ?? {}), [p.name]: { ...pd, ...patch } })
        return (
          <Group key={p.name}>
            <div className="set-account-head" data-accent={m.color}>
              <span className="avatar">{m.label.slice(0, 2).toUpperCase()}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{m.label}</div>
                <div className="muted truncate text-[11px]">{p.name} · {s.statuses[p.name]?.accountId ?? p.accountId ?? p.kind} · {p.region}</div>
              </div>
              <div className="flex gap-1">
                {ACCENTS.map((c) => (
                  <button key={c} data-accent={c} title={c} aria-label={`Colour ${c}`} onClick={() => setMeta({ color: c })} className={`swatch ${m.color === c ? 'on' : ''}`} />
                ))}
              </div>
            </div>
            <Row label="Name" hint="Shown on folders, avatars and badges, e.g. Dev, QA, Prod.">
              <input className="input w-56" placeholder={p.name} value={draft.accountMeta?.[p.name]?.label ?? ''} onChange={(e) => setMeta({ label: e.target.value || undefined })} />
            </Row>
            <Row label="SSH user and key" hint="With either set, SSH connects at once (shift-click for the dialog).">
              <div className="flex gap-1">
                <input className="input w-28" placeholder="user" value={pd.sshUser ?? ''} onChange={(e) => setDefaults({ sshUser: e.target.value || undefined })} />
                <input className="input w-48" placeholder="~/path/to/key.pem" value={pd.identityFile ?? ''} onChange={(e) => setDefaults({ identityFile: e.target.value || undefined })} />
                <button className="btn" title="Choose a key file" onClick={async () => { const f = await window.api.invoke('dialog:pickFile', `Key for ${p.name}`); if (f) setDefaults({ identityFile: f }) }}>…</button>
              </div>
            </Row>
          </Group>
        )
      })}
      <Group title="Hidden accounts">
        <Row label={draft.hiddenProfiles.length ? `${draft.hiddenProfiles.length} hidden` : 'None hidden'} hint="Profiles from ~/.aws you chose not to show.">
          <div className="flex flex-wrap justify-end gap-1">
            {draft.hiddenProfiles.map((h) => (
              <span key={h} className="badge badge-neutral gap-1">
                {h}
                <button className="hover:opacity-70" title={`Show ${h} again`} aria-label={`Unhide ${h}`} onClick={() => upd('hiddenProfiles', draft.hiddenProfiles.filter((x) => x !== h))}><Icon.x /></button>
              </span>
            ))}
          </div>
        </Row>
      </Group>
    </>
  )

  const ssh = (
    <>
      <Group title="Defaults">
        <Row label="Linux user" hint="Blank picks by OS: ec2-user, ubuntu, admin…">{text('defaultLinuxUser', 'automatic')}</Row>
        <Row label="Windows user">{text('defaultWindowsUser', 'Administrator')}</Row>
        <Row label="SSH agent socket" hint="The 1Password agent is used when present.">{text('sshAgentSock', '$SSH_AUTH_SOCK', true)}</Row>
        <Row label="Identity file" hint="Optional key used when nothing else applies.">{text('defaultIdentityFile', '~/.ssh/id_ed25519', true)}</Row>
        <Row label="Key pair (.pem)" hint="Decrypts Windows passwords (GetPasswordData) on this Mac.">{text('pemFile', '~/.ssh/keypair.pem', true)}</Row>
      </Group>
      <Group title="Sessions">
        <Row label="Keep shells running" hint={<>Runs SSH shells in tmux on Linux hosts, so a dropped connection resumes where you were (same user after <span className="mono">sudo su</span>, same directory, jobs still running). Closing a tab ends its shell; Detach leaves it running.</>}>
          <Toggle label="Keep shells running" checked={draft.persistentShells ?? true} onChange={(v) => upd('persistentShells', v)} />
        </Row>
        <Row label="Per-host settings" hint="Users, keys and routes saved from the connect dialog.">
          <div className="flex items-center gap-2">
            <span className="muted">{Object.keys(draft.overrides).length} saved</span>
            <button className="btn" disabled={!Object.keys(draft.overrides).length} onClick={() => upd('overrides', {})}>Clear all</button>
          </div>
        </Row>
      </Group>
    </>
  )

  const scheme = effectiveScheme(draft.terminalTheme, draft.colorTheme)
  const t = resolveTerminalTheme(scheme, isDarkMode())
  const ansi = [t.black, t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan, t.white].filter(Boolean) as string[]
  const terminal = (
    <>
      <Group title="Appearance">
        <div className="set-preview" style={{ background: terminalBackdrop(scheme, isDarkMode()), color: t.foreground, fontFamily: terminalFontFamily(draft.terminalFont), fontSize: draft.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE }}>
          <div><span style={{ color: t.green ?? t.foreground }}>ec2-user@ip-10-0-2-149</span>:<span style={{ color: t.blue ?? t.foreground }}>~</span>$ ls -la</div>
          <div className="flex gap-1 pt-1.5">{ansi.map((c, i) => <span key={i} className="h-2.5 w-5 rounded-sm" style={{ background: c }} />)}</div>
        </div>
        <Row label="Colour scheme" hint="Open terminals change immediately.">
          <select className="input w-48" title="Colour scheme" value={draft.terminalTheme ?? 'auto'} onChange={(e) => { upd('terminalTheme', e.target.value); void s.saveSettings({ terminalTheme: e.target.value }) }}>
            {TERMINAL_THEMES.map((th) => <option key={th.id} value={th.id}>{th.name}</option>)}
          </select>
        </Row>
        <Row label="Font" hint="Monaco, Menlo and SF Mono ship with macOS.">
          <div className="flex gap-1">
            <input className="input w-40" list="terminal-fonts" title="Font family" placeholder="Monaco" value={draft.terminalFont ?? ''} onChange={(e) => upd('terminalFont', e.target.value)} onBlur={() => void s.saveSettings({ terminalFont: draft.terminalFont })} />
            <datalist id="terminal-fonts">{TERMINAL_FONTS.map((f) => <option key={f} value={f} />)}</datalist>
            <input className="input w-16" type="number" title="Font size (px)" min={9} max={24} value={draft.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE}
              onChange={(e) => { const n = Math.min(24, Math.max(9, Number(e.target.value) || DEFAULT_TERMINAL_FONT_SIZE)); upd('terminalFontSize', n); void s.saveSettings({ terminalFontSize: n }) }} />
          </div>
        </Row>
      </Group>
      <Group title="When a session starts">
        <Row label="Run after connect" hint={<>Typed into the shell as its first input (the login user only, not after <span className="mono">su</span>). Hosts can override it; append <span className="mono">; clear</span> to hide the echo.</>} stack>
          <textarea className="input mono min-h-[60px] resize-y text-[11px]" rows={2} spellCheck={false} placeholder="e.g. a coloured prompt" value={draft.sshInitCommand ?? ''} onChange={(e) => upd('sshInitCommand', e.target.value)} />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button className="btn" onClick={() => upd('sshInitCommand', COLOR_PROMPT_PRESET)}>Use colour prompt preset</button>
            {draft.sshInitCommand && <button className="btn" onClick={() => upd('sshInitCommand', '')}>Clear</button>}
          </div>
        </Row>
        <Row label="Snippets" hint="Saved commands for the terminal toolbar and ⌘K.">
          <div className="flex items-center gap-2">
            <span className="muted">{s.settings?.snippets.length ?? 0} saved</span>
            <button className="btn" onClick={() => s.set({ snippetsOpen: {} })}>Manage…</button>
          </div>
        </Row>
      </Group>
      <Group title="Recording">
        <Row label="Record every SSH session" hint="One text file per session with colours removed; a REC badge marks recorded tabs.">
          <Toggle label="Record every SSH session" checked={draft.sessionLogging} onChange={(v) => upd('sessionLogging', v)} />
        </Row>
        <Row label="Folder" stack>
          <div className="flex gap-1">
            <input className="input" placeholder="~/Documents/EC2 Remote Access/Session logs" value={draft.sessionLogDir} onChange={(e) => upd('sessionLogDir', e.target.value)} />
            <button className="btn" title="Choose folder" onClick={async () => { const f = await window.api.invoke('dialog:pickFile', 'Choose a file in the log folder'); if (f) upd('sessionLogDir', f.replace(/\/[^/]*$/, '')) }}>Choose…</button>
          </div>
        </Row>
      </Group>
    </>
  )

  const notes = (
    <Group>
      <Row label="Notes folder" hint={
        draft.notesDir
          ? 'Notes are kept in this folder (a network share works too). Point Obsidian at it to use both.'
          : notesInfo?.source === 'obsidian'
            ? <>Using the vault Obsidian has open, <span className="mono">{notesInfo.dir}</span>, so both apps edit the same files.</>
            : <>Using <span className="mono">{notesInfo?.dir ?? '~/Documents/EC2 Remote Access/Notes'}</span> (no Obsidian vault found).</>
      } stack>
        <div className="flex gap-1">
          <input className="input" placeholder={notesInfo && notesInfo.source !== 'setting' ? notesInfo.dir : 'Folder of Markdown notes'} value={draft.notesDir ?? ''} onChange={(e) => upd('notesDir', e.target.value)} />
          <button className="btn" title="Choose folder" onClick={async () => { const f = await window.api.invoke('notes:pickFolder'); if (f) upd('notesDir', f) }}>Choose…</button>
          {draft.notesDir && <button className="btn" title="Go back to the folder chosen automatically" onClick={() => upd('notesDir', '')}>Use the Obsidian vault</button>}
        </div>
      </Row>
      <Row label="Host notes in" hint="Each host’s note is created here, inside the notes folder.">
        <input className="input w-56" placeholder="EC2 Remote/Hosts" value={draft.notesHostFolder ?? ''} onChange={(e) => upd('notesHostFolder', e.target.value)} />
      </Row>
    </Group>
  )

  const phone = (
    <Group>
      <div className="set-row stack">
        <PhoneAccessSection onPatch={(p) => setDraft((d) => (d ? { ...d, ...p } : d))} />
      </div>
    </Group>
  )

  const voiceSection = <VoiceSettings draft={draft} upd={upd} />
  const keyboard = (
    <KeyboardSettings
      draft={draft}
      onChange={(shortcuts) => { setDraft((d) => (d ? { ...d, shortcuts } : d)); void s.saveSettings({ shortcuts }) }}
      onGlobal={async (field, key) => { setDraft((d) => (d ? { ...d, [field]: key } : d)); await s.saveSettings({ [field]: key }) }}
    />
  )


  const requirements = (
    <>
      <Group>
        <Row label="AWS Session Manager plugin" hint="Needed for hosts without a reachable address (most private instances).">
          {status(paths ? !!paths.sessionManagerPlugin : null, 'Installed', 'Not found')}
        </Row>
        <Row label="Location" stack>{text('sessionManagerPluginPath', paths?.sessionManagerPlugin ?? 'brew install --cask session-manager-plugin', true)}</Row>
      </Group>
      <Group>
        <Row label="AWS CLI" hint="Optional: sign-in is built in. Used for “Sign in again” when present.">
          {status(paths ? !!paths.awsCli : null, 'Installed', 'Not installed')}
        </Row>
        <Row label="Location" stack>{text('awsCliPath', paths?.awsCli ?? 'brew install awscli', true)}</Row>
      </Group>
      <Group>
        <Row label="Windows App" hint="Optional: only for handing a desktop to Microsoft’s client. The built-in RDP works without it.">
          {paths && !paths.windowsApp
            ? <button className="btn" onClick={() => void window.api.invoke('shell:open', 'https://apps.apple.com/app/windows-app/id1295203466')}>Get it…</button>
            : status(paths ? paths.windowsApp : null, 'Installed', 'Not installed')}
        </Row>
      </Group>
    </>
  )

  const aboutSection = (
    <>
      <div className="set-about">
        <span className="brand-mark set-about-mark">&gt;_</span>
        <div>
          <div className="text-[17px] font-semibold tracking-tight">EC2 Remote Access</div>
          <div className="muted text-[12px]">Version {about?.version ?? '…'}{about?.electron ? ` · Electron ${about.electron}` : ''}{about ? ` · ${about.platform === 'darwin' ? 'macOS' : about.platform} ${about.arch}` : ''}</div>
        </div>
      </div>
      <Group title="Privacy">
        <div className="set-row stack">
          <ul className="set-list">
            <li><Icon.check /><span>No analytics, telemetry or crash reporting. The app talks only to AWS, the hosts you connect to, the pages you open in its browser, and the update server when updates are on.</span></li>
            <li><Icon.check /><span>AWS credentials stay in <span className="mono">~/.aws</span>, exactly where the AWS CLI keeps them.</span></li>
            <li><Icon.check /><span>Saved desktop passwords are encrypted (with the Keychain on a Mac).</span></li>
            <li><Icon.check /><span>A paired phone or tablet sees the screen and sends keystrokes; credentials never leave the computer running the app.</span></li>
            <li><Icon.check /><span>Dictation listens only while you hold its key or a mic button is on. It is recognised on this Mac when macOS has an on-device model for your language (Settings → Voice says which); otherwise Apple’s speech service processes the audio, as macOS Dictation does. A paired phone can never turn on this Mac’s microphone.</span></li>
          </ul>
        </div>
      </Group>
      <Group title="Your data">
        <Row label="App data" hint={<span className="mono">{about?.dataDir ?? '…'}</span>}>
          <button className="btn" onClick={() => void window.api.invoke('app:reveal', 'data')}>Show in Finder</button>
        </Row>
        <Row label="Logs" hint="Attach these when reporting a problem.">
          <button className="btn" onClick={() => void window.api.invoke('app:reveal', 'logs')}>Show in Finder</button>
        </Row>
      </Group>
    </>
  )

  const svcList = draft.serviceCatalog?.length ? draft.serviceCatalog : DEFAULT_SERVICES
  const setSvc = (list: ServiceDef[]): void => upd('serviceCatalog', list)
  const servicesSection = (
    <>
      <Group title="Services and their units">
        {svcList.map((d, i) => {
          const bad = d.units.filter((u) => !isUnitName(u))
          return (
            <div key={d.id} className="set-row svc-def">
              <input className="input" value={d.name} aria-label="Service name" onChange={(e) => setSvc(svcList.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <UnitsInput units={d.units} name={d.name} onChange={(units) => setSvc(svcList.map((x, j) => (j === i ? { ...x, units } : x)))} />
              <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`Remove ${d.name}`} title="Remove" onClick={() => setSvc(svcList.filter((_, j) => j !== i))}><Icon.x /></button>
              {bad.length > 0 && <span className="set-key-error svc-def-error">Not a unit name, so it is left out: {bad.join(', ')}</span>}
            </div>
          )
        })}
        <div className="set-row">
          <button type="button" className="btn" onClick={() => setSvc([...svcList, { id: `custom-${Date.now().toString(36)}`, name: 'New service', units: [] }])}><Icon.plus /> Add a service</button>
          <span className="flex-1" />
          <button type="button" className="btn" disabled={!draft.serviceCatalog?.length} onClick={() => setSvc([])}>Restore the install sheet’s list</button>
        </div>
      </Group>
      <Group title="How it works">
        <div className="set-row stack">
          <ul className="set-list">
            <li><Icon.check /><span>Services (Health → Control services, a server’s Services button, a host’s menu, or ⌘K) asks each server which of these units it has, through SSM, and shows only those, with their state.</span></li>
            <li><Icon.check /><span>Restart and Start wait until the unit is active and the server’s own health check (the probe Grafana runs) passes; Restart all, one at a time does a service’s servers in turn, stopping at the first failure.</span></li>
            <li><Icon.check /><span>Units run as root through the SSM agent: only names like <code>name.service</code> are used, and only the ones listed here. Production asks you to type PROD, and every action is kept in History.</span></li>
          </ul>
        </div>
      </Group>
    </>
  )
  const windows = (
    <WindowSettings draft={draft} onPatch={async (patch) => { setDraft((d) => (d ? { ...d, ...patch } : d)); await s.saveSettings(patch) }} />
  )
  const body: Record<SectionId, ReactElement> = { general, accounts, ssh, terminal, notes, data: <DataSettings />, keyboard, windows, launcher: <QuicklinkSettings />, voice: voiceSection, services: servicesSection, phone, requirements, about: aboutSection }

  return (
    <Modal title="Settings" onClose={close} width="max-w-[880px]" bare>
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav-title">Settings</div>
          {SECTIONS.filter((x) => (x.id !== 'voice' || CAN_DICTATE) && (x.id !== 'windows' || IN_ELECTRON)).map((x) => (
            <button key={x.id} type="button" data-section={x.id} className={`settings-nav-item ${section === x.id ? 'on' : ''}`} aria-current={section === x.id ? 'page' : undefined} onClick={() => setSection(x.id)}>
              <x.icon />
              {x.label}
            </button>
          ))}
        </nav>
        <div className="settings-main">
          <header className="settings-head">
            <div className="min-w-0">
              <h3 className="settings-title">{sec.label}</h3>
              <p className="settings-blurb">{sec.blurb}</p>
            </div>
            <button className="btn btn-ghost btn-sm btn-icon" aria-label="Close dialog" onClick={close}><Icon.x /></button>
          </header>
          <div className="settings-body">{body[section]}</div>
          <footer className="settings-foot">
            <span className="muted text-[11px]">Appearance, terminal and keyboard changes apply right away.</span>
            <span className="flex-1" />
            <button className="btn" onClick={close}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void save()}>Save</button>
          </footer>
        </div>
      </div>
    </Modal>
  )
}

/** A service's units as text, kept while typing (spaces separate them) and read on leaving the field. */
function UnitsInput({ units, name, onChange }: { units: string[]; name: string; onChange: (units: string[]) => void }): ReactElement {
  const [text, setText] = useState(units.join(' '))
  useEffect(() => setText(units.join(' ')), [units.join(' ')]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input className="input mono" value={text} aria-label={`Units of ${name}`} placeholder="name.service other.service" spellCheck={false}
      onChange={(e) => setText(e.target.value)} onBlur={() => onChange(text.split(/[\s,]+/).filter(Boolean))} />
  )
}

