import { useEffect, useRef, useState } from 'react'
import { frameRect, type BackdropFrame } from '../../../shared/contacts'

// The call screen is 380 × 680 and its background reaches 12px past each edge, so the blur has no rim.
const SCALE = 0.5
const BOX = { width: (380 + 24) * SCALE, height: (680 + 24) * SCALE }
const CENTER: BackdropFrame = { x: 0.5, y: 0.5, zoom: 1 }
const MAX_ZOOM = 4
const WHEEL_SPEED = 0.0015
const PINCH_SPEED = 0.012

const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v))

/**
 * The call screen at half size, with the background it will have: drag the background to frame it, and pinch
 * (or ⌘ and the wheel) to zoom. Without a background the avatar stands in, as it does in a call.
 */
export function CallPreview({ name, avatar, portrait, frame, onFrame }: { name: string; avatar?: string; portrait?: string; frame?: BackdropFrame; onFrame: (frame: BackdropFrame) => void }) {
  const picture = portrait ?? avatar
  // Kept with the picture it was measured on, so a new picture never borrows the old one's size.
  const [measured, setMeasured] = useState<{ src: string; width: number; height: number }>()
  const size = measured && measured.src === picture ? measured : undefined
  const grip = useRef<{ x: number; y: number; from: BackdropFrame }>(undefined)
  const box = useRef<HTMLDivElement>(null)
  const onWheel = useRef<(e: WheelEvent) => void>(undefined)
  const shown = portrait ? (frame ?? CENTER) : CENTER
  const rect = size && frameRect(size.width, size.height, BOX, shown)

  onWheel.current = (e) => {
    if (!portrait || !(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    onFrame({ ...shown, zoom: clamp(shown.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? PINCH_SPEED : WHEEL_SPEED)), 1, MAX_ZOOM) })
  }
  // Added by hand: React's wheel listener can't stop the settings page from scrolling.
  useEffect(() => {
    const el = box.current
    const listener = (e: WheelEvent) => onWheel.current?.(e)
    el?.addEventListener('wheel', listener, { passive: false })
    return () => el?.removeEventListener('wheel', listener)
  }, [])

  const down = (e: React.PointerEvent) => {
    if (!portrait) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    grip.current = { x: e.clientX, y: e.clientY, from: shown }
  }
  const move = (e: React.PointerEvent) => {
    const g = grip.current
    if (!g || !size) return
    const r = frameRect(size.width, size.height, BOX, g.from)
    // Moving the picture right shows more of its left, so x falls.
    const x = r.width > BOX.width ? clamp(g.from.x - (e.clientX - g.x) / (r.width - BOX.width), 0, 1) : g.from.x
    const y = r.height > BOX.height ? clamp(g.from.y - (e.clientY - g.y) / (r.height - BOX.height), 0, 1) : g.from.y
    onFrame({ ...g.from, x, y })
  }
  const up = () => (grip.current = undefined)

  return (
    <div className={`call-preview ${portrait ? 'framing' : ''}`} ref={box} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {picture && (
        <div className="call-preview-back">
          <img
            src={picture}
            alt=""
            draggable={false}
            onLoad={(e) => setMeasured({ src: picture, width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
            style={rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : { opacity: 0 }}
          />
        </div>
      )}
      <div className="call-preview-veil" />
      <div className="call-preview-lines">
        <i style={{ width: '62%' }} />
        <i className="you" style={{ width: '40%' }} />
        <i style={{ width: '74%' }} />
      </div>
      <span className="call-preview-avatar">{avatar ? <img src={avatar} alt="" draggable={false} /> : <b>{name.trim().slice(0, 1).toUpperCase()}</b>}</span>
      <div className="call-preview-name">{name}</div>
      <div className="call-preview-time" />
      <div className="call-preview-capsule" />
    </div>
  )
}
