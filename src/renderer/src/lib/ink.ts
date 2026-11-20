/**
 * Ink for what sits straight on clear glass: dark over what is bright, white over what is dark. Any element marked
 * `.glass-ink` (words) or `.glass-tray` (a flat tray, such as the phone's row of people) inside the glass is judged on
 * its own, from what the page shows right under it, and gets data-ink="dark" or "light"; CSS does the rest. New words
 * or trays on the glass only need the class.
 *
 * What is under a point is read from the page itself, front to back: each element's background colour, a picture
 * (an <img>, or a background image such as the wallpaper) by its pixels there, until nothing shows through. Layers
 * that paint but take no pointer (the wallpaper and its veil) are not found by hit-testing, so they say so with
 * `data-ink-layer` and are looked at last.
 */

/* a band either side of the middle: once dark, it takes clearly darker ground to turn light again, and the other way
   round, so nothing flickers over ground that is half and half */
const TO_DARK = 0.63
const TO_LIGHT = 0.47
function settle(now: string | undefined, v: number): 'dark' | 'light' {
  if (now === 'dark') return v < TO_LIGHT ? 'light' : 'dark'
  if (now === 'light') return v > TO_DARK ? 'dark' : 'light'
  return v > (TO_DARK + TO_LIGHT) / 2 ? 'dark' : 'light'
}
/** how often to look again while the glass is up; scrolling and resizing look sooner */
const EVERY = 700

type Grid = { w: number; h: number; lum: Float32Array }
const GRID = 24
const grids = new Map<string, Grid | null | 'loading'>()

/** a picture's brightness as a small grid, read once; null when it cannot be read */
function gridOf(src: string): Grid | null | undefined {
  const known = grids.get(src)
  if (known === 'loading') return undefined
  if (known !== undefined) return known
  grids.set(src, 'loading')
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    try {
      const c = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
      c.canvas.width = GRID
      c.canvas.height = GRID
      c.drawImage(img, 0, 0, GRID, GRID)
      const d = c.getImageData(0, 0, GRID, GRID).data
      const lum = new Float32Array(GRID * GRID)
      for (let i = 0; i < lum.length; i++) lum[i] = luma(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])
      grids.set(src, { w: img.naturalWidth, h: img.naturalHeight, lum })
    } catch {
      grids.set(src, null)
    }
  }
  img.onerror = () => grids.set(src, null)
  img.src = src
  return undefined
}

const luma = (r: number, g: number, b: number): number => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

/** brightness of a picture drawn in box `r` (as `fit`), at the point x, y of the window */
function pictureAt(src: string, r: DOMRect, fit: string, x: number, y: number): number | undefined {
  const g = gridOf(src)
  if (!g) return g === null ? 0.85 : undefined
  let u = (x - r.left) / r.width
  let v = (y - r.top) / r.height
  if (fit === 'cover') {
    const k = Math.max(r.width / g.w, r.height / g.h)
    u = (x - r.left - (r.width - g.w * k) / 2) / (g.w * k)
    v = (y - r.top - (r.height - g.h * k) / 2) / (g.h * k)
  }
  const i = Math.min(GRID - 1, Math.max(0, Math.floor(v * GRID))) * GRID + Math.min(GRID - 1, Math.max(0, Math.floor(u * GRID)))
  return g.lum[i]
}

const urlOf = (bg: string): string | undefined => /url\("?([^")]+)"?\)/.exec(bg)?.[1]

function colourOf(css: string): { lum: number; a: number } | undefined {
  const m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+%?))?\)/.exec(css)
  if (!m) return undefined
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
  return a > 0 ? { lum: luma(+m[1], +m[2], +m[3]), a } : undefined
}

/** what one element shows at a point: its picture if it has one there, else its background colour */
function layerAt(el: Element, x: number, y: number): { lum: number; a: number } | undefined {
  const r = el.getBoundingClientRect()
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return undefined
  if (el instanceof HTMLImageElement && el.currentSrc) {
    const lum = pictureAt(el.currentSrc, r, getComputedStyle(el).objectFit, x, y)
    return lum === undefined ? undefined : { lum, a: 1 }
  }
  const s = getComputedStyle(el)
  const src = urlOf(s.backgroundImage)
  if (src) {
    const lum = pictureAt(src, r, s.backgroundSize, x, y)
    if (lum !== undefined) return { lum, a: 1 }
  }
  return colourOf(s.backgroundColor)
}

/** how bright the page is at a point of the window, leaving out the glass itself */
function brightnessAt(glass: Element, x: number, y: number): number | undefined {
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return undefined
  const stack = document.elementsFromPoint(x, y).filter((e) => !glass.contains(e))
  // the painters that take no pointer, top one first, then the page's own ground
  const below = [...document.querySelectorAll('[data-ink-layer]')].reverse()
  let lum = 0
  let shown = 0
  for (const el of [...stack.filter((e) => e !== document.documentElement && e !== document.body), ...below, document.body, document.documentElement]) {
    const l = layerAt(el, x, y)
    if (!l) continue
    lum += (1 - shown) * l.a * l.lum
    shown += (1 - shown) * l.a
    if (shown > 0.97) break
  }
  return shown > 0 ? lum / shown : undefined
}

/** Keeps the ink of every `.glass-ink` and `.glass-tray` inside `glass` right for what is under it; returns a function
 * that stops. */
export function startInk(glass: HTMLElement): () => void {
  let frame = 0
  const judge = () => {
    frame = 0
    if (document.hidden) return
    for (const el of glass.querySelectorAll<HTMLElement>('.glass-ink, .glass-tray')) {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      // a few points across the words; the brighter ones decide, since white ink drowns on any bright patch
      const seen: number[] = []
      const cols = Math.max(3, Math.min(8, Math.round(r.width / 24)))
      for (let i = 0; i < cols; i++)
        for (const fy of [0.3, 0.7]) {
          const v = brightnessAt(glass, r.left + ((i + 0.5) / cols) * r.width, r.top + fy * r.height)
          if (v !== undefined) seen.push(v)
        }
      if (!seen.length) continue
      seen.sort((a, b) => a - b)
      const ink = settle(el.dataset.ink, seen[Math.floor(seen.length * 0.75)])
      if (el.dataset.ink !== ink) el.dataset.ink = ink
    }
  }
  const soon = () => {
    if (!frame) frame = requestAnimationFrame(judge)
  }
  judge()
  const timer = window.setInterval(soon, EVERY)
  window.addEventListener('scroll', soon, { capture: true, passive: true })
  window.addEventListener('resize', soon)
  return () => {
    window.clearInterval(timer)
    cancelAnimationFrame(frame)
    window.removeEventListener('scroll', soon, { capture: true })
    window.removeEventListener('resize', soon)
  }
}
