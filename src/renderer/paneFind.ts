/**
 * Messages between the panes of the side-by-side view. Each pane is its own component tree, so they talk through
 * window events: the split bar asks every pane to find a value (and step through its matches), panes answer with how
 * many they found, and a pane can put text into the split bar's find box (a value selected in a terminal or a page).
 */

export interface FindAllRequest {
  /** The panes asked (the split's tab ids). */
  ids: string[]
  /** '' clears every highlight. */
  text: string
  /** Moves to the next (or previous) match in this one pane instead of starting over. */
  step?: { tabId: string; back?: boolean }
}

const FIND = 'ec2ra:find-all'
const COUNT = 'ec2ra:find-count'
const ASK = 'ec2ra:find-all-ui'

function listen<T>(name: string, fn: (d: T) => void): () => void {
  const h = (e: Event): void => fn((e as CustomEvent<T>).detail)
  window.addEventListener(name, h)
  return () => window.removeEventListener(name, h)
}

export function findAll(req: FindAllRequest): void {
  window.dispatchEvent(new CustomEvent(FIND, { detail: req }))
}

export function onFindAll(fn: (req: FindAllRequest) => void): () => void {
  return listen(FIND, fn)
}

/** A pane's match count for the current text (null: nothing to count, e.g. a blank page). */
export function reportFindCount(tabId: string, count: number | null): void {
  window.dispatchEvent(new CustomEvent(COUNT, { detail: { tabId, count } }))
}

export function onFindCount(fn: (d: { tabId: string; count: number | null }) => void): () => void {
  return listen(COUNT, fn)
}

/** Puts `text` into the split bar's find box and searches every pane for it. */
export function findInAllPanes(text: string): void {
  window.dispatchEvent(new CustomEvent(ASK, { detail: text }))
}

export function onFindInAllPanes(fn: (text: string) => void): () => void {
  return listen(ASK, fn)
}
