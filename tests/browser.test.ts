import { test } from 'node:test'
import assert from 'node:assert/strict'
import { frequentSites, loginMatches, matchesWords, searchHistory, siteOf } from '../src/shared/browser.ts'
import { AWS_SERVICES, consoleHome, ec2InstanceUrl, federationLoginUrl, federationTokenUrl, hostOf, isAwsConsoleUrl, isAwsSignInPage, isWebUrl, normalizeInput, partitionFor, restorableUrl, signInDestination } from '../src/shared/browser.ts'

test('typed text becomes an address, or a search', () => {
  assert.equal(normalizeInput('jira.example.com/browse/PLM-1'), 'https://jira.example.com/browse/PLM-1')
  assert.equal(normalizeInput('https://grafana.local:3000'), 'https://grafana.local:3000')
  assert.equal(normalizeInput('localhost:8080/health'), 'http://localhost:8080/health')
  assert.equal(normalizeInput('10.1.2.91:8443'), 'http://10.1.2.91:8443')
  assert.equal(normalizeInput('tomee heap size'), 'https://www.google.com/search?q=tomee%20heap%20size')
  assert.equal(normalizeInput('  '), '')
})

test('only web pages load, and each space has its own cookie container', () => {
  for (const ok of ['https://x.com', 'http://localhost:3000', 'about:blank']) assert.equal(isWebUrl(ok), true, ok)
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', undefined]) assert.equal(isWebUrl(bad), false, String(bad))
  assert.equal(partitionFor('aws-pplm'), 'persist:web-aws-pplm')
  assert.equal(partitionFor('my space!'), 'persist:web-my_space_')
  assert.notEqual(partitionFor('aws-pplm'), partitionFor('aws-qplm'))
  assert.equal(hostOf('https://www.google.com/search?q=x'), 'google.com')
})

test('AWS console addresses are regional, and the sign-in page is recognised with where it was going', () => {
  assert.equal(consoleHome('us-west-1'), 'https://us-west-1.console.aws.amazon.com/console/home?region=us-west-1')
  assert.equal(ec2InstanceUrl('us-west-1', 'i-0abc'), 'https://us-west-1.console.aws.amazon.com/ec2/home?region=us-west-1#InstanceDetails:instanceId=i-0abc')
  assert.ok(AWS_SERVICES.every((s) => isAwsConsoleUrl(s.url('us-west-1'))))
  const redirect = 'https://us-west-1.console.aws.amazon.com/ec2/home?region=us-west-1&state=abc'
  const signin = `https://us-west-1.signin.aws.amazon.com/oauth?client_id=x&redirect_uri=${encodeURIComponent(redirect)}`
  assert.equal(isAwsSignInPage(signin), true)
  assert.equal(signInDestination(signin), redirect)
  assert.equal(isAwsSignInPage('https://signin.aws.amazon.com/federation?Action=login'), false)
  assert.equal(isAwsSignInPage('https://us-west-1.console.aws.amazon.com/ec2/home'), false)
  assert.equal(signInDestination('https://signin.aws.amazon.com/oauth?redirect_uri=https%3A%2F%2Fevil.example%2F'), null)
})

test('federation URLs carry the session and the destination', () => {
  const t = new URL(federationTokenUrl({ accessKeyId: 'ASIA1', secretAccessKey: 's/ec+ret', sessionToken: 'tok=en' }))
  assert.equal(t.searchParams.get('Action'), 'getSigninToken')
  assert.deepEqual(JSON.parse(t.searchParams.get('Session')!), { sessionId: 'ASIA1', sessionKey: 's/ec+ret', sessionToken: 'tok=en' })
  const l = new URL(federationLoginUrl('SIGNIN&TOKEN', 'https://us-west-1.console.aws.amazon.com/ec2/home?region=us-west-1#Instances:'))
  assert.equal(l.searchParams.get('SigninToken'), 'SIGNIN&TOKEN')
  assert.equal(l.searchParams.get('Destination'), 'https://us-west-1.console.aws.amazon.com/ec2/home?region=us-west-1#Instances:')
})

test('a used federation link is kept as the console page it opened, never with its token', () => {
  const dest = 'https://us-west-1.console.aws.amazon.com/ec2/home?region=us-west-1#Instances:'
  assert.equal(restorableUrl(federationLoginUrl('SECRET', dest)), dest)
  assert.equal(restorableUrl('https://jira.example.com/browse/X-1'), 'https://jira.example.com/browse/X-1')
  assert.equal(restorableUrl('https://signin.aws.amazon.com/federation?Action=login'), '')
})

test('the command bar matches every word, and history is newest first without repeats', () => {
  assert.equal(matchesWords('pplm ec2', 'PPLM', 'EC2 instances'), true)
  assert.equal(matchesWords('pplm s3', 'PPLM', 'EC2 instances'), false)
  assert.equal(matchesWords('', 'anything'), true)
  const h = [
    { url: 'https://a.com/1', title: 'Alpha one', spaceId: 'general', at: 1 },
    { url: 'https://b.com/', title: 'Beta', spaceId: 'aws-pplm', at: 2 },
    { url: 'https://a.com/1', title: 'Alpha one', spaceId: 'general', at: 3 },
    { url: 'https://a.com/2', title: 'Alpha two', spaceId: 'general', at: 4 }
  ]
  assert.deepEqual(searchHistory(h, 'alpha', 5).map((x) => x.at), [4, 3])
  assert.deepEqual(searchHistory(h, '', 5, 'aws-pplm').map((x) => x.url), ['https://b.com/'])
  assert.deepEqual(frequentSites(h, 'general', 4), [{ host: 'a.com', url: 'https://a.com/', visits: 3 }])
})

test('saved logins match pages of the same site, never another one', () => {
  assert.equal(siteOf('jira.example.com'), 'example.com')
  assert.equal(siteOf('a.example.co.uk'), 'example.co.uk')
  assert.equal(siteOf('10.1.2.3'), '10.1.2.3')
  assert.equal(siteOf('localhost'), 'localhost')
  assert.equal(loginMatches(['https://id.example.com/login'], 'https://jira.example.com/browse/X-1'), true)
  assert.equal(loginMatches(['example.com'], 'https://example.com/'), true)
  assert.equal(loginMatches(['https://example.com'], 'https://example.com.evil.io/'), false)
  assert.equal(loginMatches(['https://examplecorp.com'], 'https://example.com/'), false)
  assert.equal(loginMatches([], 'https://example.com/'), false)
  assert.equal(loginMatches(['https://example.com'], 'about:blank'), false)
})

test('a space keeps only a #rrggbb colour of its own, and one emoji as its icon', async () => {
  const { isHexColor, lastGrapheme } = await import('../src/shared/browser.ts')
  assert.equal(isHexColor('#00b4a6'), true)
  assert.equal(isHexColor('#00B4A6'), true)
  for (const bad of ['00b4a6', '#0b4', '#00b4a6;background:url(x)', 'red', 7, undefined]) assert.equal(isHexColor(bad), false, String(bad))
  assert.equal(lastGrapheme('💼'), '💼')
  assert.equal(lastGrapheme('💼🚀'), '🚀', 'picking another emoji replaces the first')
  assert.equal(lastGrapheme('👩‍💻'), '👩‍💻', 'a joined emoji is one character')
  assert.equal(lastGrapheme('🇺🇸'), '🇺🇸')
  assert.equal(lastGrapheme('  '), '')
})
