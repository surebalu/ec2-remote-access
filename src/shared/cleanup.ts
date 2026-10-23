/**
 * The Storage tool's Cleanup rooms (Junk Files, AI Models, System Data, Installers): what each lists and why, as pure
 * rules main/storage/cleanup.ts applies to what it finds on disk. Nothing here touches the disk, so
 * tests/cleanup.test.ts covers it.
 */

/** One thing a room offers to clear, or only shows. */
export interface CleanItem {
  /** Its path (also its key in the room). */
  path: string
  name: string
  size: number
  dir: boolean
  /** What it is and what happens if it goes. */
  note?: string
  /** Ticked for you: nothing anyone made is lost, and what made it fills it again. */
  safe: boolean
  /** Shown but not selectable, and why (an app is using it, only macOS removes it). */
  blocked?: string
  /** Something to do instead of the Trash: a setting to open, a command to copy, a place to show. */
  action?: { label: string; url?: string; copy?: string; reveal?: string; room?: string }
  mtime?: number
  /** Last opened (Spotlight), for old downloads. */
  used?: number
}

export interface CleanGroup {
  id: string
  title: string
  text: string
  items: CleanItem[]
}

export interface CleanReport {
  groups: CleanGroup[]
  at: number
  /** What could not be looked at ("Without Full Disk Access, the caches apps keep in their containers are not measured"). */
  notes: string[]
}

export const groupSize = (g: CleanGroup): number => g.items.reduce((s, i) => s + i.size, 0)
export const reportSize = (r: CleanReport, safeOnly = false): number => r.groups.reduce((s, g) => s + g.items.filter((i) => !i.blocked && (!safeOnly || i.safe)).reduce((t, i) => t + i.size, 0), 0)

/** Package managers' download caches in ~/Library/Caches, named for the Junk room. */
export const DOWNLOAD_CACHES: Record<string, string> = {
  Homebrew: 'Homebrew downloads', pip: 'pip downloads', Yarn: 'Yarn cache', CocoaPods: 'CocoaPods cache', 'node-gyp': 'node-gyp headers', 'go-build': 'Go build cache',
  'pnpm': 'pnpm metadata cache', 'com.apple.dt.Xcode': 'Xcode cache', 'org.swift.swiftpm': 'Swift Package Manager cache', 'ms-playwright': 'Playwright browsers', 'Cypress': 'Cypress binaries'
}

/** Folders in ~/.cache that are AI models: they belong to the AI Models room, not Junk. */
export const AI_CACHE_DIRS = new Set(['huggingface', 'torch', 'whisper', 'lm-studio', 'llama.cpp', 'chroma', 'sentence_transformers'])

/** Caches in ~/Library/Caches left out of Junk: models, macOS's own that apps share, or ones other rooms show. */
export const KEEP_CACHES = new Set(['llama.cpp', 'CloudKit', 'com.apple.bird', 'com.apple.akd', 'FamilyCircle', 'com.apple.nsurlsessiond', 'com.apple.Safari.SafeBrowsing', 'com.apple.iCloudHelper', 'com.apple.ap.adprivacyd'])

/**
 * Whether a cache folder belongs to an app that is open now: by bundle id (com.google.Chrome, or a folder named for a
 * part of it), or by the app's name ('Google' holds Chrome's caches, so a vendor folder counts when one of its apps
 * is open). An open app may be writing into its cache, so it is not ticked.
 */
export function cacheOwner(folder: string, running: { id: string; name: string }[]): { id: string; name: string } | null {
  const f = folder.toLowerCase().replace(/\.(savedstate|binarycookies)$/, '')
  for (const r of running) {
    const id = r.id.toLowerCase()
    const name = r.name.toLowerCase()
    if (!id && !name) continue
    if (id && (f === id || f.startsWith(`${id}.`) || id.startsWith(`${f}.`))) return r
    if (name && (f === name || f === name.replace(/\s+/g, ''))) return r
    // Vendor folders: ~/Library/Caches/Google for com.google.Chrome, Microsoft for com.microsoft.*.
    const vendor = id.split('.')[1]
    if (vendor && vendor.length > 2 && f === vendor) return r
  }
  return null
}

/** A reverse-DNS name: com.vendor.app (three parts at least, letters first). */
export const isBundleId = (s: string): boolean => /^[a-z][a-z0-9-]*(\.[A-Za-z0-9_-]+){2,}$/i.test(s)

/** Apple's own downloads in /System/Library/AssetsV2, grouped by the feature they serve and where it is set. */
export const APPLE_ASSETS: { id: string; title: string; text: string; match: RegExp; how: string; url: string }[] = [
  { id: 'intelligence', title: 'Apple Intelligence', text: 'Models behind Writing Tools, summaries, Image Playground and other features, which run on this Mac.', match: /UAF_(FM|IF|Generative|Summar|Image|Writing|Mail|Photos|Visual)|GenerativeModels|AppleIntelligence/i, how: 'Each feature has its own switch.', url: 'x-apple.systempreferences:com.apple.Siri-Settings.extension' },
  { id: 'siri', title: 'Siri', text: 'What Siri uses to understand what is said, and to answer in its voice.', match: /Siri/i, how: 'Siri is set in the Siri pane.', url: 'x-apple.systempreferences:com.apple.Siri-Settings.extension' },
  { id: 'speech', title: 'Dictation and speech', text: 'What Dictation, Voice Control and Live Captions use to recognise speech.', match: /Speech|Dictation|Endpointer|Hammer/i, how: 'Turn off Dictation, or remove the languages you do not dictate in.', url: 'x-apple.systempreferences:com.apple.Keyboard-Settings.extension' },
  { id: 'voices', title: 'Voices', text: 'Voices that read text aloud, for Spoken Content in Accessibility.', match: /Voice|MacinTalk|TTS/i, how: 'Untick the voices you do not use in Manage Voices.', url: 'x-apple.systempreferences:com.apple.Accessibility-Settings.extension' },
  { id: 'language', title: 'Translation and language', text: 'Translation languages, and the models for autocorrect, prediction and understanding text.', match: /Translat|Linguistic|TextUnderstanding|Lexicon|Dictionar/i, how: 'Remove the languages you do not use in Language & Region.', url: 'x-apple.systempreferences:com.apple.Localization-Settings.extension' }
]

/** Which Apple asset group a folder in AssetsV2 belongs to, or null for assets that are not models. */
export function appleAssetGroup(name: string): string | null {
  return APPLE_ASSETS.find((a) => a.match.test(name))?.id ?? null
}

/** An Ollama manifest's layers: model name (name:tag), its blobs and their sizes. */
export interface OllamaModel { name: string; blobs: { digest: string; size: number }[]; size: number }

/**
 * Reads one manifest (manifests/<registry>/<namespace>/<model>/<tag>) into a model. The library namespace is left out
 * of the name, as `ollama list` shows it.
 */
export function parseOllamaManifest(rel: string, json: string): OllamaModel | null {
  const parts = rel.split('/')
  if (parts.length < 4) return null
  const [registry, ns, model, tag] = parts.slice(-4)
  let m: { layers?: { digest?: string; size?: number }[]; config?: { digest?: string; size?: number } }
  try { m = JSON.parse(json) } catch { return null }
  const blobs = [...(m.layers ?? []), ...(m.config ? [m.config] : [])].filter((l): l is { digest: string; size: number } => typeof l.digest === 'string' && typeof l.size === 'number')
  const base = registry === 'registry.ollama.ai' ? (ns === 'library' ? model : `${ns}/${model}`) : `${registry}/${ns}/${model}`
  return { name: `${base}:${tag}`, blobs, size: blobs.reduce((s, b) => s + b.size, 0) }
}

/** A blob file's digest as manifests write it: blobs/sha256-<hex> → sha256:<hex>. */
export const blobDigest = (file: string): string => file.replace(/^sha256-/, 'sha256:')

/** The apps an installer package carries, from its PackageInfo XML: bundle id, versions and path. */
export function parsePackageInfo(xml: string): { id: string; version: string; path: string }[] {
  const out: { id: string; version: string; path: string }[] = []
  for (const m of xml.matchAll(/<bundle\b([^>]*)>/g)) {
    const attr = (k: string): string => new RegExp(`\\b${k}="([^"]*)"`).exec(m[1])?.[1] ?? ''
    const path = attr('path')
    if (!/\.app$/i.test(path)) continue
    out.push({ id: attr('id'), version: attr('CFBundleShortVersionString') || attr('CFBundleVersion'), path })
  }
  // The outermost app first: ./Foo.app before ./Foo.app/Contents/Helpers/Bar.app.
  return out.sort((a, b) => a.path.split('/').length - b.path.split('/').length)
}

/** The app a zip carries: the first Foo.app/Contents/Info.plist at its top or one folder down. */
export function zipAppPlist(entries: string[]): string | null {
  return entries.find((e) => !e.startsWith('__MACOSX/') && /^([^/]+\/)?[^/]+\.app\/Contents\/Info\.plist$/.test(e)) ?? null
}

/** Installer files in Downloads and on the Desktop, by extension. */
export const INSTALLER_EXTS = new Set(['dmg', 'pkg', 'mpkg', 'zip', 'xip'])

/** What an installer package put on this Mac, from macOS's receipt, and how much of it is still there. */
export interface PackageReceipt {
  id: string
  version: string
  installedAt: number
  /** Where it installed (its volume and install location). */
  location: string
  files: number
  remaining: number
  bytes: number
  /** Files in folders the app cannot look into, so whether they remain is not known. */
  unreadable: number
  /** The app it installed, when it installed one. */
  app?: string
}

/** How an installer compares with what is installed. */
export type InstallerVerdict = 'same' | 'older' | 'newer' | 'unread' | 'none'

export const VERDICT_NOTE: Record<InstallerVerdict, string> = {
  same: 'The app it carries is installed, at this version.',
  older: 'Older than the app installed, which is newer.',
  newer: 'Newer than the app installed: someone\'s next install, so it is not ticked.',
  unread: 'Its name matches an installed app, but it could not be opened to check (a password or licence first, or a format the app does not read). Not ticked for you.',
  none: 'No installed app matches it.'
}

/** Folders AI apps keep models in, under the home folder, with how each comes back. */
export const AI_PLACES: { tool: string; path: string; back: string; layout: 'dirs' | 'files' | 'hf' | 'ollama' }[] = [
  { tool: 'Ollama', path: '.ollama/models', back: 'Ollama downloads a model again with ollama pull, or when a chat asks for it.', layout: 'ollama' },
  { tool: 'LM Studio', path: '.lmstudio/models', back: 'LM Studio can download a model again from its Discover tab.', layout: 'dirs' },
  { tool: 'LM Studio', path: '.cache/lm-studio/models', back: 'LM Studio can download a model again from its Discover tab.', layout: 'dirs' },
  { tool: 'Hugging Face', path: '.cache/huggingface/hub', back: 'The library that fetched it downloads it again the next time code asks for it.', layout: 'hf' },
  { tool: 'PyTorch', path: '.cache/torch/hub/checkpoints', back: 'Downloaded again the next time code asks for it.', layout: 'files' },
  { tool: 'Sentence Transformers', path: '.cache/torch/sentence_transformers', back: 'Downloaded again the next time code asks for it.', layout: 'dirs' },
  { tool: 'Whisper', path: '.cache/whisper', back: 'Whisper downloads a model again the first time it is asked for it.', layout: 'files' },
  { tool: 'llama.cpp', path: 'Library/Caches/llama.cpp', back: 'llama.cpp downloads it again when a command asks for it.', layout: 'files' },
  { tool: 'GPT4All', path: 'Library/Application Support/nomic.ai/GPT4All', back: 'GPT4All can download a model again from its Models page.', layout: 'files' },
  { tool: 'Jan', path: 'jan/models', back: 'Jan can download a model again from its Hub.', layout: 'dirs' },
  { tool: 'Jan', path: 'Library/Application Support/Jan/data/models', back: 'Jan can download a model again from its Hub.', layout: 'dirs' },
  { tool: 'DiffusionBee', path: '.diffusionbee/downloads', back: 'DiffusionBee can download a model again from its settings.', layout: 'files' },
  { tool: 'Draw Things', path: 'Library/Containers/com.liuliu.draw-things/Data/Documents/Models', back: 'Draw Things can download a model again from its list of models.', layout: 'files' },
  { tool: 'Docker', path: '.docker/models', back: 'Docker downloads a model again with docker model pull.', layout: 'dirs' }
]

/** Model file extensions, for files the AI room finds in the scan outside the known places. */
export const MODEL_EXTS = ['.gguf', '.safetensors', '.ckpt', '.pt', '.pth', '.onnx', '.mlmodel', '.ggml', '.tflite', '.h5']

/** A Hugging Face hub folder's name, models--org--name → org/name, with its kind. */
export function hfRepo(folder: string): { kind: 'model' | 'dataset' | 'space'; name: string } | null {
  const m = /^(models|datasets|spaces)--(.+)$/.exec(folder)
  if (!m) return null
  return { kind: m[1] === 'models' ? 'model' : m[1] === 'datasets' ? 'dataset' : 'space', name: m[2].replace(/--/g, '/') }
}
