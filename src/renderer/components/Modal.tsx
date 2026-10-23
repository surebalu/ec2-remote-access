import type { ReactNode, ReactElement } from 'react'
import { useEffect, useId, useRef } from 'react'
import { Icon } from './icons'

/** `bare` drops the padding and the title row for dialogs with their own layout (Settings); the title stays for screen readers. */
export default function Modal({ title, onClose, children, width = 'max-w-lg', bare = false, className = '' }: { title: string; onClose: () => void; children: ReactNode; width?: string; bare?: boolean; className?: string }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const previousFocus = useRef(document.activeElement as HTMLElement | null)
  const titleId = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = previousFocus.current
    const panel = ref.current!
    const focusable = (): HTMLElement[] => [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]')].filter((el) => el.getClientRects().length > 0)
    if (!panel.contains(document.activeElement)) (panel.querySelector<HTMLElement>('[autofocus], input:not([disabled])') ?? panel).focus()
    const onKey = (e: KeyboardEvent): void => {
      if (document.querySelectorAll('.modal-backdrop').item(document.querySelectorAll('.modal-backdrop').length - 1) !== panel.parentElement) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current() }
      if (e.key === 'Tab') {
        const elements = focusable()
        const first = elements[0]
        const last = elements.at(-1)
        if (!first) { e.preventDefault(); panel.focus() }
        else if (e.shiftKey && (document.activeElement === first || !elements.includes(document.activeElement as HTMLElement))) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && (document.activeElement === last || !elements.includes(document.activeElement as HTMLElement))) { e.preventDefault(); first.focus() }
      }
    }
    // Handle UI keys before the RDP guard on window suppresses remote input.
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); if (previous?.isConnected) previous.focus() }
  }, [])
  return (
    <div className="modal-backdrop fixed inset-0 z-40 flex items-center justify-center" onMouseDown={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={`panel modal max-h-[calc(100vh-32px)] w-full ${width} border ${bare ? 'modal-bare overflow-hidden' : 'overflow-y-auto p-5'} ${className}`} onMouseDown={(e) => e.stopPropagation()}>
        {bare ? (
          <h2 id={titleId} className="sr-only">{title}</h2>
        ) : (
          <div className="mb-4 flex items-center justify-between">
            <h2 id={titleId} className="text-sm font-semibold tracking-tight">{title}</h2>
            <button className="btn btn-ghost btn-sm btn-icon" aria-label="Close dialog" onClick={onClose}>
              <Icon.x />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
