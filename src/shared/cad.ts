/**
 * The CAD tool (components/cad): STEP, IGES and B-rep files read on this Mac with OpenCascade (occt-import-js, in a
 * worker), meshes (STL, glTF) read directly, and design reviews of them kept as records ('reviews', synced through the
 * data folder like Tasks): numbered comments pinned to the model, measurements, issues, a manufacturing checklist and
 * a sign-off, then a report. Reviews belong to a file's content (its SHA-256), so a renamed copy keeps its review and
 * a changed file starts a new one. The checklist and the issue fields come from ReviewBench's review sidebar. Pure,
 * for tests/cad.test.ts.
 */
import { ymd } from './naturalDate.ts'
import type { RecordItem } from './records'

export type CadFormat = 'step' | 'iges' | 'brep' | 'stl' | 'glb' | 'gltf' | 'obj' | '3mf'

const EXTENSIONS: Record<string, CadFormat> = {
  step: 'step', stp: 'step', p21: 'step', iges: 'iges', igs: 'iges', brep: 'brep', brp: 'brep',
  stl: 'stl', glb: 'glb', gltf: 'gltf', obj: 'obj', '3mf': '3mf'
}

/** The formats OpenCascade reads (a B-rep: exact surfaces, tessellated here); the rest are meshes already. */
export const BREP_FORMATS: readonly CadFormat[] = ['step', 'iges', 'brep']

export function cadFormat(path: string): CadFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return ext ? EXTENSIONS[ext] ?? null : null
}

export const isCadFile = (path: string): boolean => cadFormat(path) !== null

/** For the Open dialog's filter. */
export const CAD_EXTENSIONS = Object.keys(EXTENSIONS)

// ----- lengths (the model is in millimetres: occt-import-js converts STEP's own units) -----

export function formatLength(mm: number): string {
  if (!Number.isFinite(mm)) return '—'
  const a = Math.abs(mm)
  const digits = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 3
  return `${mm.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })} mm`
}

/** "120.00 × 45.50 × 30.00 mm": a box's size along X, Y and Z. */
export function formatDims(size: [number, number, number]): string {
  const n = (v: number): string => formatLength(v).replace(/ mm$/, '')
  return `${n(size[0])} × ${n(size[1])} × ${n(size[2])} mm`
}

export const distance = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

// ----- what the reader gives back -----

export interface CadMesh {
  name: string
  /** 0–1 each, from the file; none means the viewer's default. */
  color?: [number, number, number]
  positions: Float32Array
  normals?: Float32Array
  indices: Uint32Array
}

export interface CadNode {
  name: string
  meshes: number[]
  children: CadNode[]
}

export interface CadModel {
  root: CadNode
  meshes: CadMesh[]
}

/** How many parts a model has (nodes with geometry of their own) and the triangles in all. */
export function modelStats(m: CadModel): { parts: number; triangles: number } {
  let parts = 0
  const walk = (n: CadNode): void => { if (n.meshes.length) parts++; n.children.forEach(walk) }
  walk(m.root)
  return { parts, triangles: m.meshes.reduce((t, x) => t + x.indices.length / 3, 0) }
}

/** A node's name for people: "(unnamed)" becomes the file's name at the top, "Part 3" further down. */
export function nodeLabel(name: string, fallback: string): string {
  const n = name.trim()
  return !n || /^(solid|shell|compound|\(node\))$/i.test(n) ? fallback : n
}

// ----- reviews -----

export type CheckStatus = 'pending' | 'pass' | 'fail' | 'na'
export interface CheckItem { id: string; text: string; category: string; status: CheckStatus; note?: string }

/** ReviewBench's manufacturing review, as a starting list for every file. */
export const DEFAULT_CHECKLIST: Omit<CheckItem, 'status'>[] = [
  { id: 'd1', text: 'Critical dimensions match drawing', category: 'Dimensions' },
  { id: 'd2', text: 'Tolerance call-outs reviewed (+/- limits)', category: 'Dimensions' },
  { id: 'm1', text: 'Material spec matches BOM', category: 'Material' },
  { id: 'm2', text: 'Surface finish noted on drawing', category: 'Material' },
  { id: 'f1', text: 'No undercuts on primary pull direction', category: 'DFM' },
  { id: 'f2', text: 'Min wall thickness above process limit', category: 'DFM' },
  { id: 'f3', text: 'Draft angles applied to vertical walls', category: 'DFM' },
  { id: 'a1', text: 'GD&T datums consistent with assembly', category: 'GD&T' },
  { id: 'a2', text: 'Datum reference frame fully constrained', category: 'GD&T' },
  { id: 'q1', text: 'Inspection points called out', category: 'Quality' }
]

export const newChecklist = (): CheckItem[] => DEFAULT_CHECKLIST.map((c) => ({ ...c, status: 'pending' }))

export type ReviewVerdict = 'open' | 'approved' | 'changes'

/** One reviewed file: by its content's SHA-256 (the record id). */
export interface CadFileRecord extends RecordItem {
  type: 'cadfile'
  name: string
  /** Where it was last opened from. */
  path: string
  size: number
  format: CadFormat
  checklist: CheckItem[]
  verdict: ReviewVerdict
  /** When the verdict was given, and a word with it. */
  verdictAt?: number
  verdictNote?: string
  /** A small picture for the list of reviewed files (a JPEG data URL). */
  thumb?: string
  openedAt: number
}

/** Where a comment or an issue points: a spot on the model, or the file as a whole. */
export type CadAnchor = { kind: 'point'; p: [number, number, number]; part?: string } | { kind: 'global' }

/** The camera when something was written, so clicking it shows what the reviewer saw. */
export interface CadView { pos: [number, number, number]; target: [number, number, number]; up: [number, number, number] }

export interface CadNoteRecord extends RecordItem {
  type: 'cadnote'
  fileId: string
  /** Its pin's number on the model (1, 2, 3…), kept when others are deleted. */
  pin: number
  body: string
  anchor: CadAnchor
  view?: CadView
  createdAt: number
  resolvedAt?: number
}

export type IssueSeverity = 'low' | 'med' | 'high' | 'critical'
export type IssueCategory = 'DFM' | 'DFA' | 'Tolerance' | 'Material' | 'GD&T' | 'Cost' | 'Other'
export type IssueStatus = 'open' | 'in_progress' | 'resolved'
export const ISSUE_SEVERITIES: IssueSeverity[] = ['low', 'med', 'high', 'critical']
export const ISSUE_CATEGORIES: IssueCategory[] = ['DFM', 'DFA', 'Tolerance', 'Material', 'GD&T', 'Cost', 'Other']

export interface CadIssueRecord extends RecordItem {
  type: 'cadissue'
  fileId: string
  title: string
  severity: IssueSeverity
  category: IssueCategory
  status: IssueStatus
  /** The comment pin it was raised from, when it was. */
  pin?: number
  createdAt: number
}

export interface CadMeasureRecord extends RecordItem {
  type: 'cadmeasure'
  fileId: string
  a: [number, number, number]
  b: [number, number, number]
  /** Millimetres. */
  length: number
  label?: string
  createdAt: number
}

export interface ReviewSummary {
  checked: number
  total: number
  failed: number
  openIssues: number
  blocking: number
  openComments: number
}

/** Where a review stands: checklist progress, open issues (high and critical block approval), open comments. */
export function reviewSummary(file: Pick<CadFileRecord, 'checklist'> | null, issues: CadIssueRecord[], notes: CadNoteRecord[]): ReviewSummary {
  const list = file?.checklist ?? []
  const open = issues.filter((i) => i.status !== 'resolved')
  return {
    checked: list.filter((c) => c.status !== 'pending').length,
    total: list.length,
    failed: list.filter((c) => c.status === 'fail').length,
    openIssues: open.length,
    blocking: open.filter((i) => i.severity === 'high' || i.severity === 'critical').length,
    openComments: notes.filter((n) => !n.resolvedAt).length
  }
}

/** Why approving now would be premature, in words; '' when nothing stands in the way. */
export function approvalWarning(s: ReviewSummary): string {
  const why: string[] = []
  if (s.blocking) why.push(`${s.blocking} high or critical issue${s.blocking === 1 ? ' is' : 's are'} open`)
  if (s.failed) why.push(`${s.failed} check${s.failed === 1 ? '' : 's'} failed`)
  if (s.total && s.checked < s.total) why.push(`${s.total - s.checked} check${s.total - s.checked === 1 ? ' is' : 's are'} not done`)
  return why.length ? `${why.join(', ')}.` : ''
}

/** The next free pin number for a file: one more than the highest used, so numbers never repeat after a delete. */
export const nextPin = (notes: Pick<CadNoteRecord, 'pin'>[]): number => notes.reduce((m, n) => Math.max(m, n.pin), 0) + 1

const VERDICT_WORDS: Record<ReviewVerdict, string> = { open: 'In review', approved: 'Approved', changes: 'Changes requested' }
export const verdictLabel = (v: ReviewVerdict): string => VERDICT_WORDS[v]

/** This Mac's local time, as the note's name and the rest of the app show it. */
const fmtDate = (t: number): string => { const d = new Date(t); return `${ymd(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const fmtPoint = (p: number[]): string => `(${p.map((v) => v.toFixed(1)).join(', ')}) mm`

/**
 * The review as Markdown, to save as a note or send: the verdict, the checklist, issues, numbered comments (matching
 * the pins in the picture) and measurements. `image` is a file name the note embeds (![[name]]), when there is one.
 */
export function reviewReport(file: CadFileRecord, notes: CadNoteRecord[], issues: CadIssueRecord[], measures: CadMeasureRecord[], extra: { dims?: string; parts?: number; image?: string; now?: number } = {}): string {
  const s = reviewSummary(file, issues, notes)
  const out: string[] = [`# Design review: ${file.name}`, '']
  out.push(`- **Status:** ${verdictLabel(file.verdict)}${file.verdictAt ? ` (${fmtDate(file.verdictAt)})` : ''}${file.verdictNote ? ` — ${file.verdictNote}` : ''}`)
  out.push(`- **File:** \`${file.path}\` (${file.format.toUpperCase()}, ${(file.size / 1024 / 1024).toFixed(2)} MB)`)
  if (extra.dims) out.push(`- **Size:** ${extra.dims}`)
  if (extra.parts !== undefined) out.push(`- **Parts:** ${extra.parts}`)
  out.push(`- **Checklist:** ${s.checked} of ${s.total} done${s.failed ? `, ${s.failed} failed` : ''}`)
  out.push(`- **Issues:** ${issues.length} (${s.openIssues} open)`)
  out.push(`- **Written:** ${fmtDate(extra.now ?? Date.now())}`, '')
  if (extra.image) out.push(`![[${extra.image}]]`, '')
  if (issues.length) {
    out.push('## Issues', '')
    for (const i of [...issues].sort((a, b) => ISSUE_SEVERITIES.indexOf(b.severity) - ISSUE_SEVERITIES.indexOf(a.severity) || a.createdAt - b.createdAt)) {
      out.push(`- [${i.status === 'resolved' ? 'x' : ' '}] **${i.severity.toUpperCase()}** · ${i.category} · ${i.title}${i.pin ? ` (pin ${i.pin})` : ''}${i.status === 'in_progress' ? ' — in progress' : ''}`)
    }
    out.push('')
  }
  if (notes.length) {
    out.push('## Comments', '')
    for (const n of [...notes].sort((a, b) => a.pin - b.pin)) {
      const where = n.anchor.kind === 'point' ? ` at ${fmtPoint(n.anchor.p)}${n.anchor.part ? ` on ${n.anchor.part}` : ''}` : ''
      out.push(`${n.pin}. ${n.body.replace(/\n+/g, ' ')}${where}${n.resolvedAt ? ' — resolved' : ''}`)
    }
    out.push('')
  }
  if (measures.length) {
    out.push('## Measurements', '')
    for (const m of measures) out.push(`- ${m.label ? `${m.label}: ` : ''}${formatLength(m.length)} from ${fmtPoint(m.a)} to ${fmtPoint(m.b)}`)
    out.push('')
  }
  out.push('## Checklist', '')
  let cat = ''
  for (const c of file.checklist) {
    if (c.category !== cat) { cat = c.category; out.push(`**${cat}**`, '') }
    const mark = c.status === 'pass' ? 'x' : ' '
    const word = c.status === 'fail' ? ' — FAIL' : c.status === 'na' ? ' — n/a' : ''
    out.push(`- [${mark}] ${c.text}${word}${c.note ? ` (${c.note})` : ''}`)
  }
  return `${out.join('\n')}\n`
}
