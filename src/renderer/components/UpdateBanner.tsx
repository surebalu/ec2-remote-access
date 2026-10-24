import type { ReactElement } from 'react'
import { useUpdateReady } from '../updates'
import { Icon } from './icons'

/** A newer version of the app is on the computer; this page keeps working until reloaded (see updates.ts). */
export default function UpdateBanner(): ReactElement | null {
  if (!useUpdateReady()) return null
  return (
    <div className="update-banner" role="status">
      <Icon.refresh />
      <span className="min-w-0 flex-1">The app was updated. Reload to get the new version; open sessions reconnect after it.</span>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => location.reload()}>Reload</button>
    </div>
  )
}
