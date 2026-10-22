import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureHostFilters, sameHostFilters, upsertHostView, type HostView } from '../src/shared/hostViews.ts'

const filters = { search: '  web prod  ', profileFilter: 'production', favoritesOnly: false, osFilter: 'linux', stateFilter: 'running', reachFilter: 'reachable' } as const

test('views capture only host filters, preserve full account identity, and do not retain credentials', () => {
  const state = { ...filters, password: 'not-for-storage', tabs: [{ id: 'session' }], selectedKey: 'host' }
  const saved = captureHostFilters(state)
  assert.deepEqual(saved, { ...filters, search: 'web prod' })
  assert.equal(sameHostFilters(saved, state), true)
  assert.equal(sameHostFilters(saved, { ...saved, profileFilter: 'production-readonly' }), false)
  assert.equal(sameHostFilters(saved, { ...saved, reachFilter: 'all' }), false)
  state.search = 'changed' as typeof state.search
  assert.equal(saved.search, 'web prod')
})

test('saved views round trip, rename without changing filters, and reject ambiguous names', () => {
  const first: HostView = { id: 'one', name: '  Production Linux  ', filters }
  const views = upsertHostView([], first)
  const second = upsertHostView(views, { ...first, id: 'two', name: 'Favorites', filters: { ...filters, favoritesOnly: true } })
  const renamed = upsertHostView(second, { ...second[0], name: 'Production web' })
  assert.deepEqual(JSON.parse(JSON.stringify(renamed)), renamed)
  assert.equal(renamed.length, 2)
  assert.equal(renamed[0].name, 'Production web')
  assert.deepEqual(renamed[0].filters, captureHostFilters(filters))
  assert.equal(views[0].name, 'Production Linux', 'the prior settings object remains unchanged')
  assert.throws(() => upsertHostView(renamed, { ...first, name: ' favorites ' }), /already exists/)
  assert.throws(() => upsertHostView([], { ...first, name: '  ' }), /name/)
  assert.throws(() => upsertHostView([], { ...first, name: 'a'.repeat(61) }), /60/)
})
