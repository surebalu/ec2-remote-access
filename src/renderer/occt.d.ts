// occt-import-js (OpenCascade in WebAssembly, LGPL-2.1) has no types of its own; this is the part the CAD tool uses.
declare module 'occt-import-js' {
  interface OcctMesh {
    name: string
    color?: [number, number, number]
    brep_faces: { first: number; last: number; color: [number, number, number] | null }[]
    attributes: { position: { array: number[] }; normal?: { array: number[] } }
    index: { array: number[] }
  }
  interface OcctNode { name: string; meshes: number[]; children: OcctNode[] }
  interface OcctResult { success: boolean; root: OcctNode; meshes: OcctMesh[] }
  interface OcctParams { linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot'; linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value'; linearDeflection?: number; angularDeflection?: number }
  export interface Occt {
    ReadStepFile(content: Uint8Array, params: OcctParams | null): OcctResult
    ReadIgesFile(content: Uint8Array, params: OcctParams | null): OcctResult
    ReadBrepFile(content: Uint8Array, params: OcctParams | null): OcctResult
  }
  const occtimportjs: (overrides?: { wasmBinary?: ArrayBuffer; locateFile?: (path: string) => string; print?: (s: string) => void; printErr?: (s: string) => void }) => Promise<Occt>
  export default occtimportjs
}
