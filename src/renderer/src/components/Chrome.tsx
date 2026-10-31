import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PetState, Settings } from '../../../shared/types'
import { api } from '../api'
import { Icon } from './Icon'

const THEMES: { id: Settings['theme']; icon: string; label: string }[] = [
  { id: 'system', icon: 'monitor', label: '跟随系统' },
  { id: 'light', icon: 'sun', label: '浅色' },
  { id: 'dark', icon: 'moon', label: '深色' },
  { id: 'sepia', icon: 'leaf', label: '护眼' }
]

export function ThemeButton({ theme, onChange }: { theme: Settings['theme']; onChange: (t: Settings['theme']) => void }) {
  const i = Math.max(0, THEMES.findIndex((t) => t.id === theme))
  const cur = THEMES[i]
  return (
    <button className="icon-btn bordered no-drag" title={`主题：${cur.label}`} onClick={() => onChange(THEMES[(i + 1) % THEMES.length].id)}>
      <Icon name={cur.icon} />
    </button>
  )
}

export const themeOptions = THEMES

/** The character's face: click to call her onto the desktop, click again to send her away. */
export function PetButton() {
  const [pet, setPet] = useState<PetState>()
  useEffect(() => {
    api.petState().then(setPet)
    return api.onPetChanged(setPet)
  }, [])
  if (!pet?.available) return null
  return (
    <button className={`pet-btn no-drag ${pet.visible ? 'on' : ''}`} title={pet.visible ? '收起助手' : '唤起助手'} onClick={() => api.togglePet().then(setPet)}>
      <img src="shiori://pet/avatar.png" alt="" draggable={false} />
    </button>
  )
}

/** Close on outside click or Escape. */
export function useDismiss(ref: React.RefObject<HTMLElement | null>, onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const t = window.setTimeout(() => document.addEventListener('mousedown', down), 0)
    document.addEventListener('keydown', key)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [ref, onClose, active])
}

export interface MenuItem {
  label: string
  icon?: string
  danger?: boolean
  onClick: () => void
}

export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, onClose)
  const left = Math.min(x, window.innerWidth - 200)
  const top = Math.max(8, Math.min(y, window.innerHeight - items.length * 34 - 16))
  return (
    <div ref={ref} className="popover menu" style={{ left, top }}>
      {items.map((it) => (
        <button
          key={it.label}
          className={it.danger ? 'danger' : ''}
          onClick={() => {
            onClose()
            it.onClick()
          }}
        >
          {it.icon && <Icon name={it.icon} size={15} />}
          {it.label}
        </button>
      ))}
    </div>
  )
}

export function Modal({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="modal">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </>
  )
}
