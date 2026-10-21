import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cookieSet, restorable } from '../src/shared/sessionCookies.ts'

test('only session cookies are kept: the others are on disk with their own expiry', () => {
  assert.equal(restorable({ name: 'jc_session', value: 'x', domain: 'sso.jumpcloud.com', session: true }), true)
  assert.equal(restorable({ name: '_ga', value: 'x', domain: '.jumpcloud.com', session: false }), false)
  assert.equal(restorable({ name: '', value: 'x', domain: 'a.com', session: true }), false)
})

test('a cookie goes back as it was: host-only without a domain, a domain cookie with it, still a session cookie', () => {
  assert.deepEqual(cookieSet({ name: 'TICKET_etagen', value: 'v', domain: 'etagen.quickbase.com', hostOnly: true, path: '/', secure: true, httpOnly: true, session: true, sameSite: 'no_restriction' }), {
    url: 'https://etagen.quickbase.com/', name: 'TICKET_etagen', value: 'v', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction'
  })
  const d = cookieSet({ name: 'jcsession', value: 'v', domain: '.jumpcloud.com', hostOnly: false, path: '/sso', secure: true, session: true })
  assert.deepEqual(d, { url: 'https://jumpcloud.com/sso', name: 'jcsession', value: 'v', domain: '.jumpcloud.com', path: '/sso', secure: true, httpOnly: false, sameSite: 'unspecified' })
  assert.equal('expirationDate' in d, false, 'no expiry: it stays a session cookie')
  // __Host- cookies are secure, for one host, never with a domain.
  const h = cookieSet({ name: '__Host-sid', value: 'v', domain: 'app.example.com', path: '/', session: true })
  assert.equal(h.url, 'https://app.example.com/')
  assert.equal(h.domain, undefined)
  assert.equal(cookieSet({ name: 'plain', value: 'v', domain: 'intranet.local', session: true }).url, 'http://intranet.local/')
})
