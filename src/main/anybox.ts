/**
 * "Import from Anybox on this Mac" (links:anybox): reads Anybox's own library, so links come over with their folders,
 * tags, stars, comments and keywords without an export file. Anybox keeps a Core Data store in its group container;
 * it is copied (with its write-ahead log) to a temporary folder and read there with Node's built-in SQLite, read-only,
 * so Anybox is never touched while it runs. Files Anybox keeps (PDFs, images) stay there. Table and column names are
 * Anybox 2.x's; a store that does not have them gets a readable error that points to File → Export instead.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnyboxLibrary, ParsedLink } from '@shared/links'

const CANDIDATES = ['group.cc.anybox.Anybox', 'S8MRM84X6F.group.cc.anybox.Anybox'].map((g) => join(homedir(), 'Library', 'Group Containers', g, 'Anybox.sqlite'))
/** Shown when macOS will not let this app read Anybox's library (LinksTab offers the file import with it). */
export const ANYBOX_PRIVATE = 'macOS keeps Anybox\'s library private to Anybox, so this app cannot read it directly. In Anybox, export your links (File → Export, as HTML or JSON) and import that file here.'

/** Core Data counts seconds from 2001-01-01. */
const CORE_DATA_EPOCH = 978_307_200

type Row = Record<string, unknown>
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

export async function readAnybox(): Promise<AnyboxLibrary> {
  const source = CANDIDATES.find(existsSync)
  if (!source) throw new Error('Anybox\'s library was not found on this Mac. In Anybox, use File → Export (JSON or HTML) and import that file instead.')
  const tmp = mkdtempSync(join(tmpdir(), 'ec2ra-anybox-'))
  try {
    try {
      for (const suffix of ['', '-wal', '-shm']) if (existsSync(source + suffix)) copyFileSync(source + suffix, join(tmp, `Anybox.sqlite${suffix}`))
    } catch (e) {
      // macOS keeps an app's group container to that app (and to apps the user lets in, which for this ad-hoc signed
      // app does not survive an update), so the export file is the dependable way.
      if (['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw new Error(ANYBOX_PRIVATE)
      throw e
    }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(tmp, 'Anybox.sqlite'))
    try {
      const all = (sql: string): Row[] => db.prepare(sql).all() as Row[]
      const columns = (table: string): string[] => all(`SELECT name FROM pragma_table_info('${table.replace(/'/g, '')}')`).map((r) => String(r.name))
      const need = ['Z_PK', 'ZKIND', 'ZNAME', 'ZTEXT', 'ZFOLDER', 'ZDATEADDED']
      const docCols = columns('ZDOCUMENT')
      if (!need.every((c) => docCols.includes(c))) throw new Error('This version of Anybox keeps its library in a way this app does not read. In Anybox, use File → Export (JSON or HTML) and import that file instead.')
      const has = (c: string): string => (docCols.includes(c) ? c : 'NULL')

      // Folders and tags nest (a parent column); a tag "Parent/Child" keeps that.
      const tree = (table: string): Map<number, string[]> => {
        const rows = columns(table).includes('ZPARENT') ? all(`SELECT Z_PK, ZNAME, ZPARENT FROM ${table}`) : all(`SELECT Z_PK, ZNAME, NULL AS ZPARENT FROM ${table}`)
        const byPk = new Map(rows.map((r) => [Number(r.Z_PK), r]))
        const paths = new Map<number, string[]>()
        for (const r of rows) {
          const path: string[] = []
          for (let cur: Row | undefined = r, i = 0; cur && i < 30; cur = cur.ZPARENT == null ? undefined : byPk.get(Number(cur.ZPARENT)), i++) path.unshift(text(cur.ZNAME) ?? 'Untitled')
          paths.set(Number(r.Z_PK), path)
        }
        return paths
      }
      const folders = all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ZFOLDER'").length ? tree('ZFOLDER') : new Map<number, string[]>()
      const tags = all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ZTAG'").length ? tree('ZTAG') : new Map<number, string[]>()

      // The document ↔ tag join table is named by Core Data's entity numbers (Z_3TAGS: Z_3DOCUMENTS1, Z_11TAGS).
      const tagsOf = new Map<number, string[]>()
      for (const { name } of all("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'Z_[0-9]*TAGS'")) {
        const cols = columns(String(name))
        const docCol = cols.find((c) => /^Z_\d+DOCUMENTS\d*$/.test(c))
        const tagCol = cols.find((c) => /^Z_\d+TAGS$/.test(c))
        if (!docCol || !tagCol) continue
        for (const r of all(`SELECT ${docCol} AS doc, ${tagCol} AS tag FROM ${String(name)}`)) {
          const path = tags.get(Number(r.tag))
          if (path) tagsOf.set(Number(r.doc), [...(tagsOf.get(Number(r.doc)) ?? []), path.join('/')])
        }
      }

      const rows = all(`SELECT Z_PK, ZKIND, ZNAME, ZTEXT, ZFOLDER, ZDATEADDED, ${has('ZLINKTITLE')} AS ZLINKTITLE, ${has('ZCOMMENT')} AS ZCOMMENT,
        ${has('ZLINKDESCRIPTION')} AS ZLINKDESCRIPTION, ${has('ZKEYWORD')} AS ZKEYWORD, ${has('ZISSTARRED')} AS ZISSTARRED, ${has('ZISARCHIVED')} AS ZISARCHIVED,
        ${has('ZISTRASH')} AS ZISTRASH FROM ZDOCUMENT`)
      const links: ParsedLink[] = []
      let skippedFiles = 0
      for (const r of rows) {
        if (Number(r.ZISTRASH) === 1) continue
        const kind = text(r.ZKIND)
        const common = {
          folder: r.ZFOLDER == null ? undefined : folders.get(Number(r.ZFOLDER)),
          tags: tagsOf.get(Number(r.Z_PK)),
          starred: Number(r.ZISSTARRED) === 1 || undefined,
          archived: Number(r.ZISARCHIVED) === 1 || undefined,
          keyword: text(r.ZKEYWORD),
          note: text(r.ZCOMMENT),
          addedAt: typeof r.ZDATEADDED === 'number' ? Math.round((r.ZDATEADDED + CORE_DATA_EPOCH) * 1000) : undefined
        }
        if (kind === 'Link') {
          const url = text(r.ZTEXT)
          if (!url || !/^[a-z][a-z0-9+.-]*:/i.test(url)) { skippedFiles++; continue }
          // Anybox's name is the title shown (a custom one when renamed); some are only the address.
          const name = text(r.ZNAME)
          const title = name && !/^[a-z][a-z0-9+.-]*:\/\//i.test(name) ? name : text(r.ZLINKTITLE) ?? name ?? url
          links.push({ kind: 'link', url, title, description: text(r.ZLINKDESCRIPTION), ...common })
        } else if (kind === 'Note') {
          const body = text(r.ZTEXT)
          if (!body) continue
          links.push({ kind: 'note', title: text(r.ZNAME) ?? body.split('\n')[0].slice(0, 80), text: body, ...common })
        } else skippedFiles++
      }
      return { links, skippedFiles, source }
    } finally {
      db.close()
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
