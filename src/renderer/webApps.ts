/**
 * Chat assistants with a tool of their own on the app rail. Each is one signed-in page (WebAppTab) in its own cookie
 * partition, so it stays signed in apart from the Browser's spaces, and comes back to the chat it was showing.
 */
export type WebAppKind = 'claude' | 'chatgpt'

export interface WebApp {
  name: string
  /** Where a new chat starts. */
  home: string
  /** Sites that belong to the app (subdomains included): its pages and pop-ups stay in its tab, other links go to the Browser. */
  sites: string[]
  partition: string
}

export const WEB_APPS: Record<WebAppKind, WebApp> = {
  claude: { name: 'Claude', home: 'https://claude.ai/new', sites: ['claude.ai', 'claude.com', 'anthropic.com'], partition: 'persist:web-app-claude' },
  chatgpt: { name: 'ChatGPT', home: 'https://chatgpt.com/', sites: ['chatgpt.com', 'openai.com'], partition: 'persist:web-app-chatgpt' }
}

/** Sign-in providers the sites hand you to; those pages load in the app's tab, where its cookies are. */
const SIGN_IN_SITES = ['accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com']

export const isWebApp = (kind: string): kind is WebAppKind => kind === 'claude' || kind === 'chatgpt'

function onSite(url: string, sites: string[]): boolean {
  try {
    const host = new URL(url).hostname
    return sites.some((s) => host === s || host.endsWith(`.${s}`))
  } catch {
    return false
  }
}

export const ownPage = (app: WebApp, url: string): boolean => onSite(url, app.sites)
export const staysInApp = (app: WebApp, url: string): boolean => onSite(url, app.sites) || onSite(url, SIGN_IN_SITES)

/**
 * Electron's user agent names the app and Electron. Some sign-in pages turn such "embedded browsers" away, so the
 * assistants' pages present themselves as the Chrome they run on.
 */
export function plainChromeAgent(ua: string): string {
  return ua.replace(/\sElectron\/\S+/, '').replace(/\s[^\s/()]+\/[\d.]+(?=\sChrome\/)/, '')
}
