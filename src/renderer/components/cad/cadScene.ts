import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { CadView } from '@shared/cad'
import { partMaterial } from './cadLoad'

/**
 * The CAD tool's 3D view, after ReviewBench's Viewer3D: orbit, fit, standard views, wireframe, a section plane,
 * point-to-point measurement and comment pins, plus what a STEP viewer needs on top: edge lines, Y-up or Z-up
 * (SolidWorks or 3DEXPERIENCE), snapping a measurement to the nearest corner, picking and highlighting a part, hiding
 * and isolating parts, and a camera that moves smoothly to a view. It draws only while the tab is on screen. The
 * renderer is transparent, so the page's own background (the theme's) shows behind the model.
 */

export type CadTool = 'orbit' | 'measure' | 'pin'
export type StandardView = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right'
export type SectionAxis = 'none' | 'x' | 'y' | 'z'
export type UpAxis = 'y' | 'z'
type V3 = [number, number, number]

export interface PickHit {
  point: V3
  /** The part's name (its group in the model's tree). */
  part: string
  /** The part's group, for the tree. */
  object: THREE.Object3D
}

export interface SceneEvents {
  /** A click (not a drag) with the orbit tool: a part, or nothing. */
  onSelect(hit: PickHit | null): void
  onMeasure(a: V3, b: V3, length: number): void
  onPin(hit: PickHit): void
  /** After each drawn frame: overlays (pin numbers, lengths) follow the model. */
  onFrame(): void
}

const v3 = (v: THREE.Vector3): V3 => [v.x, v.y, v.z]
/** Edge lines cost memory; past this many triangles they start off. */
export const EDGE_TRIANGLE_LIMIT = 1_500_000

export class CadScene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls
  private model: THREE.Group | null = null
  private bounds = new THREE.Box3()
  private readonly overlay = new THREE.Group()
  private readonly edges = new THREE.Group()
  private edgePairs: { mesh: THREE.Mesh; lines: THREE.LineSegments }[] = []
  private edgesOn = true
  private wireframe = false
  private readonly clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0)
  private section: { axis: SectionAxis; offset: number; flip: boolean } = { axis: 'none', offset: 0.5, flip: false }
  private tool: CadTool = 'orbit'
  private up: UpAxis = 'y'
  private selected: THREE.Object3D | null = null
  private highlighted = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
  private measureA: THREE.Vector3 | null = null
  private measureMarker: THREE.Mesh | null = null
  private flight: { from: CadView; to: CadView; t0: number } | null = null
  private down: { x: number; y: number } | null = null
  private running = false
  private readonly ro: ResizeObserver
  private readonly lineMaterial = new THREE.LineBasicMaterial({ color: 0x1b1f27, transparent: true, opacity: 0.5 })
  private readonly measureMaterial = new THREE.LineBasicMaterial({ color: 0xf59e0b, depthTest: false, transparent: true })

  constructor(private readonly container: HTMLElement, private readonly events: SceneEvents) {
    const w = Math.max(1, container.clientWidth)
    const h = Math.max(1, container.clientHeight)
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(w, h, false)
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.localClippingEnabled = true
    this.renderer.domElement.className = 'cad-canvas'
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100_000)
    this.camera.position.set(200, 200, 200)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.zoomToCursor = true
    this.controls.screenSpacePanning = true

    // Studio light from a room environment, and a key light riding on the camera so every side reads.
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environmentIntensity = 0.75
    pmrem.dispose()
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f4a, 0.55))
    const key = new THREE.DirectionalLight(0xffffff, 1.25)
    key.position.set(0.4, 0.8, 1)
    this.camera.add(key)
    this.scene.add(this.camera, this.overlay, this.edges)

    const dom = this.renderer.domElement
    dom.addEventListener('pointerdown', this.onDown)
    dom.addEventListener('pointerup', this.onUp)
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
  }

  // ----- life -----

  setActive(on: boolean): void {
    if (on === this.running) return
    this.running = on
    this.renderer.setAnimationLoop(on ? () => this.frame() : null)
  }

  dispose(): void {
    this.setActive(false)
    this.ro.disconnect()
    this.renderer.domElement.removeEventListener('pointerdown', this.onDown)
    this.renderer.domElement.removeEventListener('pointerup', this.onUp)
    this.setModel(null)
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth)
    const h = Math.max(1, this.container.clientHeight)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
  }

  private frame(): void {
    if (this.flight) {
      const t = Math.min(1, (performance.now() - this.flight.t0) / 320)
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
      const lerp = (a: V3, b: V3): THREE.Vector3 => new THREE.Vector3(...a).lerp(new THREE.Vector3(...b), e)
      this.camera.position.copy(lerp(this.flight.from.pos, this.flight.to.pos))
      this.controls.target.copy(lerp(this.flight.from.target, this.flight.to.target))
      this.camera.up.copy(lerp(this.flight.from.up, this.flight.to.up).normalize())
      if (t >= 1) this.flight = null
    }
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
    this.events.onFrame()
  }

  // ----- the model -----

  setModel(group: THREE.Group | null): void {
    if (this.model) {
      this.scene.remove(this.model)
      this.model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose() })
    }
    this.clearEdges()
    this.clearOverlay()
    this.highlighted.clear()
    this.selected = null
    this.model = group
    if (!group) return
    group.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      // A cached GLB comes back with plain materials: the same look and clipping as a fresh read.
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      for (const mat of mats) {
        if (mat instanceof THREE.MeshStandardMaterial) { mat.side = THREE.DoubleSide; mat.polygonOffset = true; mat.polygonOffsetFactor = 1; mat.polygonOffsetUnits = 1 }
        mat.clippingPlanes = this.section.axis === 'none' ? [] : [this.clip]
      }
      if (!m.material) m.material = partMaterial()
    })
    this.scene.add(group)
    group.updateMatrixWorld(true)
    this.bounds = new THREE.Box3().setFromObject(group)
    const size = this.bounds.getSize(new THREE.Vector3()).length() || 100
    this.camera.near = size / 2000
    this.camera.far = size * 50
    this.camera.updateProjectionMatrix()
    if (this.edgesOn && this.triangles() <= EDGE_TRIANGLE_LIMIT) this.buildEdges()
    else this.edgesOn = false
    this.view('iso', false)
  }

  /** The model's size along X, Y, Z (millimetres) and its triangles. */
  stats(): { size: V3; triangles: number } {
    return { size: v3(this.bounds.getSize(new THREE.Vector3())), triangles: this.triangles() }
  }

  private triangles(): number {
    let n = 0
    this.model?.traverse((o) => {
      const g = (o as THREE.Mesh).geometry
      if ((o as THREE.Mesh).isMesh && g) n += (g.index ? g.index.count : g.getAttribute('position').count) / 3
    })
    return Math.round(n)
  }

  root(): THREE.Group | null {
    return this.model
  }

  // ----- edges and looks -----

  edgesEnabled(): boolean {
    return this.edgesOn
  }

  setEdges(on: boolean): void {
    this.edgesOn = on
    if (on && !this.edgePairs.length) this.buildEdges()
    this.edges.visible = on
  }

  private buildEdges(): void {
    if (!this.model) return
    this.model.updateMatrixWorld(true)
    this.model.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 28), this.lineMaterial)
      lines.matrixAutoUpdate = false
      lines.matrix.copy(mesh.matrixWorld)
      lines.raycast = () => undefined
      this.edges.add(lines)
      this.edgePairs.push({ mesh, lines })
    })
    this.edges.visible = this.edgesOn
    this.syncEdges()
  }

  private clearEdges(): void {
    for (const { lines } of this.edgePairs) lines.geometry.dispose()
    this.edges.clear()
    this.edgePairs = []
  }

  /** Edge lines follow their part's visibility. */
  private syncEdges(): void {
    for (const { mesh, lines } of this.edgePairs) lines.visible = shown(mesh)
  }

  setWireframe(on: boolean): void {
    this.wireframe = on
    this.model?.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if ('wireframe' in mat) (mat as THREE.MeshStandardMaterial).wireframe = on
    })
  }

  /** Edge lines dark on a light page, lighter on a dark one. */
  setDark(dark: boolean): void {
    this.lineMaterial.color.set(dark ? 0x0b0d12 : 0x1b1f27)
    this.lineMaterial.opacity = dark ? 0.7 : 0.5
  }

  // ----- views -----

  setUp(up: UpAxis): void {
    this.up = up
    this.view('iso')
  }

  /** Where the camera looks from for a standard view, Y-up (SolidWorks) or Z-up (3DEXPERIENCE, CATIA). */
  private direction(v: StandardView): { dir: THREE.Vector3; up: THREE.Vector3 } {
    const Y = this.up === 'y'
    const U = Y ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
    const F = Y ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, -1, 0)
    const R = new THREE.Vector3(1, 0, 0)
    switch (v) {
      case 'top': return { dir: U.clone(), up: F.clone().negate() }
      case 'bottom': return { dir: U.clone().negate(), up: F.clone() }
      case 'front': return { dir: F.clone(), up: U.clone() }
      case 'back': return { dir: F.clone().negate(), up: U.clone() }
      case 'right': return { dir: R.clone(), up: U.clone() }
      case 'left': return { dir: R.clone().negate(), up: U.clone() }
      default: return { dir: R.clone().add(U).add(F).normalize(), up: U.clone() }
    }
  }

  view(v: StandardView, animate = true): void {
    const { dir, up } = this.direction(v)
    this.flyTo(this.framing(dir, up), animate)
  }

  fit(animate = true): void {
    const dir = this.camera.position.clone().sub(this.controls.target).normalize()
    this.flyTo(this.framing(dir, this.camera.up.clone()), animate)
  }

  private framing(dir: THREE.Vector3, up: THREE.Vector3, box: THREE.Box3 = this.bounds): CadView {
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3())
    const radius = (box.isEmpty() ? 100 : box.getSize(new THREE.Vector3()).length() / 2) || 1
    const fov = (this.camera.fov * Math.PI) / 180
    const dist = (radius / Math.sin(fov / 2)) * 1.08
    return { pos: v3(center.clone().addScaledVector(dir, dist)), target: v3(center), up: v3(up) }
  }

  /** Frames one part (a double-click in the tree). */
  zoomTo(obj: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(obj)
    if (box.isEmpty()) return
    const dir = this.camera.position.clone().sub(this.controls.target).normalize()
    this.flyTo(this.framing(dir, this.camera.up.clone(), box))
  }

  getView(): CadView {
    return { pos: v3(this.camera.position), target: v3(this.controls.target), up: v3(this.camera.up) }
  }

  flyTo(to: CadView, animate = true): void {
    if (!animate || !this.running) {
      this.flight = null
      this.camera.position.set(...to.pos)
      this.controls.target.set(...to.target)
      this.camera.up.set(...to.up)
      this.controls.update()
      return
    }
    this.flight = { from: this.getView(), to, t0: performance.now() }
  }

  /** The camera's rotation as a CSS matrix, for the view cube to turn with the model. */
  cubeMatrix(): string {
    const m = new THREE.Matrix4().extractRotation(this.camera.matrixWorldInverse)
    const e = m.elements
    // CSS's y points down: flip it on both sides of the rotation.
    return `matrix3d(${e[0]},${-e[1]},${e[2]},0,${-e[4]},${e[5]},${-e[6]},0,${e[8]},${-e[9]},${e[10]},0,0,0,0,1)`
  }

  /** Where a model point is on screen (CSS pixels), and whether it is in front of the camera. */
  project(p: V3): { x: number; y: number; visible: boolean } {
    const v = new THREE.Vector3(...p).project(this.camera)
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, visible: v.z < 1 && v.z > -1 }
  }

  // ----- section -----

  setSection(axis: SectionAxis, offset01 = this.section.offset, flip = this.section.flip): void {
    this.section = { axis, offset: Math.min(1, Math.max(0, offset01)), flip }
    const planes = axis === 'none' ? [] : [this.clip]
    if (axis !== 'none') {
      const n = axis === 'x' ? new THREE.Vector3(1, 0, 0) : axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
      const min = this.bounds.min[axis]
      const cut = min + (this.bounds.max[axis] - min) * this.section.offset
      // Keeps what is below the cut (or above it, flipped): three clips where the plane's distance is negative.
      if (flip) this.clip.set(n, -cut)
      else this.clip.set(n.negate(), cut)
    }
    this.model?.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.clippingPlanes = planes
    })
    // A highlighted part's own materials are set aside: they get the plane too, for when the highlight goes.
    for (const mat of this.highlighted.values()) for (const m of Array.isArray(mat) ? mat : [mat]) m.clippingPlanes = planes
    this.lineMaterial.clippingPlanes = planes
  }

  // ----- parts -----

  setVisible(obj: THREE.Object3D, on: boolean): void {
    obj.visible = on
    this.syncEdges()
  }

  /** Shows only `obj` (and what it holds); null shows everything. */
  isolate(obj: THREE.Object3D | null): void {
    if (!this.model) return
    this.model.traverse((o) => { o.visible = true })
    if (obj) {
      const keep = new Set<THREE.Object3D>()
      obj.traverse((o) => keep.add(o))
      for (let p: THREE.Object3D | null = obj; p; p = p.parent) keep.add(p)
      this.model.traverse((o) => { if (!keep.has(o) && (o as THREE.Mesh).isMesh) o.visible = false })
    }
    this.syncEdges()
  }

  /** Lights up a part (and what it holds); null clears it. */
  highlight(obj: THREE.Object3D | null): void {
    for (const [mesh, mat] of this.highlighted) mesh.material = mat
    this.highlighted.clear()
    this.selected = obj
    if (!obj) return
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      this.highlighted.set(mesh, mesh.material)
      const base = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial
      const lit = base.clone()
      lit.emissive = new THREE.Color(0x3b6cff)
      lit.emissiveIntensity = 0.45
      mesh.material = lit
    })
  }

  selection(): THREE.Object3D | null {
    return this.selected
  }

  // ----- tools -----

  setTool(tool: CadTool): void {
    this.tool = tool
    this.cancelMeasure()
    this.renderer.domElement.style.cursor = tool === 'orbit' ? 'grab' : 'crosshair'
  }

  cancelMeasure(): void {
    this.measureA = null
    if (this.measureMarker) { this.overlay.remove(this.measureMarker); this.measureMarker.geometry.dispose(); this.measureMarker = null }
  }

  /** The measurement lines drawn on the model (the lengths are HTML labels the tab places with project()). */
  setMeasures(list: { a: V3; b: V3 }[]): void {
    for (const c of [...this.overlay.children]) if (c !== this.measureMarker) { this.overlay.remove(c); (c as THREE.Line).geometry?.dispose() }
    for (const m of list) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...m.a), new THREE.Vector3(...m.b)]), this.measureMaterial)
      line.renderOrder = 10
      this.overlay.add(line)
      for (const p of [m.a, m.b]) this.overlay.add(this.dot(new THREE.Vector3(...p), 0xf59e0b))
    }
  }

  private clearOverlay(): void {
    this.cancelMeasure()
    for (const c of [...this.overlay.children]) { this.overlay.remove(c); (c as THREE.Mesh).geometry?.dispose() }
  }

  private dot(p: THREE.Vector3, color: number): THREE.Mesh {
    const r = (this.bounds.isEmpty() ? 100 : this.bounds.getSize(new THREE.Vector3()).length()) * 0.004
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }))
    m.position.copy(p)
    m.renderOrder = 11
    return m
  }

  private readonly onDown = (e: PointerEvent): void => {
    this.down = { x: e.clientX, y: e.clientY }
    if (this.tool !== 'orbit') {
      // Measuring and pinning click on the model; the view still turns with a drag.
      this.renderer.domElement.style.cursor = 'crosshair'
    }
  }

  private readonly onUp = (e: PointerEvent): void => {
    const d = this.down
    this.down = null
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || e.button !== 0) return
    const hit = this.pick(e.clientX, e.clientY)
    if (this.tool === 'orbit') { this.events.onSelect(hit); return }
    if (!hit) return
    if (this.tool === 'pin') { this.events.onPin(hit); return }
    const p = new THREE.Vector3(...hit.point)
    if (!this.measureA) {
      this.measureA = p
      this.measureMarker = this.dot(p, 0xf59e0b)
      this.overlay.add(this.measureMarker)
      return
    }
    const a = this.measureA
    this.cancelMeasure()
    this.events.onMeasure(v3(a), v3(p), a.distanceTo(p))
  }

  /** What is under the pointer: the nearest visible, uncut surface, snapped to a corner within 10 px when measuring. */
  pick(clientX: number, clientY: number): PickHit | null {
    if (!this.model) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    const cut = this.section.axis !== 'none'
    const hit = ray.intersectObject(this.model, true).find((h) => shown(h.object) && (h.object as THREE.Mesh).isMesh && (!cut || this.clip.distanceToPoint(h.point) >= 0))
    if (!hit) return null
    let point = hit.point.clone()
    if (this.tool === 'measure' && hit.face) {
      const mesh = hit.object as THREE.Mesh
      const pos = mesh.geometry.getAttribute('position')
      let best = 10
      for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
        const s = v.clone().project(this.camera)
        const px = Math.hypot(((s.x + 1) / 2) * rect.width - (clientX - rect.left), ((1 - s.y) / 2) * rect.height - (clientY - rect.top))
        if (px < best) { best = px; point = v }
      }
    }
    const part = partOf(hit.object, this.model)
    return { point: v3(point), part: part.name || hit.object.name, object: part }
  }

  /** The picture on screen as a PNG, on an opaque background (the report's image). */
  screenshot(background: string): string {
    this.renderer.setClearColor(new THREE.Color(background), 1)
    this.renderer.render(this.scene, this.camera)
    const url = this.renderer.domElement.toDataURL('image/png')
    this.renderer.setClearColor(0x000000, 0)
    return url
  }
}

/** Visible, and every group above it too. */
function shown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false
  return true
}

/** The part a mesh belongs to: its nearest named group inside the model. */
function partOf(o: THREE.Object3D, root: THREE.Object3D): THREE.Object3D {
  for (let p: THREE.Object3D | null = o.parent; p && p !== root.parent; p = p.parent) if (p.name) return p
  return o
}
