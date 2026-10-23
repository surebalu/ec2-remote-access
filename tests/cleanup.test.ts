import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appleAssetGroup, blobDigest, cacheOwner, hfRepo, isBundleId, parseOllamaManifest, parsePackageInfo, reportSize, zipAppPlist, type CleanReport } from '../src/shared/cleanup.ts'

test('a cache belongs to an open app by its bundle id, a part of it, its name or its vendor', () => {
  const running = [{ id: 'com.google.Chrome', name: 'Google Chrome' }, { id: 'com.microsoft.VSCode', name: 'Code' }, { id: 'com.tinyspeck.slackmacgap', name: 'Slack' }]
  assert.equal(cacheOwner('com.google.Chrome', running)?.name, 'Google Chrome')
  assert.equal(cacheOwner('com.microsoft.VSCode.ShipIt', running)?.name, 'Code')
  assert.equal(cacheOwner('Google', running)?.name, 'Google Chrome', 'a vendor folder')
  assert.equal(cacheOwner('Slack', running)?.name, 'Slack', 'by name')
  assert.equal(cacheOwner('com.spotify.client', running), null)
  assert.equal(cacheOwner('Homebrew', running), null)
})

test('bundle ids look like reverse DNS', () => {
  assert.ok(isBundleId('com.apple.Safari'))
  assert.ok(isBundleId('org.mozilla.firefox'))
  assert.ok(!isBundleId('Google'))
  assert.ok(!isBundleId('com.example'))
})

test('Apple\'s model assets are grouped by the feature they serve', () => {
  assert.equal(appleAssetGroup('com_apple_MobileAsset_UAF_Siri_Understanding'), 'siri')
  assert.equal(appleAssetGroup('com_apple_MobileAsset_UAF_FM_GenerativeModels'), 'intelligence')
  assert.equal(appleAssetGroup('com_apple_MobileAsset_MacinTalkVoiceAssets'), 'voices')
  assert.equal(appleAssetGroup('com_apple_MobileAsset_LinguisticData'), 'language')
  assert.equal(appleAssetGroup('com_apple_MobileAsset_Font7'), null)
})

test('an Ollama manifest names its model as ollama list does, with its layers', () => {
  const json = JSON.stringify({ config: { digest: 'sha256:c0', size: 500 }, layers: [{ digest: 'sha256:a1', size: 4_000_000_000 }, { digest: 'sha256:b2', size: 120 }] })
  const m = parseOllamaManifest('registry.ollama.ai/library/llama3.2/latest', json)!
  assert.equal(m.name, 'llama3.2:latest')
  assert.equal(m.size, 4_000_000_620)
  assert.deepEqual(m.blobs.map((b) => b.digest).sort(), ['sha256:a1', 'sha256:b2', 'sha256:c0'])
  assert.equal(parseOllamaManifest('registry.ollama.ai/someone/tool/7b', json)!.name, 'someone/tool:7b')
  assert.equal(parseOllamaManifest('x/y', json), null)
  assert.equal(parseOllamaManifest('registry.ollama.ai/library/a/b', 'not json'), null)
  assert.equal(blobDigest('sha256-a1'), 'sha256:a1')
})

test('an installer package names the app it carries, the outermost first', () => {
  const xml = `<pkg-info identifier="com.example.pkg"><bundle-version>
    <bundle id="com.example.Helper" CFBundleShortVersionString="2.1" path="./Example.app/Contents/Helpers/Helper.app"/>
    <bundle id="com.example.Example" CFBundleShortVersionString="2.1.3" CFBundleVersion="213" path="./Example.app"/>
    <bundle id="com.example.plugin" CFBundleShortVersionString="1" path="./Example.app/Contents/PlugIns/X.plugin"/>
  </bundle-version></pkg-info>`
  assert.deepEqual(parsePackageInfo(xml)[0], { id: 'com.example.Example', version: '2.1.3', path: './Example.app' })
  assert.equal(parsePackageInfo(xml).length, 2, 'plug-ins are not apps')
})

test('a zip\'s app is found at its top or one folder down, never in __MACOSX', () => {
  assert.equal(zipAppPlist(['__MACOSX/Foo.app/Contents/Info.plist', 'Foo.app/', 'Foo.app/Contents/Info.plist']), 'Foo.app/Contents/Info.plist')
  assert.equal(zipAppPlist(['Release/Bar.app/Contents/Info.plist']), 'Release/Bar.app/Contents/Info.plist')
  assert.equal(zipAppPlist(['a/b/c/Deep.app/Contents/Info.plist', 'readme.txt']), null)
})

test('Hugging Face folders read as repos', () => {
  assert.deepEqual(hfRepo('models--meta-llama--Llama-3.2-1B'), { kind: 'model', name: 'meta-llama/Llama-3.2-1B' })
  assert.deepEqual(hfRepo('datasets--squad'), { kind: 'dataset', name: 'squad' })
  assert.equal(hfRepo('.locks'), null)
})

test('a report adds up what it found, or only what is safe and selectable', () => {
  const r: CleanReport = { at: 0, notes: [], groups: [{ id: 'g', title: 'G', text: '', items: [
    { path: '/a', name: 'a', size: 100, dir: true, safe: true },
    { path: '/b', name: 'b', size: 50, dir: true, safe: false },
    { path: '/c', name: 'c', size: 25, dir: true, safe: true, blocked: 'Only macOS removes it.' }
  ] }] }
  assert.equal(reportSize(r), 150)
  assert.equal(reportSize(r, true), 100)
})
