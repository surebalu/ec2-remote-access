import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeGit, MAX_GIT_FILES, parseNumstat, parseStatus } from '../src/shared/gitStatus.ts'

const z = (...records: string[]): string => records.map((r) => `${r}\0`).join('')

test('porcelain v2: branch, upstream, ahead/behind and every kind of change', () => {
  const st = parseStatus(z(
    '# branch.oid 1234567890abcdef1234567890abcdef12345678',
    '# branch.head terminal-cyber-wave',
    '# branch.upstream origin/terminal-cyber-wave',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa src/renderer/styles.css',
    '1 A. N... 000000 100644 100644 0000000 bbbbbbb src/main/localgit.ts',
    '1 MM N... 100644 100644 100644 ccccccc ddddddd my file with spaces.md',
    '1 D. N... 100644 000000 000000 eeeeeee 0000000 old.txt',
    '2 R. N... 100644 100644 100644 fffffff fffffff R100 new name.ts',
    'old name.ts',
    'u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 conflict.ts',
    '? notes/draft.md'
  ))
  assert.equal(st.branch, 'terminal-cyber-wave')
  assert.equal(st.detached, false)
  assert.equal(st.upstream, 'origin/terminal-cyber-wave')
  assert.equal(st.ahead, 2)
  assert.equal(st.behind, 1)
  assert.equal(st.changed, 7)
  assert.deepEqual(st.files, [
    { path: 'src/renderer/styles.css', status: 'M', staged: false },
    { path: 'src/main/localgit.ts', status: 'A', staged: true },
    { path: 'my file with spaces.md', status: 'M', staged: true },
    { path: 'old.txt', status: 'D', staged: true },
    { path: 'new name.ts', status: 'R', staged: true, from: 'old name.ts' },
    { path: 'conflict.ts', status: 'U', staged: false },
    { path: 'notes/draft.md', status: '?', staged: false }
  ])
})

test('porcelain v2: a clean branch without upstream, a detached HEAD, a repository without commits', () => {
  const clean = parseStatus(z('# branch.oid 1234567890abcdef', '# branch.head main'))
  assert.deepEqual(clean, { branch: 'main', detached: false, ahead: 0, behind: 0, files: [], changed: 0, insertions: 0, deletions: 0 })
  const detached = parseStatus(z('# branch.oid 9fceb02d0ae598e95dc970b74767f19372d61af8', '# branch.head (detached)'))
  assert.equal(detached.branch, '9fceb02')
  assert.equal(detached.detached, true)
  const fresh = parseStatus(z('# branch.oid (initial)', '# branch.head main', '? README.md'))
  assert.equal(fresh.branch, 'main')
  assert.equal(fresh.changed, 1)
  assert.equal(parseStatus('').changed, 0)
})

test('the file list is capped but the count is not', () => {
  const many = Array.from({ length: MAX_GIT_FILES + 20 }, (_, i) => `? f${i}.txt`)
  const st = parseStatus(z('# branch.head main', ...many))
  assert.equal(st.files.length, MAX_GIT_FILES)
  assert.equal(st.changed, MAX_GIT_FILES + 20)
})

test('numstat: lines added and removed, binary files and renames', () => {
  assert.deepEqual(parseNumstat(z('10\t2\tsrc/a.ts', '-\t-\timage.png', '3\t0\t', 'old.ts', 'new.ts', '18\t6\tb c.md')), { insertions: 31, deletions: 8 })
  assert.deepEqual(parseNumstat(''), { insertions: 0, deletions: 0 })
})

test('the chip tooltip', () => {
  const st = parseStatus(z('# branch.head main', '# branch.upstream origin/main', '# branch.ab +1 -0', '? a'))
  assert.equal(describeGit({ ...st, insertions: 31, deletions: 8 }), '1 changed file · +31 −8 · 1 ahead origin/main')
  assert.equal(describeGit(parseStatus(z('# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -0'))), 'No changes · up to date with origin/main')
})

// The real thing, when git is installed: the parser reads what git prints. The user's global and system config are
// left out so nothing (commit signing, hooks, credential helpers) can reach the desktop.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { env: gitEnv, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

test('agrees with git itself', { skip: !hasGit && 'git is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec2ra-git-'))
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { env: gitEnv, encoding: 'utf8' })
  try {
    git('init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(dir, 'gone.txt'), 'bye\n')
    git('add', '.')
    git('commit', '-q', '-m', 'first')
    writeFileSync(join(dir, 'a.txt'), 'one\n2\nthree\nfour\n')
    unlinkSync(join(dir, 'gone.txt'))
    writeFileSync(join(dir, 'new file.txt'), 'hello\n')
    writeFileSync(join(dir, 'staged.txt'), 'x\ny\n')
    git('add', 'staged.txt')
    const st = parseStatus(git('status', '--porcelain=v2', '--branch', '-z'))
    Object.assign(st, parseNumstat(git('diff', '--numstat', '-z', 'HEAD')))
    assert.equal(st.branch, 'main')
    assert.equal(st.changed, 4)
    assert.deepEqual(st.files.map((f) => `${f.status} ${f.path}`).sort(), ['? new file.txt', 'A staged.txt', 'D gone.txt', 'M a.txt'])
    // a.txt: two lines added and one removed; gone.txt: one removed; staged.txt: two added (untracked files are not counted).
    assert.deepEqual({ insertions: st.insertions, deletions: st.deletions }, { insertions: 4, deletions: 2 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
