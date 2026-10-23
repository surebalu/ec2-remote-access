import { useState, type ReactElement } from 'react'
import { bytes, hiddenInfo, plural, type MapNode } from '@shared/storage'
import { Icon } from '../icons'
import { ItemMenu, ItemRow, NeedsScan, NodeIcon, RoomHead, tilde, TrashBar, useLoad, useNodeIcons, useScanTree, useTicks } from './parts'

/**
 * Hidden Files: the largest things Finder does not show (names starting with a dot), each with what it is when known.
 * Only caches a tool fills again start ticked; keys, settings, repositories and installs never do.
 */

const LEVEL: Record<string, { label: string; tone: string }> = {
  cache: { label: 'Cache', tone: 'ok' },
  rebuilt: { label: 'Made again', tone: 'info' },
  tool: { label: 'Installed tools', tone: 'warn' },
  yours: { label: 'Keep', tone: 'crit' }
}

export default function HiddenFiles(): ReactElement {
  const { live, version } = useScanTree()
  const [menu, setMenu] = useState<{ node: MapNode; anchor: HTMLElement } | null>(null)
  const load = useLoad(() => (live ? window.api.invoke('storage:hidden') : Promise.resolve([] as MapNode[])), [live, version])
  const items = load.data ?? []
  const [ticks, tick, setTicks] = useTicks(`${version}:${items.length}`, () => items.filter((i) => hiddenInfo(i.name)?.level === 'cache').map((i) => i.path))
  const icons = useNodeIcons(items)
  const picked = items.filter((i) => ticks.has(i.path))

  if (!live) return <div className="plan-scroll st-scroll"><RoomHead icon={<Icon.eyeOff />} title="Hidden Files" sub="The largest things Finder does not show you." /><NeedsScan what="what hides in dot folders" /></div>
  return (
    <div className="st-list-room">
      <RoomHead icon={<Icon.eyeOff />} title="Hidden Files" sub={load.data ? `${plural(items.length, 'hidden item')} of 1 MB or more · ${bytes(items.reduce((s, i) => s + i.size, 0))}` : 'Looking for hidden files…'} />
      <p className="st-intro">Folders and files whose names start with a dot, which Finder does not show. Only caches a tool fills again start ticked: the tool that made one rebuilds it when it needs it.</p>
      <div className="plan-scroll st-list">
        {load.error && <div className="plan-error"><Icon.alert />{load.error}</div>}
        {load.data && !items.length && <div className="st-empty"><p>Nothing hidden here of 1 MB or more.</p></div>}
        {items.map((i) => {
          const info = hiddenInfo(i.name)
          const lv = info ? LEVEL[info.level] : null
          return (
            <ItemRow key={i.id} checked={ticks.has(i.path)} onCheck={(on) => tick(i.path, on)} icon={<NodeIcon node={i} icons={icons} />}
              title={i.name} badge={lv && <span className={`st-badge ${lv.tone}`}>{lv.label}</span>}
              sub={<span title={i.path}>{tilde(i.path.replace(/\/[^/]+$/, ''))}</span>}
              note={info?.what ?? 'Not one the app knows. Hidden folders are usually made by an app or a developer tool; if you do not know which, leave it.'}
              warn={info?.level === 'yours'} size={i.size} onMenu={(anchor) => setMenu({ node: i, anchor })} />
          )
        })}
      </div>
      {items.length > 0 && (
        <div className="st-selectline">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTicks(items.filter((i) => hiddenInfo(i.name)?.level === 'cache').map((i) => i.path))}>Tick the caches</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTicks([])}>Select none</button>
        </div>
      )}
      <TrashBar items={picked.map((i) => ({ path: i.path, size: i.size, dir: i.dir }))} from="Hidden Files" onDone={() => setTicks([])} />
      {menu && <ItemMenu node={menu.node} anchor={menu.anchor} from="Hidden Files" onClose={() => setMenu(null)} />}
    </div>
  )
}
