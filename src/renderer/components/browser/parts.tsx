import type { CSSProperties, ReactElement } from 'react'
import { useState } from 'react'
import type { AccentColor, WebSpace } from '@shared/types'
import { AWS_SERVICES, consoleHome, hostOf, isHexColor, type AwsService } from '@shared/browser'
import { ACCENTS, initials } from '../../colors'

/** A space as the browser shows it: AWS account spaces also carry the account's region and id. */
export interface Space extends WebSpace {
  region?: string
  accountId?: string
}

/** The AWS services an account space offers, with the console home first. */
export const SPACE_SERVICES: AwsService[] = [
  { id: 'home', name: 'Console Home', keywords: 'console home dashboard aws', url: consoleHome },
  ...AWS_SERVICES
]

const SERVICE_STYLE: Record<string, { short: string; color: AccentColor }> = {
  home: { short: 'AWS', color: 'slate' },
  ec2: { short: 'EC2', color: 'orange' },
  cloudwatch: { short: 'CW', color: 'rose' },
  ssm: { short: 'SSM', color: 'teal' },
  s3: { short: 'S3', color: 'emerald' },
  iam: { short: 'IAM', color: 'amber' },
  billing: { short: '$', color: 'violet' }
}

export function ServiceBadge({ id, size = 22 }: { id: string; size?: number }): ReactElement {
  const s = SERVICE_STYLE[id] ?? { short: id.slice(0, 3).toUpperCase(), color: 'slate' as AccentColor }
  return (
    <span className="svc-badge" data-accent={s.color} style={{ width: size, height: size, fontSize: size * (s.short.length > 2 ? 0.34 : 0.42) }}>
      {s.short}
    </span>
  )
}

/** The named colours' values (styles.css [data-accent]), to start a custom colour from the one chosen. */
export const ACCENT_HEX: Record<AccentColor, string> = {
  emerald: '#10b981', amber: '#f59e0b', rose: '#f43f5e', violet: '#8b5cf6', sky: '#0ea5e9', teal: '#14b8a6', orange: '#f97316', slate: '#64748b'
}

/** Ready-made gradients for a space, as [from, to, name]. */
export const SPACE_GRADIENTS: [string, string, string][] = [
  ['#22d3ee', '#a855f7', 'Aurora'], ['#f97316', '#ec4899', 'Sunset'], ['#0ea5e9', '#1e3a8a', 'Ocean'], ['#34d399', '#065f46', 'Forest'],
  ['#f472b6', '#a78bfa', 'Candy'], ['#00b4a6', '#c26ad6', 'Cyber Wave'], ['#fbbf24', '#dc2626', 'Ember'], ['#94a3b8', '#334155', 'Graphite']
]

/** Emoji offered at a click for a space's icon; the macOS picker (More…) has the rest. */
export const SPACE_EMOJI = ['💼', '🏠', '🧪', '🚀', '🛠️', '📊', '💻', '☁️', '🔒', '🎯', '📚', '🎨', '🧠', '⚙️', '🌐', '📝', '🐞', '🔥', '💡', '🏢', '🎮', '🎵', '✈️', '🤖']

/**
 * CSS variables for a space with a colour of its own, the same ones [data-accent] sets for a named colour, plus --c2
 * for the gradient's second colour. Undefined for a named colour (or anything that is not #rrggbb).
 */
export function spaceVars(space: Pick<WebSpace, 'custom'>): CSSProperties | undefined {
  const c = space.custom
  if (!c || !isHexColor(c.from)) return undefined
  // --c2 only for a gradient: the browser's fade down the sidebar is drawn only when it is set.
  return { '--c': c.from, ...(isHexColor(c.to) ? { '--c2': c.to } : {}), '--c-soft': `color-mix(in srgb, ${c.from} 15%, transparent)`, '--c-text': `color-mix(in srgb, ${c.from} 80%, var(--text))` } as CSSProperties
}

export function SpaceAvatar({ space, size = 22 }: { space: WebSpace; size?: number }): ReactElement {
  const icon = space.icon && space.icon.length <= 16 ? space.icon : ''
  return (
    <span className={`space-avatar ${icon ? 'emoji' : ''}`} data-accent={space.color} style={{ ...spaceVars(space), width: size, height: size, fontSize: size * (icon ? 0.6 : 0.4) }}>
      {icon || initials(space.name)}
    </span>
  )
}

function hostColor(host: string): AccentColor {
  let h = 0
  for (const c of host) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return ACCENTS[h % ACCENTS.length]
}

/** A page's favicon, or a lettered tile in a colour of its host when it has none (or it fails to load). */
export function Favicon({ src, url, size = 16 }: { src?: string; url: string; size?: number }): ReactElement {
  const [failed, setFailed] = useState<string | null>(null)
  const host = hostOf(url)
  if (src && failed !== src) {
    return <img className="favicon" src={src} width={size} height={size} alt="" draggable={false} onError={() => setFailed(src)} />
  }
  const letter = (host.replace(/^[^a-z0-9]+/i, '')[0] ?? '•').toUpperCase()
  return (
    <span className="favicon-letter" data-accent={url ? hostColor(host) : 'slate'} style={{ width: size, height: size, fontSize: size * 0.6 }}>
      {url ? letter : '+'}
    </span>
  )
}
