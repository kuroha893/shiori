import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Annotation, Block, PaperMeta, Settings } from '../../../shared/types'
import { fileUrl } from '../api'
import { renderMarkdown } from '../lib/markdown'
import { offsetsToRange } from '../lib/anchors'
import { Icon } from './Icon'
import { VenueTags } from './VenueTags'

export type View = Settings['view']
type Lang = 'en' | 'zh'

const LABEL = /^(\*\*)?((?:Figure|Fig\.|Table|Algorithm|图|表|算法)\s*[\dA-Z]+(?:\.\d+)?\s*[:：.]?)(\*\*)?\s*/i

const text = (b: Block, lang: Lang) => (lang === 'zh' ? (b.parts.zh ?? b.parts.en) : b.parts.en) ?? ''

function caption(b: Block, lang: Lang): string {
  // "Figure 3: …" → bold label; Chinese labels end in a full-width colon, so no extra space.
  return renderMarkdown(
    // (HTML, not **…**: CommonMark won't close emphasis between "：" and a Chinese character.)
    text(b, lang).replace(LABEL, (_m, _a, label) => `<strong>${label.trim()}</strong>${/[：]$/.test(label.trim()) ? '' : ' '}`),
    false,
    lang === 'zh'
  )
}

/** The HTML of one block in one language; also used by hover previews. */
export function blockHtml(paperId: string, b: Block, lang: Lang): string {
  switch (b.type) {
    case 'h':
      return renderMarkdown(text(b, lang), true)
    case 'eq':
      return renderMarkdown(b.parts.en ?? '')
    case 'ref':
      return renderMarkdown(b.parts.en ?? '', true)
    case 'fig':
    case 'tab': {
      const img = b.bbox ? `<img src="${fileUrl(paperId, `figures/${b.id}.png`)}" alt="" draggable="false">` : ''
      const table = b.type === 'tab' && b.parts.table ? `<div class="table-wrap">${renderMarkdown(b.parts.table)}</div>` : ''
      return `${b.type === 'tab' ? caption(b, lang) : ''}${table || img}${b.type === 'fig' ? caption(b, lang) : ''}`
    }
    default:
      return renderMarkdown(text(b, lang), false, lang === 'zh')
  }
}

interface Props {
  paper: PaperMeta
  blocks: Block[]
  view: View
  annotations: Annotation[]
  onJump: (id: string) => void
  onPeek: (b: Block) => void
  onZoom: (src: string) => void
  onGuide: () => void
  footer: ReactNode
}

const Html = ({ html, className, block, lang, as = 'div' }: { html: string; className?: string; block?: string; lang?: Lang; as?: 'div' | 'span' | 'figcaption' }) => {
  const Tag = as
  return (
    <Tag
      className={className}
      data-block={block}
      data-lang={lang}
      lang={lang === 'zh' ? 'zh-CN' : lang}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

const BlockView = memo(function BlockView({ paperId, b, view, onPeek }: { paperId: string; b: Block; view: View; onPeek: (b: Block) => void }) {
  const langs: Lang[] = view === 'both' ? ['en', 'zh'] : [view]
  const page = b.page ? (
    <button className="pg" title={`看原文第 ${b.page} 页`} onClick={() => onPeek(b)}>
      p.{b.page}
    </button>
  ) : null

  if (b.type === 'h') {
    const level = Math.min(3, Math.max(1, parseInt(b.attrs.level || '1', 10)))
    const Tag = (['h2', 'h3', 'h4'] as const)[level - 1]
    return (
      <Tag id={b.id} className={`blk h h${level}`} data-id={b.id}>
        {b.attrs.num && <span className="h-num">{b.attrs.num}</span>}
        <span className="h-texts">
          {langs.map((l) => (
            <Html key={l} as="span" className={`h-text lang-${l}`} block={b.id} lang={l} html={blockHtml(paperId, b, l)} />
          ))}
        </span>
      </Tag>
    )
  }

  if (b.type === 'eq') {
    return (
      <div id={b.id} className="blk eq" data-id={b.id}>
        {page}
        <Html className="eq-body" html={blockHtml(paperId, b, 'en')} />
      </div>
    )
  }

  if (b.type === 'fig' || b.type === 'tab') {
    // Keep the figure's size relative to the text, as in the paper (a text block is ~700 of 1000 units wide).
    const scale = b.bbox ? Math.min(100, Math.round(((b.bbox[2] - b.bbox[0]) / 700) * 115)) : 100
    const img = b.bbox ? (
      <div className="fig-frame">
        <img src={fileUrl(paperId, `figures/${b.id}.png`)} alt="" draggable={false} data-zoom style={{ width: `${scale}%` }} />
      </div>
    ) : null
    const caps = langs.map((l) => <Html key={l} as="figcaption" className={`cap lang-${l}`} block={b.id} lang={l} html={caption(b, l)} />)
    return (
      <figure id={b.id} className={`blk ${b.type}`} data-id={b.id}>
        {page}
        {b.type === 'tab' ? (
          <>
            {caps}
            <TableBody b={b} img={img} />
          </>
        ) : (
          <>
            {img}
            {caps}
          </>
        )}
      </figure>
    )
  }

  const cls = `blk ${b.type}`
  if (view === 'both' && (b.type === 'p' || b.type === 'list' || b.type === 'note' || b.type === 'quote')) {
    return (
      <div id={b.id} className={`${cls} pair`} data-id={b.id}>
        {page}
        <Html className="txt lang-en" block={b.id} lang="en" html={blockHtml(paperId, b, 'en')} />
        <Html className="txt lang-zh" block={b.id} lang="zh" html={blockHtml(paperId, b, 'zh')} />
      </div>
    )
  }
  const lang: Lang = b.type === 'ref' || b.type === 'code' ? 'en' : langs[langs.length - 1]
  return (
    <div id={b.id} className={cls} data-id={b.id}>
      {page}
      {b.type === 'ref' && b.attrs.num && <span className="ref-num">[{b.attrs.num}]</span>}
      <Html className={`txt lang-${lang}`} block={b.id} lang={lang} html={blockHtml(paperId, b, lang)} />
    </div>
  )
})

function TableBody({ b, img }: { b: Block; img: ReactNode }) {
  const [showImage, setShowImage] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  // Wide tables: first a compact layout that also uses the page margins, then horizontal scrolling.
  const [fit, setFit] = useState<'' | 'wide' | 'wide scroll'>('')
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const check = () => {
      el.className = 'table-wrap'
      if (el.scrollWidth <= el.clientWidth + 1) return setFit('')
      el.className = 'table-wrap wide'
      setFit(el.scrollWidth > el.clientWidth + 1 ? 'wide scroll' : 'wide')
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el.parentElement!)
    return () => ro.disconnect()
  }, [showImage, b.parts.table])
  if (!b.parts.table) return <>{img}</>
  return (
    <>
      {showImage && img ? (
        img
      ) : (
        <div ref={wrap} className={`table-wrap ${fit}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(b.parts.table) }} />
      )}
      {img && (
        <button className="btn ghost sm tab-toggle" onClick={() => setShowImage((v) => !v)}>
          <Icon name={showImage ? 'type' : 'image'} size={13} />
          {showImage ? '看转写' : '看原表'}
        </button>
      )}
    </>
  )
}

const COLORS = ['yellow', 'green', 'blue', 'pink'] as const

export function useHighlights(root: React.RefObject<HTMLElement | null>, annotations: Annotation[], deps: unknown[]) {
  useLayoutEffect(() => {
    const reg = (CSS as any).highlights as Map<string, any> | undefined
    const HighlightCtor = (window as any).Highlight
    if (!reg || !HighlightCtor || !root.current) return
    const groups: Record<string, Range[]> = { noted: [] }
    for (const c of COLORS) groups[c] = []
    for (const a of annotations) {
      const el = root.current.querySelector(`[data-block="${CSS.escape(a.block)}"][data-lang="${a.lang}"]`)
      if (!el) continue
      const r = offsetsToRange(el, a.start, a.end)
      if (!r) continue
      groups[a.color]?.push(r)
      if (a.note) groups.noted.push(r)
    }
    for (const [k, ranges] of Object.entries(groups)) reg.set(`hl-${k}`, new HighlightCtor(...ranges))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, ...deps])
}

export function Article({ paper, blocks, view, annotations, onJump, onPeek, onZoom, onGuide, footer }: Props) {
  const ref = useRef<HTMLElement>(null)
  const [preview, setPreview] = useState<{ id: string; rect: DOMRect }>()
  const hoverTimer = useRef<number>(undefined)
  const leaveTimer = useRef<number>(undefined)

  useHighlights(ref, annotations, [view, blocks])

  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  const zh = blocks.filter((b) => b.type === 'p').reduce((n, b) => n + (b.parts.zh?.length ?? 0), 0)
  const minutes = Math.max(1, Math.round(zh / 450))

  return (
    <article
      ref={ref}
      className={`doc view-${view}`}
      onClick={(e) => {
        const t = e.target as HTMLElement
        const a = t.closest('a[data-ref]') as HTMLAnchorElement | null
        if (a) {
          e.preventDefault()
          setPreview(undefined)
          onJump(a.dataset.ref!)
          return
        }
        if (t.matches('img[data-zoom]')) onZoom((t as HTMLImageElement).src)
      }}
      onMouseOver={(e) => {
        const a = (e.target as HTMLElement).closest('a[data-ref]') as HTMLAnchorElement | null
        if (!a) return
        window.clearTimeout(leaveTimer.current)
        window.clearTimeout(hoverTimer.current)
        hoverTimer.current = window.setTimeout(() => setPreview({ id: a.dataset.ref!, rect: a.getBoundingClientRect() }), 260)
      }}
      onMouseOut={(e) => {
        if (!(e.target as HTMLElement).closest('a[data-ref]')) return
        window.clearTimeout(hoverTimer.current)
        leaveTimer.current = window.setTimeout(() => setPreview(undefined), 220)
      }}
    >
      <header className="doc-head">
        {(paper.venue || paper.year || paper.arxiv) && (
          <div className="doc-kicker">
            <VenueTags venue={paper.venue} year={paper.year} />
            {paper.arxiv && <span className="mono">arXiv {paper.arxiv}</span>}
          </div>
        )}
        {view !== 'en' && <h1 className="doc-title">{paper.titleZh || paper.title}</h1>}
        {(view === 'en' || paper.titleZh) && <p className={view === 'en' ? 'doc-title' : 'doc-title-en'}>{paper.title}</p>}
        {paper.authors.length > 0 && <p className="doc-authors">{paper.authors.join(', ')}</p>}
        <div className="doc-meta">
          <span className="faint">
            {paper.pages} 页 · 约 {minutes} 分钟
          </span>
          <button className="btn sm" onClick={onGuide}>
            <Icon name="sparkles" size={13} />
            导读
          </button>
          {paper.arxiv && (
            <a className="btn sm" href={`https://arxiv.org/abs/${paper.arxiv}`} target="_blank" rel="noreferrer">
              <Icon name="external" size={13} />
              arXiv
            </a>
          )}
        </div>
      </header>

      {blocks.map((b) => (
        <BlockView key={b.id} paperId={paper.id} b={b} view={view} onPeek={onPeek} />
      ))}

      {footer}

      {preview && (
        <Preview
          paperId={paper.id}
          blocks={blocks}
          id={preview.id}
          rect={preview.rect}
          lang={view === 'en' ? 'en' : 'zh'}
          onEnter={() => window.clearTimeout(leaveTimer.current)}
          onLeave={() => setPreview(undefined)}
          onJump={(id) => {
            setPreview(undefined)
            onJump(id)
          }}
        />
      )}
    </article>
  )
}

function Preview({
  paperId,
  blocks,
  id,
  rect,
  lang,
  onEnter,
  onLeave,
  onJump
}: {
  paperId: string
  blocks: Block[]
  id: string
  rect: DOMRect
  lang: Lang
  onEnter: () => void
  onLeave: () => void
  onJump: (id: string) => void
}) {
  const i = blocks.findIndex((b) => b.id === id)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>()
  const target = blocks[i]

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.max(12, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - 12))
    const below = rect.bottom + 8
    const top = below + h > window.innerHeight - 12 ? Math.max(12, rect.top - h - 8) : below
    setPos({ left, top })
  }, [rect, id])

  if (!target) return null
  // A section preview shows its heading and the first paragraph after it.
  const shown = target.type === 'h' ? blocks.slice(i, i + 3).filter((b, k) => k === 0 || b.type !== 'h').slice(0, 2) : [target]
  return (
    <div
      ref={ref}
      className={`popover preview type-${target.type}`}
      style={pos ?? { left: -9999, top: 0 }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a[data-ref]') as HTMLAnchorElement | null
        e.preventDefault()
        onJump(a?.dataset.ref ?? id)
      }}
    >
      {shown.map((b) => (
        <div key={b.id} className={`pv-${b.type}`}>
          {b.type === 'ref' && b.attrs.num && <span className="ref-num">[{b.attrs.num}] </span>}
          <span dangerouslySetInnerHTML={{ __html: blockHtml(paperId, b, b.type === 'ref' || b.type === 'eq' ? 'en' : lang) }} />
        </div>
      ))}
      <div className="pv-hint faint">点击跳转</div>
    </div>
  )
}
