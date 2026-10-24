import { useMemo, useState, type ReactElement } from 'react'
import type * as THREE from 'three'
import { Icon } from '../icons'

/**
 * The model's parts as the file structures them (the scene graph cadLoad.ts built from STEP's product tree): click
 * to select (the part lights up), the eye to hide or show, double-click to frame it, Isolate to show it alone.
 * Assemblies open one level at first; a filter finds a part by name in a large assembly.
 */

interface TreeNode { obj: THREE.Object3D; label: string; kids: TreeNode[]; parts: number }

/** Groups only: meshes are a part's faces, not parts of their own (a group of meshes is shown as one part). */
function nodeOf(o: THREE.Object3D): TreeNode {
  const kids = o.children.filter((c) => !(c as THREE.Mesh).isMesh && (c.children.length || c.name)).map(nodeOf)
  const own = o.children.some((c) => (c as THREE.Mesh).isMesh) ? 1 : 0
  return { obj: o, label: o.name || 'Part', kids, parts: own + kids.reduce((n, k) => n + k.parts, 0) }
}

export default function CadTree({ root, version, selected, onSelect, onToggle, onFrame, onIsolate }: {
  root: THREE.Object3D | null
  /** Bumped when visibility changes, so the eyes redraw. */
  version: number
  selected: THREE.Object3D | null
  onSelect: (o: THREE.Object3D | null) => void
  onToggle: (o: THREE.Object3D, visible: boolean) => void
  onFrame: (o: THREE.Object3D) => void
  onIsolate: (o: THREE.Object3D | null) => void
}): ReactElement {
  const tree = useMemo(() => (root ? nodeOf(root) : null), [root])
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  void version
  if (!tree) return <aside className="cad-tree" aria-label="Parts" />
  const q = filter.trim().toLowerCase()
  const matches = (n: TreeNode): boolean => n.label.toLowerCase().includes(q) || n.kids.some(matches)

  const row = (n: TreeNode, depth: number): ReactElement | null => {
    if (q && !matches(n)) return null
    const id = n.obj.uuid
    const expanded = q ? true : depth === 0 || open.has(id)
    const sel = selected === n.obj
    return (
      <li key={id} role="treeitem" aria-selected={sel} aria-expanded={n.kids.length ? expanded : undefined}>
        <div className={`cad-node ${sel ? 'on' : ''} ${n.obj.visible ? '' : 'hidden'}`} style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => onSelect(sel ? null : n.obj)} onDoubleClick={() => onFrame(n.obj)}>
          {n.kids.length ? (
            <button type="button" className="cad-node-chev" aria-label={expanded ? 'Collapse' : 'Expand'} onClick={(e) => {
              e.stopPropagation()
              setOpen((s) => { const x = new Set(s); if (x.has(id)) x.delete(id); else x.add(id); return x })
            }}><Icon.chevron open={expanded} /></button>
          ) : <span className="cad-node-chev" />}
          <span className="cad-node-name" title={n.label}>{n.label}</span>
          {n.kids.length > 0 && <span className="cad-node-count">{n.parts}</span>}
          <button type="button" className="cad-node-eye" aria-label={n.obj.visible ? `Hide ${n.label}` : `Show ${n.label}`} title={n.obj.visible ? 'Hide' : 'Show'}
            onClick={(e) => { e.stopPropagation(); onToggle(n.obj, !n.obj.visible) }}>{n.obj.visible ? <Icon.eye /> : <Icon.eyeOff />}</button>
        </div>
        {expanded && n.kids.length > 0 && <ul role="group">{n.kids.map((k) => row(k, depth + 1))}</ul>}
      </li>
    )
  }

  return (
    <aside className="cad-tree" aria-label="Parts">
      <div className="cad-panel-head">
        <span>Parts <b>{tree.parts}</b></span>
        <span className="flex-1" />
        <button type="button" className="cad-mini" disabled={!selected} onClick={() => onIsolate(selected)} title="Show only the selected part">Isolate</button>
        <button type="button" className="cad-mini" onClick={() => onIsolate(null)} title="Show every part">Show all</button>
      </div>
      <input className="cad-filter" placeholder="Find a part…" aria-label="Find a part" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
      <ul className="cad-nodes" role="tree" aria-label="Model tree">{row(tree, 0)}</ul>
    </aside>
  )
}
