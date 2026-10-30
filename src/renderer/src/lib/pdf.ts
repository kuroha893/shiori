import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const docs = new Map<string, Promise<pdfjs.PDFDocumentProxy>>()

export function openPdf(url: string): Promise<pdfjs.PDFDocumentProxy> {
  let d = docs.get(url)
  if (!d) {
    d = pdfjs.getDocument({ url }).promise
    d.catch(() => docs.delete(url))
    docs.set(url, d)
  }
  return d
}

/** Render a page to a new canvas, `width` CSS pixels wide (times devicePixelRatio when hidpi). */
export async function renderPage(url: string, pageNo: number, width: number): Promise<HTMLCanvasElement> {
  const doc = await openPdf(url)
  const page = await doc.getPage(pageNo)
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: width / base.width })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(viewport.width)
  canvas.height = Math.round(viewport.height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvas, viewport }).promise
  return canvas
}
