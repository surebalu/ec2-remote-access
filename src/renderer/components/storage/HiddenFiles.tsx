import { useMemo, useState, type ReactElement } from 'react'
import { bytes, hiddenInfo, plural, type MapNode } from '@shared/storage'
import { Icon } from '../icons'
import { Badge, Intro, ItemMenu, ListBar, NeedsScan, NodeIcon, Row, Segmented, TopBar, TrashFooter, useLoad, useNodeIcons, useScanTree, useTicks } from './parts'
import { startScan, useStorage } from './state'

/**
 * Hidden Files: the largest things Finder does not show (names starting with a dot), each with what it is when known.
 * Only caches a tool fills again start ticked; keys, settings, repositories and installs never do.
 */

const LEVEL: Record<string, { label: string; tone: 'ok' | 'info' | 'warn' | 'crit' }> = {
  cache: { label: 'Cache', tone: 'ok' }, rebuilt: { label: 'Made again', tone: 'info' }, tool: { label: 'Installed tools', tone: 'warn' }, yours: { label: 'Keep', tone: 'crit' }
}

export default function HiddenFiles(): ReactElement {
  const { live, version } = useScanTree()
  const summary = useStorage((s) => s.scan.summary)
  const [sort, setSort] = useState<'size' | 'name'>('size')
  const [menu, setMenu] = useState<{ node: MapNode; anchor: HTMLElement } | null>(null)
  const load = useLoad(() => (live ? window.api.invoke('storage:hidden') : Promise.resolve([] as MapNode[])), [live, version])
  const items = useMemo(() => [...(load.data ?? [])].sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.size - a.size), [load.data, sort])
  const total = items.reduce((s, i) => s + i.size, 0)
  const largest = items.reduce((m, i) => Math.max(m, i.size), 1)
  const caches = items.filter((i) => hiddenInfo(i.name)?.level === 'cache').map((i) => i.path)
  const [ticks, tick, setTicks] = useTicks(`${version}:${items.length}`, () => caches)
  const icons = useNodeIcons(items)
  const picked = items.filter((i) => ticks.has(i.path))

  if (!live) return <div className="st-room"><TopBar title="Hidden Files" /><div className="st-scroll"><NeedsScan what="what hides in dot folders" /></div></div>
  return (
    <div className="st-room">
      <TopBar title="Hidden Files" />
      <Intro actions={<button type="button" className="st-button" onClick={() => void startScan(summary?.kind ?? 'mac', summary?.kind === 'path' ? summary.root : undefined)}><Icon.refresh />Scan Again</button>}>
        Folders and files whose names start with a dot, which Finder does not show. {load.data ? `${bytes(total)} of them in this scan.` : ''} Only caches a tool fills again start ticked.
      </Intro>
      <ListBar text={load.data ? `${plural(items.length, 'hidden item')} of 1 MB or more` : 'Looking for hidden files…'}>
        <Segmented small value={sort} onChange={setSort} options={[{ id: 'size', label: 'Largest' }, { id: 'name', label: 'Name' }]} />
      </ListBar>
      <div className="st-list">
        {load.error && <div className="plan-error"><Icon.alert />{load.error}</div>}
        {load.data && !items.length && <div className="st-empty"><h3>Nothing hidden here</h3><p className="muted">No hidden item of 1 MB or more.</p></div>}
        {items.map((i) => {
          const info = hiddenInfo(i.name)
          const lv = info ? LEVEL[info.level] : null
          return (
            <Row key={i.id} checked={ticks.has(i.path)} onCheck={(on) => tick(i.path, on)} icon={<NodeIcon node={i} icons={icons} />}
              title={i.name} badges={lv && <Badge tone={lv.tone}>{lv.label}</Badge>}
              sub={<span title={info?.what ?? 'Not one the app knows. Hidden folders are usually made by an app or a developer tool; if you do not know which, leave it.'}>{i.path.replace(/^\/Users\/[^/]+/, '~')}</span>}
              bar={(i.size / largest) * 100} size={i.size} reveal={i.path} onMenu={(anchor) => setMenu({ node: i, anchor })} />
          )
        })}
      </div>
      <TrashFooter items={picked.map((i) => ({ path: i.path, size: i.size, dir: i.dir }))} from="Hidden Files" onDone={() => setTicks([])}
        links={[{ label: 'Select Caches', onClick: () => setTicks(caches), disabled: !caches.length }, { label: 'Select All', onClick: () => setTicks(items.map((i) => i.path)), disabled: !items.length }, { label: 'Select None', onClick: () => setTicks([]), disabled: !picked.length }]} />
      {menu && <ItemMenu node={menu.node} anchor={menu.anchor} from="Hidden Files" onClose={() => setMenu(null)} />}
    </div>
  )
}
