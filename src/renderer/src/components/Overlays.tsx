import { useEffect, useRef, useState } from 'react'
import type { Block } from '../../../shared/types'
import { renderPage } from '../lib/pdf'
import { Icon } from './Icon'

/** The original PDF page next to the text, with the block's box marked when known. */
export function PdfPeek({ url, block, pages, onClose }: { url: string; block: Block; pages: number; onClose: () => void }) {
  const [page, setPage] = useState(block.page ?? 1)
  const holder = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const width = 540

  useEffect(() => setPage(block.page ?? 1), [block])

  useEffect(() => {
    let dead = false
    setLoading(true)
    renderPage(url, page, width * 2).then((canvas) => {
      if (dead || !holder.current) return
      canvas.style.width = '100%'
      holder.current.querySelector('canvas')?.remove()
      holder.current.prepend(canvas)
      setLoading(false)
    })
    return () => {
      dead = true
    }
  }, [url, page])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') setPage((p) => Math.max(1, p - 1))
      if (e.key === 'ArrowRight') setPage((p) => Math.min(pages, p + 1))
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onClose, pages])

  const box = block.bbox && page === block.page ? block.bbox : undefined
  return (
    <div className="peek">
      <div className="peek-head">
        <b>原文</b>
        <span className="faint">
          第 {page} / {pages} 页
        </span>
        <span className="spacer" />
        <button className="icon-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          <Icon name="back" />
        </button>
        <button className="icon-btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>
          <Icon name="next" />
        </button>
        <button className="icon-btn" onClick={onClose} title="关闭（Esc）">
          <Icon name="x" />
        </button>
      </div>
      <div className="peek-body">
        <div className={`peek-page ${loading ? 'loading' : ''}`} ref={holder}>
          {box && (
            <div
              className="peek-box"
              style={{
                left: `${box[0] / 10}%`,
                top: `${box[1] / 10}%`,
                width: `${(box[2] - box[0]) / 10}%`,
                height: `${(box[3] - box[1]) / 10}%`
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/** Full-window figure viewer: pinch or ⌘-scroll to zoom, drag to pan, double-click to toggle. */
export function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const [z, setZ] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; px: number; py: number }>(undefined)

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onClose])

  return (
    <div
      className="lightbox"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onWheel={(e) => {
        if (e.ctrlKey || e.metaKey) setZ((v) => Math.min(6, Math.max(0.5, v * Math.exp(-e.deltaY * 0.01))))
        else if (z > 1) setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }))
      }}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${z})` }}
        onDoubleClick={() => {
          setZ((v) => (v > 1 ? 1 : 2.2))
          setPan({ x: 0, y: 0 })
        }}
        onMouseDown={(e) => (drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y })}
        onMouseMove={(e) => drag.current && setPan({ x: drag.current.px + e.clientX - drag.current.x, y: drag.current.py + e.clientY - drag.current.y })}
        onMouseUp={() => (drag.current = undefined)}
        onMouseLeave={() => (drag.current = undefined)}
      />
      <div className="lightbox-hint">双指捏合缩放 · 双击放大 · Esc 关闭</div>
      <button className="icon-btn lightbox-close" onClick={onClose}>
        <Icon name="x" />
      </button>
    </div>
  )
}
