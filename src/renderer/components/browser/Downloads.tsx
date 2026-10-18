import type { ReactElement } from 'react'
import type { WebDownload } from '@shared/types'
import { useStore } from '../../store'
import { Icon } from '../icons'

const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`)
const ext = (name: string): string => /\.([a-z0-9]{1,8})$/i.exec(name)?.[1].toLowerCase() ?? 'file'

function open(path: string | null, how: 'open' | 'reveal'): void {
  window.api.invoke('browser:openDownload', path, how).catch((e: Error) => useStore.getState().toast('error', e.message))
}

/** The Downloads popover: recent files with progress, open on click, show in Finder, and the Downloads folder. */
export default function Downloads({ items, onClear, onDone }: { items: WebDownload[]; onClear: () => void; onDone: () => void }): ReactElement {
  return (
    <div className="dl">
      <div className="dl-head">
        <span className="section-title">Recent downloads</span>
        {items.some((d) => d.state !== 'progressing') && <button type="button" className="dl-clear" onClick={onClear}>Clear</button>}
      </div>
      {!items.length && <div className="dl-empty muted">Files you download appear here. They are saved to your Downloads folder.</div>}
      <div className="dl-list">
        {items.map((d) => {
          const done = d.state === 'completed'
          const pct = d.total > 0 ? Math.min(100, (d.received / d.total) * 100) : 0
          return (
            <div
              key={d.id}
              className={`dl-row ${done ? 'done' : ''} ${d.state}`}
              role={done ? 'button' : undefined}
              title={done ? `Open ${d.name}` : d.name}
              onClick={() => { if (done) { open(d.path, 'open'); onDone() } }}
            >
              {d.icon ? <img className="dl-icon" src={d.icon} alt="" draggable={false} /> : <span className="dl-icon generic"><Icon.note /></span>}
              <div className="min-w-0 flex-1">
                <div className="dl-name">{d.name}</div>
                {d.state === 'progressing' ? (
                  <>
                    <div className="dl-bar"><span style={{ width: `${d.total > 0 ? pct : 30}%` }} className={d.total > 0 ? '' : 'indeterminate'} /></div>
                    <div className="dl-sub">{size(d.received)}{d.total > 0 ? ` of ${size(d.total)}` : ''}</div>
                  </>
                ) : (
                  <div className="dl-sub">{done ? `${ext(d.name)}${d.total > 0 ? ` · ${size(d.total)}` : ''}` : d.state === 'cancelled' ? 'Cancelled' : 'Failed'}</div>
                )}
              </div>
              {d.state === 'progressing' ? (
                <button type="button" className="dl-act" title="Cancel" aria-label={`Cancel ${d.name}`} onClick={(e) => { e.stopPropagation(); void window.api.invoke('browser:cancelDownload', d.id) }}><Icon.x /></button>
              ) : done && (
                <button type="button" className="dl-act" title="Show in Finder" aria-label={`Show ${d.name} in Finder`} onClick={(e) => { e.stopPropagation(); open(d.path, 'reveal'); onDone() }}><Icon.search /></button>
              )}
            </div>
          )
        })}
      </div>
      <button type="button" className="dl-all" onClick={() => { open(null, 'open'); onDone() }}>
        View all downloads <Icon.external />
      </button>
    </div>
  )
}
