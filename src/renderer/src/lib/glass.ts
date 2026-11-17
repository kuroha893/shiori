/**
 * Liquid glass on the trays that float over the wallpaper (the space switch, the status area, the reader's bar): near
 * the rim the picture behind bends inward and its colours run richer; inside the rim it is clear. The lens is an SVG
 * displacement filter made for each size the element takes and handed to CSS as --lens; room.css decides the rest.
 */

interface Kind {
  sel: string
  /** how far in from the rim the picture bends, and by how much at most, in CSS pixels */
  bezel: number
  scale: number
  /** the element's glass is a layer this much larger on each side */
  pad?: number
}

const KINDS: Kind[] = [
  { sel: '.topbar .topbar-actions', bezel: 10, scale: 22 },
  { sel: '.reader-nav', bezel: 10, scale: 22 },
  { sel: '.space-switch', bezel: 8, scale: 18 }
]

/** Signed distance from a rounded rectangle's edge (negative inside), for a w×h box with corner radius r. */
function edge(w: number, h: number, r: number) {
  return (x: number, y: number): number => {
    const qx = Math.abs(x - w / 2) - (w / 2 - r)
    const qy = Math.abs(y - h / 2) - (h / 2 - r)
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
  }
}

/** A displacement map for a w×h lens: neutral grey inside, and near the rim pointing inward, strongest at the edge. */
function lensMap(w: number, h: number, r: number, bezel: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(w, h)
  const d = img.data
  d.fill(128)
  for (let i = 3; i < d.length; i += 4) d[i] = 255
  const sdf = edge(w, h, r)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const depth = -sdf(px, py)
      if (!(depth > 0 && depth < bezel)) continue
      const nx = sdf(px + 0.5, py) - sdf(px - 0.5, py)
      const ny = sdf(px, py + 0.5) - sdf(px, py - 0.5)
      const n = Math.hypot(nx, ny) || 1
      const t = 1 - depth / bezel
      const f = t * t * (3 - 2 * t)
      // feDisplacementMap samples at p + scale·(channel − ½): against the normal pulls the picture in from the rim
      const i = (y * w + x) * 4
      d[i] = 128 - (nx / n) * f * 127
      d[i + 1] = 128 - (ny / n) * f * 127
    }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL()
}

/** Starts the glass on the page; returns a function that takes it away again. */
export function startGlass(): () => void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.position = 'absolute'
  document.body.appendChild(svg)

  const filters = new Map<string, string>()
  const filterFor = (w: number, h: number, r: number, k: Kind): string => {
    const key = `${w}x${h}r${r}b${k.bezel}s${k.scale}`
    let id = filters.get(key)
    if (id) return id
    id = `glass-lens-${filters.size}`
    svg.insertAdjacentHTML(
      'beforeend',
      `<filter id="${id}" x="0" y="0" width="${w}" height="${h}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">` +
        `<feGaussianBlur in="SourceGraphic" stdDeviation="0.4" result="b"/>` +
        `<feImage href="${lensMap(w, h, r, k.bezel)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="m"/>` +
        `<feDisplacementMap in="b" in2="m" scale="${k.scale}" xChannelSelector="R" yChannelSelector="G" result="d"/>` +
        `<feColorMatrix in="d" type="saturate" values="1.5"/></filter>`
    )
    filters.set(key, id)
    return id
  }

  const kindOf = new Map<HTMLElement, Kind>()
  const lens = (el: HTMLElement): void => {
    const k = kindOf.get(el)
    if (!k || !el.offsetWidth || !el.offsetHeight) return
    const pad = k.pad ?? 0
    const w = el.offsetWidth + pad * 2
    const h = el.offsetHeight + pad * 2
    const r = Math.round(Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, h / 2))
    const value = `url(#${filterFor(w, h, r, k)})`
    if (el.style.getPropertyValue('--lens') !== value) el.style.setProperty('--lens', value)
  }
  const sizes = new ResizeObserver((entries) => entries.forEach((e) => lens(e.target as HTMLElement)))

  // the switch and the block come and go with pages
  const scan = (): void => {
    for (const k of KINDS)
      for (const el of document.querySelectorAll<HTMLElement>(k.sel))
        if (!kindOf.has(el)) {
          kindOf.set(el, k)
          sizes.observe(el)
        }
    for (const el of [...kindOf.keys()])
      if (!el.isConnected) {
        sizes.unobserve(el)
        kindOf.delete(el)
      }
  }
  let timer = 0
  const pages = new MutationObserver(() => {
    if (!timer) timer = window.setTimeout(() => ((timer = 0), scan()), 100)
  })
  pages.observe(document.body, { childList: true, subtree: true })
  scan()

  return () => {
    clearTimeout(timer)
    sizes.disconnect()
    pages.disconnect()
    for (const el of kindOf.keys()) el.style.removeProperty('--lens')
    svg.remove()
  }
}
