import type { ReactElement, ReactNode } from 'react'
import { GAUGE_TICKS, gaugeFraction, rpmWord, speedCapabilities, type SpeedRun, type SpeedSample } from '@shared/macTools'
import { Icon } from '../components/icons'

/**
 * Speed Test as Raycast draws it: a dial each for download and upload (marks 0, 1, 5, 10, 50, 100, 500, 1000 Mbps at
 * equal steps), how each went over the test, ping, download and upload as tinted pills, and on the right what the
 * connection is good for (calls, video, streaming) with who provides it. The readings arrive while networkQuality
 * runs (main/macTools.ts), so the dials move as it measures.
 */

const START = 135
const SWEEP = 270

const polar = (cx: number, cy: number, r: number, deg: number): [number, number] => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)]

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x1, y1] = polar(cx, cy, r, from)
  const [x2, y2] = polar(cx, cy, r, to)
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
}

const mbps = (v: number): string => (v >= 100 ? v.toFixed(2) : v >= 10 ? v.toFixed(2) : v.toFixed(2))

function Gauge({ value, label, tone }: { value: number; label: string; tone: 'down' | 'up' }): ReactElement {
  const W = 190
  const cx = W / 2
  const cy = 98
  const r = 72
  const f = gaugeFraction(value)
  const end = START + SWEEP * f
  const [kx, ky] = polar(cx, cy, r, end)
  return (
    <div className={`sp-gauge ${tone}`}>
      <svg viewBox={`0 0 ${W} 170`} width="100%" role="img" aria-label={`${label}: ${mbps(value)} Mbps`}>
        <path d={arc(cx, cy, r, START, START + SWEEP)} className="sp-track" />
        {f > 0.002 && <path d={arc(cx, cy, r, START, end)} className="sp-fill" />}
        {GAUGE_TICKS.map((t, i) => {
          const a = START + (SWEEP * i) / (GAUGE_TICKS.length - 1)
          const [x1, y1] = polar(cx, cy, r + 12, a)
          const [x2, y2] = polar(cx, cy, r + 16, a)
          const [lx, ly] = polar(cx, cy, r + 26, a)
          return (
            <g key={t}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} className="sp-tick" />
              <text x={lx} y={ly + 3} className="sp-tick-label" textAnchor={Math.abs(lx - cx) < 4 ? 'middle' : lx < cx ? 'end' : 'start'}>{t}</text>
            </g>
          )
        })}
        {f > 0.002 && <circle cx={kx} cy={ky} r={8.5} className="sp-knob" />}
        <text x={cx} y={cy + 8} className="sp-value" textAnchor="middle">{mbps(value)}</text>
        <text x={cx} y={cy + 28} className="sp-unit" textAnchor="middle">Mbps</text>
        <text x={cx} y={cy + 66} className="sp-label" textAnchor="middle">{label}</text>
      </svg>
    </div>
  )
}

/** How a direction went over the test: an area under the readings, the peak, the latest, how many readings. */
function OverTime({ samples, pick, label, tone }: { samples: SpeedSample[]; pick: (s: SpeedSample) => number; label: string; tone: 'down' | 'up' }): ReactElement {
  const values = samples.map(pick)
  const peak = Math.max(0, ...values)
  const last = values.at(-1) ?? 0
  const W = 120
  const H = 38
  const pts = values.map((v, i) => [values.length < 2 ? W : (i / (values.length - 1)) * W, H - (peak ? (v / peak) * (H - 4) : 0) - 2] as const)
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  return (
    <div className={`sp-card ${tone}`}>
      <div className="sp-card-title">{label} over time</div>
      <div className="sp-card-body">
        <div className="sp-spark">
          <span className="sp-peak">peak {mbps(peak)} Mbps</span>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            {pts.length > 1 && <path d={`${line} L${W} ${H} L0 ${H} Z`} className="sp-area" />}
            {pts.length > 1 && <path d={line} className="sp-line" vectorEffect="non-scaling-stroke" />}
          </svg>
        </div>
        <div className="sp-card-now">
          <b>{mbps(last)} Mbps</b>
          <span>{values.length} sample{values.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>
  )
}

function Chips({ list, icon }: { list: { label: string; ok: boolean }[]; icon: ReactNode }): ReactElement {
  return <div className="sp-chips">{list.map((c) => <span key={c.label} className={`sp-chip ${c.ok ? 'ok' : ''}`} title={c.ok ? 'Fast enough' : 'Too slow for this'}>{icon}{c.label}</span>)}</div>
}

export default function SpeedTest({ run }: { run: SpeedRun | null }): ReactElement {
  const samples = run?.samples ?? []
  const last = samples.at(-1)
  const result = run?.result
  const down = result ? result.download / 1e6 : last?.down ?? 0
  const up = result ? result.upload / 1e6 : last?.up ?? 0
  const caps = speedCapabilities(down * 1e6, up * 1e6)
  const status = !run ? 'Starting…' : run.error ? 'Failed' : result ? 'Finished' : 'Testing…'
  const fact = (label: string, value: ReactNode): ReactElement | null => (value ? <div className="sp-fact"><span>{label}</span><div>{value}</div></div> : null)
  return (
    <div className="sp" aria-label="Speed test">
      <div className="sp-main">
        <div className="sp-gauges">
          <Gauge value={down} label="Download" tone="down" />
          <Gauge value={up} label="Upload" tone="up" />
        </div>
        <div className="sp-cards">
          <OverTime samples={samples} pick={(s) => s.down} label="Download" tone="down" />
          <OverTime samples={samples} pick={(s) => s.up} label="Upload" tone="up" />
        </div>
        <div className="sp-pills">
          <div className="sp-pill ping"><i /><div><b>Ping</b><span>{result ? `${result.idleMs.toFixed(1)} ms` : '…'}</span></div></div>
          <div className="sp-pill down"><i /><div><b>Download</b><span>{mbps(down)} Mbps</span></div></div>
          <div className="sp-pill up"><i /><div><b>Upload</b><span>{mbps(up)} Mbps</span></div></div>
        </div>
      </div>
      <aside className="sp-side">
        <div className="sp-fact"><span>Status</span><div className={`sp-status ${run?.error ? 'err' : result ? 'ok' : ''}`}>{result ? <Icon.check /> : run?.error ? <Icon.alert /> : <Icon.gauge className="launcher-spin" />}{status}</div></div>
        {run?.error && <p className="sp-error">{run.error}</p>}
        {(result || samples.length > 0) && <>
          <div className="sp-fact"><span>Voice Call</span><Chips list={caps.voice} icon={<Icon.phone />} /></div>
          <div className="sp-fact"><span>Video Call</span><Chips list={caps.video} icon={<Icon.monitor />} /></div>
          <div className="sp-fact"><span>Streaming</span><Chips list={caps.streaming} icon={<Icon.broadcast />} /></div>
        </>}
        {fact('Responsiveness', result?.rpm ? `${result.rating || rpmWord(result.rpm)} · ${result.rpm} RPM${result.workingMs ? ` (${result.workingMs} ms under load)` : ''}` : '')}
        {fact('ISP', result?.isp)}
        {fact('Location', result?.location)}
        {fact('Internal IP', result?.internalIp)}
        {fact('External IP', result?.externalIp)}
        {fact('Interface', result?.interface)}
        {fact('Test server', result?.server)}
      </aside>
    </div>
  )
}
