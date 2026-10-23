import { useState, type ReactElement } from 'react'
import type { PackageReceipt } from '@shared/cleanup'
import { ago, bytes, plural } from '@shared/storage'
import { Icon } from '../icons'
import CleanRoom from './CleanRoom'
import { tilde } from './parts'

/** The Cleanup rooms that measure places they know (CleanRoom does the list); Duplicates has its own file. */

export function JunkFiles(): ReactElement {
  return (
    <CleanRoom room="junk" from="Junk Files" icon={<Icon.sparkles />} title="Junk Files" sub="Caches, logs, build data and installers."
      measuring="Measuring caches, logs and build data…" load={() => window.api.invoke('storage:junk')}
      intro="Caches, logs, build data and installers that can go without losing anything anyone made, and what is yours to judge: old downloads, Xcode's archives, virtual machines and games. Only what is safe starts ticked; caches of open apps wait until the app is closed." />
  )
}

export function AiModels(): ReactElement {
  return (
    <CleanRoom room="ai" from="AI Models" icon={<Icon.brain />} title="AI Models" sub="Models and caches AI apps downloaded."
      measuring="Looking where AI apps keep models…" load={() => window.api.invoke('storage:ai')}
      intro="The AI models on this Mac, often tens of gigabytes: what Ollama, LM Studio, Hugging Face and other AI apps downloaded, and Apple Intelligence's and Siri's. Each says how its models come back. Only unfinished downloads and caches start ticked." />
  )
}

export function SystemData(): ReactElement {
  return (
    <CleanRoom room="system" from="System Data" icon={<Icon.disk />} title="System Data" sub="What Storage settings counts as System Data, and beside it."
      measuring="Measuring backups, attachments and the Trash…" load={() => window.api.invoke('storage:systemData')}
      intro="What System Data holds that can go, and what Storage settings counts beside it: iPhone and iPad backups, attachments Mail and Messages keep, simulators, sound libraries, Time Machine's local snapshots and the Trash, each with where it is managed." />
  )
}

export function Installers(): ReactElement {
  return (
    <CleanRoom room="installers" from="Installers" icon={<Icon.archive />} title="Installers" sub="Installers for apps already installed."
      measuring="Looking inside the installers in Downloads and on the Desktop…" load={() => window.api.invoke('storage:installers')}
      intro="Disk images, packages and zips in Downloads and on the Desktop whose app is already installed, at their version or newer. The app looks inside each without installing anything. An installer for something not installed, or newer, is someone's next install, and is left alone."
      after={<Receipts />} />
  )
}

/** What each installer package put on this Mac, from macOS's receipts, and how much of it is still there. */
function Receipts(): ReactElement {
  const [list, setList] = useState<PackageReceipt[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [all, setAll] = useState(false)
  const load = (): void => { setBusy(true); void window.api.invoke('storage:receipts').then(setList, () => setList([])).finally(() => setBusy(false)) }
  const shown = list ? (all ? list : list.slice(0, 12)) : []
  return (
    <section className="st-group st-receipts">
      <header className="st-group-head">
        <div className="st-group-text">
          <h3>What packages installed {list && <span className="muted">{plural(list.length, 'package')}</span>}</h3>
          <p>Each package's receipt lists what it put on this Mac. Packages usually install into folders only an administrator can change; remove those apps with their own uninstaller, or in Finder.</p>
        </div>
        {!list && <button type="button" className="btn btn-sm" disabled={busy} onClick={load}>{busy ? 'Reading…' : 'Read the receipts'}</button>}
      </header>
      {shown.map((r) => (
        <div key={r.id} className="st-row">
          <span className="st-icon st-icon-glyph"><Icon.box /></span>
          <div className="st-row-body">
            <div className="st-row-title">{r.app ?? r.id} <span className="muted">{r.version}</span></div>
            <div className="st-row-sub">{r.app ? `${r.id} · ` : ''}into {tilde(r.location)}{r.installedAt ? ` · ${ago(r.installedAt)}` : ''}</div>
            <div className="st-row-note">
              {r.remaining === 0 && !r.unreadable ? 'Every file it installed has since been removed; only its receipt remains.' : `${r.remaining.toLocaleString('en-US')} of ${plural(r.files, 'file')} still there`}
              {r.unreadable > 0 && `, ${r.unreadable.toLocaleString('en-US')} in folders the app cannot look into`}
            </div>
          </div>
          <span className="st-size">{bytes(r.bytes)}</span>
          <button type="button" className="st-more" aria-label="Show in Finder" title="Show where it installed" onClick={() => void window.api.invoke('local:reveal', r.location)}><Icon.finder /></button>
        </div>
      ))}
      {list && list.length > 12 && <button type="button" className="st-showmore" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${list.length}`}</button>}
    </section>
  )
}
