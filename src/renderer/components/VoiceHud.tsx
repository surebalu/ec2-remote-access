import type { CSSProperties, ReactElement } from 'react'
import { dictationKeyLabel, transcriptTail } from '@shared/dictation'
import { useVoice, voice } from '../voice'
import { useStore } from '../store'
import { Icon } from './icons'

const BARS = 20

/**
 * The dictation pill at the bottom of the window: a live waveform from the microphone level, what has been heard so
 * far, where it will go, and how to finish. Only its buttons take clicks; everything under it stays usable.
 */
export default function VoiceHud(): ReactElement | null {
  const v = useVoice()
  const key = useStore((s) => s.settings?.dictationKey ?? 'AltRight')
  if (!v) return null
  const levels = [...Array(Math.max(0, BARS - v.levels.length)).fill(0), ...v.levels]
  const level = v.levels.at(-1) ?? 0
  const status = v.phase === 'starting' ? 'Starting…' : v.phase === 'finishing' ? 'Finishing…' : 'Listening…'
  const finishHint = `Release ${dictationKeyLabel(key) || 'the key'} to insert`
  return (
    <div className="voice-hud-wrap" aria-live="polite" style={v.lift ? { bottom: v.lift } : undefined}>
      <div className={`voice-hud ${v.phase}`} role="status" aria-label="Dictation" style={{ '--lvl': level } as CSSProperties}>
        <span className="voice-orb" aria-hidden>
          <Icon.mic />
        </span>
        {v.phase !== 'error' && (
          <span className="voice-wave" aria-hidden>
            {levels.map((l, i) => <span key={i} style={{ transform: `scaleY(${0.12 + 0.88 * l})` }} />)}
          </span>
        )}
        <div className="voice-main">
          {v.phase === 'error'
            ? <div className="voice-text error"><Icon.alert className="shrink-0" /><span>{v.error}</span></div>
            : <div className={`voice-text ${v.text ? '' : 'placeholder'}`}>{v.text ? transcriptTail(v.text) : status}</div>}
          {v.phase !== 'error' && (
            <div className="voice-meta">
              {v.onDevice !== undefined && (
                <span className={`voice-chip ${v.onDevice ? 'local' : ''}`} title={v.onDevice ? 'Recognised on this Mac; the audio does not leave it' : 'This language is recognised by Apple’s speech service'}>
                  {v.onDevice ? <Icon.lock /> : <Icon.cloud />}
                  {v.onDevice ? 'On this Mac' : 'Apple speech service'}
                </span>
              )}
              <span className="voice-into" title={v.into ? `The words go into ${v.into}` : 'Nothing has the keyboard: the words will be copied to the clipboard'}>
                {v.into ? <>into <b>{v.into}</b></> : 'to the clipboard'}
              </span>
              {/* With a mic button the Done button says it; holding a key, the release does. */}
              {v.via === 'hold' && <span className="voice-hint">{finishHint}</span>}
              <span className="voice-hint">Esc to cancel</span>
            </div>
          )}
        </div>
        {v.phase === 'error' && v.privacy && (
          <button type="button" className="voice-btn done" onMouseDown={(e) => e.preventDefault()} onClick={() => { void window.api.invoke('voice:openPrivacy', v.privacy!).catch(() => undefined); voice.cancel() }}>
            Open Privacy Settings
          </button>
        )}
        {v.via === 'toggle' && v.phase !== 'error' && (
          <button type="button" className="voice-btn done" onMouseDown={(e) => e.preventDefault()} onClick={() => voice.stop()} disabled={v.phase === 'finishing'}>
            Done
          </button>
        )}
        <button type="button" className="voice-btn close" aria-label={v.phase === 'error' ? 'Dismiss' : 'Cancel dictation'} title={v.phase === 'error' ? 'Dismiss' : 'Cancel (Esc)'} onMouseDown={(e) => e.preventDefault()} onClick={() => voice.cancel()}>
          <Icon.x />
        </button>
      </div>
    </div>
  )
}
