import { useEffect, useRef, useState } from 'react'
import type { AvatarCrop } from '../../../shared/contacts'

const AVATAR_SIZE = 256
const STAGE_HEIGHT = 300
// The smallest circle, as a fraction of the room there is.
const SMALLEST = 0.2

const PORTRAIT_MAX = 1800
// How fast the circle changes size: a wheel notch is around 100, a pinch sends many small steps.
const WHEEL_SPEED = 0.0015
const PINCH_SPEED = 0.012

const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v))

/** The picture kept whole so the avatar can be cut from it, at a size the call screen can't outgrow. */
export function fitPortrait(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onerror = () => reject(new Error('这张图片读不出来'))
    img.onload = () => {
      const scale = Math.min(1, PORTRAIT_MAX / Math.max(img.naturalWidth, img.naturalHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.naturalWidth * scale)
      canvas.height = Math.round(img.naturalHeight * scale)
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', 0.9))
    }
    img.src = src
  })
}

/** Where the avatar is cut from the portrait: drag the circle, and scroll or pinch to change its size. */
export function PortraitCrop({ src, crop, onChange }: { src: string; crop?: AvatarCrop; onChange: (crop: AvatarCrop, avatar: string) => void }) {
  const image = useRef<HTMLImageElement>(null)
  const [ratio, setRatio] = useState<number>() // height / width
  const grip = useRef<{ x: number; y: number; from: AvatarCrop }>(undefined)
  const stage = useRef<HTMLDivElement>(null)
  // Wheel events come faster than the crop returns through the parent, so each builds on the one before.
  const latest = useRef<AvatarCrop>(undefined)
  const onWheel = useRef<(e: WheelEvent) => void>(undefined)

  // The side as a fraction of the height is size / ratio, and it has to fit both ways.
  const largest = (r: number) => Math.min(1, r)
  const fit = (c: AvatarCrop, r: number): AvatarCrop => {
    const size = clamp(c.size, largest(r) * SMALLEST, largest(r))
    return { size, x: clamp(c.x, 0, 1 - size), y: clamp(c.y, 0, 1 - size / r) }
  }

  const apply = (c: AvatarCrop) => {
    latest.current = c
    const img = image.current
    if (!img) return
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = AVATAR_SIZE
    const w = img.naturalWidth
    const h = img.naturalHeight
    canvas.getContext('2d')!.drawImage(img, c.x * w, c.y * h, c.size * w, c.size * w, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
    onChange(c, canvas.toDataURL('image/png'))
  }

  const loaded = () => {
    const img = image.current!
    const r = img.naturalHeight / img.naturalWidth
    setRatio(r)
    // A new picture starts with its top, where a face usually is.
    if (!crop) {
      const size = largest(r) * 0.8
      apply({ size, x: (1 - size) / 2, y: 0 })
    }
  }

  // A picture from memory can be ready before onLoad is listening.
  useEffect(() => {
    if (image.current?.complete && image.current.naturalWidth) loaded()
    else setRatio(undefined)
  }, [src])

  const stageWidth = ratio ? STAGE_HEIGHT / ratio : undefined
  const shown = ratio && crop ? fit(crop, ratio) : undefined
  latest.current = shown

  onWheel.current = (e) => {
    const now = latest.current
    if (!now || !ratio) return
    e.preventDefault()
    // A pinch on the trackpad arrives as a wheel event with the control key set.
    const size = now.size * Math.exp(-e.deltaY * (e.ctrlKey ? PINCH_SPEED : WHEEL_SPEED))
    const next = fit({ ...now, size }, ratio)
    // It grows from its center.
    apply(fit({ ...next, x: now.x + (now.size - next.size) / 2, y: now.y + (now.size - next.size) / 2 / ratio }, ratio))
  }

  // Added by hand: React's wheel listener can't stop the settings page from scrolling.
  useEffect(() => {
    const el = stage.current
    const listener = (e: WheelEvent) => onWheel.current?.(e)
    el?.addEventListener('wheel', listener, { passive: false })
    return () => el?.removeEventListener('wheel', listener)
  }, [])

  const down = (e: React.PointerEvent) => {
    if (!shown) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    grip.current = { x: e.clientX, y: e.clientY, from: shown }
  }
  const move = (e: React.PointerEvent) => {
    const g = grip.current
    if (!g || !ratio || !stageWidth) return
    apply(fit({ ...g.from, x: g.from.x + (e.clientX - g.x) / stageWidth, y: g.from.y + (e.clientY - g.y) / STAGE_HEIGHT }, ratio))
  }
  return (
    <div className="set-crop">
      <div className="set-crop-stage" ref={stage} style={{ height: STAGE_HEIGHT, width: stageWidth }}>
        <img ref={image} src={src} alt="" draggable={false} onLoad={loaded} />
        {shown && (
          <div
            className="set-crop-ring"
            style={{ left: `${shown.x * 100}%`, top: `${shown.y * 100}%`, width: `${shown.size * 100}%`, aspectRatio: '1' }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={() => (grip.current = undefined)}
            onPointerCancel={() => (grip.current = undefined)}
          />
        )}
      </div>
      <p className="faint">拖动圆圈选择头像，滚轮或双指缩放。</p>
    </div>
  )
}
