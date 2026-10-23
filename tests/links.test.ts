import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  asUrl, domainOf, exportLinksCsv, exportLinksHtml, exportLinksJson, folderTree, hasTag, normalizeUrl, parseCsv, parseLinksFile, planImport, searchLinks,
  tagTree, viewLinks, type LinkFolder, type LinkItem
} from '../src/shared/links.ts'

let n = 0
const id = (): string => `id${++n}`
const link = (o: Partial<LinkItem>): LinkItem => ({ id: id(), type: 'link', kind: 'link', title: 'x', addedAt: n, updatedAt: n, ...o })
const folder = (o: Partial<LinkFolder>): LinkFolder => ({ id: id(), type: 'folder', name: 'f', order: n, updatedAt: n, ...o })

test('addresses: the same link spelled differently, domains, typed addresses', () => {
  assert.equal(normalizeUrl('HTTPS://WWW.Example.com/Docs/?utm_source=x&q=1#top'), 'https://example.com/Docs?q=1#top')
  assert.equal(normalizeUrl('https://example.com/'), normalizeUrl('https://example.com'))
  assert.equal(domainOf('https://www.github.com/a'), 'github.com')
  assert.equal(asUrl('github.com/anthropics'), 'https://github.com/anthropics')
  assert.equal(asUrl('obsidian://open?vault=x'), 'obsidian://open?vault=x')
  assert.equal(asUrl('not a link'), null)
})

test('views, folders below folders, and search', () => {
  const work = folder({ name: 'Work' })
  const docs = folder({ name: 'Docs', parentId: work.id })
  const home = folder({ name: 'Home' })
  const a = link({ title: 'AWS console', url: 'https://console.aws.amazon.com', folderId: docs.id, tags: ['aws'], keyword: 'aws' })
  const b = link({ title: 'Grafana', url: 'https://grafana.example.com', folderId: work.id, starred: true, note: 'prod dashboards' })
  const c = link({ title: 'Old thing', url: 'https://old.example.com', archived: true })
  const d = link({ title: 'Wifi password', kind: 'note', text: 'guest network' })
  const e = link({ title: 'Recipes', url: 'https://food.example.com', folderId: home.id, tags: ['aws-not'] })
  const all = [a, b, c, d, e]
  const folders = [work, docs, home]
  const t = (v: Parameters<typeof viewLinks>[0]): string[] => viewLinks(v, all, folders).map((l) => l.title)
  assert.deepEqual(t('all'), ['AWS console', 'Grafana', 'Wifi password', 'Recipes'])
  assert.deepEqual(t(`folder:${work.id}`), ['AWS console', 'Grafana'], 'a folder shows what is in its folders too')
  assert.deepEqual([t('starred'), t('archived'), t('notes'), t('unsorted'), t('tag:aws')], [['Grafana'], ['Old thing'], ['Wifi password'], ['Wifi password'], ['AWS console']])
  assert.deepEqual(folderTree(folders).map((x) => `${'-'.repeat(x.depth)}${x.folder.name}`), ['Work', '-Docs', 'Home'])
  const byId = new Map(folders.map((f) => [f.id, f]))
  assert.deepEqual(searchLinks(all, 'prod', byId).map((l) => l.title), ['Grafana'], 'the comment is searched')
  assert.deepEqual(searchLinks(all, 'docs aws', byId).map((l) => l.title), ['AWS console'], 'and the folder path')
  assert.deepEqual(searchLinks(all, 'guest', byId).map((l) => l.title), ['Wifi password'])
  assert.equal(searchLinks(all, 'aws', byId)[0].title, 'AWS console', 'the exact keyword first')
})

const NETSCAPE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000">Work &amp; Ops</H3>
    <DL><p>
        <DT><A HREF="https://grafana.example.com/d/x" ADD_DATE="1700000100" TAGS="monitoring,prod">Grafana &mdash; prod</A>
        <DD>Main dashboards
        <DT><H3>Docs</H3>
        <DL><p>
            <DT><A HREF="https://docs.aws.amazon.com/">AWS docs</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="https://news.ycombinator.com/" ADD_DATE="1700000200">HN</A>
    <DT><A HREF="javascript:alert(1)">bookmarklet</A>
</DL><p>`

test('reading a browser or Anybox HTML bookmarks file', () => {
  const { links, format } = parseLinksFile(NETSCAPE, 'bookmarks.html')
  assert.equal(format, 'HTML bookmarks')
  assert.deepEqual(links.map((l) => [l.title, l.folder ?? [], l.tags ?? [], l.description, l.addedAt]), [
    ['Grafana — prod', ['Work & Ops'], ['monitoring', 'prod'], 'Main dashboards', 1700000100000],
    ['AWS docs', ['Work & Ops', 'Docs'], [], undefined, undefined],
    ['HN', [], [], undefined, 1700000200000]
  ])
})

test('reading JSON exports: Anybox-like, Pinboard, GoodLinks, and notes', () => {
  const anybox = parseLinksFile(JSON.stringify({ documents: [
    { title: 'Grafana', url: 'https://grafana.example.com', comment: 'prod', tags: [{ name: 'ops' }], folder: { name: 'Work' }, isStarred: true, dateAdded: '2026-01-02T03:04:05Z', keyword: 'graf' },
    { name: 'Wifi', text: 'guest password', tags: 'home, network' },
    { title: 'nothing here' }
  ] })).links
  assert.deepEqual(anybox.map((l) => [l.kind, l.title, l.note, l.tags, l.folder, l.starred, l.keyword, l.addedAt]), [
    ['link', 'Grafana', 'prod', ['ops'], ['Work'], true, 'graf', Date.parse('2026-01-02T03:04:05Z')],
    ['note', 'Wifi', undefined, ['home', 'network'], undefined, undefined, undefined, undefined]
  ])
  const pinboard = parseLinksFile(JSON.stringify([{ href: 'https://a.example', description: 'Title A', extended: 'my notes', tags: 'one two', time: '2020-05-05T00:00:00Z', shared: 'no' }])).links
  assert.deepEqual([pinboard[0].title, pinboard[0].note, pinboard[0].tags], ['Title A', 'my notes', ['one', 'two']])
  const goodlinks = parseLinksFile(JSON.stringify([{ url: 'https://b.example', title: 'B', summary: 'about b', starred: true, addedAt: 1700000000 }])).links
  assert.deepEqual([goodlinks[0].description, goodlinks[0].starred, goodlinks[0].addedAt], ['about b', true, 1700000000000])
  assert.throws(() => parseLinksFile('{"nope": 1}'), /No list of links/)
})

test('reading CSV: Pocket, Raindrop, quoted fields', () => {
  assert.deepEqual(parseCsv('a,"b, ""c""",d\r\n"multi\nline",e,\n'), [['a', 'b, "c"', 'd'], ['multi\nline', 'e', '']])
  const pocket = parseLinksFile('title,url,time_added,tags,status\nRead later,https://c.example,1700000000,ai|ml,unread\n').links
  assert.deepEqual([pocket[0].title, pocket[0].tags, pocket[0].addedAt], ['Read later', ['ai', 'ml'], 1700000000000])
  const raindrop = parseLinksFile('id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite\n1,R,my note,the excerpt,https://d.example,Work/Ops,"x, y",2026-01-01T00:00:00Z,,,true\n').links
  assert.deepEqual([raindrop[0].note, raindrop[0].description, raindrop[0].folder, raindrop[0].tags, raindrop[0].starred], ['my note', 'the excerpt', ['Work', 'Ops'], ['x', 'y'], true])
  assert.throws(() => parseLinksFile('name,age\nbob,3\n'), /no URL column/)
})

test('planning an import: folders reused, duplicates merged or skipped', () => {
  const work = folder({ name: 'Work & Ops' })
  const have = link({ url: 'https://grafana.example.com/d/x/', title: 'Mine', tags: ['prod'], note: 'keep me' })
  const plan = planImport({ links: [have], folders: [work] }, parseLinksFile(NETSCAPE).links, id, 5)
  assert.deepEqual([plan.added, plan.merged, plan.skipped, plan.folders], [2, 1, 0, 1], 'Docs is new; Grafana gains a tag')
  const merged = plan.ops.find((o) => o.op === 'put' && o.item.id === have.id)
  assert.ok(merged && merged.op === 'put')
  assert.deepEqual([(merged.item as LinkItem).tags, (merged.item as LinkItem).note, (merged.item as LinkItem).title], [['prod', 'monitoring'], 'keep me', 'Mine'])
  const docs = plan.ops.map((o) => (o.op === 'put' ? o.item : null)).find((i) => i?.type === 'folder') as LinkFolder
  assert.deepEqual([docs.name, docs.parentId], ['Docs', work.id])
  const again = planImport({ links: [have, ...plan.ops.flatMap((o) => (o.op === 'put' && o.item.type === 'link' ? [o.item as LinkItem] : []))], folders: [work, docs] }, parseLinksFile(NETSCAPE).links, id, 6)
  assert.deepEqual([again.added, again.merged, again.skipped, again.folders], [0, 0, 3, 0], 'importing twice adds nothing')
})

test('nested tags: a tree, and a parent shows what is below it', () => {
  assert.deepEqual(tagTree(['ops', 'aws/iam', 'aws', 'AWS/ec2/spot', 'reading']).map((t) => `${'-'.repeat(t.depth)}${t.name}${t.hasChildren ? '>' : ''}`),
    ['aws>', '-iam', 'AWS>', '-ec2>', '--spot', 'ops', 'reading'])
  assert.deepEqual(tagTree(['work/docs']).map((t) => [t.path, t.parent ?? null, t.hasChildren]), [['work', null, true], ['work/docs', 'work', false]], 'a prefix-only parent is a node')
  assert.equal(hasTag({ tags: ['aws/iam'] }, 'aws'), true)
  assert.equal(hasTag({ tags: ['awsome'] }, 'aws'), false)
  assert.deepEqual(viewLinks('tag:aws', [link({ title: 'a', tags: ['aws/iam'] }), link({ title: 'b', tags: ['aws'] }), link({ title: 'c', tags: ['awsx'] })], []).map((l) => l.title), ['a', 'b'])
})

test('the same address twice in one file is one link, with both copies\' tags', () => {
  const plan = planImport({ links: [], folders: [] }, [
    { kind: 'link', url: 'https://www.example.com/', title: 'A', tags: ['one'] },
    { kind: 'link', url: 'https://example.com', title: 'A again', tags: ['two'], starred: true }
  ], id, 1)
  assert.deepEqual([plan.added, plan.merged, plan.skipped, plan.ops.length], [1, 0, 1, 1])
  const item = plan.ops[0].op === 'put' ? (plan.ops[0].item as LinkItem) : null
  assert.deepEqual([item?.title, item?.tags, item?.starred], ['A', ['one', 'two'], true])
})

test('exports read back: JSON exactly, HTML and CSV with folders and tags', () => {
  const work = folder({ name: 'Work' })
  const docs = folder({ name: 'Docs', parentId: work.id })
  const links = [
    link({ title: 'A "quoted", title', url: 'https://a.example/?x=1&y=2', folderId: docs.id, tags: ['t1', 't2'], description: 'desc', note: 'note', starred: true, keyword: 'kw', addedAt: 1700000000000 }),
    link({ title: 'Loose', url: 'https://b.example', addedAt: 1700000001000 }),
    link({ title: 'A note', kind: 'note', text: 'line 1\nline 2', folderId: work.id, addedAt: 1700000002000 })
  ]
  const json = parseLinksFile(exportLinksJson(links, [work, docs])).links
  assert.deepEqual(json.map((l) => [l.kind, l.title, l.folder, l.tags, l.starred, l.keyword, l.text, l.addedAt]), [
    ['link', 'A "quoted", title', ['Work', 'Docs'], ['t1', 't2'], true, 'kw', undefined, 1700000000000],
    ['link', 'Loose', undefined, undefined, undefined, undefined, undefined, 1700000001000],
    ['note', 'A note', ['Work'], undefined, undefined, undefined, 'line 1\nline 2', 1700000002000]
  ])
  const html = parseLinksFile(exportLinksHtml(links, [work, docs])).links
  assert.deepEqual(html.map((l) => [l.title, l.url, l.folder ?? [], l.tags ?? [], l.addedAt]), [
    ['A "quoted", title', 'https://a.example/?x=1&y=2', ['Work', 'Docs'], ['t1', 't2'], 1700000000000],
    ['Loose', 'https://b.example', [], [], 1700000001000]
  ], 'notes have no place in a bookmarks file')
  const csv = parseLinksFile(exportLinksCsv(links, [work, docs])).links
  assert.deepEqual(csv.map((l) => [l.kind, l.title, l.folder, l.tags, l.text]), [
    ['link', 'A "quoted", title', ['Work', 'Docs'], ['t1', 't2'], undefined],
    ['link', 'Loose', undefined, undefined, undefined],
    ['note', 'A note', ['Work'], undefined, 'line 1\nline 2']
  ])
})
