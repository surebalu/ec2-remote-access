import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

/** Bundles src/gateway (plus the Electron-free parts of src/main it imports) into out/gateway/index.js for Node. */
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { dependencies: Record<string, string> }
const deps = ['cpu-features', ...Object.keys(pkg.dependencies)]
const external = [...deps, new RegExp(`^(${deps.map((d) => d.replace('/', '\\/')).join('|')})\\/`), /^node:/]

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  build: {
    ssr: 'src/gateway/index.ts',
    outDir: 'out/gateway',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: { external, output: { format: 'es', entryFileNames: 'index.js' } }
  },
  ssr: { noExternal: [] }
})
