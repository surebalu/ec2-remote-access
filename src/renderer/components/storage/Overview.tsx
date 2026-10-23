import { useState, type ReactElement } from 'react'
import { ago, bytes, DISK_PARTS, FULL_DISK_ACCESS_URL, KIND_NAMES, plural, type DiskPart, type FileKind } from '@shared/storage'
import { reportSize } from '@shared/cleanup'
import { Icon } from '../icons'
import { homePath, KIND_COLORS, RoomHead, ScanButtons, ScanProgressCard, ShareBar, tilde, useLoad } from './parts'
import { openInMap, refreshFda, setRoom, startScan, useStorage, type RoomId } from './state'

const PART_COLORS: Record<DiskPart, string> = {
  apps: '#6366f1', documents: '#3b82f6', downloads: '#06b6d4', pictures: '#10b981', library: '#f59e0b', other: '#a78bfa', trash: '#f43f5e', system: '#64748b'
}

/** Where each part of the bar opens: a folder in the Space Map, or a room. */
const partTarget = (id: DiskPart): { path?: string; room?: RoomId } => {
  const h = homePath()
  return id === 'apps' ? { path: '/Applications' } : id === 'documents' ? { path: h } : id === 'downloads' ? { path: `${h}/Downloads` } : id === 'pictures' ? { path: `${h}/Pictures` }
    : id === 'library' ? { path: `${h}/Library` } : id === 'trash' ? { room: 'removed' } : id === 'system' ? { path: '/System' } : { path: h }
}

/** Ways to make room, each opening its room. */
const CARDS: { room: RoomId; icon: () => ReactElement; title: string; text: string }[] = [
  { room: 'junk', icon: () => <Icon.sparkles />, title: 'Junk Files', text: 'Caches, logs, build data and old installers, and how much each would free.' },
  { room: 'ai', icon: () => <Icon.brain />, title: 'AI Models', text: 'Models AI apps downloaded, often tens of gigabytes.' },
  { room: 'duplicates', icon: () => <Icon.copy />, title: 'Duplicates', text: 'Identical files, whatever they are called, and what removing the extra copies frees.' },
  { room: 'system', icon: () => <Icon.disk />, title: 'System Data', text: 'Backups, attachments, simulators and what else Storage settings counts there.' },
  { room: 'unused', icon: () => <Icon.moon />, title: 'Unused Apps', text: 'Apps not opened for months, from Spotlight\'s record.' },
  { room: 'optimize', icon: () => <Icon.wand />, title: 'Optimize', text: 'Junk nobody will miss and apps nobody is using, in one press.' },
  { room: 'large', icon: () => <Icon.note />, title: 'Large Files', text: 'Your files of 100 MB or more, biggest first.' },
  { room: 'hidden', icon: () => <Icon.eyeOff />, title: 'Hidden Files', text: 'The largest things Finder does not show you, with what each one is.' },
  { room: 'map', icon: () => <Icon.treemap />, title: 'Space Map', text: 'Every folder as a card sized by the space it takes.' },
  { room: 'removed', icon: () => <Icon.history />, title: 'Recently Removed', text: 'What went to the Trash from here, ready to put back.' }
]

export default function Overview(): ReactElement {
  const disk = useStorage((s) => s.disk)
  const scan = useStorage((s) => s.scan)
  const fda = useStorage((s) => s.fda)
  const trashed = useStorage((s) => s.trashed)
  const reports = useStorage((s) => s.reports)
  const trash = useLoad(() => window.api.invoke('storage:trashSize'), [trashed])
  const [hover, setHover] = useState<DiskPart | 'free' | null>(null)
  const summary = scan.summary
  const parts = summary?.parts?.length && summary.kind !== 'path' ? summary.parts : null
  const free = disk?.free ?? 0
  const total = disk?.total ?? 0
  const used = total - free
  const freeShare = total ? free / total : 1
  const level = freeShare < 0.05 ? 'crit' : freeShare < 0.1 ? 'warn' : 'ok'
  // The bar's parts are scaled to the disk's used space, so the bar always adds up to the disk.
  const partSum = parts ? parts.reduce((s, p) => s + p.bytes, 0) : 0
  const segs = parts ? parts.map((p) => ({ ...p, share: total ? ((p.bytes / partSum) * used) / total : 0 })) : []
  const kinds = summary ? (Object.entries(summary.byKind) as [FileKind, number][]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]) : []
  const kindMax = kinds[0]?.[1] ?? 0
  const history = disk?.history ?? []

  return (
    <div className="plan-scroll st-scroll">
      <RoomHead icon={<Icon.storage />} title="Overview" sub={disk ? `${disk.name} · ${bytes(free)} free of ${bytes(total)}` : 'Reading the disk…'}>
        {scan.status !== 'scanning' && summary && (
          <button type="button" className="btn btn-sm" onClick={() => void startScan(summary.kind, summary.kind === 'path' ? summary.root : undefined)}><Icon.refresh />Scan again</button>
        )}
      </RoomHead>

      {level !== 'ok' && disk && (
        <div className={`st-banner ${level}`}>
          <Icon.alert />
          <div>
            <b>{disk.name} is almost out of space: {bytes(free)} left.</b>
            <p>When it runs out, apps stop working and the Mac can freeze. Clear at least {bytes(Math.max(0, total * 0.1 - free))}, and empty the Trash in Finder: what is in it still takes space.</p>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => setRoom('large')}>Find what can go</button>
        </div>
      )}

      {fda === false && (
        <div className="st-banner info">
          <Icon.shield />
          <div>
            <b>Let the app read your whole disk</b>
            <p>macOS hides Mail, Messages, Safari and other apps' data from any app without Full Disk Access. Scans still run, but those folders stay closed and the totals come up short. Switch EC2 Remote Access on in Privacy &amp; Security, then quit and open it again.</p>
          </div>
          <div className="st-banner-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void window.api.invoke('shell:open', FULL_DISK_ACCESS_URL)}>Open Settings</button>
            <button type="button" className="btn btn-sm" onClick={() => void refreshFda()}>Check again</button>
          </div>
        </div>
      )}

      <section className="st-card st-diskcard">
        <div className="st-disk-big">
          <span><b>{bytes(used)}</b> used</span>
          <span className="muted"><b>{bytes(free)}</b> free</span>
        </div>
        <div className="st-stack" onMouseLeave={() => setHover(null)}>
          {parts
            ? segs.map((p) => <span key={p.id} className={hover && hover !== p.id ? 'dim' : ''} style={{ width: `${p.share * 100}%`, background: PART_COLORS[p.id] }} onMouseEnter={() => setHover(p.id)} />)
            : <span style={{ width: `${total ? (used / total) * 100 : 0}%`, background: 'var(--text-2)' }} />}
          <span className={`st-stack-free ${hover && hover !== 'free' ? 'dim' : ''}`} style={{ width: `${freeShare * 100}%` }} onMouseEnter={() => setHover('free')} />
        </div>
        {parts ? (
          <div className="st-legend">
            {DISK_PARTS.filter((d) => parts.some((p) => p.id === d.id)).map((d) => {
              const p = parts.find((x) => x.id === d.id)!
              const t = partTarget(d.id)
              return (
                <button key={d.id} type="button" className={`st-legend-item ${hover === d.id ? 'on' : ''}`} title={d.hint} onMouseEnter={() => setHover(d.id)} onMouseLeave={() => setHover(null)}
                  onClick={() => (t.room ? setRoom(t.room) : t.path && openInMap(t.path))}>
                  <span className="st-dot" style={{ background: PART_COLORS[d.id] }} />
                  <span className="st-legend-label">{d.label}</span>
                  <span className="st-legend-size">{bytes(p.bytes)}</span>
                </button>
              )
            })}
            <span className={`st-legend-item static ${hover === 'free' ? 'on' : ''}`}><span className="st-dot free" /><span className="st-legend-label">Free</span><span className="st-legend-size">{bytes(free)}</span></span>
          </div>
        ) : null}
        <div className="st-scanline">
          {scan.status === 'scanning' ? null : summary ? (
            <span className="muted">
              {summary.kind === 'path' ? `Scanned ${tilde(summary.root)}` : summary.kind === 'home' ? 'Scanned your home folder' : 'Scanned the whole Mac'} {ago(summary.at)}: {plural(summary.files, 'file')}, {bytes(summary.bytes)}, in {Math.max(1, Math.round(summary.took / 1000))} s.
              {summary.unreadable > 0 && ` ${plural(summary.unreadable, 'folder')} could not be read${summary.fullDiskAccess ? '' : ' without Full Disk Access'}.`}
              {!scan.live && ' The scan is no longer in memory; scan again to look into it.'}
            </span>
          ) : <span className="muted">See what fills the disk, by kind and by folder, in a minute or two. Nothing is removed until you say so.</span>}
        </div>
        {scan.status === 'scanning' ? <ScanProgressCard /> : !summary && <ScanButtons />}
      </section>

      {kinds.length > 0 && (
        <section className="st-card">
          <h3 className="st-card-title">By kind <span className="muted">files of 1 MB or more</span></h3>
          <div className="st-kinds">
            {kinds.map(([k, v]) => (
              <div key={k} className="st-kind">
                <span className="st-dot" style={{ background: KIND_COLORS[k] }} />
                <span className="st-kind-label">{KIND_NAMES[k]}</span>
                <ShareBar pct={kindMax ? (v / kindMax) * 100 : 0} color={KIND_COLORS[k]} />
                <span className="st-size">{bytes(v)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="st-cards">
        {trash.data != null && trash.data > 0 && (
          <button type="button" className="st-tile warn" onClick={() => void window.api.invoke('storage:openTrash')}>
            <Icon.trash />
            <b>{bytes(trash.data)} in the Trash</b>
            <span>Still taking space until it is emptied. Opens the Trash in Finder, where Empty is.</span>
          </button>
        )}
        {CARDS.map((c) => {
          const r = reports[c.room]
          const can = r ? reportSize(r, true) : 0
          return (
            <button key={c.room} type="button" className="st-tile" onClick={() => setRoom(c.room)}>
              {c.icon()}
              <b>{c.title}{r && can > 0 && <span className="st-tile-size"> · {bytes(can)} can go</span>}</b>
              <span>{c.text}</span>
            </button>
          )
        })}
      </div>

      {history.length > 1 && <Trend history={history} />}
    </div>
  )
}

/** The disk's use, one reading a day, over the last 7, 30 or 90 days. */
function Trend({ history }: { history: { day: string; used: number; total: number }[] }): ReactElement {
  const [days, setDays] = useState(30)
  const pts = history.slice(-days)
  const max = Math.max(...pts.map((p) => p.total))
  const min = Math.min(...pts.map((p) => p.used)) * 0.98
  const w = 600
  const h = 90
  const x = (i: number): number => (pts.length < 2 ? 0 : (i / (pts.length - 1)) * w)
  const y = (v: number): number => h - ((v - min) / Math.max(1, max - min)) * h
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.used).toFixed(1)}`).join(' ')
  const change = pts.length > 1 ? pts[pts.length - 1].used - pts[0].used : 0
  return (
    <section className="st-card">
      <h3 className="st-card-title">
        Used space
        <span className="muted">{change === 0 ? 'no change' : `${change > 0 ? 'up' : 'down'} ${bytes(Math.abs(change))}`} since {pts[0].day}</span>
        <span className="flex-1" />
        <span className="plan-segment" role="radiogroup" aria-label="Days">
          {[7, 30, 90].map((d) => <button key={d} type="button" role="radio" aria-checked={days === d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d} days</button>)}
        </span>
      </h3>
      <svg className="st-trend" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Used space over time">
        <polyline points={`0,${h} ${line} ${w},${h}`} className="st-trend-fill" />
        <polyline points={line} className="st-trend-line" />
      </svg>
      <p className="muted st-trend-note">One reading a day while the app runs, kept on this Mac.</p>
    </section>
  )
}
