import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { dependencies: Record<string, string> }
const deps = ['electron', 'cpu-features', 'electron-updater', ...Object.keys(pkg.dependencies)]
const external = [...deps, new RegExp(`^(${deps.map((d) => d.replace('/', '\\/')).join('|')})\\/`), /^node:/]

// OpenCascade's Emscripten glue (occt-import-js, the CAD tool's STEP reader) builds embind's call wrappers with
// `new Function`, which the renderer's CSP refuses (no 'unsafe-eval'), and its blob worker inherits that CSP. These
// closures do what the generated code does. The version is pinned; if the glue changes and a pattern is missing, the
// build stops rather than shipping a reader that cannot start.
const OCCT_SITES: [string, string][] = [
  ['let[args,invokerFnBody]=createJsInvoker(argTypes,isClassMethodFunc,returns,isAsync);args.push(invokerFnBody);var invokerFn=newFunc(Function,args)(...closureArgs);',
    'var invokerFn=occtInvoker(argTypes,isClassMethodFunc,needsDestructorStack,returns,cppInvokerFunc,cppTargetFunc,runDestructors);'],
  ['params.push(functionBody);var invokerFunction=newFunc(Function,params)(...args);',
    'var invokerFunction=occtMethodCaller(retType,types,kind,emval_returnValue);']
]
const OCCT_HELPERS = `
function occtInvoker(argTypes, isClassMethodFunc, needsDestructorStack, returns, invoker, fn, runDestructors) {
  var count = argTypes.length - 2;
  return function (...args) {
    var destructors = needsDestructorStack ? [] : null;
    var thisWired;
    var wired = [];
    if (isClassMethodFunc) thisWired = argTypes[1]['toWireType'](destructors, this);
    for (var i = 0; i < count; ++i) wired.push(argTypes[i + 2]['toWireType'](destructors, args[i]));
    var rv = isClassMethodFunc ? invoker(fn, thisWired, ...wired) : invoker(fn, ...wired);
    if (needsDestructorStack) runDestructors(destructors);
    else for (var j = isClassMethodFunc ? 1 : 2; j < argTypes.length; ++j) {
      if (argTypes[j].destructorFunction !== null) argTypes[j].destructorFunction(j === 1 ? thisWired : wired[j - 2]);
    }
    if (returns) return argTypes[0]['fromWireType'](rv);
  };
}
function occtMethodCaller(retType, types, kind, emval_returnValue) {
  return function (obj, func, destructorsRef, args) {
    var list = kind === 0 ? [obj] : [];
    var offset = 0;
    for (var i = 0; i < types.length; ++i) { list.push(types[i].readValueFromPointer(args + offset)); offset += types[i].argPackAdvance; }
    var rv = kind === 1 ? new func(...list) : func.call(...list);
    if (!retType.isVoid) return emval_returnValue(retType, destructorsRef, rv);
  };
}
`
const occtNoEval = (): Plugin => ({
  name: 'occt-no-eval',
  enforce: 'pre',
  transform(code, id) {
    if (!/occt-import-js[\\/]dist[\\/]occt-import-js\.js$/.test(id)) return null
    let out = code
    for (const [from, to] of OCCT_SITES) {
      if (!out.includes(from)) this.error(`occt-import-js changed: "${from.slice(0, 60)}…" is gone, so the no-eval patch no longer applies.`)
      out = out.replace(from, to)
    }
    if (/newFunc\(Function/.test(out)) this.error('occt-import-js still builds a function from a string after the no-eval patch.')
    return { code: OCCT_HELPERS + out, map: null }
  }
})

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
    plugins: [react(), tailwindcss(), occtNoEval()],
    // The CAD tool's STEP reader runs in a worker, which is bundled on its own.
    worker: { plugins: () => [occtNoEval()] },
    resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer') } }
  }
})
