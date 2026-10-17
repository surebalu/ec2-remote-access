import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import Sheet from './Sheet'

/**
 * The paste box. A terminal or desktop canvas has no text field for iOS to offer Paste on, so this gives it one where
 * a long press → Paste always works. Multi-line clipboard text also lands here first, so a line break cannot run a
 * half-copied command before the user has seen it.
 */
export function PasteSheet({ initial, action, onSend, onClose }: { initial: string; action: string; onSend: (text: string) => void; onClose: () => void }): ReactElement {
  const [text, setText] = useState(initial)
  const lines = text ? text.replace(/\r?\n$/, '').split(/\r\n|\r|\n/).length : 0
  return (
    <Sheet title="Paste" subtitle={initial ? 'Line breaks press Enter. Check the text before sending it.' : 'Long-press in the box and choose Paste, or type.'} onClose={onClose}>
      <textarea
        className="m-paste-input"
        aria-label="Text to send"
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
      />
      <button className="btn btn-primary m-sheet-action" disabled={!text} onClick={() => onSend(text)}>
        {lines > 1 ? `${action} ${lines} lines` : action}
      </button>
    </Sheet>
  )
}

/**
 * Terminal text in a read-only field. xterm.js has no touch selection, so this is where iOS's own selection handles
 * and Copy work on a phone.
 */
export function CopySheet({ text, onClose }: { text: string; onClose: () => void }): ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [selected, setSelected] = useState(false)
  const toast = useStore((s) => s.toast)
  useEffect(() => {
    const t = ref.current
    if (t) t.scrollTop = t.scrollHeight
  }, [])
  const copy = (): void => {
    const t = ref.current
    if (!t) return
    const part = t.selectionEnd > t.selectionStart ? t.value.slice(t.selectionStart, t.selectionEnd) : t.value
    // Invoked synchronously from the tap: on the gateway this is navigator.clipboard.writeText, which needs the gesture.
    void window.api.invoke('clipboard:write', part).then(() => { toast('success', 'Copied'); onClose() }, (e: Error) => toast('error', e.message))
  }
  return (
    <Sheet title="Select text" subtitle="Long-press to select, then Copy. The button copies the selection, or everything when nothing is selected." onClose={onClose}>
      <textarea
        ref={ref}
        className="m-copy-text"
        aria-label="Terminal text"
        readOnly
        value={text}
        onSelect={(e) => setSelected(e.currentTarget.selectionEnd > e.currentTarget.selectionStart)}
      />
      <button className="btn btn-primary m-sheet-action" disabled={!text} onPointerDown={(e) => e.preventDefault()} onClick={copy}>
        {selected ? 'Copy selection' : 'Copy all'}
      </button>
    </Sheet>
  )
}
