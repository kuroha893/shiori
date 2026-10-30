import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BUNDLED, fontLabel, installedFamilies } from '../lib/fonts'
import { Icon } from './Icon'

/** Pick a font: the bundled open fonts first, then any font installed on this Mac. Each shows in itself. */
export function FontPicker({ kind, value, onChange }: { kind: 'ui' | 'mono'; value: string; onChange: (family: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [system, setSystem] = useState<string[]>()
  const [pos, setPos] = useState<React.CSSProperties>()
  const ref = useRef<HTMLDivElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  // Rendered into <body>: the settings dialog scrolls (would clip it) and is transformed (would offset
  // fixed positioning). Opens upwards when there's no room below.
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - 16
    setPos(below >= 420 ? { left: r.left, top: r.bottom + 6 } : { left: r.left, bottom: window.innerHeight - r.top + 6 })
    setOpen((v) => !v)
  }
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !pop.current?.contains(t)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key, true)
    }
  }, [open])

  useEffect(() => {
    if (open && !system) installedFamilies().then(setSystem)
  }, [open, system])

  const q = query.trim().toLowerCase()
  const bundled = BUNDLED[kind].filter((f) => !q || f.label.toLowerCase().includes(q))
  const local = useMemo(() => (system ?? []).filter((f) => !q || f.toLowerCase().includes(q)), [system, q])
  const sample = kind === 'mono' ? '2017 · {x: 42}' : 'Aa 论文 Shiori'

  const item = (family: string, label: string) => (
    <button
      key={family}
      className={`fp-item ${value === family ? 'on' : ''}`}
      onClick={() => {
        onChange(family)
        setOpen(false)
      }}
    >
      <span className="fp-name" style={{ fontFamily: `"${family}"` }}>
        {label}
      </span>
      <span className="fp-sample faint" style={{ fontFamily: `"${family}"` }}>
        {sample}
      </span>
      {value === family && <Icon name="check" size={14} />}
    </button>
  )

  return (
    <div className="fp" ref={ref}>
      <button className="fp-current" onClick={toggle}>
        <span style={{ fontFamily: `"${value}"` }}>{fontLabel(value)}</span>
        <Icon name="down" size={14} className="faint" />
      </button>
      {open &&
        createPortal(
        <div className="popover fp-pop" style={pos} ref={pop}>
          <input className="input" placeholder="搜索字体" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} />
          <div className="fp-list">
            {bundled.length > 0 && <div className="fp-head faint">内置 · 开源字体</div>}
            {bundled.map((f) => item(f.family, f.label))}
            <div className="fp-head faint">本机已安装</div>
            {!system ? <div className="fp-empty faint">读取中…</div> : local.length ? local.map((f) => item(f, f)) : <div className="fp-empty faint">没有匹配的字体</div>}
          </div>
          <div className="fp-foot faint">想用别的字体：在「字体册」里安装后，它会出现在这里。</div>
        </div>,
          document.body
        )}
    </div>
  )
}
