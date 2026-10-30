import { openPdf, renderPage } from './lib/pdf'
import type { WorkerBridge } from '../../preload'

declare global {
  interface Window {
    workerBridge: WorkerBridge
  }
}

const toPng = (canvas: HTMLCanvasElement) =>
  new Promise<Uint8Array>((resolve, reject) =>
    canvas.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a))) : reject(new Error('encode failed'))), 'image/png')
  )

/** Overlay a 0..1000 coordinate grid so Claude can read off figure boxes. */
function drawGrid(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')!
  const { width: w, height: h } = canvas
  ctx.save()
  for (let u = 50; u < 1000; u += 50) {
    const major = u % 100 === 0
    ctx.strokeStyle = major ? 'rgba(0, 120, 255, 0.45)' : 'rgba(0, 120, 255, 0.18)'
    ctx.lineWidth = major ? 1 : 0.75
    const x = Math.round((u / 1000) * w) + 0.5
    const y = Math.round((u / 1000) * h) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
    if (major) {
      ctx.font = 'bold 12px Helvetica'
      ctx.fillStyle = 'rgba(0, 90, 220, 0.95)'
      for (const [tx, ty] of [
        [x + 2, 12],
        [x + 2, h - 3]
      ])
        ctx.fillText(String(u), tx, ty)
      for (const [tx, ty] of [
        [2, y - 2],
        [w - 26, y - 2]
      ])
        ctx.fillText(String(u), tx, ty)
    }
  }
  ctx.restore()
}

/** Crop a page region (bbox in 0..1000 units), then trim surrounding white space. */
async function crop(url: string, page: number, bbox: number[]): Promise<Uint8Array> {
  const full = await renderPage(url, page, 2200)
  const pad = 3
  const [x0, y0, x1, y1] = [
    Math.max(0, Math.min(bbox[0], bbox[2]) - pad),
    Math.max(0, Math.min(bbox[1], bbox[3]) - pad),
    Math.min(1000, Math.max(bbox[0], bbox[2]) + pad),
    Math.min(1000, Math.max(bbox[1], bbox[3]) + pad)
  ]
  const sx = Math.round((x0 / 1000) * full.width)
  const sy = Math.round((y0 / 1000) * full.height)
  const sw = Math.max(1, Math.round(((x1 - x0) / 1000) * full.width))
  const sh = Math.max(1, Math.round(((y1 - y0) / 1000) * full.height))
  const data = full.getContext('2d')!.getImageData(sx, sy, sw, sh).data
  const ink = (x: number, y: number) => {
    const i = (y * sw + x) * 4
    return data[i] + data[i + 1] + data[i + 2] < 3 * 242
  }
  let top = 0, bottom = sh - 1, left = 0, right = sw - 1
  const rowInk = (y: number) => { for (let x = 0; x < sw; x += 2) if (ink(x, y)) return true; return false }
  const colInk = (x: number) => { for (let y = top; y <= bottom; y += 2) if (ink(x, y)) return true; return false }
  while (top < bottom && !rowInk(top)) top++
  while (bottom > top && !rowInk(bottom)) bottom--
  while (left < right && !colInk(left)) left++
  while (right > left && !colInk(right)) right--
  const margin = 16
  top = Math.max(0, top - margin)
  left = Math.max(0, left - margin)
  bottom = Math.min(sh - 1, bottom + margin)
  right = Math.min(sw - 1, right + margin)
  const out = document.createElement('canvas')
  out.width = right - left + 1
  out.height = bottom - top + 1
  out.getContext('2d')!.drawImage(full, sx + left, sy + top, out.width, out.height, 0, 0, out.width, out.height)
  return toPng(out)
}

const methods: Record<string, (a: any) => Promise<unknown>> = {
  async info({ url }) {
    const doc = await openPdf(url)
    return { pages: doc.numPages }
  },
  async render({ url, page, width, grid }) {
    const canvas = await renderPage(url, page, width)
    if (grid) drawGrid(canvas)
    return toPng(canvas)
  },
  crop: ({ url, page, bbox }) => crop(url, page, bbox)
}

window.workerBridge.onCall(async (id, method, args) => {
  try {
    const fn = methods[method]
    if (!fn) throw new Error(`unknown method ${method}`)
    window.workerBridge.reply(id, null, await fn(args))
  } catch (e) {
    window.workerBridge.reply(id, String((e as Error)?.message || e), null)
  }
})
window.workerBridge.ready()
