/**
 * The picture a Computers card shows (components/computers): a small JPEG of a session's screen, saved where the engine
 * runs (`computers:saveThumb`). Blank frames (a canvas not drawn yet, or one that cannot be read back) are skipped.
 */
const WIDTH = 640

export function captureThumb(canvas: HTMLCanvasElement | null | undefined): string | null {
  if (!canvas || !canvas.width || !canvas.height) return null
  const w = Math.min(WIDTH, canvas.width)
  const h = Math.max(1, Math.round((canvas.height * w) / canvas.width))
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  try {
    ctx.drawImage(canvas, 0, 0, w, h)
    // A few sampled pixels all black means nothing to show yet.
    const data = ctx.getImageData(0, 0, w, h).data
    let lit = false
    for (let i = 0; i < data.length && !lit; i += 4 * 997) lit = data[i] + data[i + 1] + data[i + 2] > 24
    return lit ? out.toDataURL('image/jpeg', 0.72) : null
  } catch {
    return null
  }
}

export function saveThumb(instanceKey: string, canvas: HTMLCanvasElement | null | undefined): void {
  const image = captureThumb(canvas)
  if (image) void window.api.invoke('computers:saveThumb', instanceKey, image).catch(() => undefined)
}
