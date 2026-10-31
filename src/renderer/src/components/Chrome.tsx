import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PaperMeta, PetState, Settings } from '../../../shared/types'
import { api } from '../api'
import { CONTACTS } from '../../../shared/contacts'
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

/** A green ring that opens the list of people to call; click someone to call them, click again to hang up. */
export function CallLauncher() {
  const [call, setCall] = useState<PetState>({})
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useDismiss(box, () => setOpen(false), open)
  useEffect(() => {
    api.petState().then(setCall)
    return api.onPetChanged(setCall)
  }, [])
  return (
    <div className={`call-launcher no-drag ${open ? 'open' : ''} ${call.contact ? 'live' : ''}`} ref={box}>
      <div className="call-contacts">
        {CONTACTS.map((c, i) => (
          <button
            key={c.id}
            className={`call-contact ${call.contact === c.id ? 'on' : ''}`}
            style={{ '--i': CONTACTS.length - 1 - i } as React.CSSProperties}
            tabIndex={open ? 0 : -1}
            aria-label={call.contact === c.id ? `挂断${c.name}` : `和${c.name}通话`}
            onClick={() => {
              setOpen(false)
              api.togglePet(c.id).then(setCall)
            }}
          >
            <span className="call-contact-name">{call.contact === c.id ? `挂断${c.name}` : c.name}</span>
            <img src={c.avatar} alt="" draggable={false} />
          </button>
        ))}
      </div>
      <button className="call-launch" title="联系人" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <i />
        <i />
        <i />
      </button>
    </div>
  )
}

/** Red when the owner likes the paper; click to change your mind. */
export function HeartButton({ paper, bordered }: { paper: PaperMeta; bordered?: boolean }) {
  const liked = !!paper.likedAt
  return (
    <button
      className={`icon-btn heart ${bordered ? 'bordered' : ''} ${liked ? 'on' : ''}`}
      title={liked ? '取消喜欢' : '喜欢这篇'}
      onClick={(e) => {
        e.stopPropagation()
        api.updatePaper(paper.id, { likedAt: liked ? undefined : new Date().toISOString() })
      }}
    >
      <Icon name="heart" />
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
