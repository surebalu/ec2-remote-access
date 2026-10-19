import type { ReactElement } from 'react'
import { useStore } from '../store'
import { BROWSER_SHORTCUTS, dictationShortcuts, FINDER_SHORTCUTS, NOTES_SHORTCUTS, SHORTCUTS, TERMINAL_SHORTCUTS, WHITEBOARD_SHORTCUTS, type ShortcutInfo } from '../shortcuts'
import { dictationKeyLabel } from '@shared/dictation'
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
  return (
    <Modal title="Keyboard shortcuts" onClose={() => set({ shortcutsOpen: false })}>
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
