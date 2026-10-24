// Screen sharing and Tailscale machines in the built renderer, against a fake VNC server on loopback (no real
// computer, no Tailscale). Called from ui-smoke.cjs, which owns the fixture IPC; this file owns the RFB side.
const assert = require('node:assert/strict')
const { join, resolve } = require('node:path')
const { writeFileSync } = require('node:fs')
const { BrowserWindow } = require('electron')
const { WebSocketServer } = require('ws')

const W = 64
const H = 40

/**
 * A minimal RFB 3.8 server over WebSocket, the way main/vnc/relay.ts hands the page a host: VNC password auth (type 2)
 * that turns down the first attempt, then a 64×40 screen in one colour. Records key events.
 */
function fakeVnc() {
  const keys = []
  let attempts = 0
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  wss.on('connection', (ws) => {
    let stage = 'version'
    let buf = Buffer.alloc(0)
    ws.send(Buffer.from('RFB 003.008\n'))
    ws.on('message', (d) => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        if (stage === 'version') {
          if (buf.length < 12) return
          buf = buf.subarray(12)
          ws.send(Buffer.from([1, 2]))
          stage = 'type'
        } else if (stage === 'type') {
          if (buf.length < 1) return
          buf = buf.subarray(1)
          ws.send(Buffer.alloc(16, 7))
          stage = 'response'
        } else if (stage === 'response') {
          if (buf.length < 16) return
          buf = buf.subarray(16)
          attempts++
          if (attempts === 1) {
            const reason = Buffer.from('Authentication failed')
            const out = Buffer.alloc(8 + reason.length)
            out.writeUInt32BE(1, 0)
            out.writeUInt32BE(reason.length, 4)
            reason.copy(out, 8)
            ws.send(out)
            setTimeout(() => ws.close(), 20)
            return
          }
          ws.send(Buffer.from([0, 0, 0, 0]))
          stage = 'init'
        } else if (stage === 'init') {
          if (buf.length < 1) return
          buf = buf.subarray(1)
          const name = Buffer.from('Fixture Mac')
          const init = Buffer.alloc(24 + name.length)
          init.writeUInt16BE(W, 0)
          init.writeUInt16BE(H, 2)
          Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4)
          init.writeUInt32BE(name.length, 20)
          name.copy(init, 24)
          ws.send(init)
          stage = 'normal'
        } else {
          if (buf.length < 1) return
          const type = buf[0]
          const need = type === 0 ? 20 : type === 2 ? (buf.length >= 4 ? 4 + 4 * buf.readUInt16BE(2) : Infinity) : type === 3 ? 10 : type === 4 ? 8 : type === 5 ? 6 : type === 6 ? (buf.length >= 8 ? 8 + buf.readUInt32BE(4) : Infinity) : 1
          if (buf.length < need) return
          const msg = buf.subarray(0, need)
          buf = buf.subarray(need)
          if (type === 4) keys.push({ down: msg[1] === 1, keysym: msg.readUInt32BE(4) })
          if (type === 3 && msg[1] === 0) {
            // A full update: one raw rectangle in the 32-bit format noVNC asks for (R, G, B, unused).
            const head = Buffer.alloc(16)
            head.writeUInt16BE(1, 2)
            head.writeUInt16BE(W, 8)
            head.writeUInt16BE(H, 10)
            head.writeInt32BE(0, 12)
            const px = Buffer.alloc(W * H * 4)
            for (let i = 0; i < W * H; i++) px.set([0x33, 0x99, 0xff, 0], i * 4)
            ws.send(Buffer.concat([head, px]))
          }
        }
      }
    })
  })
  return new Promise((res) => wss.on('listening', () => res({ port: wss.address().port, keys, attempts: () => attempts, close: () => wss.close() })))
}

module.exports = async function screensScenario({ output, errors, fixture }) {
  const vnc = await fakeVnc()
  const url = `ws://127.0.0.1:${vnc.port}/vnc/fixture-session-token-0123`
  fixture.allowWs(`ws://127.0.0.1:${vnc.port}/`)
  fixture.setVnc(url)
  fixture.setTailnet({
    installed: true, running: true, tailnet: 'person@example.com',
    devices: [
      { key: 'tailnet/nMAC', profile: 'tailscale', region: 'Tailscale', instanceId: 'fixture-mac.tail0000.ts.net', name: 'Fixture Mac', platform: 'linux', platformDetails: 'macOS', osHint: 'macOS', state: 'running', instanceType: '', publicIp: '100.64.0.10', ssmOnline: false, tags: { OS: 'macOS', Tailscale: 'fixture-mac.tail0000.ts.net' }, manual: true, tailnet: { os: 'macOS', online: true, dnsName: 'fixture-mac.tail0000.ts.net' } },
      { key: 'tailnet/nWIN', profile: 'tailscale', region: 'Tailscale', instanceId: 'fixture-pc.tail0000.ts.net', name: 'Fixture PC', platform: 'windows', platformDetails: 'Windows', osHint: 'Windows', state: 'stopped', instanceType: '', publicIp: '100.64.0.11', ssmOnline: false, tags: { OS: 'Windows' }, manual: true, tailnet: { os: 'Windows', online: false, lastSeen: new Date(Date.now() - 86400000).toISOString() } }
    ]
  })

  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, backgroundThrottling: false } })
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
  const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { throw new Error(`${e.message}\n  in: ${code.slice(0, 300)}`) })
  const until = async (code, what = code) => { for (let n = 0; n < 200; n++) { if (await js(code)) return; await new Promise((r) => setTimeout(r, 30)) } throw new Error(`Timed out (screens): ${what}`) }
  const shot = async (name) => { await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await new Promise((r) => setTimeout(r, 150)); writeFileSync(join(output, name), (await win.webContents.capturePage()).toPNG()) }
  const typePassword = (value) => js(`(() => { const el = document.querySelector('.vnc-card input[type="password"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)

  try {
    await win.loadFile(resolve('out/renderer/index.html'))
    // The tailnet's machines: a section of their own in the sidebar, and rows in the hosts list.
    await until(`[...document.querySelectorAll('.section-title')].some((t) => t.textContent === 'Tailscale')`, 'Tailscale section')
    // The table shows running hosts by default: the online Mac is there, the offline PC only with All.
    await until(`!!document.querySelector('[data-host-key="tailnet/nMAC"]') && !document.querySelector('[data-host-key="tailnet/nWIN"]')`, 'tailnet hosts in the table')
    assert.match(await js(`document.querySelector('[data-host-key="tailnet/nMAC"]').textContent`), /Fixture Mac.*100\.64\.0\.10/, 'listed by name with its Tailscale address')
    assert.match(await js(`[...document.querySelectorAll('.nav-row')].find((r) => r.textContent.includes('All machines')).textContent`), /1\/2/, 'online / all')
    await shot('tailnet-hosts.png')

    // Double-clicking the Mac shows its screen: noVNC asks for the VNC password, the first is turned down.
    await js(`[...document.querySelectorAll('.nav-row')].find((r) => r.textContent.includes('Fixture Mac')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await until(`!!document.querySelector('.vnc-card input[type="password"]')`, 'password prompt')
    assert.equal(await js(`!!document.querySelector('.vnc-card input[placeholder="User name"]')`), false, 'a VNC password server asks for the password only')
    await shot('screen-signin.png')
    await typePassword('wrong')
    await js(`document.querySelector('.vnc-card button[type="submit"]').click()`)
    await until(`document.querySelector('.vnc-card-error')?.textContent.includes('Authentication failed')`, 'rejection shown')
    // noVNC logs the rejection it was given as an error; that one is expected here, nothing else is.
    const expected = errors.findIndex((m) => /^Failed when connecting: Security negotiation failed on security result \(reason: Authentication failed\)$/.test(m))
    if (expected >= 0) errors.splice(expected, 1)
    await typePassword('fixture-secret')
    await js(`document.querySelector('.vnc-card button[type="submit"]').click()`)
    await until(`!document.querySelector('.vnc-overlay') && document.querySelector('.vnc-screen canvas')?.width === ${W}`, 'connected screen')
    assert.equal(vnc.attempts(), 2)
    const px = await js(`(() => { const c = document.querySelector('.vnc-screen canvas'); return [...c.getContext('2d').getImageData(10, 10, 1, 1).data].slice(0, 3) })()`)
    assert.deepEqual(px, [0x33, 0x99, 0xff], 'the remote screen is drawn')
    assert.ok(fixture.calls().some((c) => c.channel === 'creds:set' && c.args[0] === 'vnc:tailnet/nMAC' && c.args[1].password === 'fixture-secret'), 'remembered once accepted, apart from RDP sign-ins')
    assert.ok(fixture.calls().some((c) => c.channel === 'vnc:prepare' && c.args[0].instanceKey === 'tailnet/nMAC'))
    await shot('screen-connected.png')

    // ⌥ on this Mac reaches a Mac as Meta (what macOS's key table reads as Option), not noVNC's Mode_switch.
    await js(`document.querySelector('.vnc-screen canvas').focus()`)
    await js(`(() => { const c = document.querySelector('.vnc-screen canvas'); for (const type of ['keydown', 'keyup']) c.dispatchEvent(new KeyboardEvent(type, { key: 'Alt', code: 'AltLeft', location: 1, bubbles: true, cancelable: true })) })()`)
    for (let n = 0; n < 50 && vnc.keys.length < 2; n++) await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(vnc.keys.map((k) => k.keysym.toString(16)), ['ffe7', 'ffe7'], '⌥ is sent as Meta_L to a Mac')

    // Closing the tab ends the session in main.
    await js(`[...document.querySelectorAll('.rdp-toolbar button')].find((b) => b.textContent === 'Disconnect').click()`)
    await until(`!document.querySelector('.vnc-screen')`, 'tab closed')
    assert.ok(fixture.calls().some((c) => c.channel === 'vnc:release'))

    // The phone layout: the saved password connects straight away, with the key bar's ⌘.
    await win.setSize(430, 932)
    await win.loadFile(resolve('out/renderer/index.html'), { query: { layout: 'mobile' } })
    await until(`!!document.querySelector('[data-host-key="tailnet/nMAC"]')`, 'phone host list')
    await js(`document.querySelector('[data-host-key="tailnet/nMAC"]').click()`)
    await until(`[...document.querySelectorAll('.m-sheet-item')].some((b) => b.textContent.includes('Share screen'))`, 'host sheet')
    await js(`[...document.querySelectorAll('.m-sheet-item')].find((b) => b.textContent.includes('Share screen')).click()`)
    await until(`document.querySelector('.vnc-screen canvas')?.width === ${W} && !document.querySelector('.vnc-overlay')`, 'phone screen')
    assert.equal(await js(`document.querySelector('.m-keybar [aria-label^="Command"]')?.textContent`), '⌘')
    await shot('screen-phone.png')
    win.destroy()
  } catch (e) {
    await shot('screens-failure.png').catch(() => undefined)
    throw e
  } finally {
    fixture.setTailnet(null)
    fixture.allowWs(null)
    vnc.close()
  }
}
