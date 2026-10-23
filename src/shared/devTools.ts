/** Pure, local text utilities shared by the developer workbench and its tests. */
export type DevTool = 'json' | 'base64' | 'url' | 'jwt' | 'time' | 'uuid' | 'hash'
export const MAX_TOOL_INPUT = 200_000

export function formatJson(input: string, compact = false): string {
  JSON.parse(input)
  // Validate with the parser, then format the original tokens. Parsing/stringifying would round large IDs,
  // normalize exponents and discard duplicate keys, even though the user asked only to change whitespace.
  const tokens = input.match(/"(?:\\.|[^"\\])*"|[^\s{}\[\],:]+|[{}\[\],:]/g) ?? []
  if (compact) return tokens.join('')
  let depth = 0
  let output = ''
  const line = (): string => `\n${'  '.repeat(depth)}`
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '{' || token === '[') {
      if (++depth > 128) throw new Error('JSON nesting is too deep to format (maximum 128 levels).')
      output += token + (tokens[i + 1] === '}' || tokens[i + 1] === ']' ? '' : line())
    } else if (token === '}' || token === ']') {
      depth--
      output += (tokens[i - 1] === '{' || tokens[i - 1] === '[' ? '' : line()) + token
    } else output += token === ',' ? `,${line()}` : token === ':' ? ': ' : token
    if (output.length > 2_000_000) throw new Error('Formatted output is too large. Use Minify or a smaller payload.')
  }
  return output
}

export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function decodeBase64(text: string, urlSafe = false): string {
  let input = text.trim()
  if (urlSafe) input = input.replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input) || input.length % 4 === 1) throw new Error('Enter valid Base64 text.')
  try {
    const bytes = Uint8Array.from(atob(input), (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch { throw new Error('This is not valid Base64-encoded UTF-8 text.') }
}

export function inspectJwt(text: string): string {
  const parts = text.trim().split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !/^[A-Za-z0-9_-]*$/.test(parts[2])) throw new Error('Enter a JWT with three dot-separated segments.')
  const header: unknown = JSON.parse(decodeBase64(parts[0], true))
  const claims: unknown = JSON.parse(decodeBase64(parts[1], true))
  if (!header || typeof header !== 'object' || Array.isArray(header) || !claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('JWT header and payload must be JSON objects.')
  const dates: Record<string, string> = {}
  for (const key of ['iat', 'nbf', 'exp']) {
    const value = (claims as Record<string, unknown>)[key]
    if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value * 1000) <= 8.64e15) dates[key] = new Date(value * 1000).toISOString()
  }
  return JSON.stringify({ verification: 'Not verified — decoded only', header, payload: claims, datesUTC: dates }, null, 2)
}

export function convertTimestamp(input: string, unit: 'seconds' | 'milliseconds'): string {
  const value = input.trim()
  const numeric = /^[+-]?\d+(?:\.\d+)?$/.test(value)
  // Require a timezone for calendar input; silent local-time guesses are dangerous when reading server logs.
  if (!numeric && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error('Enter a Unix timestamp or an ISO date with a timezone, such as 2026-10-22T14:30:00Z.')
  if (!numeric) {
    const monthEnd = new Date(`${value.slice(0, 7)}-01T00:00:00Z`)
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0)
    if (Number(value.slice(8, 10)) < 1 || Number(value.slice(8, 10)) > monthEnd.getUTCDate() || Number(value.slice(11, 13)) > 23) throw new Error('Enter a real calendar date and a time from 00:00:00 to 23:59:59.')
  }
  const ms = numeric ? Number(value) * (unit === 'seconds' ? 1000 : 1) : Date.parse(value)
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) throw new Error('This timestamp is outside the supported date range.')
  const date = new Date(ms)
  return `UTC          ${date.toISOString()}\nLocal        ${date.toString()}\nUnix seconds ${Math.floor(date.getTime() / 1000)}\nMilliseconds ${date.getTime()}`
}

export async function transformText(tool: DevTool, input: string, action = ''): Promise<string> {
  if (input.length > MAX_TOOL_INPUT) throw new Error('Use up to 200,000 characters at a time.')
  switch (tool) {
    case 'json': return formatJson(input, action === 'minify')
    case 'base64': return action === 'decode' ? decodeBase64(input) : encodeBase64(input)
    case 'url':
      try { return action === 'decode' ? decodeURIComponent(input) : encodeURIComponent(input) }
      catch { throw new Error('Enter valid URL-encoded UTF-8 text (check the % escapes).') }
    case 'jwt': return inspectJwt(input)
    case 'time': return convertTimestamp(input, action === 'milliseconds' ? 'milliseconds' : 'seconds')
    case 'uuid': {
      const count = Number(input || '1')
      if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Choose a whole number from 1 to 100.')
      return Array.from({ length: count }, () => {
        // getRandomValues also works on a plain-HTTP gateway; randomUUID requires a secure context.
        const bytes = crypto.getRandomValues(new Uint8Array(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x40
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      }).join('\n')
    }
    case 'hash': {
      if (!crypto.subtle) throw new Error('SHA-256 needs a secure browser context. Use the desktop app or an HTTPS gateway.')
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
    }
  }
}
