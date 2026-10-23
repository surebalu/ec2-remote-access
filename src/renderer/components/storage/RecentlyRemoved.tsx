import { useMemo, type ReactElement } from 'react'
import { ago, bytes, plural, type RemovedEntry } from '@shared/storage'
import { Icon } from '../icons'
import { Badge, Footer, Intro, ItemIcon, ListBar, Row, TopBar, useIcons, useLoad, useTicks, where } from './parts'
import { putBack, useStorage } from './state'

/**
 * Recently Removed: everything the Storage tool moved to the Trash in the last 90 days, and where it came from. Put
 * Back returns what is still in the Trash, never replacing anything at its old place. The app never empties the Trash:
 * that is the one step that cannot be undone, and it is Finder's.
 */

const STATE: Record<RemovedEntry['state'], { text: string; tone: 'ok' | 'muted' | 'warn' } | null> = {
  'in-trash': null,
  gone: { text: 'No longer in the Trash', tone: 'muted' },
  restored: { text: 'Already back', tone: 'ok' },
  occupied: { text: 'Its place is taken', tone: 'warn' },
  'no-folder': { text: 'Its folder is gone', tone: 'warn' }
}

export default function RecentlyRemoved(): ReactElement {
  const trashed = useStorage((s) => s.trashed)
  const list = useLoad(() => window.api.invoke('storage:removed'), [trashed])
  const trash = useLoad(() => window.api.invoke('storage:trashSize'), [trashed])
  const items = list.data ?? []
  const back = useMemo(() => items.filter((i) => i.state === 'in-trash'), [items])
  const [ticks, tick, setTicks] = useTicks(`${trashed}:${items.length}`, () => [])
  const icons = useIcons(items.filter((i) => i.state === 'in-trash').map((i) => i.trashPath))
  const picked = back.filter((i) => ticks.has(i.id))
  const restore = async (ids: string[]): Promise<void> => { if (await putBack(ids)) { list.reload(); trash.reload() } }
  const forget = async (ids: string[]): Promise<void> => { await window.api.invoke('storage:forget', ids); list.reload() }

  return (
    <div className="st-room">
      <TopBar title="Recently Removed" />
      <Intro actions={<button type="button" className="st-button" onClick={() => void window.api.invoke('storage:openTrash')}><Icon.trash />Open the Trash</button>}>
        {trash.data != null ? <><b>{bytes(trash.data)}</b> waits in the Trash, still taking space until it is emptied in Finder. </> : 'Looking in the Trash needs Full Disk Access. '}
        Everything moved from here in the last 90 days, and where it came from. Put Back never replaces anything.
      </Intro>
      <ListBar text={`${plural(items.length, 'item')} in the last 90 days`}
        links={[{ label: 'Select All', onClick: () => setTicks(back.map((i) => i.id)), disabled: !back.length }, { label: 'Select None', onClick: () => setTicks([]), disabled: !picked.length }]} />
      <div className="st-list">
        {list.error && <div className="plan-error"><Icon.alert />{list.error}</div>}
        {list.data && !items.length && <div className="st-empty"><span className="st-empty-art"><Icon.history /></span><h3>Nothing removed yet</h3><p className="muted">When something goes to the Trash from here, it is listed for 90 days with where it came from, so you can put it back while it is still in the Trash.</p></div>}
        {items.map((i) => {
          const can = i.state === 'in-trash'
          const st = STATE[i.state]
          return (
            <Row key={i.id} checked={ticks.has(i.id)} onCheck={can ? (on) => tick(i.id, on) : undefined} disabled={!can}
              icon={<ItemIcon path={can ? i.trashPath : undefined} icons={icons} dir={i.dir} />}
              title={i.path.split('/').pop() || i.path} badges={st && <Badge tone={st.tone}>{st.text}</Badge>}
              sub={`From ${where(i.path)} · ${i.from}, ${ago(i.at)}`} size={i.size}
              extra={can
                ? <button type="button" className="st-button sm" onClick={(e) => { e.stopPropagation(); void restore([i.id]) }}><Icon.undo />Put Back</button>
                : <button type="button" className="st-link" onClick={(e) => { e.stopPropagation(); void forget([i.id]) }}>Forget</button>} />
          )
        })}
      </div>
      <Footer count={picked.length} size={picked.reduce((s, i) => s + i.size, 0)} note="Put Back moves items from the Trash to where they were, never replacing anything there.">
        <button type="button" className="st-primary" disabled={!picked.length} onClick={() => void restore(picked.map((i) => i.id))}><Icon.undo />Put Back</button>
      </Footer>
    </div>
  )
}
