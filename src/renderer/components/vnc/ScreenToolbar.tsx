import { useState, type ReactElement, type ReactNode } from 'react'
import { Icon } from '../icons'

/**
 * The screen tab's floating toolbar on a phone or tablet: one row of tools, and above it the row the ⌘, arrows or
 * scissors button opened (modifiers, arrow keys, editing). The shortcuts and settings buttons open a floating menu
 * whose groups open in place over it. Buttons never take focus, so the iOS keyboard stays up while they are used.
 */

export interface MenuNode {
  id: string
  label: string
  icon?: ReactNode
  /** Shown with a check mark (a choice within its group). */
  checked?: boolean
  disabled?: boolean
  danger?: boolean
  run?: () => void
  children?: MenuNode[]
}

export type ToolbarRow = 'mods' | 'arrows' | 'edit' | null
export type StickyMod = 'shift' | 'ctrl' | 'option' | 'cmd'

function Btn({ label, on, onPress, children, className = '' }: { label: string; on?: boolean; onPress: () => void; children: ReactNode; className?: string }): ReactElement {
  return (
    <button
      type="button"
      className={`vt-btn ${on ? 'on' : ''} ${className}`}
      aria-label={label}
      aria-pressed={on}
      title={label}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
    >
      {children}
    </button>
  )
}

/** A floating menu; a node with children opens them in a card over the list, with its name as a header to go back. */
export function FloatingMenu({ items, onClose, align = 'right' }: { items: MenuNode[]; onClose: () => void; align?: 'left' | 'right' }): ReactElement {
  const [open, setOpen] = useState<MenuNode | null>(null)
  const item = (n: MenuNode, inner: boolean): ReactElement => (
    <button
      key={n.id}
      type="button"
      role="menuitem"
      className={`vt-item ${n.danger ? 'danger' : ''}`}
      disabled={n.disabled}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => {
        if (n.children) { setOpen(n); return }
        onClose()
        n.run?.()
      }}
    >
      {inner && <span className="vt-check">{n.checked ? '✓' : ''}</span>}
      {n.icon && <span className="vt-item-icon">{n.icon}</span>}
      <span className="vt-item-label">{n.label}</span>
      {n.children && <span className="vt-chev"><Icon.chevron /></span>}
    </button>
  )
  const groups: MenuNode[][] = []
  for (const n of items) {
    if (n.id.startsWith('sep')) groups.push([])
    else (groups[groups.length - 1] ?? (groups[0] = [])).push(n)
  }
  return (
    <div className="vt-menu-layer" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`vt-menu ${align} ${open ? 'dim' : ''}`} role="menu">
        {groups.filter((g) => g.length).map((g, i) => <div key={i} className="vt-menu-group">{g.map((n) => item(n, false))}</div>)}
      </div>
      {open && (
        <div className={`vt-menu vt-sub ${align}`} role="menu" aria-label={open.label}>
          <button type="button" className="vt-sub-head" onPointerDown={(e) => e.preventDefault()} onClick={() => setOpen(null)}>
            {open.icon && <span className="vt-item-icon">{open.icon}</span>}
            <span className="vt-item-label">{open.label}</span>
            <span className="vt-chev open"><Icon.chevron open /></span>
          </button>
          <div className="vt-menu-group">{(open.children ?? []).map((n) => item(n, true))}</div>
        </div>
      )}
    </div>
  )
}

export default function ScreenToolbar(props: {
  mac: boolean
  row: ToolbarRow
  onRow: (r: ToolbarRow) => void
  keyboardOpen: boolean
  onKeyboard: () => void
  onDictate: () => void
  sticky: Record<StickyMod, boolean>
  onSticky: (m: StickyMod) => void
  onKey: (name: string) => void
  onEdit: (action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste') => void
  onTypeText: () => void
  shortcuts: MenuNode[]
  settings: MenuNode[]
}): ReactElement {
  const { row, onRow, sticky } = props
  const [menu, setMenu] = useState<'shortcuts' | 'settings' | null>(null)
  const toggle = (r: Exclude<ToolbarRow, null>): void => onRow(row === r ? null : r)
  return (
    <>
      {menu && <FloatingMenu items={menu === 'shortcuts' ? props.shortcuts : props.settings} align={menu === 'shortcuts' ? 'left' : 'right'} onClose={() => setMenu(null)} />}
      <div className="vt-bar" role="toolbar" aria-label="Screen tools">
        {row === 'mods' && (
          <div className="vt-row">
            <Btn label="Tab" onPress={() => props.onKey('Tab')}><span className="vt-glyph">⇥</span></Btn>
            <Btn label="Return" onPress={() => props.onKey('Enter')}><span className="vt-glyph">↩</span></Btn>
            <span className="vt-gap" />
            <Btn label="Shift (applies to the next key)" on={sticky.shift} onPress={() => props.onSticky('shift')}><span className="vt-glyph">⇧</span></Btn>
            <Btn label="Control (applies to the next key)" on={sticky.ctrl} onPress={() => props.onSticky('ctrl')}><span className="vt-glyph">⌃</span></Btn>
            <Btn label={props.mac ? 'Option (applies to the next key)' : 'Alt (applies to the next key)'} on={sticky.option} onPress={() => props.onSticky('option')}><span className="vt-glyph">{props.mac ? '⌥' : 'alt'}</span></Btn>
            <Btn label={props.mac ? 'Command (applies to the next key)' : 'Windows key (applies to the next key)'} on={sticky.cmd} onPress={() => props.onSticky('cmd')}><span className="vt-glyph">{props.mac ? '⌘' : 'win'}</span></Btn>
          </div>
        )}
        {row === 'arrows' && (
          <div className="vt-row">
            <Btn label="Up" onPress={() => props.onKey('ArrowUp')}><span className="vt-glyph">↑</span></Btn>
            <Btn label="Down" onPress={() => props.onKey('ArrowDown')}><span className="vt-glyph">↓</span></Btn>
            <Btn label="Left" onPress={() => props.onKey('ArrowLeft')}><span className="vt-glyph">←</span></Btn>
            <Btn label="Right" onPress={() => props.onKey('ArrowRight')}><span className="vt-glyph">→</span></Btn>
            <Btn label="Home" onPress={() => props.onKey('Home')}><span className="vt-glyph">⇤</span></Btn>
            <Btn label="End" onPress={() => props.onKey('End')}><span className="vt-glyph">⇥</span></Btn>
            <Btn label="Page up" onPress={() => props.onKey('PageUp')}><span className="vt-glyph">⇞</span></Btn>
            <Btn label="Page down" onPress={() => props.onKey('PageDown')}><span className="vt-glyph">⇟</span></Btn>
          </div>
        )}
        {row === 'edit' && (
          <div className="vt-row">
            <Btn label="Undo" onPress={() => props.onEdit('undo')}><Icon.undo /></Btn>
            <Btn label="Redo" onPress={() => props.onEdit('redo')}><Icon.redo /></Btn>
            <span className="vt-gap" />
            <Btn label="Cut" onPress={() => props.onEdit('cut')}><Icon.scissors /></Btn>
            <Btn label="Copy" onPress={() => props.onEdit('copy')}><Icon.copy /></Btn>
            <Btn label="Paste" onPress={() => props.onEdit('paste')}><Icon.clipboard /></Btn>
            <span className="vt-gap" />
            <Btn label="Type some text" onPress={props.onTypeText}><Icon.textInput /></Btn>
          </div>
        )}
        <div className="vt-row main">
          <Btn label={props.keyboardOpen ? 'Hide keyboard' : 'Show keyboard'} on={props.keyboardOpen} onPress={props.onKeyboard}><Icon.keyboard /></Btn>
          <Btn label="Dictate" onPress={props.onDictate}><Icon.mic /></Btn>
          <Btn label="Modifier keys" on={row === 'mods' || Object.values(sticky).some(Boolean)} onPress={() => toggle('mods')}><span className="vt-glyph">⌘</span></Btn>
          <Btn label="Arrow keys" on={row === 'arrows'} onPress={() => toggle('arrows')}><Icon.move /></Btn>
          <Btn label="Editing" on={row === 'edit'} onPress={() => toggle('edit')}><Icon.scissors /></Btn>
          <Btn label="Shortcuts" on={menu === 'shortcuts'} onPress={() => setMenu(menu === 'shortcuts' ? null : 'shortcuts')}><Icon.keyCombo /></Btn>
          <Btn label="Settings" on={menu === 'settings'} onPress={() => setMenu(menu === 'settings' ? null : 'settings')}><Icon.sliders /></Btn>
        </div>
      </div>
    </>
  )
}
