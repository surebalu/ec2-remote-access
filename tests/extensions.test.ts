import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crxZipOffset, iconPathOf, isExtensionPage, localized, missingFeatures, optionsOf, popupOf, siteAccess, storeIdOf } from '../src/shared/extensions.ts'

const DARK = 'eimadpbcbfnmbkopoojfekhnkhdbieeh'

test('a Chrome Web Store link or id', () => {
  assert.equal(storeIdOf(`https://chromewebstore.google.com/detail/dark-reader/${DARK}`), DARK)
  assert.equal(storeIdOf(`https://chromewebstore.google.com/detail/${DARK}?hl=en`), DARK)
  assert.equal(storeIdOf(`https://chrome.google.com/webstore/detail/dark-reader/${DARK}`), DARK)
  assert.equal(storeIdOf(`  ${DARK} `), DARK)
  assert.equal(storeIdOf('https://example.com/detail/x/' + DARK), null, 'only the Web Store')
  assert.equal(storeIdOf('dark reader'), null)
  assert.equal(storeIdOf('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), null, 'ids use the letters a to p')
})

test('the zip inside a CRX package', () => {
  const zip = [0x50, 0x4b, 0x03, 0x04, 1, 2, 3]
  const crx3 = new Uint8Array([...Buffer.from('Cr24'), 3, 0, 0, 0, 5, 0, 0, 0, 9, 9, 9, 9, 9, ...zip])
  assert.equal(crxZipOffset(crx3), 17)
  const crx2 = new Uint8Array([...Buffer.from('Cr24'), 2, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 7, 7, 8, ...zip])
  assert.equal(crxZipOffset(crx2), 19)
  assert.throws(() => crxZipOffset(new Uint8Array([...Buffer.from('<html>'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), /did not send/)
  assert.throws(() => crxZipOffset(new Uint8Array([...Buffer.from('Cr24'), 3, 0, 0, 0, 1, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6])), /format/)
})

test('popup, options, icon and site access from the manifest', () => {
  const v3 = { manifest_version: 3, action: { default_popup: 'ui/popup.html', default_icon: { 16: 'i16.png', 48: 'i48.png' } }, options_ui: { page: 'options.html' }, host_permissions: ['<all_urls>'], permissions: ['storage', 'contextMenus', 'notifications'], commands: { x: {} } }
  assert.equal(popupOf(v3), 'ui/popup.html')
  assert.equal(optionsOf(v3), 'options.html')
  assert.equal(iconPathOf(v3, 32), 'i48.png')
  assert.deepEqual(siteAccess(v3), { all: true, hosts: [] })
  assert.deepEqual(missingFeatures(v3), ['right-click menu items', 'notifications', 'keyboard shortcuts'])
  const v2 = { manifest_version: 2, browser_action: { default_popup: 'p.html', default_icon: 'icon.png' }, options_page: 'o.html', permissions: ['https://*.example.com/*', 'storage'], content_scripts: [{ matches: ['https://github.com/*'] }] }
  assert.equal(popupOf(v2), 'p.html')
  assert.equal(optionsOf(v2), 'o.html')
  assert.equal(iconPathOf(v2), 'icon.png')
  assert.deepEqual(siteAccess(v2), { all: false, hosts: ['*.example.com', 'github.com'] })
  assert.equal(popupOf({ manifest_version: 3 }), null)
})

test('names in the extension\'s language, and which pages may be shown', () => {
  assert.equal(localized('__MSG_extName__', { extname: { message: 'Dark Reader' } }), 'Dark Reader')
  assert.equal(localized('Plain', null), 'Plain')
  assert.equal(localized('__MSG_missing__', {}), '__MSG_missing__')
  const id = 'opcjhlljcickophihkldacfdenldiabd'
  assert.ok(isExtensionPage(`chrome-extension://${id}/popup.html`, [id]))
  assert.ok(!isExtensionPage(`chrome-extension://${DARK}/popup.html`, [id]), 'only installed extensions')
  assert.ok(!isExtensionPage('https://example.com/', [id]))
})
