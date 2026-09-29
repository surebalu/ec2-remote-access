import { useMemo, useState, type ReactElement } from 'react'
import type { PortForwardPreset } from '@shared/types'
import { allInstances, useStore } from '../store'
import Modal from './Modal'

/** Common targets, so the usual case is one click and Enter. */
const PRESETS: [string, number][] = [
  ['PostgreSQL', 5432], ['MySQL', 3306], ['Redis', 6379], ['HTTP', 80], ['HTTPS', 443], ['8080', 8080], ['RDP', 3389], ['SSH', 22]
]

export default function PortForwardDialog(): ReactElement | null {
  const s = useStore()
  const req = s.portForwardFor!
  const preset = s.settings?.portForwards.find((p) => p.id === req.presetId)
  // Port forwarding rides on SSM, so only running instances with an online agent can be picked.
  const candidates = useMemo(
    () => allInstances(s).filter((i) => !i.manual && i.state === 'running' && i.ssmOnline).sort((a, b) => a.name.localeCompare(b.name)),
    [s.instances] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const [key, setKey] = useState(preset?.instanceKey ?? req.key ?? candidates[0]?.key ?? '')
  const [remotePort, setRemotePort] = useState(preset ? String(preset.remotePort) : '')
  const [remoteHost, setRemoteHost] = useState(preset?.remoteHost ?? '')
  const [localPort, setLocalPort] = useState(preset?.localPort ? String(preset.localPort) : '')
  const [name, setName] = useState(preset?.name ?? '')
  const [save, setSave] = useState(!!preset)
  const [busy, setBusy] = useState(false)
  const close = (): void => s.set({ portForwardFor: null })
  const inst = allInstances(s).find((i) => i.key === key)
  const rp = Number(remotePort)
  const lp = localPort ? Number(localPort) : undefined
  const valid = !!inst && Number.isInteger(rp) && rp > 0 && rp < 65536 && (lp === undefined || (Number.isInteger(lp) && lp > 0 && lp < 65536))

  const submit = async (): Promise<void> => {
    if (!valid || busy) return
    setBusy(true)
    const body = { instanceKey: key, remotePort: rp, localPort: lp, remoteHost: remoteHost.trim() || undefined, name: name.trim() || undefined }
    if (save) {
      const p: PortForwardPreset = { id: preset?.id ?? `pf-${Date.now().toString(36)}`, ...body, name: body.name ?? `${inst!.name}${body.remoteHost ? ` → ${body.remoteHost}` : ''}:${rp}` }
      await s.saveSettings({ portForwards: [...(s.settings?.portForwards ?? []).filter((x) => x.id !== p.id), p] })
    }
    const t = await s.openPortForward(body)
    setBusy(false)
    if (t) close()
  }

  return (
    <Modal title={preset ? `Port forward: ${preset.name}` : 'Forward a port'} onClose={close} width="max-w-lg">
      <form className="space-y-3 text-xs" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <p className="muted">Opens an SSM tunnel from <span className="mono">localhost</span> to a port on the instance, or to another host the instance can reach (a database endpoint, an internal load balancer).</p>
        <label className="block">
          <span className="muted mb-1 block">Through instance</span>
          <select className="input" value={key} onChange={(e) => setKey(e.target.value)}>
            {!candidates.some((c) => c.key === key) && <option value={key}>{inst?.name ?? 'Choose an instance'}</option>}
            {candidates.map((i) => <option key={i.key} value={i.key}>{i.name} · {i.profile} · {i.region}</option>)}
          </select>
          {!candidates.length && <span className="mt-1 block" style={{ color: 'var(--warn)' }}>No running instance has an online SSM agent.</span>}
        </label>
        <div className="flex flex-wrap gap-1">
          {PRESETS.map(([label, port]) => (
            <button key={label} type="button" className={`btn btn-sm ${rp === port ? 'on' : ''}`} onClick={() => setRemotePort(String(port))}>{label}</button>
          ))}
        </div>
        <div className="grid grid-cols-[1fr_110px] gap-2">
          <label className="block">
            <span className="muted mb-1 block">Remote host <span className="opacity-70">(optional)</span></span>
            <input className="input mono" placeholder="the instance itself" value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} spellCheck={false} />
          </label>
          <label className="block">
            <span className="muted mb-1 block">Remote port</span>
            <input className="input mono" autoFocus inputMode="numeric" placeholder="5432" value={remotePort} onChange={(e) => setRemotePort(e.target.value.replace(/\D/g, ''))} />
          </label>
        </div>
        <div className="grid grid-cols-[1fr_110px] gap-2">
          <label className="block">
            <span className="muted mb-1 block">Name <span className="opacity-70">(optional)</span></span>
            <input className="input" placeholder={inst ? `${inst.name}:${remotePort || 'port'}` : ''} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <span className="muted mb-1 block">Local port</span>
            <input className="input mono" inputMode="numeric" placeholder="any" value={localPort} onChange={(e) => setLocalPort(e.target.value.replace(/\D/g, ''))} />
          </label>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Save for one-click reuse (tunnel bar and ⌘K)
        </label>
        <div className="flex justify-end gap-2 pt-1">
          {preset && (
            <button type="button" className="btn mr-auto" onClick={() => void s.saveSettings({ portForwards: (s.settings?.portForwards ?? []).filter((p) => p.id !== preset.id) }).then(close)}>
              Delete preset
            </button>
          )}
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!valid || busy}>{busy ? 'Opening…' : 'Start forwarding'}</button>
        </div>
      </form>
    </Modal>
  )
}
