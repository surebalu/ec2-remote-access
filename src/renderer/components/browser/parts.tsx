import type { ReactElement } from 'react'
import { useState } from 'react'
import type { AccentColor, WebSpace } from '@shared/types'
import { AWS_SERVICES, consoleHome, hostOf, type AwsService } from '@shared/browser'
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

export function SpaceAvatar({ space, size = 22 }: { space: WebSpace; size?: number }): ReactElement {
  return (
    <span className="space-avatar" data-accent={space.color} style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {initials(space.name)}
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
