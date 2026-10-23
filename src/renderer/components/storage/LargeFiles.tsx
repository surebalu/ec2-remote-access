import { useMemo, useState, type ReactElement } from 'react'
import { bytes, KIND_NAMES, plural, type FileKind, type MapNode } from '@shared/storage'
import { Icon } from '../icons'
import { changed, Intro, ItemMenu, KIND_COLORS, ListBar, NeedsScan, NodeIcon, Row, Segmented, TopBar, TrashFooter, useLoad, useNodeIcons, useScanTree, useTicks, where } from './parts'

/**
 * Large Files: files of 100 MB or more in the last scan, biggest first. Files inside apps and packages are left out,
 * as are libraries and macOS's own folders unless asked. They are yours, so none starts ticked.
 */

const SIZES = [50e6, 100e6, 500e6, 1e9, 5e9]

export default function LargeFiles(): ReactElement {
  const { live, version } = useScanTree()
  const [min, setMin] = useState(100e6)
  const [everywhere, setEverywhere] = useState(false)
  const [kind, setKind] = useState<FileKind | 'all'>('all')
  const [sort, setSort] = useState<'size' | 'date' | 'name'>('size')
  const [menu, setMenu] = useState<{ node: MapNode; anchor: HTMLElement } | null>(null)
  const load = useLoad(() => (live ? window.api.invoke('storage:large', min, everywhere) : Promise.resolve([] as MapNode[])), [live, version, min, everywhere])
  const all = load.data ?? []
  const kinds = useMemo(() => {
    const m = new Map<FileKind, number>()
    for (const f of all) m.set(f.kind ?? 'other', (m.get(f.kind ?? 'other') ?? 0) + f.size)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [all])
  const shown = useMemo(() => {
    const l = kind === 'all' ? all : all.filter((f) => (f.kind ?? 'other') === kind)
    return [...l].sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : sort === 'date' ? (a, b) => (b.mtime ?? 0) - (a.mtime ?? 0) : (a, b) => b.size - a.size)
  }, [all, kind, sort])
  const [ticks, tick, setTicks] = useTicks(`${version}:${min}:${everywhere}`, () => [])
  const icons = useNodeIcons(shown)
  const picked = shown.filter((f) => ticks.has(f.path))

  if (!live) return <div className="st-room"><TopBar title="Large Files" /><div className="st-scroll"><NeedsScan what="your largest files" /></div></div>
  return (
    <div className="st-room">
      <TopBar title="Large Files" />
      <Intro actions={<>
        <label className="st-toggle" title="Also look inside Library folders and macOS's own folders"><input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} />Libraries too</label>
        <select className="st-select" value={min} aria-label="At least" onChange={(e) => setMin(Number(e.target.value))}>{SIZES.map((s) => <option key={s} value={s}>{bytes(s)} or more</option>)}</select>
      </>}>Your files of {bytes(min)} or more, biggest first. Files inside apps and packages are left out, so is what apps keep in Library folders unless you ask. They are yours, so none starts ticked.</Intro>
      <ListBar text={load.data ? `${plural(all.length, 'file')}, ${bytes(all.reduce((s, f) => s + f.size, 0))}` : 'Looking for large files…'}>
        <Segmented small value={sort} onChange={setSort} options={[{ id: 'size', label: 'Largest' }, { id: 'date', label: 'Newest' }, { id: 'name', label: 'Name' }]} />
      </ListBar>
      {kinds.length > 1 && (
        <div className="st-chips st-pad">
          <button type="button" className={`st-chip ${kind === 'all' ? 'on' : ''}`} onClick={() => setKind('all')}>All</button>
          {kinds.map(([k, v]) => <button key={k} type="button" className={`st-chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}><span className="st-dot" style={{ background: KIND_COLORS[k] }} />{KIND_NAMES[k]} <span className="muted">{bytes(v)}</span></button>)}
        </div>
      )}
      <div className="st-list">
        {load.error && <div className="plan-error"><Icon.alert />{load.error}</div>}
        {load.data && !shown.length && <div className="st-empty"><h3>None of your files here is {bytes(min)} or more</h3>{!everywhere && <p className="muted">Files inside apps and libraries are left out; tick Libraries too to include them.</p>}</div>}
        {shown.map((f) => (
          <Row key={f.id} checked={ticks.has(f.path)} onCheck={(on) => tick(f.path, on)} icon={<NodeIcon node={f} icons={icons} />}
            title={f.name} sub={`${KIND_NAMES[f.kind ?? 'other']} · ${where(f.path)}${f.mtime ? ` · ${changed(f.mtime)}` : ''}`} size={f.size} reveal={f.path}
            onOpen={() => void window.api.invoke('local:quickLook', f.path)} onMenu={(anchor) => setMenu({ node: f, anchor })} />
        ))}
      </div>
      <TrashFooter items={picked.map((f) => ({ path: f.path, size: f.size }))} from="Large Files" onDone={() => setTicks([])} note="Double-click for Quick Look. Everything goes to the Trash, and can be put back."
        links={[{ label: 'Select All', onClick: () => setTicks(shown.map((f) => f.path)), disabled: !shown.length }, { label: 'Select None', onClick: () => setTicks([]), disabled: !picked.length }]} />
      {menu && <ItemMenu node={menu.node} anchor={menu.anchor} from="Large Files" onClose={() => setMenu(null)} />}
    </div>
  )
}
