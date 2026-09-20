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
    build: { rollupOptions: { external, output: { format: 'es' } } }
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { rollupOptions: { external, output: { format: 'cjs' } } }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer') } }
  }
})
