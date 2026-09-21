import type { MouseEvent, ReactElement } from 'react'
import { useState } from 'react'
import { isDarkMode, useStore } from '../store'
import { TERMINAL_THEMES, TERMINAL_FONTS, DEFAULT_TERMINAL_FONT, DEFAULT_TERMINAL_FONT_SIZE, resolveTerminalTheme, terminalFontFamily, type TerminalTheme } from '../terminalThemes'
import { Icon } from './icons'

/** Miniature terminal window in the scheme's colours: three "lines" of output, like Termius' theme cards. */
function ThemeCard({ t }: { t: TerminalTheme }): ReactElement {
  const th = t.id === 'auto' ? resolveTerminalTheme('auto', isDarkMode()) : t.theme
  const bars = [
    [th.green ?? th.foreground, 46], [th.foreground, 30],
    [th.blue ?? th.foreground, 24], [th.foreground, 40],
    [th.magenta ?? th.foreground, 18], [th.yellow ?? th.foreground, 36]
  ] as [string | undefined, number][]
  return (
    <span className="theme-card" style={{ background: th.background, borderColor: 'color-mix(in srgb, var(--border) 60%, transparent)' }}>
      <span className="theme-card-bar" style={{ background: th.brightBlack ?? th.foreground, opacity: 0.35 }} />
      {[0, 2, 4].map((i) => (
        <span key={i} className="flex gap-[3px]">
          <span style={{ background: bars[i][0], width: `${bars[i][1]}%`, height: 3, borderRadius: 1 }} />
          <span style={{ background: bars[i + 1][0], width: `${bars[i + 1][1]}%`, height: 3, borderRadius: 1, opacity: 0.8 }} />
        </span>
      ))}
    </span>
  )
}

/** Buttons in the pane must not take keyboard focus away from the terminal: the user keeps typing after a click. */
const keepTerminalFocus = { onMouseDown: (e: MouseEvent): void => e.preventDefault() }

/** Right-hand pane inside an SSH tab: pick a colour scheme or font and it applies to every open terminal at once. */
export default function TerminalAppearancePane(): ReactElement {
  const s = useStore()
  const current = s.settings?.terminalTheme ?? 'auto'
  const font = s.settings?.terminalFont ?? DEFAULT_TERMINAL_FONT
  const size = s.settings?.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE
  const [fontOpen, setFontOpen] = useState(false)
  const setSize = (n: number): void => void s.saveSettings({ terminalFontSize: Math.min(24, Math.max(9, n)) })
  const dark = TERMINAL_THEMES.filter((t) => t.dark)
  const light = TERMINAL_THEMES.filter((t) => !t.dark)

  const row = (t: TerminalTheme): ReactElement => (
    <button key={t.id} {...keepTerminalFocus} className={`theme-row${t.id === current ? ' on' : ''}`} onClick={() => void s.saveSettings({ terminalTheme: t.id })} title={t.name}>
      <ThemeCard t={t} />
      <span className="min-w-0 flex-1 truncate text-left text-[12px]">{t.name}</span>
      <span className="theme-radio" aria-hidden />
    </button>
  )

  return (
    <aside className="appearance-pane" aria-label="Terminal appearance">
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Appearance</span>
        <button {...keepTerminalFocus} className="btn btn-ghost btn-icon !h-6 !w-6" title="Hide appearance pane" onClick={() => s.toggleTerminalPane(false)}><Icon.x /></button>
      </div>

      <button {...keepTerminalFocus} className="pane-section" onClick={() => setFontOpen(!fontOpen)}>
        <span>Font</span>
        <span className="muted flex items-center gap-1 text-[11px]"><span style={{ fontFamily: terminalFontFamily(font) }}>{font} {size}</span><Icon.chevron open={fontOpen} /></span>
      </button>
      {fontOpen && (
        <div className="space-y-1.5 px-3 pb-2">
          <input className="input text-[12px]" list="pane-terminal-fonts" value={font} onChange={(e) => void s.saveSettings({ terminalFont: e.target.value })} spellCheck={false} />
          <datalist id="pane-terminal-fonts">{TERMINAL_FONTS.map((f) => <option key={f} value={f} />)}</datalist>
          <div className="flex items-center gap-1">
            <button {...keepTerminalFocus} className="btn btn-sm btn-icon" onClick={() => setSize(size - 1)} disabled={size <= 9} title="Smaller">−</button>
            <span className="mono w-8 text-center text-[12px]">{size}</span>
            <button {...keepTerminalFocus} className="btn btn-sm btn-icon" onClick={() => setSize(size + 1)} disabled={size >= 24} title="Larger">+</button>
            <span className="muted ml-1 text-[10px]">px</span>
          </div>
          <div className="rounded border px-2 py-1 text-[12px]" style={{ fontFamily: terminalFontFamily(font), fontSize: size, borderColor: 'var(--border)', background: 'var(--panel-2)' }}>0O il1 {'{}'} =&gt; ~/src $</div>
        </div>
      )}

      <div className="pane-section as-label">Theme</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {dark.map(row)}
        <div className="muted px-1 pt-2 pb-1 text-[10px] uppercase tracking-wide">Light</div>
        {light.map(row)}
      </div>
    </aside>
  )
}
