import { useMemo, type ReactElement, type ReactNode } from 'react'
import { LIMITS, checkCells, formatMs, formatPct, levelOf, type CheckCell, type Level, type PlmEnvHealth } from '@shared/plmHealth'
import { Icon } from '../icons'
import { Bar, Dot, MARKS, Pill, SectionHead } from './parts'
import Comb, { type CombItem } from './Comb'

/**
 * The health checks as Grafana runs them, as two honeycombs: each service's URL through the load balancer (the
 * "<Environment> ALB Healthcheck" job) and on each server (the "Service HTTP Healthcheck" jobs and Apache's), one
 * hexagon per check: green healthy, amber slow, red unhealthy, grey on a server stopped in EC2, dashed when the probe
 * itself is not running. Pointing at one says what it checks and, for a server check, which machine it is and how that
 * machine is doing; a click goes to the machine's row under Servers (or the service). On a touch screen the first tap
 * shows the details and a second one goes. Cells keep the services' order, never status, so a check keeps its place
 * when it changes colour.
 */

const WORDS: Record<Level, string> = { ok: 'Healthy', warn: 'Slow', crit: 'Unhealthy', off: 'Stopped', unknown: 'Not running' }
/** What fits under the letters: "01", "Pri", "01 int", "AiO"; nothing for a service's only server. */
function shortLabel(label: string): string {
  const one = (l: string): string => (l === 'Primary' ? 'Pri' : l === 'Secondary' ? 'Sec' : l === 'All-in-one server' ? 'AiO' : l === 'server' ? '' : /^0\d$/.test(l) ? l : l.replace(/^3D/, '').slice(0, 4))
  const internal = /^(.*?)\s*internal$/i.exec(label)
  return internal ? `${one(internal[1])} int`.trim() : one(label)
}
const markOf = (c: CheckCell): string => {
  const known = MARKS[c.serviceId]?.[0]
  if (known) return known
  const letters = c.service.replace(/^3D/, '').replace(/[^A-Za-z]/g, '')
  return letters.slice(0, 1).toUpperCase() + letters.slice(1, 2).toLowerCase()
}
const shortUrl = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\.us-west-\d\.compute\.internal/, '')
const statusWord = (c: CheckCell): string =>
  c.level === 'off' ? 'Server stopped' : c.level === 'unknown' ? (c.broken ?? 'Probe not running') : c.status ? `HTTP ${c.status}` : 'No answer'

type CheckItem = CheckCell & CombItem

const toItem = (c: CheckCell): CheckItem => {
  const where = c.via === 'lb' ? 'through the load balancer' : `on ${c.machine?.name ?? shortUrl(c.url).split(/[:/]/)[0]}`
  return { ...c, id: c.url, mark: markOf(c), label: shortLabel(c.label), ip: c.machine?.ip, aria: `${c.service}${c.label ? ` ${c.label}` : ''} ${where}: ${WORDS[c.level]}, ${statusWord(c)}` }
}

export default function Honeycombs({ env, onPick }: { env: PlmEnvHealth; onPick: (c: CheckCell) => void }): ReactElement | null {
  const alb = useMemo(() => checkCells(env, 'lb').map(toItem), [env])
  const http = useMemo(() => checkCells(env, 'server').map(toItem), [env])
  if (!alb.length && !http.length) return null
  const foot = (c: CheckItem): string => `to see ${c.machine?.listed ? 'its server under Servers' : 'its service'}`
  return (
    <>
      <SectionHead id="hl-checks" icon={<Icon.hexes />} title="Health checks" sub="As Grafana runs them: each URL through the load balancer, and on each server" />
      <div className="hl-combs">
        {alb.length > 0 && <Comb kind="alb" title="ALB checks" sub="Through the load balancer, as users reach them" items={alb} words={WORDS} tip={(c) => <CheckTip c={c} />} foot={foot} onPick={onPick} />}
        {http.length > 0 && <Comb kind="http" title="HTTP checks" sub="On each server" items={http} words={WORDS} tip={(c) => <CheckTip c={c} />} foot={foot} onPick={onPick} />}
      </div>
    </>
  )
}

function CheckTip({ c }: { c: CheckCell }): ReactElement {
  const m = c.machine
  const stat = (name: string, value: ReactNode): ReactElement => <div className="hl-hex-tip-stat"><span>{name}</span><strong>{value}</strong></div>
  // Its checks are this tip's subject, and "not reporting" has its own line.
  const problems = m?.problems.filter((p) => !/check (fails|is slow)|^Not reporting/.test(p)) ?? []
  return (
    <>
      <div className="hl-hex-tip-head">
        <Dot level={c.level} />
        <strong className="min-w-0 flex-1">{c.service}{c.label && c.label !== 'server' ? ` ${c.label}` : ''}</strong>
        <Pill level={c.level}>{WORDS[c.level]}</Pill>
      </div>
      <div className="hl-hex-tip-sub">{c.via === 'lb' ? 'Through the load balancer' : m ? m.name : 'On its server'}<span className="hl-hex-tip-url">{shortUrl(c.url)}</span></div>
      <div className="hl-hex-tip-stats">
        {stat('Status', statusWord(c))}
        {stat('Response', formatMs(c.ms))}
        {c.via === 'lb' ? stat('Certificate', c.certDays === null ? '–' : `${c.certDays} days`) : stat('Address', m?.ip ?? '–')}
      </div>
      {c.note && <p className="hl-hex-tip-note">{c.note}</p>}
      {m && c.via === 'server' && (m.state === 'stopped'
        ? <p className="hl-hex-tip-note">Its server is stopped in EC2: set aside, not counted as a problem.</p>
        : (
          <div className="hl-hex-tip-machine">
            <span className="hl-mini-label">{m.title}{m.instanceType ? ` · ${m.instanceType}` : ''}</span>
            {m.reporting ? (
              <div className="hl-hex-tip-stats">
                {([['CPU', m.cpu, LIMITS.cpu], ['Memory', m.mem, LIMITS.mem], [m.disk ? `Disk ${m.disk.mount}` : 'Disk', m.disk?.pct ?? null, m.os === 'windows' ? LIMITS.diskWindows : LIMITS.disk]] as const).map(([name, v, limits]) => (
                  <div key={name} className="hl-hex-tip-stat">
                    <span className="truncate">{name}</span>
                    <strong>{formatPct(v)}</strong>
                    <Bar pct={v} level={levelOf(v, limits)} />
                  </div>
                ))}
              </div>
            ) : m.reporting === false ? <p className="hl-hex-tip-note">The server is not reporting its CPU, memory and disk.</p> : null}
            {problems.length > 0 && <ul className="hl-hex-tip-problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
            {m.sharedStores.filter((d) => d.level === 'warn' || d.level === 'crit').map((d) => (
              <p key={d.mount} className="hl-hex-tip-note">Shared store {d.mount} is {formatPct(d.pct)} full: counted under Storage, not against this machine.</p>
            ))}
          </div>
        ))}
    </>
  )
}
