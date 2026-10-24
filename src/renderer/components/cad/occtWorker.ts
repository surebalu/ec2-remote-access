/// <reference lib="webworker" />
/**
 * Reads STEP, IGES and B-rep files with OpenCascade (occt-import-js) off the page's thread, so a large assembly never
 * freezes the app. Inlined as a blob worker (no file of its own to load from file://); the page fetches the WebAssembly
 * once and hands its bytes over with the first file. Answers with the model's tree and its meshes as typed arrays,
 * transferred rather than copied. Lengths come back in millimetres whatever the file used.
 */
import occtimportjs, { type Occt } from 'occt-import-js'
import type { CadMesh, CadModel, CadNode } from '@shared/cad'

interface Request { id: number; format: 'step' | 'iges' | 'brep'; bytes: Uint8Array; wasm?: ArrayBuffer }

let occt: Promise<Occt> | null = null

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, format, bytes, wasm } = e.data
  try {
    if (!occt) {
      if (!wasm) throw new Error('The reader was not given its WebAssembly.')
      occt = occtimportjs({ wasmBinary: wasm, locateFile: (p) => p, print: () => undefined, printErr: () => undefined })
    }
    const lib = await occt
    const params = { linearUnit: 'millimeter' as const }
    const r = format === 'step' ? lib.ReadStepFile(bytes, params) : format === 'iges' ? lib.ReadIgesFile(bytes, params) : lib.ReadBrepFile(bytes, params)
    if (!r.success) throw new Error('OpenCascade could not read this file: it may be damaged, or not a 3D model (a drawing, say).')
    const transfer: ArrayBuffer[] = []
    const meshes: CadMesh[] = r.meshes.map((m) => {
      const positions = new Float32Array(m.attributes.position.array)
      const normals = m.attributes.normal ? new Float32Array(m.attributes.normal.array) : undefined
      const indices = new Uint32Array(m.index.array)
      transfer.push(positions.buffer, indices.buffer, ...(normals ? [normals.buffer] : []))
      return { name: m.name, ...(m.color ? { color: m.color } : {}), positions, ...(normals ? { normals } : {}), indices }
    })
    const node = (n: { name: string; meshes: number[]; children: unknown[] }): CadNode => ({ name: n.name, meshes: n.meshes, children: (n.children as typeof n[]).map(node) })
    const model: CadModel = { root: node(r.root), meshes }
    ;(self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, model }, transfer)
  } catch (err) {
    ;(self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
