import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Small floating menu anchored to a button. Portalled to body because the title bar and toolbars clip overflow;
 * closes on an outside press or Escape and flips above the anchor when it would run off the bottom of the window.
 */
export default function Popover({ anchor, onClose, children, align = 'left', width }: {
  anchor: HTMLElement | null
  onClose: () => void
  children: ReactNode
  align?: 'left' | 'right'
  width?: number
}): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return
    const a = anchor.getBoundingClientRect()
    const m = ref.current.getBoundingClientRect()
    let top = a.bottom + 4
    if (top + m.height > window.innerHeight - 8) top = Math.max(8, a.top - m.height - 4)
    let left = align === 'right' ? a.right - m.width : a.left
    left = Math.max(8, Math.min(left, window.innerWidth - m.width - 8))
    setPos({ top, left })
  }, [anchor, align])

  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (ref.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return
      closeRef.current()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeRef.current()
      }
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key, true)
    }
  }, [anchor])

  if (!anchor) return null
  return createPortal(
    <div
      ref={ref}
      className="popover panel no-drag fixed z-50 border py-1 text-xs"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, minWidth: width ? undefined : 180 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  )
}

/** A row inside a Popover. */
export function MenuItem({ children, onClick, disabled, on, hint, danger, title }: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  on?: boolean
  hint?: ReactNode
  danger?: boolean
  title?: string
}): ReactElement {
  return (
    <button type="button" className={`menu-item ${on ? 'on' : ''} ${danger ? 'danger' : ''}`} disabled={disabled} title={title} onClick={onClick}>
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      {hint && <span className="muted shrink-0 text-[10px]">{hint}</span>}
    </button>
  )
}

export function MenuSep(): ReactElement {
  return <div className="my-1 border-t" style={{ borderColor: 'var(--border)' }} />
}

export function MenuLabel({ children }: { children: ReactNode }): ReactElement {
  return <div className="section-title px-3 pb-1 pt-1.5">{children}</div>
}
