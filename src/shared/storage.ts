/**
 * The Storage tool (components/storage, main/storage): a Mac cleaner in the spirit of Strata, as rooms in its own
 * sidebar. This module holds what both sides share: the shapes the scan and the rooms pass around, sizes in Finder's
 * decimal units, file kinds by extension, the places the disk's use is split into, what may never go to the Trash,
 * and what the common hidden folders are. Pure, so tests/storage.test.ts covers it.
 */

/** Files of 1 MB or more are kept by name; smaller ones are counted into their folder. */
export const BIG_FILE = 1_000_000

/** Where a scan starts. 'mac' is the whole startup disk; 'home' the user's folder; 'path' anything else. */
export type ScanRootKind = 'mac' | 'home' | 'path'

export interface ScanProgress {
  /** Folders read so far, files counted so far, and their bytes on disk. */
  dirs: number
  files: number
  bytes: number
  /** The folder being read now, for the progress line. */
  path: string
}

export interface ScanSummary {
  root: string
  kind: ScanRootKind
  /** When the scan finished (ms). */
  at: number
  /** How long it took (ms). */
  took: number
  bytes: number
  files: number
  dirs: number
  /** Folders macOS did not let the scan read, or that did not answer in time. */
  unreadable: number
  /** Whether the app could read the folders macOS keeps behind Full Disk Access. */
  fullDiskAccess: boolean
  /** Bytes by kind of file, for files of 1 MB or more (smaller ones are only in their folder's total). */
  byKind: Partial<Record<FileKind, number>>
  /** The disk's use split into the Overview's parts (a scan of the Mac or the home folder). */
  parts?: { id: DiskPart; bytes: number }[]
  /** Bytes in files under 1 MB, counted with their folders, and how many such files. */
  smallBytes?: number
  smallFiles?: number
  /** Every kind's files, packages included, so the parts add up to the scan. */
  kindCounts?: Partial<Record<FileKind, number>>
}

export interface ScanState {
  status: 'idle' | 'scanning' | 'done' | 'error'
  progress?: ScanProgress
  summary?: ScanSummary
  error?: string
  /** What is being scanned while status is 'scanning'. */
  root?: string
  /** The scan's tree is in memory, so the rooms can look into it (after a restart only its summary is). */
  live?: boolean
}

/** One folder or file of a scan, as the Space Map and the lists show it. */
export interface MapNode {
  id: number
  name: string
  path: string
  /** Bytes on disk, everything beneath it included. */
  size: number
  /** Files beneath it (a file counts itself). */
  files: number
  dir: boolean
  /** An app, library or other package Finder shows as one item. */
  package?: boolean
  /** Has folders or named files beneath it worth opening. */
  more?: boolean
  /** Why its contents were not counted: macOS refused, it lives in the cloud, or it did not answer. */
  closed?: 'unreadable' | 'cloud' | 'protected' | 'timeout' | 'mount'
  /** Last modified (ms), for files. */
  mtime?: number
  kind?: FileKind
}

export interface MapView {
  node: MapNode
  /** The folders above it, top first (root included). */
  chain: { id: number; name: string }[]
  children: MapNode[]
  /** Files under 1 MB directly inside, counted together. */
  small: { bytes: number; files: number }
  /** For the treemap's second level: each child folder's own largest children. */
  inner?: Record<number, { size: number; kind?: FileKind; dir: boolean }[]>
}

export type FileKind = 'video' | 'audio' | 'image' | 'document' | 'archive' | 'diskimage' | 'developer' | 'app' | 'other'

const KIND_EXTS: [FileKind, string][] = [
  ['video', 'mp4 m4v mov avi mkv webm wmv flv mpg mpeg 3gp mts m2ts mxf braw r3d vob ts'],
  ['audio', 'mp3 m4a m4b m4r aac wav aif aiff aifc flac ogg oga opus caf wma mid midi ape dsf'],
  ['image', 'jpg jpeg png gif heic heif tif tiff bmp webp avif jxl raw cr2 cr3 nef arw dng raf orf rw2 srw psd psb ai eps svg ico icns exr hdr afphoto xcf kra procreate'],
  ['document', 'pdf doc docx pages key numbers xls xlsx ppt pptx txt rtf md markdown epub mobi odt ods odp csv tsv tex sketch fig xd indd afdesign afpub'],
  ['archive', 'zip tar gz tgz bz2 tbz xz txz 7z rar zst lz4 lzma cpio xip jar war ear apk ipa aab whl gem deb rpm pkg mpkg crx'],
  ['diskimage', 'dmg iso img sparseimage sparsebundle vmdk vdi vhd vhdx qcow2 hdd toast cdr ipsw'],
  ['developer', 'json xml yml yaml plist sql sqlite sqlite3 db db-wal realm log dylib a o so dll exe wasm jsbundle map lock pack idx pb onnx safetensors gguf ggml pt pth ckpt h5 hdf5 npy npz parquet arrow feather tflite mlmodel swiftmodule pcm']
]
const BY_EXT = new Map<string, FileKind>(KIND_EXTS.flatMap(([k, list]) => list.split(' ').map((e) => [e, k] as [string, FileKind])))

export const KIND_NAMES: Record<FileKind, string> = {
  video: 'Videos', audio: 'Music & Audio', image: 'Images', document: 'Documents', archive: 'Archives',
  diskimage: 'Disk Images', developer: 'Code & Data', app: 'Apps', other: 'Other Files'
}

/** What a package (a folder Finder shows as one item) counts as: Photos' library is pictures, a VM is a disk image. */
export function packageKind(name: string): FileKind {
  const ext = extOf(name)
  if (ext === 'app') return 'app'
  if (/^(photoslibrary|photolibrary|aplibrary|lrdata)$/.test(ext)) return 'image'
  if (/^(imovielibrary|fcpbundle|tvlibrary)$/.test(ext)) return 'video'
  if (/^(musiclibrary|band|logicx)$/.test(ext)) return 'audio'
  if (/^(sparsebundle|vmwarevm|pvm|utm)$/.test(ext)) return 'diskimage'
  if (/^(pages|numbers|key|rtfd)$/.test(ext)) return 'document'
  if (/^(xcarchive|framework|bundle|plugin|kext|appex|docset|mlpackage|xcodeproj|xcworkspace|playground)$/.test(ext)) return 'developer'
  return 'other'
}

/** A folder or file in a nested map: the Space Map's cards, three levels deep, with what did not fit summed up. */
export interface NestNode {
  id: number
  name: string
  path: string
  size: number
  /** Entries directly inside (named ones plus small files counted together). */
  items: number
  dir: boolean
  package?: boolean
  kind?: FileKind
  more?: boolean
  closed?: MapNode['closed']
  children?: NestNode[]
  /** What is not drawn: how many entries and their bytes ("+90 more, 22.4 GB"). */
  rest?: { count: number; size: number }
}

/** One kind of file across a scan, with its largest files and packages. */
export interface KindGroup {
  kind: FileKind | 'small'
  size: number
  count: number
  top: NestNode[]
}

/** A file's extension, lower-cased, without the dot ('' for none, and for names that are only a dot name). */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** What kind of file a name is, by its extension (an .app is an app). */
export function kindOf(name: string, dir = false): FileKind {
  const ext = extOf(name)
  if (ext === 'app') return 'app'
  if (dir) return ext === 'sparsebundle' ? 'diskimage' : 'other'
  return BY_EXT.get(ext) ?? 'other'
}

/** Folders Finder shows as one item: apps, libraries, bundles and documents that are folders inside. */
const PACKAGE_EXTS = new Set('app photoslibrary photolibrary aplibrary lrdata fcpbundle imovielibrary tvlibrary logicx band musiclibrary sparsebundle vmwarevm pvm utm xcarchive framework bundle plugin kext appex docset mlpackage mpkg pkg rtfd pages numbers key xcodeproj xcworkspace playground prefpane saver qlgenerator mdimporter'.split(' '))
export const isPackageName = (name: string): boolean => PACKAGE_EXTS.has(extOf(name))

/**
 * Bytes as Finder writes them: decimal units (1 KB = 1000 bytes), three significant figures at most.
 * `zero` is what to show for nothing at all.
 */
export function bytes(n: number | undefined | null, zero = 'Zero KB'): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n <= 0) return zero
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  let v = n
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++ }
  if (i === 0) return `${Math.round(v)} bytes`
  // Trailing zeros go only after the point: 800 stays 800, 1.50 becomes 1.5.
  const s = v >= 100 ? Math.round(v).toString() : (v >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/\.?0+$/, '')
  return `${s} ${units[i]}`
}

/** "3 files", "1 file": a count and its noun. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** "4 min ago", "3 days ago": how long ago something happened, roughly. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  if (d < 60) return `${d} day${d === 1 ? '' : 's'} ago`
  const mo = Math.round(d / 30)
  if (mo < 24) return `${mo} months ago`
  return `${Math.round(d / 365)} years ago`
}

/** A home-relative path for display: /Users/me/Downloads → ~/Downloads. */
export function tildePath(path: string, home: string): string {
  if (!home) return path
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** The disk as the Overview's bar shows it, from a scan of the whole Mac. */
export type DiskPart = 'apps' | 'documents' | 'downloads' | 'pictures' | 'library' | 'other' | 'trash' | 'system'

export const DISK_PARTS: { id: DiskPart; label: string; hint: string }[] = [
  { id: 'apps', label: 'Apps', hint: 'The Applications folders.' },
  { id: 'documents', label: 'Documents', hint: 'Your home folder, apart from Downloads, Pictures, its Library and the hidden folders in it.' },
  { id: 'downloads', label: 'Downloads', hint: 'Your Downloads folder.' },
  { id: 'pictures', label: 'Pictures', hint: 'Your Pictures folder, with the Photos library in it.' },
  { id: 'library', label: 'Library', hint: 'What apps keep for themselves: caches, containers and support files, yours and the shared ones.' },
  { id: 'other', label: 'Other', hint: 'Everything else the scan counted: hidden folders in your home folder, other accounts, and tools in /opt or /usr/local.' },
  { id: 'trash', label: 'Trash', hint: 'What waits in the Trash, still taking space until it is emptied in Finder.' },
  { id: 'system', label: 'macOS', hint: 'macOS itself, its swap and its own files, and space the disk reports as used that no folder accounts for.' }
]

/** The paths each part of the bar adds up (the Data volume's folders as '/' shows them). */
export function diskPartPaths(home: string): Record<Exclude<DiskPart, 'documents' | 'other' | 'system'>, string[]> & { documentsExcept: string[] } {
  return {
    apps: ['/Applications', `${home}/Applications`],
    downloads: [`${home}/Downloads`],
    pictures: [`${home}/Pictures`],
    library: [`${home}/Library`, '/Library'],
    trash: [`${home}/.Trash`],
    // Home minus these is Documents; its hidden folders go to Other.
    documentsExcept: [`${home}/Downloads`, `${home}/Pictures`, `${home}/Library`, `${home}/.Trash`, `${home}/Applications`]
  }
}

/** Why something cannot go to the Trash from here, or null when it can. Checked in main before anything moves. */
export function protectedReason(path: string, home: string): string | null {
  const p = path.replace(/\/+$/, '') || '/'
  if (!p.startsWith('/') || p.includes('/../') || p.endsWith('/..')) return 'Not a full path.'
  if (p === '/' || p === home || p === '/Users' || p === '/Applications' || p === '/Library' || p === '/System' || p === '/Volumes') return 'A standard folder. Its contents can be removed, but the folder itself stays.'
  if (p.startsWith('/System/') || (p.startsWith('/usr/') && !p.startsWith('/usr/local/')) || p.startsWith('/bin/') || p.startsWith('/sbin/') || p.startsWith('/private/var/db/') || p === '/private') return 'Part of macOS. Removing it would break the system.'
  if (p.startsWith(`${home}/.Trash/`) || p === `${home}/.Trash` || /^\/Volumes\/[^/]+\/\.Trashes(\/|$)/.test(p) || p.startsWith('/.Trashes')) return 'Already in the Trash. Empty the Trash in Finder to remove it for good.'
  if (p.startsWith(`${home}/Library/Keychains`)) return 'Your keychain. Deleting it would lock you out of saved passwords.'
  if (p.startsWith(`${home}/Library/Mobile Documents`) || p.startsWith(`${home}/Library/CloudStorage`)) return 'Stored in the cloud. Deleting it here would remove it from every device.'
  const standard = ['Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures', 'Public', 'Applications', 'Library/Caches', 'Library/Application Support', 'Library/Preferences', 'Library/Containers', 'Library/Group Containers', 'Library/Logs', 'Library/Developer']
  if (standard.some((s) => p === `${home}/${s}`)) return 'A standard folder. Its contents can be removed, but the folder itself stays.'
  if (p.startsWith(`${home}/.ssh`) || p.startsWith(`${home}/.gnupg`) || p.startsWith(`${home}/.aws`)) return 'Keys and credentials. A lost private key cannot be recovered.'
  return null
}

/** Something moved to the Trash from the Storage tool, kept 90 days so it can be put back. */
export interface RemovedItem {
  id: string
  /** Where it was, and where it went in the Trash. */
  path: string
  trashPath: string
  size: number
  at: number
  /** Which room moved it ("Large Files"). */
  from: string
  dir: boolean
}

export interface RemovedEntry extends RemovedItem {
  /** Whether it can go back now: still in the Trash, and nothing else at its old place. */
  state: 'in-trash' | 'gone' | 'restored' | 'occupied' | 'no-folder'
}

export interface DuplicateGroup {
  /** Each copy's length in bytes. */
  length: number
  /** The copies, the one to keep first (the oldest). */
  files: MapNode[]
}

export interface TrashOutcome {
  /** What went, with the Recently Removed id that puts it back. */
  moved: { id: string; path: string; trashPath: string; size: number }[]
  /** What stayed, and why ("Only an administrator can move this"). */
  failed: { path: string; reason: string; admin?: boolean }[]
  bytes: number
}

/** The disk's capacity and use, from the startup volume. */
export interface DiskInfo {
  name: string
  total: number
  /** Free as Finder counts it: space macOS can clear by itself (purgeable) included. */
  free: number
  /** Free right now, without what macOS would clear. */
  freeNow: number
  /** One reading a day, for the trend. */
  history: { day: string; used: number; total: number }[]
}

/** What an often-seen hidden folder or file is, and whether it can go. */
export interface HiddenInfo {
  what: string
  /** 'cache': disposable, ticked; 'rebuilt': made again by a tool, not ticked; 'tool': an install; 'yours': never. */
  level: 'cache' | 'rebuilt' | 'tool' | 'yours'
}

/** Hidden names Strata explains, in plain words. Matched on the item's own name. */
const HIDDEN: Record<string, HiddenInfo> = {
  '.cache': { what: 'A shared cache many command line tools use. Each fills its part again when it next needs it, though big downloads such as AI models take a while to come back.', level: 'cache' },
  '.npm': { what: "npm's download cache and logs. npm downloads packages again when a project needs them.", level: 'cache' },
  '.yarn': { what: "Yarn's cache and settings. Packages download again on the next install.", level: 'rebuilt' },
  '.pnpm-store': { what: "pnpm's package store. Projects link their packages from it; the next install fills it again.", level: 'rebuilt' },
  '.gradle': { what: "Gradle's folder: caches and Gradle versions it fetches again, plus settings you may have added (gradle.properties).", level: 'rebuilt' },
  '.m2': { what: "Maven's folder: the libraries your builds downloaded, plus settings.xml, which often holds repository passwords.", level: 'rebuilt' },
  '.cargo': { what: "Rust's Cargo folder. registry and git are caches, but bin holds installed commands and, with rustup, Rust itself.", level: 'tool' },
  '.rustup': { what: 'Rust toolchains installed by rustup. Removing it uninstalls Rust; rustup toolchain uninstall removes old versions cleanly.', level: 'tool' },
  '.nvm': { what: 'Node.js versions installed with nvm, each with its global packages. nvm uninstall removes one version cleanly.', level: 'tool' },
  '.pyenv': { what: 'Python versions installed with pyenv. pyenv uninstall removes one version cleanly.', level: 'tool' },
  '.rbenv': { what: 'Ruby versions installed with rbenv, with their gems.', level: 'tool' },
  '.sdkman': { what: 'Java kits and build tools installed with SDKMAN. sdk uninstall removes one version cleanly.', level: 'tool' },
  '.conda': { what: "conda's per-user folder: environments it knows about, sometimes environments and packages of its own.", level: 'tool' },
  '.local': { what: 'Commands and data tools installed for you alone (pipx and uv put theirs here). Not a cache: removing it uninstalls them.', level: 'tool' },
  '.android': { what: "The Android tools' folder: your emulators and the key that signs debug builds. Delete emulators in Android Studio.", level: 'yours' },
  '.docker': { what: 'Settings for the docker command: registry sign-ins, contexts and plugins. Images live in Docker Desktop\'s own disk.', level: 'tool' },
  '.kube': { what: 'Settings for kubectl: your clusters and the credentials for them.', level: 'yours' },
  '.ssh': { what: 'Your SSH keys and the servers you have connected to. A lost private key cannot be recovered.', level: 'yours' },
  '.gnupg': { what: 'Your GPG keys and trust settings. A lost private key cannot be recovered.', level: 'yours' },
  '.aws': { what: 'Settings and keys for the AWS command line tools and this app. A lost secret key cannot be downloaded again.', level: 'yours' },
  '.config': { what: 'Settings for many command line tools, each in its own folder. Judge each one inside on its own.', level: 'yours' },
  '.vscode': { what: "Visual Studio Code's extensions (in your home folder), or a project's editor settings.", level: 'tool' },
  '.cursor': { what: "Cursor's extensions and settings.", level: 'tool' },
  '.git': { what: "A Git repository: the project's whole history. Anything never pushed elsewhere is lost without it.", level: 'yours' },
  '.idea': { what: "A JetBrains IDE's settings for this project.", level: 'yours' },
  '.next': { what: 'Next.js build output and cache. The next build or dev server makes it again.', level: 'cache' },
  '.nuxt': { what: 'Nuxt build output. Nuxt makes it again.', level: 'cache' },
  '.build': { what: 'Build output, usually from Swift Package Manager. The next build makes it again.', level: 'cache' },
  '.turbo': { what: "Turborepo's cache. Turborepo makes it again.", level: 'cache' },
  '.parcel-cache': { what: "Parcel's cache. Parcel makes it again.", level: 'cache' },
  '.angular': { what: "Angular's build cache. Angular makes it again.", level: 'cache' },
  '.svelte-kit': { what: 'SvelteKit build output. SvelteKit makes it again.', level: 'cache' },
  '.venv': { what: "A Python virtual environment: the project's own Python and packages, which can be installed again from its requirements.", level: 'rebuilt' },
  '.pub-cache': { what: "Dart and Flutter's package cache. Packages download again on the next pub get.", level: 'cache' },
  '.cocoapods': { what: "CocoaPods' copies of the spec repositories. The next pod install downloads what it needs.", level: 'cache' },
  '.nuget': { what: "NuGet's folder for .NET: a package cache the next restore fills again.", level: 'cache' },
  '.gem': { what: "RubyGems' per-user folder: gems installed with --user-install and a cache of listings.", level: 'tool' },
  '.oh-my-zsh': { what: 'The Oh My Zsh framework your shell settings load. Removing it breaks that part of your setup.', level: 'tool' },
  '.ollama': { what: 'Ollama\'s models. Remove them with ollama rm (the AI Models room shows each).', level: 'yours' },
  '.lmstudio': { what: "LM Studio's models and settings.", level: 'yours' },
  '.Trash': { what: 'Your Trash. Things wait here until you empty it in Finder.', level: 'yours' },
  '.Trashes': { what: "This drive's Trash. Files deleted from it wait here until the Trash is emptied while the drive is connected.", level: 'yours' },
  '.Spotlight-V100': { what: "Spotlight's index for this drive. macOS rebuilds it, but that takes hours.", level: 'yours' },
  '.fseventsd': { what: 'A log of changes Time Machine and Spotlight read. Leave it alone.', level: 'yours' },
  '.DocumentRevisions-V100': { what: 'Earlier versions of documents (File > Revert To). macOS manages it.', level: 'yours' },
  '.TemporaryItems': { what: 'Temporary files apps keep while they work. macOS manages it.', level: 'yours' },
  '.zsh_history': { what: 'Your shell\'s record of the commands you have typed.', level: 'yours' },
  '.bash_history': { what: 'Your shell\'s record of the commands you have typed.', level: 'yours' },
  '.zshrc': { what: 'Settings for your shell. Nothing recreates it.', level: 'yours' },
  '.DS_Store': { what: "Finder's view settings for this folder. Finder writes it again.", level: 'rebuilt' }
}

/** What a hidden item is, by its name (or its parent's, for a ._ file), or null when not known. */
export function hiddenInfo(name: string): HiddenInfo | null {
  if (HIDDEN[name]) return HIDDEN[name]
  if (name.startsWith('._')) return { what: 'Finder information (tags, a custom icon) for the file of the same name without ._, kept beside it on drives that cannot store it. dot_clean merges these back.', level: 'rebuilt' }
  if (/^\.zcompdump/.test(name)) return { what: "zsh's completion cache. The shell makes it again.", level: 'cache' }
  return null
}

/** Compares dotted version strings numerically: 1.10 > 1.9. Returns <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-_ ]/).map((x) => parseInt(x, 10))
  const pb = b.split(/[.\-_ ]/).map((x) => parseInt(x, 10))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0
    const y = Number.isFinite(pb[i]) ? pb[i] : 0
    if (x !== y) return x - y
  }
  return 0
}

/** This Mac in words, for the Overview's footer. */
export interface MacInfo { os: string; model: string; chip: string; memory: number; disk: string }

/** Something the disk picker can scan: the startup disk, the home folder, another drive. */
export interface DiskTarget { kind: ScanRootKind; label: string; path?: string; total?: number; free?: number }

export interface FolderChange { path: string; before: number; after: number; delta: number; kind: 'grew' | 'shrank' | 'new' | 'gone' }
export interface ScanChanges { scans: { at: number; bytes: number }[]; base?: number; changes: FolderChange[] }

/**
 * What changed between two scans' folder sizes by `min` bytes or more. A folder whose change one folder inside it
 * already explains (four fifths or more, the same way) is left out, so the list names where things happened, not every
 * folder above them.
 */
export function diffSnapshots(before: [string, number][], after: [string, number][], min: number): FolderChange[] {
  const a = new Map(before)
  const b = new Map(after)
  const all: FolderChange[] = []
  for (const [p, size] of b) {
    const old = a.get(p)
    if (old === undefined) { if (size >= min) all.push({ path: p, before: 0, after: size, delta: size, kind: 'new' }); continue }
    const d = size - old
    if (Math.abs(d) >= min) all.push({ path: p, before: old, after: size, delta: d, kind: d > 0 ? 'grew' : 'shrank' })
  }
  for (const [p, old] of a) if (!b.has(p) && old >= min) all.push({ path: p, before: old, after: 0, delta: -old, kind: 'gone' })
  const explained = (c: FolderChange): boolean => all.some((x) => x !== c && x.path.startsWith(`${c.path === '/' ? '' : c.path}/`) && Math.sign(x.delta) === Math.sign(c.delta) && Math.abs(x.delta) >= Math.abs(c.delta) * 0.8)
  // A new or vanished folder inside another new or vanished one is part of it.
  const inside = (c: FolderChange): boolean => (c.kind === 'new' || c.kind === 'gone') && all.some((x) => x !== c && x.kind === c.kind && c.path.startsWith(`${x.path}/`))
  return all.filter((c) => !explained(c) && !inside(c)).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, 200)
}

/** Settings → Privacy & Security → Full Disk Access. */
export const FULL_DISK_ACCESS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
