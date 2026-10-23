import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { ago, bytes, FULL_DISK_ACCESS_URL, KIND_NAMES, plural, type DiskPart, type FileKind, type MacInfo, type MapNode } from '@shared/storage'
import { reportSize } from '@shared/cleanup'
import { useStore } from '../../store'
import { Icon } from '../icons'
import { AreaChart, Donut, Ring } from './charts'
import { DiskBar, ItemIcon, KIND_COLORS, PART_COLORS, ScanProgressCard, Segmented, Squircle, TopBar, useIcons, useLoad, useScanTree, where } from './parts'
import { loadApps, measureReport, openInMap, openInUninstaller, refreshFda, setRoom, startScan, useStorage, type RoomId } from './state'

/**
 * Overview: the scan and Optimize as two rings, the disk split into its parts with what is free, what macOS needs and
 * what takes the most, four figures that each open a room, the largest folders and apps, what to clean up, the kinds of
 * file, the disk's use over time, the newest large files, and this Mac in words.
 */

const PART_NAMES: Record<DiskPart, string> = { apps: 'Applications', documents: 'Documents', downloads: 'Downloads', pictures: 'Pictures', library: 'App Data', other: 'Other', trash: 'Trash', system: 'System' }
const BAR_COLORS = ['#3b82f6', '#8b5cf6', '#f59e0b', '#22c55e', '#ef4444']
const SCAN_RING = ['#38bdf8', '#a855f7', '#ec4899', '#f59e0b', '#22c55e']
const OPTIMIZE_RING = ['#fb7185', '#f97316', '#ef4444', '#f43f5e']

export default function Overview(): ReactElement {
  const disk = useStorage((s) => s.disk)
  const scan = useStorage((s) => s.scan)
  const fda = useStorage((s) => s.fda)
  const reports = useStorage((s) => s.reports)
  const apps = useStorage((s) => s.apps)
  const { live, version } = useScanTree()
  const summary = scan.summary

  // What the cards need, measured in the background while the Overview is open.
  useEffect(() => { measureReport('junk'); measureReport('leftovers'); void loadApps() }, [])
  const top = useLoad(() => (live ? window.api.invoke('storage:topFolders') : Promise.resolve([] as MapNode[])), [live, version])
  const large = useLoad(() => (live ? window.api.invoke('storage:large', 100e6, false) : Promise.resolve([] as MapNode[])), [live, version])
  const recent = useLoad(() => (live ? window.api.invoke('storage:report').then((r) => r.recent) : Promise.resolve([] as MapNode[])), [live, version])
  const appsMap = useLoad(() => (live ? window.api.invoke('storage:appsMap') : Promise.resolve(null)), [live, version])
  const mac = useLoad<MacInfo>(() => window.api.invoke('storage:macInfo'), [])

  const junk = reports.junk
  const junkSafe = junk ? reportSize(junk, true) : null
  const junkAll = junk ? reportSize(junk) : null
  const oldDownloads = junk?.groups.find((g) => g.id === 'old')
  const leftovers = reports.leftovers ? reportSize(reports.leftovers) : null
  const unused = useMemo(() => (apps ? apps.filter((a) => !a.path.startsWith('/System/') && (!a.lastUsed || Date.now() - a.lastUsed > 90 * 86_400_000)) : null), [apps])
  const largeBytes = large.data?.reduce((s, f) => s + f.size, 0) ?? 0

  const free = disk?.free ?? 0
  const total = disk?.total ?? 0
  const used = total - free
  const parts = summary?.parts ?? []
  const system = parts.find((p) => p.id === 'system')?.bytes
  const biggest = [...parts].filter((p) => p.id !== 'system').sort((a, b) => b.bytes - a.bytes)[0]
  const level = total && free / total < 0.05 ? 'crit' : total && free / total < 0.1 ? 'warn' : 'ok'
  const placeName = summary ? (summary.kind === 'mac' ? disk?.name ?? 'Macintosh HD' : summary.kind === 'home' ? 'Your home folder' : summary.root.split('/').pop()) : ''

  return (
    <div className="st-room">
      <TopBar title="Overview" />
      <div className="st-scroll">
        <div className="st-rings">
          <div className="st-ring-col">
            {scan.status === 'scanning' ? (
              <Ring colors={SCAN_RING} onClick={() => setRoom('map')}>
                <span className="st-ring-big">{bytes(scan.progress?.bytes ?? 0)}</span>
                <span className="st-ring-sub">Scanning…</span>
              </Ring>
            ) : (
              <Ring colors={SCAN_RING} onClick={() => void startScan(summary?.kind ?? 'mac', summary?.kind === 'path' ? summary.root : undefined)} title={summary ? 'Scan again' : 'Scan the whole Mac'}>
                <span className="st-ring-big">{summary ? bytes(summary.bytes) : 'Scan'}</span>
                <span className="st-ring-link">{summary ? 'Scan Again' : 'Map the disk'}</span>
              </Ring>
            )}
            <h2>{scan.status === 'scanning' ? 'Mapping the disk…' : summary ? `${placeName} is mapped` : 'Find out where the space went'}</h2>
            <p>{scan.status === 'scanning' ? `${plural(scan.progress?.files ?? 0, 'file')} so far.` : summary ? `Here is where the space went${scan.live ? '' : ' at the last scan'}. Each card opens what acts on it.` : 'One scan maps everything on the disk. Nothing is removed until you say so.'}</p>
          </div>
          <div className="st-ring-col">
            <Ring colors={OPTIMIZE_RING} onClick={() => setRoom('optimize')} title="See what Optimize would clear">
              <Icon.wand />
              <span className="st-ring-big sm">Optimize</span>
              <span className="st-ring-sub warm">{junkSafe === null ? 'Checking…' : junkSafe ? `${bytes(junkSafe)} to free` : 'All clear'}</span>
            </Ring>
            <h2>{junkSafe === null ? 'Looking at caches and open apps' : junkSafe ? 'This Mac can be lighter' : 'Nothing worth clearing'}</h2>
            <p>{junkSafe ? `${bytes(junkSafe)} of junk. One press clears it, after showing what it will do.` : 'Junk nobody will miss, and apps nobody is using, cleared in one press.'}</p>
          </div>
        </div>

        {level !== 'ok' && disk && (
          <div className={`st-banner ${level}`}>
            <Icon.alert />
            <div><b>{disk.name} is almost out of space: {bytes(free)} left.</b><p>When it runs out, apps stop working and the Mac can freeze. Clear at least {bytes(Math.max(0, total * 0.1 - free))}, and empty the Trash in Finder: what is in it still takes space.</p></div>
            <button type="button" className="st-button" onClick={() => setRoom('large')}>Find what can go</button>
          </div>
        )}
        {fda === false && (
          <div className="st-banner info">
            <Icon.shield />
            <div><b>Let the app read your whole disk</b><p>macOS hides Mail, Messages, Safari and other apps' data from any app without Full Disk Access. Scans still run, but those folders stay closed and the totals come up short. Switch EC2 Remote Access on in Privacy &amp; Security, then quit and open it again.</p></div>
            <div className="st-banner-actions">
              <button type="button" className="st-primary" onClick={() => void window.api.invoke('shell:open', FULL_DISK_ACCESS_URL)}>Open Settings</button>
              <button type="button" className="st-button" onClick={() => void refreshFda()}>Check again</button>
            </div>
          </div>
        )}

        <section className="st-panel st-diskcard">
          <div className="st-diskcard-head">
            <span className="st-hd"><Icon.disk /></span>
            <div className="flex-1"><h3>{disk?.name ?? 'Macintosh HD'}</h3><p className="muted">{disk ? `${bytes(used)} of ${bytes(total)} used · ${Math.round((used / total) * 100)}% full` : 'Reading the disk…'}</p></div>
            <div className="st-avail"><b>{bytes(free)}</b><span>available</span></div>
            <button type="button" className="st-button" onClick={() => setRoom('map')}>View Details <Icon.chevron /></button>
          </div>
          <DiskBar />
          <div className="st-facts">
            <div><h5><i style={{ background: '#64748b' }} />Available</h5><b>{bytes(free)}</b><p>{total ? `${Math.round((free / total) * 100)}% of the disk` : ''}{disk && disk.free > disk.freeNow ? `, counting ${bytes(disk.free - disk.freeNow)} macOS clears by itself when it needs the room.` : '.'}</p></div>
            <div><h5><i style={{ background: PART_COLORS.system }} />Needed by macOS</h5><b>{system !== undefined ? bytes(system) : '—'}</b><p>macOS itself, its swap and its own files{summary?.unreadable ? `, with what is in the ${summary.unreadable.toLocaleString('en-US')} folders the scan could not read` : ''}.</p></div>
            <div><h5><i style={{ background: biggest ? PART_COLORS[biggest.id] : '#8b5cf6' }} />Taking the most</h5><b>{biggest ? bytes(biggest.bytes) : '—'}</b>
              <p>{biggest ? `${PART_NAMES[biggest.id]}, ${Math.round((biggest.bytes / Math.max(1, used)) * 100)}% of the space in use.` : 'Scan the Mac to see what.'}</p>
              {top.data?.[0] && <button type="button" className="st-link" onClick={() => openInMap(top.data![0].path)}>Largest folder: {top.data[0].name}, {bytes(top.data[0].size)} <Icon.chevron /></button>}
            </div>
          </div>
          {scan.status === 'scanning' && <ScanProgressCard />}
        </section>

        <div className="st-tiles">
          <StatTile look="items" big={summary ? (summary.files + summary.dirs).toLocaleString('en-US') : '—'} title="Total Items" sub={summary ? `${summary.files.toLocaleString('en-US')} files · ${summary.dirs.toLocaleString('en-US')} folders` : 'Scan the Mac'} onClick={() => setRoom('report')} />
          <StatTile look="large" big={live ? bytes(largeBytes) : '—'} title="Large Files" sub={live ? `${plural(large.data?.length ?? 0, 'file')} of 100 MB or more` : 'Scan the Mac'} onClick={() => setRoom('large')} />
          <StatTile look="junk" big={junkSafe !== null ? bytes(junkSafe) : '…'} title="Junk Files" sub={junkAll !== null && junkSafe !== null ? `Safe to clean, ${bytes(junkAll - junkSafe)} to review` : 'Measuring…'} onClick={() => setRoom('junk')} />
          <StatTile look="unused" big={unused ? String(unused.length) : '…'} title="Unused Apps" sub={unused ? `${bytes(unused.reduce((s, a) => s + a.size, 0))} can be freed` : 'Measuring…'} onClick={() => setRoom('unused')} />
        </div>

        <div className="st-cols3">
          <ListCard title="Largest Folders" icon={<Icon.folder />} onAll={() => setRoom('map')}>
            {!live && <p className="muted st-card-empty">Scan the Mac to see them.</p>}
            {top.data?.map((f, i) => (
              <button key={f.path} type="button" className="st-lrow" onClick={() => openInMap(f.path)} title={f.path}>
                <span className="st-lrow-icon"><Icon.folder /></span>
                <span className="st-lrow-main"><span className="st-lrow-name">{f.name}</span><span className="st-bar"><span style={{ width: `${(f.size / (top.data![0].size || 1)) * 100}%`, background: BAR_COLORS[i % BAR_COLORS.length] }} /></span></span>
                <b>{bytes(f.size)}</b><Icon.chevron />
              </button>
            ))}
          </ListCard>
          <ListCard title="Top Apps by Size" icon={<Icon.apps />} onAll={() => setRoom('uninstaller')}>
            {!live && <p className="muted st-card-empty">Scan the Mac to see them.</p>}
            <AppRows apps={appsMap.data?.apps.slice(0, 5) ?? []} />
          </ListCard>
          <ListCard title="Cleanup Recommendations" icon={<Icon.sparkles />}>
            <Rec look="junk" title="Junk Files" sub="Caches, logs and build data" size={junkSafe} button="Clean" primary room="junk" />
            <Rec look="downloads-old" title="Old Downloads" sub="Not opened for three months" size={junk ? (oldDownloads?.items.reduce((s, i) => s + i.size, 0) ?? 0) : null} button="Review" room="junk" />
            <Rec look="unused" title="Unused Apps" sub="Not opened in 3 months" size={unused ? unused.reduce((s, a) => s + a.size, 0) : null} button="Review" room="unused" />
            <Rec look="duplicates" title="Duplicate Files" sub="Identical copies, by content" size={undefined} button="Find" room="duplicates" />
            <Rec look="large" title="Large Files" sub="Files of 100 MB or more" size={live ? largeBytes : undefined} button="Review" room="large" />
            <Rec look="leftover" title="Leftovers" sub="From apps no longer here" size={leftovers} button="Review" room="leftovers" />
          </ListCard>
        </div>

        <div className="st-cols3">
          <KindsCard />
          <TrendCard />
          <ListCard title="Recent Large Files" icon={<Icon.history />} onAll={() => setRoom('large')}>
            {!live && <p className="muted st-card-empty">Scan the Mac to see them.</p>}
            <RecentRows files={recent.data ?? []} />
          </ListCard>
        </div>

        {mac.data && (
          <section className="st-panel st-macinfo">
            <span className="st-hd"><Icon.monitor /></span>
            <dl>
              <div><dt>macOS</dt><dd>{mac.data.os}</dd></div>
              <div><dt>Model</dt><dd>{mac.data.model}</dd></div>
              <div><dt>Processor</dt><dd>{mac.data.chip}</dd></div>
              <div><dt>Memory</dt><dd>{Math.round(mac.data.memory / 1024 ** 3)} GB</dd></div>
              <div><dt>Startup Disk</dt><dd>{mac.data.disk}</dd></div>
              <div><dt>Last Scan</dt><dd>{summary ? new Date(summary.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not yet'}</dd></div>
            </dl>
            <button type="button" className="st-button" onClick={() => {
              const m = mac.data!
              void window.api.invoke('clipboard:write', `macOS: ${m.os}\nModel: ${m.model}\nProcessor: ${m.chip}\nMemory: ${Math.round(m.memory / 1024 ** 3)} GB\nStartup disk: ${m.disk}${disk ? ` (${bytes(free)} free of ${bytes(total)})` : ''}`).then(() => useStore.getState().toast('success', 'Copied'))
            }}>Copy</button>
          </section>
        )}
      </div>
    </div>
  )
}

function StatTile({ look, big, title, sub, onClick }: { look: string; big: string; title: string; sub: string; onClick: () => void }): ReactElement {
  return (
    <button type="button" className="st-stat" onClick={onClick}>
      <Squircle look={look} size={46} />
      <span className="st-stat-text"><b>{big}</b><span>{title}</span><small>{sub}</small></span>
      <Icon.chevron />
    </button>
  )
}

function ListCard({ title, icon, onAll, children }: { title: string; icon: ReactElement; onAll?: () => void; children: ReactNode }): ReactElement {
  return (
    <section className="st-panel st-listcard">
      <header><span className="st-listcard-icon">{icon}</span><h3>{title}</h3><span className="flex-1" />{onAll && <button type="button" className="st-button sm" onClick={onAll}>View All</button>}</header>
      <div className="st-listcard-body">{children}</div>
    </section>
  )
}

function AppRows({ apps }: { apps: { path: string; name: string; size: number }[] }): ReactElement {
  const icons = useIcons(apps.map((a) => a.path))
  return (
    <>
      {apps.map((a) => (
        <button key={a.path} type="button" className="st-lrow" onClick={() => openInUninstaller([a.path])} title={a.path}>
          <ItemIcon path={a.path} icons={icons} size={24} />
          <span className="st-lrow-main"><span className="st-lrow-name">{a.name.replace(/\.app$/, '')}</span></span>
          <b>{bytes(a.size)}</b><Icon.chevron />
        </button>
      ))}
    </>
  )
}

function RecentRows({ files }: { files: MapNode[] }): ReactElement {
  const icons = useIcons(files.map((f) => f.path))
  return (
    <>
      {files.slice(0, 5).map((f) => (
        <button key={f.path} type="button" className="st-lrow tall" onClick={() => void window.api.invoke('local:quickLook', f.path)} title={f.path}>
          <ItemIcon path={f.path} icons={icons} size={24} />
          <span className="st-lrow-main"><span className="st-lrow-name">{f.name}</span><span className="st-lrow-sub">{where(f.path)}</span></span>
          <span className="st-lrow-end"><b>{bytes(f.size)}</b><small>{f.mtime ? ago(f.mtime) : ''}</small></span>
        </button>
      ))}
    </>
  )
}

function Rec({ look, title, sub, size, button, room, primary }: { look: string; title: string; sub: string; size: number | null | undefined; button: string; room: RoomId; primary?: boolean }): ReactElement {
  return (
    <div className="st-rec">
      <Squircle look={look} size={30} />
      <span className="st-lrow-main"><span className="st-lrow-name">{title}</span><span className="st-lrow-sub">{sub}</span></span>
      <b className="st-rec-size">{size == null ? '…' : bytes(size, '0 bytes')}</b>
      <button type="button" className={primary ? 'st-primary sm' : 'st-button sm'} onClick={() => setRoom(room)}>{button}</button>
    </div>
  )
}

/** Every byte of the scan by kind, with the small files counted together. */
function KindsCard(): ReactElement {
  const summary = useStorage((s) => s.scan.summary)
  const kinds = useMemo(() => {
    if (!summary) return []
    const list: { id: FileKind | 'small'; label: string; value: number }[] = (Object.entries(summary.byKind) as [FileKind, number][]).filter(([, v]) => v > 0).map(([k, v]) => ({ id: k, label: KIND_NAMES[k], value: v }))
    if (summary.smallBytes) list.push({ id: 'small', label: 'Smaller Files', value: summary.smallBytes })
    list.sort((a, b) => b.value - a.value)
    // Six named, the rest together.
    const head = list.slice(0, 6)
    const rest = list.slice(6).reduce((s, x) => s + x.value, 0)
    return rest ? [...head, { id: 'small' as const, label: 'The Rest', value: rest }] : head
  }, [summary])
  const total = kinds.reduce((s, k) => s + k.value, 0)
  const color = (k: { id: FileKind | 'small'; label: string }): string => (k.label === 'The Rest' ? '#475569' : KIND_COLORS[k.id])
  return (
    <section className="st-panel st-listcard">
      <header><span className="st-listcard-icon"><Icon.storage /></span><h3>File Type Distribution</h3></header>
      {!kinds.length ? <p className="muted st-card-empty">Scan the Mac to see what fills it.</p> : (
        <div className="st-kinds">
          <Donut parts={kinds.map((k) => ({ value: k.value, color: color(k) }))}><b>{bytes(total)}</b><span>Total</span></Donut>
          <div className="st-kinds-legend">
            {kinds.map((k) => (
              <div key={k.label}><span className="st-dot" style={{ background: color(k) }} /><span className="flex-1">{k.label}</span><b>{bytes(k.value)}</b><small>{Math.round((k.value / (total || 1)) * 100)}%</small></div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

/** The disk's use over 7, 30 or 90 days, one reading a day. */
function TrendCard(): ReactElement {
  const disk = useStorage((s) => s.disk)
  const [days, setDays] = useState<'7' | '30' | '90'>('30')
  const pts = (disk?.history ?? []).slice(-Number(days))
  const change = pts.length > 1 ? pts[pts.length - 1].used - pts[0].used : 0
  return (
    <section className="st-panel st-listcard">
      <header><span className="st-listcard-icon"><Icon.activity /></span><h3>Storage Trend</h3><span className="flex-1" />
        <Segmented small value={days} onChange={setDays} options={[{ id: '7', label: '7D' }, { id: '30', label: '30D' }, { id: '90', label: '90D' }]} />
      </header>
      <p className="muted st-trend-sub">{disk?.name ?? 'Macintosh HD'}, the startup disk</p>
      {pts.length > 1 ? (
        <>
          <AreaChart series={[{ label: 'Used', color: '#3b82f6', values: pts.map((p) => p.used) }]} times={pts.map((p) => new Date(`${p.day}T12:00`).getTime())} format={(v) => bytes(v)} height={120} label={(t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })} />
          <p className="st-trend-note">{change === 0 ? 'No change' : `${change > 0 ? 'Up' : 'Down'} ${bytes(Math.abs(change))}`} over {pts.length} days.</p>
        </>
      ) : (
        <div className="st-trend-empty">
          <b>{disk ? `${bytes(disk.total - disk.free)} used today` : '—'}</b>
          <p className="muted">The app notes the disk's use once a day while it runs, and keeps it on this Mac. The trend draws itself from the second day.</p>
        </div>
      )}
    </section>
  )
}
