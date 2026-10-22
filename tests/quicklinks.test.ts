import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkQuicklink, cleanQuicklink, quicklinkFor, quicklinkUrl, type Quicklink } from '../src/shared/quicklinks.ts'

const aws: Quicklink = { id: 'a', name: 'AWS sign-in', keyword: 'aws', url: 'https://mainspring.awsapps.com/start', space: 'general' }
const jira: Quicklink = { id: 'j', name: 'Jira issue', keyword: 'jira', url: 'https://example.atlassian.net/browse/{query}', space: 'external' }

test('a keyword opens its link; text after it fills {query}', () => {
  assert.deepEqual(quicklinkFor('aws', [aws, jira]), { link: aws, rest: '' })
  assert.deepEqual(quicklinkFor('  AWS ', [aws, jira]), { link: aws, rest: '' }, 'any case, spaces around')
  assert.equal(quicklinkFor('aws console', [aws, jira]), null, 'a link without {query} matches only its keyword alone')
  assert.deepEqual(quicklinkFor('jira PLM-42', [aws, jira]), { link: jira, rest: 'PLM-42' })
  assert.equal(quicklinkUrl(jira, 'PLM 42/x'), 'https://example.atlassian.net/browse/PLM%2042%2Fx')
  assert.equal(quicklinkUrl(aws), 'https://mainspring.awsapps.com/start')
  assert.equal(quicklinkFor('awsx', [aws]), null)
  assert.equal(quicklinkFor('', [aws]), null)
  assert.equal(quicklinkFor('aws', [{ ...aws, keyword: '' }]), null, 'no keyword: found by name in the list only')
})

test('links are checked and cleaned as typed', () => {
  assert.equal(checkQuicklink({ name: 'AWS', keyword: 'aws', url: 'https://x.example' }, []), null)
  assert.match(checkQuicklink({ name: '', keyword: 'aws', url: 'https://x.example' }, [])!, /name/)
  assert.match(checkQuicklink({ name: 'A', keyword: 'two words', url: 'https://x.example' }, [])!, /one word/)
  assert.match(checkQuicklink({ name: 'A', keyword: 'AWS', url: 'https://x.example' }, [aws])!, /already/)
  assert.match(checkQuicklink({ name: 'A', keyword: 'a', url: 'javascript:alert(1)' }, [])!, /web addresses/)
  assert.match(checkQuicklink({ name: 'A', keyword: 'a', url: 'not a url' }, [])!, /full address/)
  assert.equal(checkQuicklink({ name: 'J', keyword: 'j', url: 'https://x.example/{query}' }, []), null, '{query} is allowed')
  const c = cleanQuicklink({ name: ' AWS ', keyword: ' aws ', url: 'mainspring.awsapps.com/start', space: '' })
  assert.deepEqual([c.name, c.keyword, c.url, c.space], ['AWS', 'aws', 'https://mainspring.awsapps.com/start', 'general'])
  assert.match(c.id, /^ql-/)
  assert.match(checkQuicklink(cleanQuicklink({ name: 'A', keyword: 'my aws', url: 'https://x', space: '' }), [])!, /one word/, 'a space inside the keyword is refused, not squeezed out')
  assert.equal(cleanQuicklink({ id: 'keep', name: 'x', keyword: '', url: 'https://x', space: 'external' }).id, 'keep')
})
