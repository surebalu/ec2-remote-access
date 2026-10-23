/**
 * The two things the planning tools fetch from the web, from main so CORS does not stand in the way and a phone gets
 * them through the Mac: a page's title and description when a link is added by its address (links:preview), and an
 * iCal subscription's .ics file (calendar:feed). Web addresses only, a time limit, and a size cap.
 */
import { pagePreview } from '@shared/links'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) EC2RemoteAccess Safari/537.36'

async function fetchText(raw: string, limit: number, accept: string, timeoutMs: number): Promise<string> {
  let url: URL
  try { url = new URL(raw.trim().replace(/^webcal:/i, 'https:')) } catch { throw new Error('That is not a web address.') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http and https addresses can be fetched.')
  const r = await fetch(url, { headers: { 'user-agent': UA, accept }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`${url.host} answered ${r.status}${r.status === 404 ? ' (not found)' : r.status === 401 || r.status === 403 ? ' (not allowed: is the link still valid?)' : ''}.`)
  if (!r.body) return ''
  // Read only as much as needed: a page's head, or a calendar up to the cap.
  const reader = r.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
    if (size >= limit) { void reader.cancel(); break }
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit))
}

export async function linkPreview(url: string): Promise<{ title?: string; description?: string }> {
  return pagePreview(await fetchText(url, 512 * 1024, 'text/html,application/xhtml+xml', 8000))
}

export async function calendarFeed(url: string): Promise<string> {
  const text = await fetchText(url, 20 * 1024 * 1024, 'text/calendar,*/*', 20000)
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4096))) throw new Error('That address did not return a calendar (.ics). Use the calendar\'s iCal or "secret address" link.')
  return text
}
