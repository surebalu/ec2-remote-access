import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { bytes, plural, type DuplicateGroup } from '@shared/storage'
import { Icon } from '../icons'
import { ItemMenu, NeedsScan, NodeIcon, RoomHead, tilde, TrashBar, useNodeIcons, useScanTree } from './parts'
import { useStorage } from './state'

/**
 * Duplicates: files with identical contents in the last scan, whatever they are called. Files are grouped by length,
 * then compared by their first and last 64 KB, then read in full only if they still match (in the scan process).
 * Every copy but the oldest starts ticked; ticking every copy of a file asks first, since that removes it entirely.
 */
export default function Duplicates(): ReactElement {
  const { live, version } = useScanTree()
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; phase: string } | null>(null)
  const [ticks, setTicks] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ path: string; size: number; anchor: HTMLElement } | null>(null)
  const scanAt = useStorage((s) => s.scan.summary?.at)

  useEffect(() => window.api.on('storage:dupProgress', setProgress), [])
  // A new scan means the old comparison no longer matches it.
  useEffect(() => { setGroups(null) }, [scanAt])
  const find = (): void => {
    setBusy(true)
    setError(null)
    setProgress(null)
    window.api.invoke('storage:duplicates').then((g) => {
      setGroups(g)
      setTicks(new Set(g.flatMap((x) => x.files.slice(1).map((f) => f.path))))
    }, (e: Error) => { if (e.message !== 'cancelled') setError(e.message) }).finally(() => { setBusy(false); setProgress(null) })
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

  if (!live) return <div className="plan-scroll st-scroll"><RoomHead icon={<Icon.copy />} title="Duplicates" sub="Identical files, whatever they are called." /><NeedsScan what="duplicate files" /></div>
  return (
    <div className="st-list-room">
      <RoomHead icon={<Icon.copy />} title="Duplicates" sub={groups ? `${plural(groups.length, 'file')} with copies · removing the extra copies frees ${bytes(frees)}` : 'Files of 1 MB or more compared by their contents.'}>
        {busy
          ? <button type="button" className="btn btn-sm" onClick={() => void window.api.invoke('storage:cancelDuplicates')}>Stop</button>
          : <button type="button" className="btn btn-sm btn-primary" onClick={find}><Icon.search />{groups ? 'Compare again' : 'Find duplicates'}</button>}
      </RoomHead>
      <p className="st-intro">Compares the contents, not the names, of every file of 1 MB or more in the scan, outside apps, libraries, hidden folders and macOS's own folders. The oldest copy in each set stays ticked off; nothing moves until you choose.</p>
      <div className="plan-scroll st-list">
        {error && <div className="plan-error"><Icon.alert />{error}</div>}
        {busy && (
          <div className="st-empty">
            <div className="st-spinner" aria-hidden="true" />
            <p>{progress?.phase ?? 'Grouping files by size'}…</p>
            {progress && <p className="muted">{progress.done.toLocaleString('en-US')} of {plural(progress.total, 'file')}</p>}
          </div>
        )}
        {!busy && !groups && <div className="st-empty"><Icon.copy className="plan-empty-icon" /><p>Find files with identical contents in {version ? 'the last scan' : 'the scan'}.</p></div>}
        {!busy && groups && !groups.length && <div className="st-empty"><Icon.check className="plan-empty-icon" /><p>No file of 1 MB or more has an identical copy anywhere else in this scan.</p></div>}
        {!busy && groups?.map((g) => (
          <section key={g.files[0].path} className="st-group">
            <header className="st-group-head">
              <div className="st-group-text">
                <h3>{g.files[0].name} <span className="muted">{g.files.length} copies · {bytes(g.length)} each</span></h3>
              </div>
              <span className="st-size">{bytes(g.files.slice(1).reduce((s, f) => s + f.size, 0))}</span>
            </header>
            {g.files.map((f, i) => (
              <div key={f.path} className="st-row" onContextMenu={(e) => { e.preventDefault(); setMenu({ path: f.path, size: f.size, anchor: e.currentTarget }) }}>
                <input type="checkbox" className="st-check" checked={ticks.has(f.path)} aria-label="Select"
                  onChange={(e) => setTicks((t) => { const n = new Set(t); if (e.target.checked) n.add(f.path); else n.delete(f.path); return n })} />
                <NodeIcon node={f} icons={icons} />
                <div className="st-row-body">
                  <div className="st-row-title">{f.name}{i === 0 && <span className="st-badge ok">Oldest</span>}</div>
                  <div className="st-row-sub" title={f.path}>{tilde(f.path.replace(/\/[^/]+$/, ''))}</div>
                </div>
                <span className="st-size">{bytes(f.size)}</span>
                <button type="button" className="st-more" aria-label="More" onClick={(e) => setMenu({ path: f.path, size: f.size, anchor: e.currentTarget })}><Icon.more /></button>
              </div>
            ))}
          </section>
        ))}
      </div>
      <TrashBar items={picked.map((f) => ({ path: f.path, size: f.size }))} from="Duplicates"
        note={wipes ? <span className="st-warn-text">That removes every copy of {plural(wipes, 'file')}, not just the extras.</span> : undefined} />
      {menu && <ItemMenu node={{ path: menu.path, dir: false, size: menu.size }} anchor={menu.anchor} from="Duplicates" onClose={() => setMenu(null)} />}
    </div>
  )
}
