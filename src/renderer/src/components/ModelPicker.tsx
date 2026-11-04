import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { modelLabel, modelName, parseModel, pickEffort, PROVIDER_NAMES, PROVIDERS, type ModelOption } from '../../../shared/models'
import { Icon } from './Icon'

/**
 * Pick a model from the connected services, grouped by service, and how hard it thinks, from the levels that
 * model takes. `mini` sits in the chat composer.
 */
export function ModelPicker({
  value,
  options,
  onChange,
  effort,
  onEffort,
  mini
}: {
  value?: string
  options: ModelOption[]
  onChange: (value: string) => void
  effort: string
  onEffort: (effort: string) => void
  mini?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<React.CSSProperties>()
  const ref = useRef<HTMLDivElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  const efforts = options.find((o) => o.value === value)?.efforts
  const level = pickEffort(effort, efforts)
  // Rendered into <body> like the font picker, so the scrolling settings dialog can't clip it. Opens upwards
  // when there's no room below, as in the composer.
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const need = 24 + options.length * 34 + new Set(options.map((o) => o.provider)).size * 26 + (efforts?.length ? 66 : 0)
    setPos(window.innerHeight - r.bottom - 16 >= need ? { left: r.left, top: r.bottom + 6 } : { left: r.left, bottom: window.innerHeight - r.top + 6 })
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

  const provider = value && parseModel(value).provider
  return (
    <div className={`fp mp ${mini ? 'mini' : ''}`} ref={ref}>
      <button className="fp-current" disabled={!options.length} onClick={toggle}>
        <span>
          {!value ? (
            '未接入'
          ) : mini || provider === 'openai' ? (
            modelLabel(value)
          ) : (
            <>
              <span className="who">{PROVIDER_NAMES[provider as keyof typeof PROVIDER_NAMES]}</span>
              {modelName(value)}
            </>
          )}
          {level && <span className="lvl">· {level}</span>}
        </span>
        <Icon name="down" size={14} className="faint" />
      </button>
      {open &&
        createPortal(
          <div className="popover mp-pop" style={pos} ref={pop}>
            {PROVIDERS.map((p) => {
              const list = options.filter((o) => o.provider === p)
              if (!list.length) return null
              return (
                <div key={p}>
                  <div className="fp-head faint">{PROVIDER_NAMES[p]}</div>
                  {list.map((o) => (
                    <button
                      key={o.value}
                      className={`fp-item ${o.value === value ? 'on' : ''}`}
                      onClick={() => {
                        onChange(o.value)
                        setOpen(false)
                      }}
                    >
                      <span className="fp-name">{o.name}</span>
                      {o.value === value && <Icon name="check" size={14} />}
                    </button>
                  ))}
                </div>
              )
            })}
            {efforts?.length ? (
              <div className="mp-effort">
                <div className="fp-head faint">思考</div>
                <div className="seg">
                  {efforts.map((e) => (
                    <button
                      key={e}
                      className={e === level ? 'on' : ''}
                      onClick={() => {
                        onEffort(e)
                        setOpen(false)
                      }}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>,
          document.body
        )}
    </div>
  )
}
