import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Bottom sheet for phone menus. It carries the `modal-backdrop` class so the app's keyboard guards and the
 * "a dialog is open" checks treat it like any other dialog.
 */
export default function Sheet({ title, subtitle, onClose, children }: { title?: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode }): ReactElement {
  return createPortal(
    <div className="modal-backdrop m-sheet-backdrop" onClick={onClose}>
      <div className="m-sheet panel" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-grip" />
        {(title || subtitle) && (
          <div className="m-sheet-head">
            {title && <div className="m-sheet-title">{title}</div>}
            {subtitle && <div className="m-sheet-sub">{subtitle}</div>}
          </div>
        )}
        {children}
        <button className="m-sheet-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>,
    document.body
  )
}

export function SheetItem({ icon, children, hint, danger, disabled, onClick }: { icon?: ReactNode; children: ReactNode; hint?: ReactNode; danger?: boolean; disabled?: boolean; onClick: () => void }): ReactElement {
  return (
    <button className={`m-sheet-item ${danger ? 'danger' : ''}`} disabled={disabled} onClick={onClick}>
      {icon && <span className="m-sheet-icon">{icon}</span>}
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      {hint && <span className="muted text-[13px]">{hint}</span>}
    </button>
  )
}
