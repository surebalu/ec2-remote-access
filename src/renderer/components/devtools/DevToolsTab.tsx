import { useRef, useState, type ReactElement } from 'react'
import { MAX_TOOL_INPUT, transformText, type DevTool } from '@shared/devTools'
import { useStore } from '../../store'
import { Icon } from '../icons'
import './devtools.css'

const TOOLS: { id: DevTool; name: string; detail: string; icon: typeof Icon.code; actions: [string, string][]; sample: string }[] = [
  { id: 'json', name: 'JSON', detail: 'Format, validate and compact payloads.', icon: Icon.code, actions: [['format', 'Format JSON'], ['minify', 'Minify']], sample: '{"service":"api","region":"us-east-1","healthy":true,"ports":[443,8080]}' },
  { id: 'base64', name: 'Base64', detail: 'Encode or decode UTF-8 text, including Unicode.', icon: Icon.convert, actions: [['encode', 'Encode'], ['decode', 'Decode']], sample: 'Hello, engineer 👋' },
  { id: 'url', name: 'URL encoding', detail: 'Encode a query value or decode percent escapes. A + stays a +.', icon: Icon.globe, actions: [['encode', 'Encode'], ['decode', 'Decode']], sample: 'service=api & region=us-east-1' },
  { id: 'jwt', name: 'JWT inspector', detail: 'Read token headers, claims and UTC dates. Signatures are not verified.', icon: Icon.shield, actions: [['inspect', 'Inspect token']], sample: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJleGFtcGxlIiwiaWF0IjoxNzAwMDAwMDAwfQ.example' },
  { id: 'time', name: 'Timestamps', detail: 'Convert Unix seconds, milliseconds or ISO dates with a timezone.', icon: Icon.history, actions: [['seconds', 'From seconds / ISO'], ['milliseconds', 'From milliseconds']], sample: '2026-10-22T14:30:00Z' },
  { id: 'uuid', name: 'UUID generator', detail: 'Generate up to 100 random version 4 identifiers.', icon: Icon.fingerprint, actions: [['generate', 'Generate UUIDs']], sample: '5' },
  { id: 'hash', name: 'SHA-256', detail: 'Calculate a SHA-256 checksum of UTF-8 text.', icon: Icon.fingerprint, actions: [['hash', 'Hash text']], sample: 'hello world' }
]
type Draft = { input: string; output: string; error: string }
const EMPTY: Draft = { input: '', output: '', error: '' }

/** Inputs stay in this mounted tab only: switching sections keeps work, closing the tab discards it. */
export default function DevToolsTab(): ReactElement {
  const [selected, setSelected] = useState<DevTool>('json')
  const [drafts, setDrafts] = useState<Partial<Record<DevTool, Draft>>>({})
  const [busy, setBusy] = useState(false)
  const revision = useRef(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const tool = TOOLS.find((t) => t.id === selected)!
  const draft = drafts[selected] ?? EMPTY
  const update = (patch: Partial<Draft>): void => setDrafts((old) => ({ ...old, [selected]: { ...(old[selected] ?? EMPTY), ...patch } }))
  const edit = (input: string): void => { revision.current++; setBusy(false); update({ input, output: '', error: '' }) }
  const pick = (id: DevTool): void => { revision.current++; setBusy(false); setSelected(id) }
  const run = async (action: string): Promise<void> => {
    const current = ++revision.current
    setBusy(true)
    try {
      const output = await transformText(selected, draft.input, action)
      if (current === revision.current) update({ output, error: '' })
    } catch (e) {
      if (current === revision.current) update({ output: '', error: (e as Error).message })
    } finally { if (current === revision.current) setBusy(false) }
  }
  const copy = async (): Promise<void> => {
    try { await window.api.invoke('clipboard:write', draft.output); useStore.getState().toast('success', 'Result copied') }
    catch (e) { useStore.getState().toast('error', (e as Error).message) }
  }
  return <section className="dev-workbench" aria-label="Developer tools">
    <header className="dev-header">
      <div className="dev-brand"><span className="dev-emblem"><Icon.code /></span><div><span className="dev-eyebrow">ENGINEER'S WORKBENCH</span><h1>Developer tools</h1></div></div>
      <span className="dev-local"><Icon.shield />Runs on this device</span>
    </header>
    <div className="dev-layout">
      <nav className="dev-nav" aria-label="Developer utilities">
        <p>EVERYDAY UTILITIES</p>
        {TOOLS.map((item) => <button key={item.id} type="button" aria-pressed={selected === item.id} onClick={() => pick(item.id)}><item.icon /><span>{item.name}</span>{selected === item.id && <Icon.forward />}</button>)}
        <div className="dev-nav-tip"><Icon.split /><span>Keep this beside a terminal.<br />Drag Dev tools from the rail onto your session.</span></div>
      </nav>
      <div className="dev-content">
        <div className="dev-intro"><div><h2>{tool.name}</h2><p>{tool.detail}</p></div><button className="btn btn-sm" onClick={() => { edit(tool.sample); inputRef.current?.focus() }}>Load example</button></div>
        {selected === 'jwt' && <div className="dev-notice"><Icon.shield />Decoded only. These claims do not prove a token is authentic or authorized.</div>}
        <div className="dev-actions">
          {tool.actions.map(([id, label], index) => <button key={id} className={`btn ${index === 0 ? 'btn-primary' : ''}`} disabled={busy} onClick={() => void run(id)}>{index === 0 && <Icon.play />}{label}</button>)}
          {selected === 'time' && <button className="btn" onClick={() => edit(new Date().toISOString())}>Use current time</button>}
          <span className="dev-action-spacer" />
          <button className="btn" disabled={!draft.output} onClick={() => void copy()}><Icon.copy />Copy result</button>
        </div>
        <div className="dev-editors">
          <div className="dev-editor">
            <label htmlFor="dev-input"><span>{selected === 'uuid' ? 'How many UUIDs?' : 'Input'}</span><small>{draft.input.length.toLocaleString()} characters</small></label>
            <textarea id="dev-input" ref={inputRef} value={draft.input} spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-describedby="dev-input-hint" placeholder={selected === 'uuid' ? '1' : `Paste ${selected === 'json' ? 'JSON' : selected === 'jwt' ? 'a token' : 'text'} here…`} onChange={(e) => edit(e.target.value)} onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void run(tool.actions[0][0]) }
            }} />
            <div className="dev-editor-foot" id="dev-input-hint"><span>Up to {MAX_TOOL_INPUT.toLocaleString()} characters</span><button disabled={!draft.input && !draft.output} onClick={() => edit('')}>Clear</button></div>
          </div>
          <div className="dev-editor dev-result">
            <label htmlFor="dev-output"><span>Result</span><small>{draft.output ? 'Ready to copy' : 'Waiting for input'}</small></label>
            <textarea id="dev-output" value={draft.output} readOnly spellCheck={false} placeholder="Your result will appear here." />
            <div className="dev-editor-foot"><span>{draft.output ? `${draft.output.length.toLocaleString()} characters` : 'Processed locally'}</span><button disabled={!draft.output || selected === 'uuid'} onClick={() => { edit(draft.output); inputRef.current?.focus() }}>Use as input <Icon.forward /></button></div>
          </div>
        </div>
        {draft.error && <p className="dev-error" role="alert"><Icon.info />{draft.error}</p>}
        <footer className="dev-footer"><span>Input stays in this tab until you clear or close it. Nothing is uploaded or saved to disk.</span><kbd>⌘ / Ctrl ↵</kbd></footer>
      </div>
    </div>
  </section>
}
