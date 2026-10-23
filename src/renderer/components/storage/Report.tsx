import { useState, type ReactElement } from 'react'
import { bytes, type MapNode, type ScanChanges } from '@shared/storage'
import { useStore } from '../../store'
import { Icon } from '../icons'
import { downloadText } from '../plan/parts'
import { Badge, ItemIcon, NeedsScan, Segmented, Squircle, tilde, TopBar, useIcons, useLoad, useScanTree } from './parts'
import { openInMap, useStorage } from './state'

/**
 * Report: the last scan in figures, its largest folders and files, exported as a spreadsheet (CSV), a page that opens
 * in any browser and loads nothing (HTML), or a few lines to paste; and what grew, shrank, appeared or went between two
 * scans of the same place (main keeps a snapshot of every folder of 50 MB or more from each scan).
 */

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const csvCell = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

export default function Report(): ReactElement {
  const { live, version } = useScanTree()
  const summary = useStorage((s) => s.scan.summary)
  const disk = useStorage((s) => s.disk)
  const [tab, setTab] = useState<'changes' | 'summary'>('summary')
  const lists = useLoad(() => (live ? window.api.invoke('storage:report') : Promise.resolve(null)), [live, version])
  const [base, setBase] = useState<number | undefined>(undefined)
  const changes = useLoad<ScanChanges>(() => window.api.invoke('storage:changes', base), [summary?.at, base])
  const icons = useIcons([...(lists.data?.folders.slice(0, 8) ?? []), ...(lists.data?.files.slice(0, 8) ?? [])].map((n) => n.path))
  const place = summary ? (summary.root === '/' ? disk?.name ?? 'Macintosh HD' : tilde(summary.root)) : ''
  const when = summary ? new Date(summary.at).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
  const share = (n: number): string => `${((n / (summary?.bytes || 1)) * 100).toFixed(1)}%`

  const exportCsv = (): void => {
    const d = lists.data
    if (!d || !summary) return
    const rows = [['Kind', 'Path', 'Bytes', 'Size', 'Share'], ...d.folders.map((f) => ['Folder', f.path, String(f.size), bytes(f.size), share(f.size)]), ...d.files.map((f) => ['File', f.path, String(f.size), bytes(f.size), share(f.size)])]
    downloadText(`Disk report ${place.replace(/[/:]/g, '-')} ${new Date(summary.at).toISOString().slice(0, 10)}.csv`, rows.map((r) => r.map(csvCell).join(',')).join('\n'), 'text/csv')
  }
  const exportHtml = (): void => {
    const d = lists.data
    if (!d || !summary) return
    const table = (title: string, list: MapNode[]): string => `<section><h2>${esc(title)}</h2><table><thead><tr><th>Path</th><th class="num">Size</th><th class="num">Share</th></tr></thead><tbody>${list.slice(0, 100).map((n) => `<tr><td class="path">${esc(n.path)}</td><td class="num">${bytes(n.size)}</td><td class="num"><span class="track"><span class="fill" style="width:${Math.min(100, (n.size / summary.bytes) * 100).toFixed(1)}%"></span></span>${share(n.size)}</td></tr>`).join('')}</tbody></table></section>`
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="color-scheme" content="light dark"><title>Disk report: ${esc(place)}</title>
<style>:root{--bg:#fff;--card:#f6f7f9;--rule:#e3e5ea;--muted:#667;--fill:#3b82f6}@media(prefers-color-scheme:dark){:root{--bg:#14161b;--card:#1d2027;--rule:#2b2f38;--muted:#99a}}body{margin:0;padding:32px;background:var(--bg);color:inherit;font:14px/1.5 -apple-system,system-ui,sans-serif}h1{margin:0 0 4px}p.when{color:var(--muted);margin:0 0 20px}.summary{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:24px}.summary div{background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:14px 16px}.summary dt{color:var(--muted);font-size:13px}.summary dd{margin:2px 0 0;font-size:22px;font-weight:650}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--rule);border-radius:12px;overflow:hidden}th,td{padding:8px 12px;text-align:left;border-top:1px solid var(--rule)}.num{text-align:right;white-space:nowrap}.path{word-break:break-all}.track{display:inline-block;width:80px;height:6px;margin-right:8px;border-radius:3px;background:var(--rule);vertical-align:middle}.fill{display:block;height:100%;border-radius:3px;background:var(--fill)}section{margin-bottom:24px}</style></head>
<body><h1>Disk report: ${esc(place)}</h1><p class="when">Scanned ${esc(when)}</p><dl class="summary"><div><dt>Total size</dt><dd>${bytes(summary.bytes)}</dd></div><div><dt>Folders</dt><dd>${summary.dirs.toLocaleString('en-US')}</dd></div><div><dt>Files</dt><dd>${summary.files.toLocaleString('en-US')}</dd></div>${disk ? `<div><dt>Free on the disk</dt><dd>${bytes(disk.free)}</dd></div>` : ''}</dl>
${table('Largest folders', d.folders)}${table('Largest files', d.files)}<p class="when">Sizes are the space allocated on disk, in decimal units, as Finder reports them. Files under 1 MB are counted in their folder's total, not listed one by one.</p></body></html>`
    downloadText(`Disk report ${place.replace(/[/:]/g, '-')} ${new Date(summary.at).toISOString().slice(0, 10)}.html`, html, 'text/html')
  }
  const copySummary = (): void => {
    const d = lists.data
    if (!d || !summary) return
    const lines = [`${place}: ${bytes(summary.bytes)} in ${summary.files.toLocaleString('en-US')} files and ${summary.dirs.toLocaleString('en-US')} folders, scanned ${when}.`, disk ? `${bytes(disk.free)} free of ${bytes(disk.total)}.` : '', 'Largest:', ...[...d.folders.slice(1, 4), ...d.files.slice(0, 2)].sort((a, b) => b.size - a.size).slice(0, 5).map((n) => `  ${tilde(n.path)}  ${bytes(n.size)}`)].filter(Boolean)
    void window.api.invoke('clipboard:write', lines.join('\n')).then(() => useStore.getState().toast('success', 'Copied a summary to the clipboard'))
  }

  return (
    <div className="st-room">
      <TopBar title="Report" />
      <div className="st-tabsbar"><Segmented value={tab} onChange={setTab} options={[{ id: 'changes', label: 'Changes Over Time' }, { id: 'summary', label: 'Summary & Export' }]} /></div>
      <div className="st-scroll">
        {tab === 'summary' && (!live ? <NeedsScan what="its summary" /> : (
          <>
            <p className="st-report-when">{place}, {summary ? bytes(summary.bytes) : ''}, scanned {when}.</p>
            <div className="st-tiles">
              <Tile look="system" big={summary ? bytes(summary.bytes) : '—'} title="Scanned" sub={when} />
              <Tile look="caches" big={summary ? summary.dirs.toLocaleString('en-US') : '—'} title="Folders" sub={`Everything beneath ${place}`} />
              <Tile look="duplicates" big={summary ? summary.files.toLocaleString('en-US') : '—'} title="Files" sub="Small ones counted with their folder" />
              <Tile look="unused" big={lists.data?.folders[0] ? bytes(lists.data.folders[0].size) : '—'} title="Largest Folder" sub={lists.data?.folders[0]?.name ?? ''} />
            </div>
            <div className="st-cols3">
              <ExportCard look="downloads" title="Spreadsheet" text="The largest folders and files, one per row, with their sizes and their share of this scan. Opens in Numbers or Excel." button="Export CSV…" onClick={exportCsv} />
              <ExportCard look="caches" title="Web Page" text="One page with the totals and the largest folders and files. Opens in any browser, and loads nothing from the internet." button="Export HTML…" onClick={exportHtml} />
              <ExportCard look="junk" title="Summary" text="A few lines of text: the place, its size, and its five largest folders and files, ready to paste into a message or a support request." button="Copy Summary" onClick={copySummary} />
            </div>
            <div className="st-cols2">
              <TopList title="Largest Folders" icon={<Icon.folder />} list={lists.data?.folders.slice(0, 8) ?? []} icons={icons} share={share} color="#3b82f6" onOpen={(n) => openInMap(n.path)} />
              <TopList title="Largest Files" icon={<Icon.note />} list={lists.data?.files.slice(0, 8) ?? []} icons={icons} share={share} color="#8b5cf6" onOpen={(n) => void window.api.invoke('local:quickLook', n.path)} />
            </div>
          </>
        ))}
        {tab === 'changes' && (
          <>
            <section className="st-panel st-changes-head">
              <div><h3>Scans of {place || 'this place'}</h3><p className="muted">Every scan keeps a snapshot of its folders of 50 MB or more, so the next scan of the same place can be compared with it.</p></div>
              {changes.data && changes.data.scans.length > 1 && (
                <select className="st-select" value={base ?? changes.data.base ?? ''} aria-label="Compare with" onChange={(e) => setBase(Number(e.target.value) || undefined)}>
                  {changes.data.scans.slice(0, -1).reverse().map((s) => <option key={s.at} value={s.at}>Since {new Date(s.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ({bytes(s.bytes)})</option>)}
                </select>
              )}
            </section>
            {changes.data && changes.data.scans.length < 2 && <div className="st-empty"><span className="st-empty-art"><Icon.history /></span><h3>Nothing to compare with yet</h3><p>One scan so far. Scan the same place again another day, and this shows what grew, shrank, appeared or disappeared in between.</p></div>}
            {changes.data && changes.data.scans.length > 1 && !changes.data.changes.length && <div className="st-empty"><h3>Nothing grew or shrank by 50 MB or more since that scan</h3></div>}
            {changes.data && changes.data.changes.length > 0 && (
              <section className="st-panel st-listcard">
                {changes.data.changes.map((c) => (
                  <button key={c.path} type="button" className="st-lrow tall" onClick={() => openInMap(c.kind === 'gone' ? c.path.replace(/\/[^/]+$/, '') || '/' : c.path)} title={c.path}>
                    <span className="st-lrow-icon"><Icon.folder /></span>
                    <span className="st-lrow-main"><span className="st-lrow-name">{c.path.split('/').pop() || c.path}</span><span className="st-lrow-sub">{tilde(c.path)}</span></span>
                    <Badge tone={c.kind === 'grew' || c.kind === 'new' ? 'warn' : 'ok'}>{c.kind === 'grew' ? 'Grew' : c.kind === 'shrank' ? 'Shrank' : c.kind === 'new' ? 'New' : 'Gone'}</Badge>
                    <span className="st-lrow-end"><b className={c.delta > 0 ? 'up' : 'down'}>{c.delta > 0 ? '+' : '−'}{bytes(Math.abs(c.delta))}</b><small>{bytes(c.before, '—')} → {bytes(c.after, '—')}</small></span>
                  </button>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Tile({ look, big, title, sub }: { look: string; big: string; title: string; sub: string }): ReactElement {
  return <div className="st-stat static"><Squircle look={look} size={46} /><span className="st-stat-text"><b>{big}</b><span>{title}</span><small>{sub}</small></span></div>
}

function ExportCard({ look, title, text, button, onClick }: { look: string; title: string; text: string; button: string; onClick: () => void }): ReactElement {
  return (
    <section className="st-panel st-export">
      <Squircle look={look} size={46} />
      <h3>{title}</h3>
      <p>{text}</p>
      <button type="button" className="st-primary sm" onClick={onClick}>{button}</button>
    </section>
  )
}

function TopList({ title, icon, list, icons, share, color, onOpen }: { title: string; icon: ReactElement; list: MapNode[]; icons: Map<string, string>; share: (n: number) => string; color: string; onOpen: (n: MapNode) => void }): ReactElement {
  const max = list[0]?.size || 1
  return (
    <section className="st-panel st-listcard">
      <header><span className="st-listcard-icon">{icon}</span><h3>{title}</h3><span className="flex-1" /><span className="muted">Largest {list.length}</span></header>
      <div className="st-listcard-body">
        {list.map((n) => (
          <button key={n.path} type="button" className="st-lrow" onClick={() => onOpen(n)} title={n.path}>
            <ItemIcon path={n.path} icons={icons} dir={n.dir && !n.package} size={22} />
            <span className="st-lrow-main"><span className="st-lrow-name">{n.name}</span><span className="st-bar"><span style={{ width: `${(n.size / max) * 100}%`, background: color }} /></span></span>
            <b>{bytes(n.size)}</b><small className="st-share">{share(n.size)}</small>
          </button>
        ))}
      </div>
    </section>
  )
}
