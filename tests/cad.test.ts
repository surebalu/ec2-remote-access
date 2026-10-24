import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  approvalWarning, cadFormat, formatDims, formatLength, modelStats, newChecklist, nextPin, nodeLabel, reviewReport, reviewSummary,
  type CadFileRecord, type CadIssueRecord, type CadMeasureRecord, type CadNoteRecord
} from '../src/shared/cad.ts'

test('which files the CAD tool opens', () => {
  assert.equal(cadFormat('/x/Bracket.STEP'), 'step')
  assert.equal(cadFormat('/x/part.stp'), 'step')
  assert.equal(cadFormat('/x/cover.igs'), 'iges')
  assert.equal(cadFormat('/x/print.stl'), 'stl')
  assert.equal(cadFormat('/x/model.glb'), 'glb')
  assert.equal(cadFormat('/x/readme.txt'), null)
  assert.equal(cadFormat('/x/noext'), null)
})

test('lengths in millimetres', () => {
  assert.equal(formatLength(12.3456), '12.35 mm')
  assert.equal(formatLength(0.1234), '0.123 mm')
  assert.equal(formatLength(1234.5), '1,235 mm')
  assert.equal(formatDims([120, 45.5, 30]), '120.0 × 45.50 × 30.00 mm')
})

test('parts, triangles and names', () => {
  const tri = { name: 'SOLID', positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) }
  const stats = modelStats({ root: { name: '', meshes: [], children: [{ name: 'PLATE', meshes: [0], children: [] }, { name: 'ROD', meshes: [1, 2], children: [] }] }, meshes: [tri, tri, tri] })
  assert.deepEqual(stats, { parts: 2, triangles: 3 })
  assert.equal(nodeLabel('SOLID', 'Part 3'), 'Part 3')
  assert.equal(nodeLabel('  ', 'bracket.step'), 'bracket.step')
  assert.equal(nodeLabel('L_BRACKET', 'x'), 'L_BRACKET')
})

const file: CadFileRecord = { id: 'a'.repeat(64), type: 'cadfile', updatedAt: 1, name: 'bracket.step', path: '/Users/me/bracket.step', size: 2 * 1024 * 1024, format: 'step', checklist: newChecklist(), verdict: 'open', openedAt: 1 }
const note = (pin: number, body: string, resolved = false): CadNoteRecord => ({ id: `n${pin}`, type: 'cadnote', updatedAt: 1, fileId: file.id, pin, body, anchor: { kind: 'point', p: [1, 2, 3], part: 'PLATE' }, createdAt: pin, ...(resolved ? { resolvedAt: 5 } : {}) })
const issue = (id: string, severity: CadIssueRecord['severity'], status: CadIssueRecord['status'] = 'open'): CadIssueRecord => ({ id, type: 'cadissue', updatedAt: 1, fileId: file.id, title: `Issue ${id}`, severity, category: 'DFM', status, createdAt: 1 })

test('where a review stands, and what stops approval', () => {
  const list = newChecklist().map((c, i) => ({ ...c, status: i < 8 ? 'pass' as const : i === 8 ? 'fail' as const : 'pending' as const }))
  const s = reviewSummary({ checklist: list }, [issue('i1', 'high'), issue('i2', 'low'), issue('i3', 'critical', 'resolved')], [note(1, 'a'), note(2, 'b', true)])
  assert.deepEqual(s, { checked: 9, total: 10, failed: 1, openIssues: 2, blocking: 1, openComments: 1 })
  assert.equal(approvalWarning(s), '1 high or critical issue is open, 1 check failed, 1 check is not done.')
  assert.equal(approvalWarning(reviewSummary({ checklist: newChecklist().map((c) => ({ ...c, status: 'na' as const })) }, [issue('i', 'low')], [])), '')
  assert.equal(nextPin([{ pin: 1 }, { pin: 4 }]), 5)
  assert.equal(nextPin([]), 1)
})

test('the report: verdict, issues by severity, numbered comments, measurements, checklist', () => {
  const measures: CadMeasureRecord[] = [{ id: 'm1', type: 'cadmeasure', updatedAt: 1, fileId: file.id, a: [0, 0, 0], b: [10, 0, 0], length: 10, label: 'Bore spacing', createdAt: 1 }]
  const md = reviewReport({ ...file, verdict: 'changes', verdictNote: 'Fix the wall' }, [note(2, 'Check fillet'), note(1, 'Wall too thin')], [issue('i2', 'low'), issue('i1', 'critical')], measures, { dims: '120 × 45 × 30 mm', parts: 4, image: 'bracket review.png', now: Date.UTC(2026, 9, 23, 12, 0) })
  assert.match(md, /^# Design review: bracket\.step/)
  assert.match(md, /\*\*Status:\*\* Changes requested — Fix the wall/)
  assert.match(md, /!\[\[bracket review\.png\]\]/)
  assert.ok(md.indexOf('CRITICAL') < md.indexOf('LOW'), 'the worst issues first')
  assert.ok(md.indexOf('1. Wall too thin') < md.indexOf('2. Check fillet'), 'comments by pin')
  assert.match(md, /Bore spacing: 10\.00 mm/)
  assert.match(md, /\*\*Dimensions\*\*\n\n- \[ \] Critical dimensions match drawing/)
})
