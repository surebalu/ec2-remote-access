import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import { BREP_FORMATS, nodeLabel, type CadFormat, type CadModel, type CadNode } from '@shared/cad'
import OcctWorker from './occtWorker.ts?worker&inline'
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url'

/**
 * Turns a CAD file into three.js objects for the viewer (cadScene.ts). STEP, IGES and B-rep go through OpenCascade
 * in a worker (occtWorker.ts); what it made is saved as a GLB in main's cache (cad:cachePut, by the file's SHA-256)
 * and read from there next time, which for a large assembly is the difference between a minute and a moment. Meshes
 * (STL, glTF, OBJ, 3MF) load with three's own loaders. Every part is a THREE.Group named after the file's product
 * structure, so the parts tree is the scene graph itself.
 */

/** Bumped when what the loader builds changes, so older cached GLBs are made again. */
const CACHE_VERSION = 1
const DEFAULT_COLOR: [number, number, number] = [0.74, 0.77, 0.82]

export interface LoadedModel {
  group: THREE.Group
  fromCache: boolean
  /** Said under the model's size when the file's units are a guess (STL, OBJ have none). */
  unitsNote?: string
}

let worker: Worker | null = null
let wasm: Promise<ArrayBuffer> | null = null
let seq = 0
let idleTimer: ReturnType<typeof setTimeout> | undefined
const pending = new Map<number, { resolve: (m: CadModel) => void; reject: (e: Error) => void }>()

/** OpenCascade's heap only grows; a worker idle for two minutes is ended, and the next file starts a fresh one. */
function idle(): void {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { if (!pending.size) { worker?.terminate(); worker = null } }, 120_000)
}

async function readBrep(format: 'step' | 'iges' | 'brep', bytes: Uint8Array): Promise<CadModel> {
  wasm ??= fetch(wasmUrl).then((r) => {
    if (!r.ok) throw new Error(`The STEP reader did not load (${r.status}).`)
    return r.arrayBuffer()
  }).catch((e: unknown) => { wasm = null; throw e })
  const binary = await wasm
  const fresh = !worker
  if (!worker) {
    worker = new OcctWorker()
    worker.onmessage = (e: MessageEvent<{ id: number; model?: CadModel; error?: string }>) => {
      const p = pending.get(e.data.id)
      if (!p) return
      pending.delete(e.data.id)
      if (e.data.model) p.resolve(e.data.model)
      else p.reject(new Error(e.data.error ?? 'The STEP reader stopped.'))
      idle()
    }
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(`The STEP reader stopped: ${e.message || 'out of memory?'}`))
      pending.clear()
      worker?.terminate()
      worker = null
    }
  }
  const id = ++seq
  return new Promise<CadModel>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    // A copy of the WebAssembly for each new worker; the file's bytes are handed over, not copied.
    const copy = bytes.slice()
    worker!.postMessage({ id, format, bytes: copy, ...(fresh ? { wasm: binary.slice(0) } : {}) }, [copy.buffer])
  })
}

const materialCache = new Map<string, THREE.MeshStandardMaterial>()

/** A part's material: one per colour, shared, with the polygon offset that keeps edge lines visible on its faces. */
export function partMaterial(rgb: [number, number, number] = DEFAULT_COLOR): THREE.MeshStandardMaterial {
  const key = rgb.map((v) => v.toFixed(3)).join(',')
  let m = materialCache.get(key)
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: new THREE.Color(rgb[0], rgb[1], rgb[2]), metalness: 0.18, roughness: 0.52, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
    materialCache.set(key, m)
  }
  return m
}

/** The reader's tree as three.js groups; an unnamed top level with one child is skipped. */
export function buildGroup(model: CadModel, fileName: string): THREE.Group {
  let partNo = 0
  const make = (n: CadNode, top: boolean): THREE.Group => {
    const g = new THREE.Group()
    g.name = nodeLabel(n.name, top ? fileName : `Part ${++partNo}`)
    for (const i of n.meshes) {
      const src = model.meshes[i]
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(src.positions, 3))
      if (src.normals && src.normals.length === src.positions.length) geo.setAttribute('normal', new THREE.BufferAttribute(src.normals, 3))
      geo.setIndex(new THREE.BufferAttribute(src.indices, 1))
      if (!geo.getAttribute('normal')) geo.computeVertexNormals()
      const mesh = new THREE.Mesh(geo, partMaterial(src.color))
      mesh.name = nodeLabel(src.name, g.name)
      g.add(mesh)
    }
    for (const c of n.children) g.add(make(c, false))
    return g
  }
  let root = model.root
  while (!root.meshes.length && root.children.length === 1 && !root.name.trim()) root = root.children[0]
  const group = make(root, true)
  group.name = nodeLabel(root.name, fileName)
  return group
}

/** GLTFLoader gives a node without a mesh of its own back as a plain Object3D; the viewer's root is a Group. */
function asGroup(o: THREE.Object3D): THREE.Group {
  if (o instanceof THREE.Group) return o
  const g = new THREE.Group()
  g.name = o.name
  g.userData = o.userData
  g.position.copy(o.position)
  g.quaternion.copy(o.quaternion)
  g.scale.copy(o.scale)
  for (const c of [...o.children]) g.add(c)
  return g
}

async function parseGlb(bytes: ArrayBuffer): Promise<THREE.Group> {
  const gltf = await new GLTFLoader().parseAsync(bytes, '')
  const g = gltf.scene as unknown as THREE.Group
  return g
}

/** Saves what OpenCascade made, as a GLB in main's cache, once the viewer shows it (a large model takes a moment). */
function cacheLater(group: THREE.Group, sha256: string): void {
  setTimeout(() => {
    group.userData = { ...group.userData, cadCache: CACHE_VERSION }
    new GLTFExporter().parseAsync(group, { binary: true, onlyVisible: false })
      .then((glb) => window.api.invoke('cad:cachePut', sha256, new Uint8Array(glb as ArrayBuffer)))
      .catch(() => undefined)
  }, 400)
}

export async function loadModel(file: { bytes: Uint8Array; format: CadFormat; sha256: string; name: string }, onStage: (text: string) => void): Promise<LoadedModel> {
  const buf = (): ArrayBuffer => file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer
  if ((BREP_FORMATS as readonly string[]).includes(file.format)) {
    const cached = await window.api.invoke('cad:cacheGet', file.sha256).catch(() => null)
    if (cached) {
      try {
        const g = await parseGlb(cached.buffer.slice(cached.byteOffset, cached.byteOffset + cached.byteLength) as ArrayBuffer)
        const top = g.children.length === 1 ? g.children[0] : g
        if (top.userData?.cadCache === CACHE_VERSION) {
          top.removeFromParent()
          return { group: asGroup(top), fromCache: true }
        }
      } catch { /* made again below */ }
    }
    onStage(`Reading ${file.format.toUpperCase()} with OpenCascade…`)
    const model = await readBrep(file.format as 'step' | 'iges' | 'brep', file.bytes)
    onStage('Building the model…')
    const group = buildGroup(model, file.name)
    cacheLater(group, file.sha256)
    return { group, fromCache: false }
  }
  onStage('Reading the mesh…')
  const named = (o: THREE.Object3D): THREE.Group => {
    const g = o instanceof THREE.Group ? o : new THREE.Group().add(o)
    g.name = file.name
    return g
  }
  switch (file.format) {
    case 'stl': {
      const geo = new STLLoader().parse(buf())
      if (!geo.getAttribute('normal')) geo.computeVertexNormals()
      const mesh = new THREE.Mesh(geo, partMaterial())
      mesh.name = file.name
      return { group: named(mesh), fromCache: false, unitsNote: 'STL has no units: read as millimetres.' }
    }
    case 'obj': {
      const g = new OBJLoader().parse(new TextDecoder().decode(file.bytes))
      g.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = partMaterial() })
      return { group: named(g), fromCache: false, unitsNote: 'OBJ has no units: read as millimetres.' }
    }
    case '3mf':
      return { group: named(new ThreeMFLoader().parse(buf())), fromCache: false }
    case 'glb':
    case 'gltf': {
      const g = await parseGlb(buf())
      // glTF is in metres; the viewer measures in millimetres.
      g.scale.setScalar(1000)
      const wrap = new THREE.Group().add(g)
      wrap.name = file.name
      return { group: wrap, fromCache: false, unitsNote: 'glTF is in metres: shown in millimetres.' }
    }
    default:
      throw new Error('The viewer does not read this kind of file.')
  }
}
