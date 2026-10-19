import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { CAN_DICTATE } from '../voice'
import { Icon } from './icons'
import { useStore } from '../store'
import { dictationKeyLabel } from '@shared/dictation'

/** Whether a dictation is running, from the `ec2ra:dictation` event every mic button listens to. */
export function useDictationActive(): boolean {
  const [active, setActive] = useState(false)
  useEffect(() => {
    const on = (e: Event): void => setActive(!!(e as CustomEvent<{ active: boolean }>).detail?.active)
    window.addEventListener('ec2ra:dictation', on)
    return () => window.removeEventListener('ec2ra:dictation', on)
  }, [])
  return active
}

/**
 * Click to talk, click again to insert (src/renderer/voice.ts). It never takes the focus, so the words go to the field
 * the user was in, or into `target` when given. Hidden outside the Mac app: phones and tablets have their keyboard's
 * own dictation key.
 */
export default function MicButton({ className = 'btn btn-ghost btn-sm btn-icon', label, target }: {
  className?: string
  /** Text beside the icon ("Dictate"); icon only without it. */
  label?: string
  /** Where the words go; defaults to whatever had the focus. */
  target?: () => Element | null
}): ReactElement | null {
  const active = useDictationActive()
  const key = useStore((s) => s.settings?.dictationKey ?? 'AltRight')
  if (!CAN_DICTATE) return null
  const hold = key !== 'off' ? ` or hold ${dictationKeyLabel(key)}` : ''
  const title = active ? 'Stop and insert what you said' : `Dictate: click to talk, click again to insert${hold}`
  return (
    <button
      type="button"
      className={`${className} mic-btn ${active ? 'on' : ''}`}
      title={title}
      aria-label={active ? 'Stop dictation' : 'Dictate'}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => window.dispatchEvent(new CustomEvent('ec2ra:dictate', { detail: { action: 'toggle', target: target?.() ?? undefined } }))}
    >
      <Icon.mic />
      {label && <span>{label}</span>}
    </button>
  )
}
