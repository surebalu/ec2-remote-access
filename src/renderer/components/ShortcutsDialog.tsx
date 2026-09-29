import type { ReactElement } from 'react'
import { useStore } from '../store'
import { SHORTCUTS } from '../shortcuts'
import Modal from './Modal'

export default function ShortcutsDialog(): ReactElement {
  const set = useStore((s) => s.set)
  return (
    <Modal title="Keyboard shortcuts" onClose={() => set({ shortcutsOpen: false })}>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-xs">
        {SHORTCUTS.map((x) => (
          <div key={x.keys} className="contents">
            <dt><kbd className="kbd">{x.keys}</kbd></dt>
            <dd className="text-2">{x.label}</dd>
          </div>
        ))}
      </dl>
      <p className="muted mt-4 text-[11px]">In the quick switcher, start with <span className="mono">&gt;</span> for commands, or type <span className="mono">start</span>, <span className="mono">stop</span> or <span className="mono">forward</span> followed by a host name. Close the window with ⌘⇧W.</p>
    </Modal>
  )
}
