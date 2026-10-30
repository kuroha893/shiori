import { useEffect, useRef, useState } from 'react'
import type { Annotation, HighlightColor } from '../../../shared/types'
import { Icon } from './Icon'
import { useDismiss } from './Chrome'

export const COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink']
const COLOR_NAMES: Record<HighlightColor, string> = { yellow: '黄', green: '绿', blue: '蓝', pink: '粉' }

export interface Selected {
  block: string
  lang: 'en' | 'zh'
  start: number
  end: number
  text: string
  /** Selection spans several blocks: AI actions only, no highlight */
  multi: boolean
  rect: DOMRect
}

export function SelectionMenu({
  sel,
  onHighlight,
  onNote,
  onExplain,
  onTranslate,
  onAsk
}: {
  sel: Selected
  onHighlight: (c: HighlightColor) => void
  onNote: () => void
  onExplain: () => void
  onTranslate: () => void
  onAsk: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: -9999, top: 0 })
  useEffect(() => {
    const el = ref.current!
    const w = el.offsetWidth
    const left = Math.max(10, Math.min(sel.rect.left + sel.rect.width / 2 - w / 2, window.innerWidth - w - 10))
    const top = sel.rect.top - el.offsetHeight - 10 < 60 ? sel.rect.bottom + 10 : sel.rect.top - el.offsetHeight - 10
    setPos({ left, top })
  }, [sel])

  return (
    <div ref={ref} className="popover selmenu" style={pos} onMouseDown={(e) => e.preventDefault()}>
      {!sel.multi && (
        <>
          {COLORS.map((c, i) => (
            <button key={c} className="swatch" title={`${COLOR_NAMES[c]}色高亮（${i + 1}）`} onClick={() => onHighlight(c)}>
              <i className={`sw-${c}`} />
            </button>
          ))}
          <button title="批注（N）" onClick={onNote}>
            <Icon name="note" size={15} />
            <span>批注</span>
          </button>
          <span className="sep" />
        </>
      )}
      <button title="解释（E）" onClick={onExplain}>
        <Icon name="sparkles" size={15} />
        <span>解释</span>
      </button>
      {sel.lang === 'en' && (
        <button title="翻译（T）" onClick={onTranslate}>
          <Icon name="lang" size={15} />
          <span>翻译</span>
        </button>
      )}
      <button title="问 Claude（A）" onClick={onAsk}>
        <Icon name="chat" size={15} />
        <span>提问</span>
      </button>
    </div>
  )
}

export function NotePopover({
  ann,
  x,
  y,
  autoFocus,
  onChange,
  onDelete,
  onClose
}: {
  ann: Annotation
  x: number
  y: number
  autoFocus?: boolean
  onChange: (patch: Partial<Annotation>) => void
  onDelete: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [note, setNote] = useState(ann.note ?? '')
  const save = () => {
    if ((ann.note ?? '') !== note.trim()) onChange({ note: note.trim() || undefined })
    onClose()
  }
  useDismiss(ref, save)
  const left = Math.max(12, Math.min(x - 160, window.innerWidth - 332))
  const top = Math.min(y + 14, window.innerHeight - 240)
  return (
    <div ref={ref} className="popover notepop" style={{ left, top }}>
      <blockquote className={`np-quote bar-${ann.color}`}>{ann.text}</blockquote>
      <textarea
        className="textarea"
        rows={4}
        autoFocus={autoFocus}
        placeholder="写点想法…（⌘↩ 保存）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.metaKey) save()
          e.stopPropagation()
        }}
      />
      <div className="np-foot">
        {COLORS.map((c) => (
          <button key={c} className={`swatch ${ann.color === c ? 'on' : ''}`} onClick={() => onChange({ color: c })}>
            <i className={`sw-${c}`} />
          </button>
        ))}
        <span className="spacer" />
        <button className="icon-btn" title="删除高亮" onClick={onDelete}>
          <Icon name="trash" size={15} />
        </button>
        <button className="btn sm primary" onClick={save}>
          完成
        </button>
      </div>
    </div>
  )
}
