import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { dependencies: Record<string, string> }
const deps = ['electron', 'cpu-features', 'electron-updater', ...Object.keys(pkg.dependencies)]
const external = [...deps, new RegExp(`^(${deps.map((d) => d.replace('/', '\\/')).join('|')})\\/`), /^node:/]

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // storageScan: the Storage tool's scan process (main/storage/scanProcess.ts), forked as a utility process.
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts'), storageScan: resolve('src/main/storage/scanProcess.ts') }, external, output: { format: 'es' } } }
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // extensionWorker: the Browser extensions' service-worker preload (main/extensions.ts).
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts'), extensionWorker: resolve('src/preload/extensionWorker.ts') }, external, output: { format: 'cjs' } } }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer') } }
  }
})
