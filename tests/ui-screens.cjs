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
  const pointers = []
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
          if (type === 5) pointers.push({ mask: msg[1], x: msg.readUInt16BE(2), y: msg.readUInt16BE(4) })
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
  return new Promise((res) => wss.on('listening', () => res({ port: wss.address().port, keys, pointers, attempts: () => attempts, close: () => wss.close() })))
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
    // Closing a connected screen keeps its picture for the Computers card.
    assert.match(fixture.thumbs()['tailnet/nMAC']?.image ?? '', /^data:image\/jpeg;base64,/, 'a thumbnail was saved on close')

    // Computers: the tailnet as cards, the Mac with its last picture and answering, the PC offline.
    await js(`document.querySelector('.app-rail [aria-label="Computers"]').click()`)
    await until(`!!document.querySelector('.cmp-card[data-key="tailnet/nMAC"].has-thumb') && !!document.querySelector('.cmp-card[data-key="tailnet/nMAC"] .cmp-dot.open')`, 'Computers cards')
    assert.equal(await js(`document.querySelector('.cmp-card[data-key="tailnet/nWIN"]').classList.contains('off')`), true, 'the offline PC is dimmed')
    assert.equal(await js(`document.querySelector('.cmp-card[data-key="tailnet/nWIN"]').dataset.tone`), 'violet')
    assert.match(await js(`document.querySelector('.computers').textContent`), /Tailscale.*Fixture Mac.*Fixture PC/, 'grouped, named as people read them')
    await shot('computers.png')
    await js(`document.querySelector('.cmp-segment [role="tab"]:nth-child(2)').click()`)
    await until(`document.querySelector('.cmp-body').textContent.includes('Recent connections') && document.querySelector('.cmp-body').textContent.includes('Fixture Mac')`, 'recent connections')
    await js(`document.querySelector('.cmp-segment [role="tab"]:nth-child(1)').click()`)

    // The phone layout: the saved password connects straight away, with the floating toolbar.
    await win.setSize(430, 932)
    await win.loadFile(resolve('out/renderer/index.html'), { query: { layout: 'mobile' } })
    await until(`!!document.querySelector('[data-host-key="tailnet/nMAC"]')`, 'phone host list')
    await js(`document.querySelector('[data-host-key="tailnet/nMAC"]').click()`)
    await until(`[...document.querySelectorAll('.m-sheet-item')].some((b) => b.textContent.includes('Share screen'))`, 'host sheet')
    await js(`[...document.querySelectorAll('.m-sheet-item')].find((b) => b.textContent.includes('Share screen')).click()`)
    await until(`document.querySelector('.vnc-screen canvas')?.width === ${W} && !document.querySelector('.vnc-overlay') && !!document.querySelector('.vt-bar')`, 'phone screen')
    await until(`!!document.querySelector('.vnc-cursor')`, 'the trackpad pointer is drawn')
    const tap = (fx, fy) => js(`(() => {
      const layer = document.querySelector('.vnc-touch'); const r = document.querySelector('.vnc-screen canvas').getBoundingClientRect()
      const x = r.left + r.width * ${fx}, y = r.top + r.height * ${fy}
      for (const type of ['pointerdown', 'pointerup']) layer.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }))
    })()`)
    const settle = async (n) => { for (let i = 0; i < 50 && vnc.pointers.length < n; i++) await new Promise((r) => setTimeout(r, 20)) }
    // Trackpad: a tap clicks where the pointer is (the middle of the screen), not under the finger.
    vnc.pointers.length = 0
    await tap(0.9, 0.9)
    await settle(3)
    assert.deepEqual(vnc.pointers.map((p) => p.mask), [0, 1, 0])
    assert.deepEqual([vnc.pointers[1].x, vnc.pointers[1].y], [W / 2, H / 2], 'trackpad click at the pointer')
    // Settings → Pointer → Touch: now a tap clicks under the finger.
    await js(`document.querySelector('.vt-bar [aria-label="Settings"]').click()`)
    await until(`[...document.querySelectorAll('.vt-item')].some((b) => b.textContent === 'Pointer')`, 'settings menu')
    await shot('screen-phone-settings.png')
    await js(`[...document.querySelectorAll('.vt-item')].find((b) => b.textContent === 'Pointer').click()`)
    await until(`!!document.querySelector('.vt-sub')`, 'pointer choices')
    await js(`[...document.querySelectorAll('.vt-sub .vt-item')].find((b) => b.textContent.includes('Touch')).click()`)
    await until(`!document.querySelector('.vt-menu') && !document.querySelector('.vnc-cursor')`, 'touch mode')
    vnc.pointers.length = 0
    await tap(0.25, 0.75)
    await settle(3)
    assert.deepEqual([vnc.pointers[1].mask, Math.round(vnc.pointers[1].x / 4), Math.round(vnc.pointers[1].y / 5)], [1, Math.round((W * 0.25) / 4), Math.round((H * 0.75) / 5)], 'touch click under the finger')
    // The editing row's Copy is ⌘C on a Mac: Alt_L (what macOS reads as ⌘) held around c.
    vnc.keys.length = 0
    await js(`document.querySelector('.vt-bar [aria-label="Editing"]').click()`)
    await until(`!!document.querySelector('.vt-bar [aria-label="Copy"]')`, 'editing row')
    await js(`document.querySelector('.vt-bar [aria-label="Copy"]').click()`)
    for (let n = 0; n < 50 && vnc.keys.length < 4; n++) await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(vnc.keys.map((k) => `${k.down ? '+' : '-'}${k.keysym.toString(16)}`), ['+ffe9', '+63', '-63', '-ffe9'])
    // The shortcuts menu opens its groups in place.
    await js(`document.querySelector('.vt-bar [aria-label="Shortcuts"]').click()`)
    await js(`[...document.querySelectorAll('.vt-item')].find((b) => b.textContent === 'App').click()`)
    await until(`document.querySelector('.vt-sub')?.textContent.includes('Minimize')`, 'App shortcuts')
    await shot('screen-phone-shortcuts.png')
    await js(`document.querySelector('.vt-menu-layer').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
    await until(`!document.querySelector('.vt-menu')`, 'menu closed')

    // Display selection: this Mac's displays are not known, so describe them once (a 200×400 and a 440×300 display side by
    // side, centred, which scale to the 64×40 picture), then show the second one alone.
    const settingsItem = async (label) => {
      await until(`[...document.querySelectorAll('.vt-menu:not(.vt-sub) .vt-item')].some((b) => b.textContent === ${JSON.stringify(label)})`, `settings item ${label}`)
      await js(`[...document.querySelectorAll('.vt-menu:not(.vt-sub) .vt-item')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`)
    }
    const subItem = async (label) => {
      await until(`[...document.querySelectorAll('.vt-sub .vt-item')].some((b) => b.textContent.includes(${JSON.stringify(label)}))`, `choice ${label}`)
      await js(`[...document.querySelectorAll('.vt-sub .vt-item')].find((b) => b.textContent.includes(${JSON.stringify(label)})).click()`)
    }
    await js(`document.querySelector('.vt-bar [aria-label="Settings"]').click()`)
    await settingsItem('Displays')
    await subItem('Set up displays')
    await until(`!!document.querySelector('.vt-setup')`, 'display setup sheet')
    await js(`(() => { const el = document.querySelector('.vt-setup input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '200x400, 440x300'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await until(`document.querySelector('.vt-setup-note.ok')?.textContent.includes('Matches the screen picture (${W}×${H})')`, 'layout accepted')
    await shot('screen-phone-displays-setup.png')
    // A layout that does not add up is not accepted.
    await js(`(() => { const el = document.querySelector('.vt-setup input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '200x400, 540x300'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await until(`document.querySelector('.vt-setup-note.bad')?.textContent.includes('add up to') && [...document.querySelectorAll('.vt-setup .btn-primary')].every((b) => b.disabled)`, 'mismatch refused')
    await js(`(() => { const el = document.querySelector('.vt-setup input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '200x400, 440x300'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await until(`!document.querySelector('.vt-setup .btn-primary').disabled`, 'save enabled')
    await js(`document.querySelector('.vt-setup .btn-primary').click()`)
    await until(`!document.querySelector('.vt-setup')`, 'setup saved')
    const saved = fixture.calls().filter((c) => c.channel === 'computers:saveDisplays').pop()
    assert.deepEqual(saved.args[1], { sizes: [{ width: 200, height: 400 }, { width: 440, height: 300 }], direction: 'row', align: 'center' })
    await js(`document.querySelector('.vt-bar [aria-label="Settings"]').click()`)
    await settingsItem('Displays')
    await until(`[...document.querySelectorAll('.vt-sub .vt-item')].map((b) => b.textContent.replace('✓', '').trim()).join('|').startsWith('All displays|Display 1 · 200 × 400|Display 2 · 440 × 300|')`, 'the displays are listed')
    await subItem('Display 2')
    await until(`document.querySelector('.vnc-screen canvas').style.clipPath.includes('inset(12.5% 0% 12.5% 31.25%')`, 'cropped to the second display')
    assert.notEqual(await js(`document.querySelector('.vnc-screen').style.transform`), '', 'the view is zoomed to the display')
    await shot('screen-phone-display2.png')
    // Whatever is tapped, the click lands inside that display (x 20–63, y 5–34 of the picture).
    vnc.pointers.length = 0
    await tap(0.02, 0.02)
    await tap(0.98, 0.98)
    await settle(6)
    const inside = vnc.pointers.filter((p) => p.mask === 1)
    assert.equal(inside.length, 2)
    for (const p of inside) assert.ok(p.x >= 20 && p.x <= 63 && p.y >= 5 && p.y <= 34, `a click at ${p.x},${p.y} stays inside Display 2`)
    // The choice is remembered for this computer; All displays shows everything again.
    assert.equal(await js(`localStorage.getItem('ui.vncDisplay.tailnet/nMAC')`), '1')
    await js(`document.querySelector('.vt-bar [aria-label="Settings"]').click()`)
    await settingsItem('Displays')
    await subItem('All displays')
    await until(`document.querySelector('.vnc-screen canvas').style.clipPath === '' && document.querySelector('.vnc-screen').style.transform === ''`, 'all displays again')
    await shot('screen-phone.png')
    // Computers on the phone: its own button in the tab bar.
    await js(`[...document.querySelectorAll('.m-tabbar button')].find((b) => b.textContent.includes('Computers')).click()`)
    await until(`!!document.querySelector('.computers.is-mobile .cmp-card[data-key="tailnet/nMAC"]')`, 'phone Computers')
    await shot('computers-phone.png')
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
