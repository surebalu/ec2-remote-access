/**
 * Voice dictation (channels voice:*). Each dictation runs the native helper `ec2ra-dictate` (native/dictation), which
 * listens through Apple's speech recognizer and prints JSON lines; they are relayed as `voice:event` to this
 * computer's own windows only, never to paired phones (they would otherwise hear what is said at the Mac). Everything
 * that needs Electron (the helper's location, the microphone permission, the windows) comes from `host().voice`, which
 * the gateway leaves null.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { VoiceStatus } from '@shared/types'
import { parseHelperLine, parseStatusOutput } from '@shared/dictation'
import { host, type VoiceHost } from './host'
import { getSettings } from './store'
import { log } from './log'

export const NO_VOICE_HERE = 'Dictation runs in the Mac app; on iPhone or iPad use the keyboard’s microphone key.'
const MISSING_HELPER = 'The dictation helper is missing from this build. Run scripts/build-dictation.sh (it needs Xcode or its Command Line Tools), then restart the app.'

interface Dictation {
  id: string
  proc: ChildProcessWithoutNullStreams
  /** An error or final text was already reported, so the exit needs no message of its own. */
  reported: boolean
  killTimer?: ReturnType<typeof setTimeout>
}

let current: Dictation | null = null

function voiceHost(): VoiceHost {
  const v = host().voice
  if (!v) throw new Error(NO_VOICE_HERE)
  return v
}

/** Whether a dictation is listening (webviews.ts forwards Escape from a page only then). */
export function isDictating(): boolean {
  return !!current
}

const unavailable = (message: string, extra: Partial<VoiceStatus> = {}): VoiceStatus => ({
  available: false, helper: false, message, mic: 'unknown', speech: 'unknown', onDevice: false, locale: '', supported: false, locales: [], ...extra
})

/** What dictation can do here, asking nothing: the helper's --status never requests a permission. */
export async function voiceStatus(opts?: { locale?: string }): Promise<VoiceStatus> {
  const v = host().voice
  if (!v) return unavailable(NO_VOICE_HERE)
  const bin = v.helperPath()
  if (!bin) return unavailable(MISSING_HELPER, { mic: v.microphoneStatus() })
  const locale = opts?.locale ?? getSettings().dictationLocale ?? ''
  const stdout = await new Promise<string>((resolve) => {
    execFile(bin, ['--status', ...(locale ? ['--locale', locale] : [])], { timeout: 8000 }, (err, out) => {
      if (err) log('voice', 'status failed', { message: err.message })
      resolve(String(out ?? ''))
    })
  })
  const st = parseStatusOutput(stdout)
  if (!st) return unavailable('The dictation helper did not answer. See the log for details.', { helper: true, mic: v.microphoneStatus() })
  const message = !st.supported
    ? `Dictation does not support ${locale || st.locale}. Pick another language.`
    : !st.recognizerAvailable ? 'Speech recognition is unavailable right now (offline, or Dictation is off in System Settings → Keyboard).' : undefined
  const { recognizerAvailable: _r, ...rest } = st
  // The app's own view of the microphone is the one that matters (the helper inherits it).
  return { ...rest, available: st.supported, helper: true, message, mic: v.microphoneStatus() }
}

/** Starts a dictation (ending any other first). Events for its id follow as voice:event, always ending with `end`. */
export async function startVoice(opts?: { id?: string; locale?: string }): Promise<{ id: string }> {
  const v = voiceHost()
  const bin = v.helperPath()
  if (!bin) throw new Error(MISSING_HELPER)
  if (current) cancelVoice(current.id)
  // The app asks for the microphone itself, so the prompt names EC2 Remote Access and comes from a real key press or click.
  if (!(await v.askMicrophone())) throw new Error('Microphone access is off for EC2 Remote Access. Turn it on in System Settings → Privacy & Security → Microphone.')
  const id = opts?.id && /^[\w-]{1,64}$/.test(opts.id) ? opts.id : randomUUID()
  const locale = opts?.locale ?? getSettings().dictationLocale ?? ''
  const proc = spawn(bin, locale ? ['--locale', locale] : [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const d: Dictation = { id, proc, reported: false }
  current = d
  log('voice', 'dictation started', { locale: locale || 'system' })

  let buf = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    buf += chunk
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const ev = parseHelperLine(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (!ev) continue
      if (ev.kind === 'final' || ev.kind === 'error') d.reported = true
      if (ev.kind === 'error') log('voice', 'helper error', { message: ev.message })
      v.send('voice:event', { id, ...ev })
    }
  })
  // macOS frameworks log chatter on stderr; keep the tail for the log when something goes wrong.
  let stderr = ''
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000) })
  proc.stdin.on('error', () => undefined)
  const end = (message?: string): void => {
    clearTimeout(d.killTimer)
    if (current === d) current = null
    if (message && !d.reported) v.send('voice:event', { id, kind: 'error', message })
    v.send('voice:event', { id, kind: 'end' })
  }
  proc.on('error', (e) => end(`The dictation helper could not start: ${e.message}`))
  proc.on('exit', (code, signal) => {
    if (code !== 0 && !d.reported && !signal) log('voice', 'helper exited', { code, stderr: stderr.trim().slice(-600) })
    end(code === 0 || signal === 'SIGTERM' ? undefined : signal ? `Dictation stopped unexpectedly (${signal}).` : `Dictation stopped unexpectedly (exit ${code}).`)
  })
  return { id }
}

function command(d: Dictation, cmd: 'stop' | 'cancel', killAfterMs: number): void {
  try { d.proc.stdin.write(`${cmd}\n`) } catch { /* already gone */ }
  clearTimeout(d.killTimer)
  // The helper answers within ~2 s (it keeps the last partial if the recognizer is slow); never leave it running.
  d.killTimer = setTimeout(() => d.proc.kill('SIGTERM'), killAfterMs)
}

export function stopVoice(id: string): void {
  if (current?.id === id) command(current, 'stop', 4000)
}

export function cancelVoice(id: string): void {
  if (current?.id !== id) return
  current.reported = true
  command(current, 'cancel', 500)
}

/** Quitting: no helper outlives the app. */
export function closeAllVoice(): void {
  if (!current) return
  current.reported = true
  current.proc.kill('SIGTERM')
  current = null
}

export async function openPrivacyPane(pane: 'microphone' | 'speech'): Promise<void> {
  await voiceHost().openPrivacy(pane === 'speech' ? 'speech' : 'microphone')
}
