import { useEffect, type ReactElement } from 'react'
import { TOOL_DRAG_TYPE } from '@shared/toolWindows'
import TabBody from './components/TabBody'
import Toasts from './components/Toasts'
import { Icon } from './components/icons'
import { handleAppShortcut } from './shortcuts'
import { TOOL_NAMES, useStore, type ToolKind } from './store'
import { LOOKS, lookVars } from './toolLooks'

/**
 * A detached tool's own window (main/toolWindows.ts loads the renderer with ?tool=<kind>): the tool's page under a
 * slim title bar. Its icon drags back onto the main window, and Put back does the same, to show the tool there again.
 * The page starts with settings and the cached hosts only (store.initToolWindow): sign-in checks and scans stay the
 * main window's.
 */
export default function ToolWindow({ kind }: { kind: ToolKind }): ReactElement {
  const tab = useStore((s) => s.tabs.find((t) => t.kind === kind))
  useEffect(() => {
    document.title = TOOL_NAMES[kind]
    void useStore.getState().initToolWindow(kind)
    // The tool's own keys (⌘T, ⌘W, ⌘1… in the Browser and Terminal) work as in the main window.
    const onKey = (e: KeyboardEvent): void => { handleAppShortcut(e, { sections: false }) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [kind])
  const look = LOOKS[kind]
  return (
    <div className="tool-window">
      <header className="tool-window-bar">
        <span className="tool-window-grip" draggable title="Drag onto the main window to put it back"
          onDragStart={(e) => {
            e.dataTransfer.setData(TOOL_DRAG_TYPE, kind)
            e.dataTransfer.setData('text/plain', TOOL_NAMES[kind])
            e.dataTransfer.effectAllowed = 'move'
          }}>
          <span className="tool-window-icon" style={lookVars(look.hue, look.sat)}>{look.icon()}</span>
          {TOOL_NAMES[kind]}
        </span>
        <span className="flex-1" />
        <button type="button" className="btn btn-ghost btn-sm tool-window-attach" title="Show it in the main window again" onClick={() => void window.api.invoke('tools:attach', kind)}>
          <Icon.restore />Put back
        </button>
      </header>
      <main className="tool-window-body">{tab && <TabBody tab={tab} active focused />}</main>
      <Toasts />
    </div>
  )
}
