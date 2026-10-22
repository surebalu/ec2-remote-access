/** Only filters belong in a saved view; never copy session state or connection credentials. */
export interface HostViewFilters {
  search: string
  profileFilter: string | null
  favoritesOnly: boolean
  osFilter: 'all' | 'linux' | 'windows'
  stateFilter: 'all' | 'running'
  reachFilter: 'all' | 'reachable' | 'unreachable'
}

export interface HostView {
  id: string
  name: string
  filters: HostViewFilters
}

export function captureHostFilters(s: HostViewFilters): HostViewFilters {
  return {
    search: s.search.trim(), profileFilter: s.profileFilter, favoritesOnly: s.favoritesOnly,
    osFilter: s.osFilter, stateFilter: s.stateFilter, reachFilter: s.reachFilter
  }
}

export function sameHostFilters(a: HostViewFilters, b: HostViewFilters): boolean {
  return a.search.trim() === b.search.trim() && a.profileFilter === b.profileFilter &&
    a.favoritesOnly === b.favoritesOnly && a.osFilter === b.osFilter &&
    a.stateFilter === b.stateFilter && a.reachFilter === b.reachFilter
}

export function upsertHostView(views: HostView[], view: HostView): HostView[] {
  const name = view.name.trim()
  if (!name) throw new Error('Give this view a name.')
  if (name.length > 60) throw new Error('Use a name with 60 characters or fewer.')
  if (views.some((v) => v.id !== view.id && v.name.toLowerCase() === name.toLowerCase())) {
    throw new Error('A view with this name already exists. Choose another name.')
  }
  const next = { id: view.id, name, filters: captureHostFilters(view.filters) }
  return views.some((v) => v.id === view.id) ? views.map((v) => v.id === view.id ? next : v) : [...views, next]
}
