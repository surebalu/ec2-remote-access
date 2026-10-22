import type { ReactElement } from 'react'
import { TOOL_NAMES, useStore } from '../../store'
import { TOOL_DESCRIPTIONS, TOOL_GROUPS } from '../../toolCatalog'
import { LOOKS, lookVars } from '../../toolLooks'
import { hasBrowser } from '../../quickConnect'
import { sectionKeyLabel } from '../../shortcuts'

export default function ToolDirectory(): ReactElement {
  const tabs = useStore((s) => s.tabs)
  const shortcuts = useStore((s) => s.settings?.shortcuts)
  return <div className="ws-directory">
    {TOOL_GROUPS.map((group) => <section key={group.id} aria-label={`${group.label} tools`}>
      <h3>{group.label}</h3>
      {group.tools.filter((kind) => hasBrowser() || !['local', 'finder'].includes(kind)).map((kind) => <button key={kind} className="ws-tool" onClick={() => useStore.getState().openTool(kind)}>
        <span className="hd-squircle" style={lookVars(LOOKS[kind].hue)}>{LOOKS[kind].icon()}</span>
        <span><strong>{TOOL_NAMES[kind]}</strong><small>{TOOL_DESCRIPTIONS[kind]}</small></span>
        <span className="ws-tool-state">{tabs.some((t) => t.kind === kind) ? 'Open' : sectionKeyLabel(kind, shortcuts)}</span>
      </button>)}
    </section>)}
  </div>
}
