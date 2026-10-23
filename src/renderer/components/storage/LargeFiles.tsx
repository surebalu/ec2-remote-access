import { useMemo, useState, type ReactElement } from 'react'
import { bytes, KIND_NAMES, plural, type FileKind, type MapNode } from '@shared/storage'
import { Icon } from '../icons'
import { useLocal } from '../plan/parts'
import { ItemMenu, ItemRow, KIND_COLORS, modified, NeedsScan, NodeIcon, RoomHead, tilde, TrashBar, useLoad, useNodeIcons, useScanTree, useTicks } from './parts'

/**
 * Large Files: files of 100 MB or more in the last scan, biggest first. Files inside apps and packages are left out,
 * as are libraries and macOS's own folders unless asked. They are yours, so none starts ticked.
 */

const SIZES = [50e6, 100e6, 500e6, 1e9, 5e9]

export default function LargeFiles(): ReactElement {
  const { live, version } = useScanTree()
  const [min, setMin] = useLocal<string>('storage.largeMin', String(100e6))
  const [everywhere, setEverywhere] = useLocal<'0' | '1'>('storage.largeAll', '0')
  const [kind, setKind] = useState<FileKind | 'all'>('all')
  const [menu, setMenu] = useState<{ node: MapNode; anchor: HTMLElement } | null>(null)
  const load = useLoad(() => (live ? window.api.invoke('storage:large', Number(min), everywhere === '1') : Promise.resolve([] as MapNode[])), [live, version, min, everywhere])
  const all = load.data ?? []
  const kinds = useMemo(() => {
    const m = new Map<FileKind, number>()
    for (const f of all) m.set(f.kind ?? 'other', (m.get(f.kind ?? 'other') ?? 0) + f.size)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [all])
  const shown = kind === 'all' ? all : all.filter((f) => (f.kind ?? 'other') === kind)
  const [ticks, tick, setTicks] = useTicks(`${version}:${min}:${everywhere}`, () => [])
  const icons = useNodeIcons(shown)
  const picked = shown.filter((f) => ticks.has(f.path))

  if (!live) return <div className="plan-scroll st-scroll"><RoomHead icon={<Icon.note />} title="Large Files" sub="Your files of 100 MB or more, biggest first." /><NeedsScan what="your largest files" /></div>
  return (
    <div className="st-list-room">
      <RoomHead icon={<Icon.note />} title="Large Files" sub={load.data ? `${plural(all.length, 'file')} of ${bytes(Number(min))} or more · ${bytes(all.reduce((s, f) => s + f.size, 0))}` : 'Looking for large files…'}>
        <select className="input st-select" value={min} aria-label="At least" onChange={(e) => setMin(e.target.value)}>
          {SIZES.map((s) => <option key={s} value={String(s)}>{bytes(s)} or more</option>)}
        </select>
        <label className="st-toggle" title="Also look inside Library folders and macOS's own folders">
          <input type="checkbox" checked={everywhere === '1'} onChange={(e) => setEverywhere(e.target.checked ? '1' : '0')} />Libraries too
        </label>
      </RoomHead>
      {kinds.length > 1 && (
        <div className="st-chips">
          <button type="button" className={`st-chip ${kind === 'all' ? 'on' : ''}`} onClick={() => setKind('all')}>All</button>
          {kinds.map(([k, v]) => (
            <button key={k} type="button" className={`st-chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
              <span className="st-dot" style={{ background: KIND_COLORS[k] }} />{KIND_NAMES[k]} <span className="muted">{bytes(v)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="plan-scroll st-list">
        {load.error && <div className="plan-error"><Icon.alert />{load.error}</div>}
        {load.data && !shown.length && <div className="st-empty"><p>None of your files here is {bytes(Number(min))} or more.</p>{everywhere === '0' && <p className="muted">Files inside apps and libraries are left out; tick Libraries too to include them.</p>}</div>}
        {shown.map((f) => (
          <ItemRow key={f.id} checked={ticks.has(f.path)} onCheck={(on) => tick(f.path, on)} icon={<NodeIcon node={f} icons={icons} />}
            title={f.name} sub={<span title={f.path}>{tilde(f.path.replace(/\/[^/]+$/, ''))}</span>} note={[KIND_NAMES[f.kind ?? 'other'], modified(f.mtime)].filter(Boolean).join(' · ')} size={f.size}
            onOpen={() => void window.api.invoke('local:quickLook', f.path)} onMenu={(anchor) => setMenu({ node: f, anchor })} />
        ))}
      </div>
      {shown.length > 0 && (
        <div className="st-selectline">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTicks(picked.length === shown.length ? [] : shown.map((f) => f.path))}>{picked.length === shown.length ? 'Select none' : 'Select all'}</button>
          <span className="muted">Double-click for Quick Look.</span>
        </div>
      )}
      <TrashBar items={picked.map((f) => ({ path: f.path, size: f.size }))} from="Large Files" onDone={() => setTicks([])} />
      {menu && <ItemMenu node={menu.node} anchor={menu.anchor} from="Large Files" onClose={() => setMenu(null)} />}
    </div>
  )
}
