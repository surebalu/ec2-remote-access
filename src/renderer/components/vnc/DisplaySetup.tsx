import { useMemo, useState, type ReactElement } from 'react'
import { layoutFromSizes, parseSizes, resolveDisplays, sizesText, type DisplayLayout } from '@shared/displays'
import Sheet from '../mobile/Sheet'

/**
 * Where a computer's displays sit, described once. A Mac shares all its displays as one wide picture, and the page can
 * show one of them only by knowing which part of the picture it is. The sizes are the ones System Settings → Displays
 * lists (points), left to right, and the page checks them against the picture's real size before anything is saved.
 */
export default function DisplaySetup({ hostName, picture, initial, problem, onSave, onClose }: {
  hostName: string
  picture: { width: number; height: number }
  initial: DisplayLayout | null
  problem?: string
  onSave: (layout: DisplayLayout | null) => void
  onClose: () => void
}): ReactElement {
  const [text, setText] = useState(initial ? sizesText(initial.sizes) : '')
  const [direction, setDirection] = useState<DisplayLayout['direction']>(initial?.direction ?? 'row')
  const [align, setAlign] = useState<DisplayLayout['align']>(initial?.align ?? 'center')
  const sizes = useMemo(() => parseSizes(text), [text])
  const layout: DisplayLayout | null = sizes ? { sizes, direction, align } : null
  const check = useMemo(() => (layout ? resolveDisplays(layoutFromSizes(layout), picture) : null), [text, direction, align, picture.width, picture.height]) // eslint-disable-line react-hooks/exhaustive-deps
  const ok = !!check && check.displays.length > 0
  const choice = <T extends string>(value: T, current: T, set: (v: T) => void, label: string): ReactElement => (
    <button type="button" role="radio" aria-checked={value === current} className={value === current ? 'on' : ''} onClick={() => set(value)}>{label}</button>
  )
  return (
    <Sheet title={`Displays of ${hostName}`} subtitle="Type each display's size, the way System Settings → Displays lists it, in order. Add @2x after a Retina display (a Mac's built-in one)." onClose={onClose}>
      <div className="vt-setup">
        <label>
          <span className="vt-setup-label">Sizes, {direction === 'row' ? 'left to right' : 'top to bottom'}</span>
          <input className="input" inputMode="text" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="1800×1169@2x, 5120×1440" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <div className="vt-setup-pair">
          <div>
            <span className="vt-setup-label">Arranged</span>
            <div className="m-segment" role="radiogroup" aria-label="Arrangement">
              {choice('row', direction, setDirection, 'Side by side')}
              {choice('column', direction, setDirection, 'Stacked')}
            </div>
          </div>
          <div>
            <span className="vt-setup-label">Shorter ones sit at the</span>
            <div className="m-segment" role="radiogroup" aria-label="Alignment">
              {choice('start', align, setAlign, direction === 'row' ? 'Top' : 'Left')}
              {choice('center', align, setAlign, 'Middle')}
              {choice('end', align, setAlign, direction === 'row' ? 'Bottom' : 'Right')}
            </div>
          </div>
        </div>
        <p className={`vt-setup-note ${ok ? 'ok' : text && !sizes ? 'bad' : check && !ok ? 'bad' : ''}`} role="status">
          {!text ? (problem ?? `The screen picture is ${picture.width}×${picture.height}. Its displays are not known yet.`)
            : !sizes ? 'Write each size as width×height, for example 1800×1169@2x, 5120×1440, separated by commas.'
              : ok ? `Matches the screen picture (${picture.width}×${picture.height}): ${check!.displays.map((d) => `${d.name} ${d.points.width}×${d.points.height}`).join(' · ')}.`
                : (check?.problem ?? 'These sizes do not fit the screen picture.')}
        </p>
        <div className="vt-setup-actions">
          {initial && <button type="button" className="btn" onClick={() => onSave(null)}>Forget</button>}
          <span className="flex-1" />
          <button type="button" className="btn btn-primary" disabled={!ok} onClick={() => layout && onSave(layout)}>Save</button>
        </div>
      </div>
    </Sheet>
  )
}
