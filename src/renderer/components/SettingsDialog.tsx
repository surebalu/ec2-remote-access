import type { ReactElement, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import type { AppAbout, DictationKey, NotesInfo, Settings, VoicePermission, VoiceStatus } from '@shared/types'
import { CAN_DICTATE } from '../voice'
import { useStore } from '../store'
import Modal from './Modal'
import { ACCENTS, metaFor } from '../colors'
import type { AccentColor } from '@shared/types'
import { TERMINAL_THEMES, TERMINAL_FONTS, COLOR_PROMPT_PRESET, resolveTerminalTheme, terminalBackdrop, terminalFontFamily, DEFAULT_TERMINAL_FONT_SIZE } from '../terminalThemes'
import { isDarkMode } from '../store'
import PhoneAccessSection from './PhoneAccessSection'
import { APP_THEMES, effectiveScheme, type AppTheme } from '../appThemes'
import { Icon } from './icons'

type SectionId = 'general' | 'accounts' | 'ssh' | 'terminal' | 'notes' | 'voice' | 'phone' | 'requirements' | 'about'

const SECTIONS: { id: SectionId; label: string; blurb: string; icon: (p: { className?: string }) => ReactElement }[] = [
  { id: 'general', label: 'General', blurb: 'Appearance, how hosts are found and how connections are routed.', icon: Icon.settings },
  { id: 'accounts', label: 'Accounts', blurb: 'A name, a colour and SSH defaults for each AWS account.', icon: Icon.cloud },
  { id: 'ssh', label: 'SSH & RDP', blurb: 'Users, keys and the SSH agent used when a host has no settings of its own.', icon: Icon.key },
  { id: 'terminal', label: 'Terminal', blurb: 'How SSH tabs look, what runs when they connect, and recordings.', icon: Icon.terminal },
  { id: 'notes', label: 'Notes', blurb: 'Where your Markdown notes live.', icon: Icon.note },
  { id: 'voice', label: 'Voice', blurb: 'Talk instead of typing, wherever you type in the app.', icon: Icon.mic },
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

export default function SettingsDialog(): ReactElement | null {
  const s = useStore()
  const [draft, setDraft] = useState<Settings | undefined>(s.settings)
  const [paths, setPaths] = useState<{ sessionManagerPlugin: string | null; awsCli: string | null; windowsApp: boolean } | null>(null)
  const [notesInfo, setNotesInfo] = useState<NotesInfo | null>(null)
  const [about, setAbout] = useState<AppAbout | null>(null)
  const [section, setSection] = useState<SectionId>(() => {
    try {
      const saved = localStorage.getItem(LAST_SECTION) as SectionId | null
      return saved && SECTIONS.some((x) => x.id === saved) && (saved !== 'voice' || CAN_DICTATE) ? saved : 'general'
    } catch { return 'general' }
  })
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
    const { snippets: _sn, portForwards: _pf, workspaces: _ws, ...rest } = draft
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
              <button key={t} className={draft.theme === t && !draft.colorTheme ? 'on' : ''} onClick={() => { setDraft((d) => (d ? { ...d, theme: t, colorTheme: '' } : d)); void s.setTheme(t) }}>
                {t === 'system' ? 'Auto' : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
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
          <div className="set-hint !mt-0">Colours for the whole app, from the terminal schemes. Terminals set to “Match app” take the theme’s scheme too.</div>
          <div className="ctheme-grid" role="radiogroup" aria-label="Colour theme">
            {[null, ...APP_THEMES].map((th) => {
              const on = (draft.colorTheme ?? '') === (th?.id ?? '')
              const pick = (): void => { upd('colorTheme', th?.id ?? ''); void s.setColorTheme(th?.id ?? '') }
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

  const body: Record<SectionId, ReactElement> = { general, accounts, ssh, terminal, notes, voice: voiceSection, phone, requirements, about: aboutSection }

  return (
    <Modal title="Settings" onClose={close} width="max-w-[880px]" bare>
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav-title">Settings</div>
          {SECTIONS.filter((x) => x.id !== 'voice' || CAN_DICTATE).map((x) => (
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
            <span className="muted text-[11px]">Appearance and terminal changes apply right away.</span>
            <span className="flex-1" />
            <button className="btn" onClick={close}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void save()}>Save</button>
          </footer>
        </div>
      </div>
    </Modal>
  )
}
