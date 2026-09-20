import type { Instance, ScanResult, ScanTarget } from './types'

/** A failed refresh must never look like a successful scan that found no hosts. */
export function mergeInventoryScan(
  fresh: Instance[], cached: ScanResult | null, targets: ScanTarget[],
  errors: ScanResult['errors'], partial: boolean, now: number
): ScanResult {
  const covered = (profile: string, region: string): boolean =>
    targets.some((t) => t.profile === profile && (!t.regions || t.regions.includes(region)))
  const instances: Instance[] = fresh.map((i) => ({ ...i, lastSeenAt: now, staleReason: undefined }))
  const seen = new Set(instances.map((i) => i.key))
  for (const i of cached?.instances ?? []) {
    if (seen.has(i.key)) continue
    const failure = errors.find((e) => e.profile === i.profile && (e.allRegions || e.region === i.region))
    if (failure) instances.push({ ...i, lastSeenAt: i.lastSeenAt ?? cached!.scannedAt, staleReason: failure.message })
    else if (partial && !covered(i.profile, i.region)) instances.push({ ...i, lastSeenAt: i.lastSeenAt ?? cached!.scannedAt })
  }
  const retainedErrors = partial ? (cached?.errors ?? []).filter((e) =>
    !covered(e.profile, e.region) && !errors.some((next) => next.profile === e.profile && next.allRegions)
  ) : []
  instances.sort((a, b) => a.profile.localeCompare(b.profile) || a.name.localeCompare(b.name))
  return { instances, errors: [...retainedErrors, ...errors], scannedAt: now }
}
