import type { ReactElement } from 'react'
import { useStore } from '../store'
import { BROWSER_SHORTCUTS, dictationShortcuts, FINDER_SHORTCUTS, NOTES_SHORTCUTS, openKeyboardSettings, SHORTCUTS, TERMINAL_SHORTCUTS, WHITEBOARD_SHORTCUTS, type ShortcutInfo } from '../shortcuts'
import { dictationKeyLabel } from '@shared/dictation'
import { formatCombo, RAIL_SECTIONS, SECTION_NAMES, sectionKeys } from '@shared/keyCombos'
import { hasBrowser } from '../quickConnect'
import { CAN_DICTATE } from '../voice'
import Modal from './Modal'

const list = (items: ShortcutInfo[]): ReactElement => (
  <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-xs">
    {items.map((x) => (
      <div key={x.keys} className="contents">
        <dt><kbd className="kbd">{x.keys}</kbd></dt>
        <dd className="text-2">{x.label}</dd>
      </div>
    ))}
  </dl>
)

export default function ShortcutsDialog(): ReactElement {
  const set = useStore((s) => s.set)
  const dictationKey = useStore((s) => s.settings?.dictationKey)
  const saved = useStore((s) => s.settings?.shortcuts)
  const launcherKey = useStore((s) => s.settings?.launcherKey ?? '')
  const keys = sectionKeys(saved)
  // The rail's sections with the keys set for them in Settings → Keyboard (Hosts is also ⌘1, below).
  const sections = [
    ...(launcherKey && hasBrowser() ? [{ keys: formatCombo(launcherKey), label: 'Launcher, from any app (apps, files, hosts, sums)' }] : []),
    ...RAIL_SECTIONS.filter((x) => keys[x] && (hasBrowser() || (x !== 'local' && x !== 'finder'))).map((x) => ({ keys: formatCombo(keys[x]), label: SECTION_NAMES[x] }))
  ]
  return (
    <Modal title="Keyboard shortcuts" onClose={() => set({ shortcutsOpen: false })}>
      <div className="mb-2 flex items-center gap-2">
        <div className="section-title">App sections</div>
        <span className="flex-1" />
        <button type="button" className="btn btn-sm" onClick={openKeyboardSettings}>Set your own…</button>
      </div>
      {sections.length ? list(sections) : <p className="muted text-xs">None set. Give Claude, ChatGPT or any other section a key of its own.</p>}
      <div className="section-title mb-2 mt-5">Everywhere</div>
      {list(SHORTCUTS)}
      {CAN_DICTATE && <>
        <div className="section-title mb-2 mt-5">Dictation</div>
        {list(dictationShortcuts(dictationKeyLabel(dictationKey)))}
      </>}
      <div className="section-title mb-2 mt-5">In the terminal</div>
      {list(TERMINAL_SHORTCUTS)}
      <div className="section-title mb-2 mt-5">In notes</div>
      {list(NOTES_SHORTCUTS)}
      <div className="section-title mb-2 mt-5">In the browser</div>
      {list(BROWSER_SHORTCUTS)}
      <div className="section-title mb-2 mt-5">In Finder</div>
      {list(FINDER_SHORTCUTS)}
      <div className="section-title mb-2 mt-5">On the whiteboard</div>
      {list(WHITEBOARD_SHORTCUTS)}
      <p className="muted mt-4 text-[11px]">In the quick switcher, start with <span className="mono">&gt;</span> for commands, or type <span className="mono">start</span>, <span className="mono">stop</span> or <span className="mono">forward</span> followed by a host name. Close the window with ⌘⇧W.</p>
    </Modal>
  )
}
