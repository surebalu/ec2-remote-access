import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { bytes, plural, type DuplicateGroup, type MapNode } from '@shared/storage'
import { Icon } from '../icons'
import { Badge, changed, GroupHead, Intro, ItemIcon, ItemMenu, ListBar, NeedsScan, Row, TopBar, TrashFooter, useNodeIcons, useScanTree, where } from './parts'
import { useStorage } from './state'

/**
 * Duplicates: files with identical contents in the last scan, whatever they are called. Files are grouped by length,
 * then compared by their first and last 64 KB, then read in full only if they still match (in the scan process).
 * Every copy but the oldest starts ticked; ticking every copy of a file is called out, since that removes it entirely.
 */
export default function Duplicates(): ReactElement {
  const { live } = useScanTree()
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; phase: string } | null>(null)
  const [ticks, setTicks] = useState<Set<string>>(new Set())
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ node: MapNode; anchor: HTMLElement } | null>(null)
  const scanAt = useStorage((s) => s.scan.summary?.at)

  useEffect(() => window.api.on('storage:dupProgress', setProgress), [])
  useEffect(() => { setGroups(null) }, [scanAt])
  const extras = (g: DuplicateGroup[]): string[] => g.flatMap((x) => x.files.slice(1).map((f) => f.path))
  const find = (): void => {
    setBusy(true)
    setError(null)
    setProgress(null)
    window.api.invoke('storage:duplicates').then((g) => { setGroups(g); setTicks(new Set(extras(g))) }, (e: Error) => { if (e.message !== 'cancelled') setError(e.message) }).finally(() => { setBusy(false); setProgress(null) })
  }
  // Files that went to the Trash leave their groups; a group of one is no longer a duplicate.
  const trashed = useStorage((s) => s.trashed)
  useEffect(() => {
    if (!groups) return
    void window.api.invoke('storage:removed').then((r) => {
      const gone = new Set(r.map((x) => x.path))
      setGroups((gs) => gs?.map((g) => ({ ...g, files: g.files.filter((f) => !gone.has(f.path)) })).filter((g) => g.files.length > 1) ?? null)
    })
  }, [trashed]) // eslint-disable-line react-hooks/exhaustive-deps

  const files = useMemo(() => groups?.flatMap((g) => g.files) ?? [], [groups])
  const icons = useNodeIcons(files)
  const picked = files.filter((f) => ticks.has(f.path))
  const wipes = groups?.filter((g) => g.files.every((f) => ticks.has(f.path))).length ?? 0
  const frees = groups?.reduce((s, g) => s + g.files.slice(1).reduce((t, f) => t + f.size, 0), 0) ?? 0
  const toggle = (path: string, on: boolean): void => setTicks((t) => { const n = new Set(t); if (on) n.add(path); else n.delete(path); return n })

  if (!live) return <div className="st-room"><TopBar title="Duplicates" /><div className="st-scroll"><NeedsScan what="duplicate files" /></div></div>
  return (
    <div className="st-room">
      <TopBar title="Duplicates" />
      <Intro actions={busy
        ? <button type="button" className="st-button" onClick={() => void window.api.invoke('storage:cancelDuplicates')}>Stop</button>
        : <button type="button" className="st-primary" onClick={find}><Icon.search />{groups ? 'Compare Again' : 'Find Duplicates'}</button>}>
        Compares the contents, not the names, of every file of 1 MB or more in the scan, outside apps, libraries, hidden folders and macOS's own folders. The oldest copy in each set stays unticked.
      </Intro>
      {groups && <ListBar text={`${plural(groups.length, 'file')} with copies · removing the extra copies frees ${bytes(frees)}`}
        links={[{ label: 'Select Extra Copies', onClick: () => setTicks(new Set(extras(groups))), disabled: !groups.length }, { label: 'Select None', onClick: () => setTicks(new Set()), disabled: !picked.length }]} />}
      <div className="st-list">
        {error && <div className="plan-error"><Icon.alert />{error}</div>}
        {busy && <div className="st-empty"><div className="st-spinner" aria-hidden="true" /><h3>{progress?.phase ?? 'Grouping files by size'}…</h3>{progress && <p className="muted">{progress.done.toLocaleString('en-US')} of {plural(progress.total, 'file')}</p>}</div>}
        {!busy && !groups && <div className="st-empty"><span className="st-empty-art"><Icon.copy /></span><h3>Find identical copies</h3><p>Files are grouped by size, then compared by a sample of their contents, then read in full only if they still match.</p></div>}
        {!busy && groups && !groups.length && <div className="st-empty"><span className="st-empty-art"><Icon.check /></span><h3>No duplicates</h3><p className="muted">No file of 1 MB or more has an identical copy anywhere else in this scan.</p></div>}
        {!busy && groups?.map((g) => {
          const key = g.files[0].path
          const on = g.files.filter((f) => ticks.has(f.path))
          return (
            <section key={key} className="st-group">
              <GroupHead look="duplicates" title={g.files[0].name} sub={`${g.files.length} copies · ${bytes(g.length)} each`} size={g.files.slice(1).reduce((s, f) => s + f.size, 0)}
                state={on.length === g.files.length ? 'all' : on.length ? 'some' : 'none'} onTick={(v) => { for (const f of v ? g.files.slice(1) : g.files) toggle(f.path, v) }}
                open={!closed.has(key)} onToggle={() => setClosed((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n })} />
              {!closed.has(key) && g.files.map((f, i) => (
                <Row key={f.path} indent checked={ticks.has(f.path)} onCheck={(v) => toggle(f.path, v)} icon={<ItemIcon path={f.path} icons={icons} />}
                  title={f.name} badges={i === 0 ? <Badge tone="ok">Oldest</Badge> : undefined} sub={`${where(f.path)}${f.mtime ? ` · ${changed(f.mtime)}` : ''}`} size={f.size} reveal={f.path}
                  onMenu={(anchor) => setMenu({ node: f, anchor })} />
              ))}
            </section>
          )
        })}
      </div>
      <TrashFooter items={picked.map((f) => ({ path: f.path, size: f.size }))} from="Duplicates"
        note={wipes ? <span className="st-warn-text">That removes every copy of {plural(wipes, 'file')}, not just the extras.</span> : 'Everything goes to the Trash, and can be put back.'} />
      {menu && <ItemMenu node={menu.node} anchor={menu.anchor} from="Duplicates" onClose={() => setMenu(null)} />}
    </div>
  )
}
