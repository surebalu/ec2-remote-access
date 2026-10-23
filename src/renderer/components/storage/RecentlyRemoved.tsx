import { useMemo, type ReactElement } from 'react'
import { ago, bytes, plural, type RemovedEntry } from '@shared/storage'
import { Icon } from '../icons'
import { ItemRow, RoomHead, tilde, useLoad, useNodeIcons, useTicks } from './parts'
import { putBack, useStorage } from './state'

/**
 * Recently Removed: everything the Storage tool moved to the Trash in the last 90 days, and where it came from. Put
 * Back returns what is still in the Trash, never replacing anything at its old place. The app never empties the Trash:
 * that is the one step that cannot be undone, and it is Finder's.
 */

const STATE_NOTE: Record<RemovedEntry['state'], string> = {
  'in-trash': '',
  gone: 'No longer in the Trash: emptied, or dragged out of it.',
  restored: 'Already back where it was.',
  occupied: 'Something else is at its old place now, so it stays in the Trash.',
  'no-folder': 'The folder it came from no longer exists. Drag it out of the Trash to a place of your choosing.'
}

export default function RecentlyRemoved(): ReactElement {
  const trashed = useStorage((s) => s.trashed)
  const list = useLoad(() => window.api.invoke('storage:removed'), [trashed])
  const trash = useLoad(() => window.api.invoke('storage:trashSize'), [trashed])
  const items = list.data ?? []
  const back = useMemo(() => items.filter((i) => i.state === 'in-trash'), [items])
  const [ticks, tick, setTicks] = useTicks(`${trashed}:${items.length}`, () => [])
  const icons = useNodeIcons(useMemo(() => items.filter((i) => i.state === 'in-trash').map((i) => ({ path: i.trashPath })), [items]))
  const picked = back.filter((i) => ticks.has(i.id))
  const restore = async (ids: string[]): Promise<void> => {
    if (await putBack(ids)) { list.reload(); trash.reload() }
  }
  const forget = async (ids: string[]): Promise<void> => { await window.api.invoke('storage:forget', ids); list.reload() }

  return (
    <div className="st-list-room">
      <RoomHead icon={<Icon.history />} title="Recently Removed" sub={`${plural(items.length, 'item')} in the last 90 days`}>
        <button type="button" className="btn btn-sm" onClick={() => void window.api.invoke('storage:openTrash')}><Icon.trash />Open the Trash</button>
      </RoomHead>
      <p className="st-intro">
        {trash.data != null ? <><b>{bytes(trash.data)}</b> waits in the Trash, still taking space until it is emptied in Finder. </> : 'Looking in the Trash needs Full Disk Access. '}
        This app moves things to the Trash and never empties it, because that is the one step that cannot be undone.
      </p>
      <div className="plan-scroll st-list">
        {list.error && <div className="plan-error"><Icon.alert />{list.error}</div>}
        {list.data && !items.length && <div className="st-empty"><Icon.history className="plan-empty-icon" /><p>Nothing removed yet.</p><p className="muted">When something goes to the Trash from here, it is listed for 90 days with where it came from, so you can put it back while it is still in the Trash.</p></div>}
        {items.map((i) => {
          const name = i.path.split('/').pop() || i.path
          const can = i.state === 'in-trash'
          return (
            <ItemRow key={i.id} checked={ticks.has(i.id)} onCheck={can ? (on) => tick(i.id, on) : undefined} disabled={!can}
              icon={icons.get(i.trashPath) ? <img className="st-icon" src={icons.get(i.trashPath)} alt="" /> : <span className="st-icon st-icon-glyph">{i.dir ? <Icon.folder /> : <Icon.note />}</span>}
              title={name} sub={<span title={i.path}>From {tilde(i.path.replace(/\/[^/]+$/, ''))}</span>}
              note={[`${i.from}, ${ago(i.at)}`, STATE_NOTE[i.state]].filter(Boolean).join(' · ')} warn={!can} size={i.size}
              extra={can
                ? <button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); void restore([i.id]) }}><Icon.undo />Put Back</button>
                : <button type="button" className="btn btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); void forget([i.id]) }}>Forget</button>} />
          )
        })}
      </div>
      {back.length > 0 && (
        <div className="st-trashbar">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTicks(picked.length === back.length ? [] : back.map((i) => i.id))}>{picked.length === back.length ? 'Select none' : 'Select all'}</button>
          <span className="flex-1" />
          <span className="muted st-trashbar-hint">Put Back never replaces anything.</span>
          <button type="button" className="btn btn-sm btn-primary" disabled={!picked.length} onClick={() => void restore(picked.map((i) => i.id))}><Icon.undo />Put Back {picked.length ? `${plural(picked.length, 'item')} (${bytes(picked.reduce((s, i) => s + i.size, 0))})` : ''}</button>
        </div>
      )}
    </div>
  )
}
