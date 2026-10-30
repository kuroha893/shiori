import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Annotation, Block, ClaudeStatus, HighlightColor, PaperDoc, PaperMeta, Settings } from '../../../shared/types'
import { api } from '../api'
import { caretOffset, rangeToOffsets, selectionText } from '../lib/anchors'
import { Article } from './Article'
import { COLORS, NotePopover, SelectionMenu, type Selected } from './Annotate'
import { SidePanel, useChat, type Quote, type Tab } from './SidePanel'
import { Lightbox, PdfPeek } from './Overlays'
import { ThemeButton, useDismiss } from './Chrome'
import { Icon } from './Icon'
import type { Toast } from './App'

const EXPLAIN = '请解释这段话：它在说什么、为什么这样说、在论文里起什么作用。涉及的符号和术语也一并说明。'
const TRANSLATE = '把这段翻译成中文，并解释其中不好懂的术语。'

export function Reader(props: {
  paper: PaperMeta
  settings: Settings
  claude?: ClaudeStatus
  onSettings: (patch: Partial<Settings>) => void
  onClose: () => void
  onOpenSettings: () => void
  toast: Toast
}) {
  const { paper, settings, toast } = props
  const [doc, setDoc] = useState<PaperDoc>()
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [panel, setPanel] = useState(true)
  const [toc, setToc] = useState(true)
  const [tab, setTab] = useState<Tab>('guide')
  const [sel, setSel] = useState<Selected>()
  const [noteFor, setNoteFor] = useState<{ ann: Annotation; x: number; y: number; focus?: boolean }>()
  const [peek, setPeek] = useState<Block>()
  const [zoom, setZoom] = useState<string>()
  const [typo, setTypo] = useState(false)
  const [history, setHistory] = useState<number[]>([])
  const [active, setActive] = useState<string>()
  const [progress, setProgress] = useState(paper.readPos?.ratio ?? 0)
  const [draftQuote, setDraftQuote] = useState<Quote>()
  const [focusComposer, setFocusComposer] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  const chat = useChat(paper.id)
  const view = settings.view

  useEffect(() => {
    api.loadDoc(paper.id).then(setDoc)
    api.loadAnnotations(paper.id).then(setAnnotations)
  }, [paper.id])

  // A guide written in the background appears when it is done.
  const guideWriting = useRef(paper.guideWriting)
  useEffect(() => {
    if (guideWriting.current && !paper.guideWriting) {
      api.loadDoc(paper.id).then((d: PaperDoc) => setDoc((old) => (old ? { ...old, summary: d.summary } : d)))
    }
    guideWriting.current = paper.guideWriting
  }, [paper.id, paper.guideWriting])

  const blocks = doc?.blocks ?? []
  const headings = useMemo(() => blocks.filter((b) => b.type === 'h' && (b.attrs.level ?? '1') !== '3'), [blocks])

  // Restore the reading position once the document is laid out.
  const restored = useRef(false)
  useEffect(() => {
    if (!doc || restored.current) return
    restored.current = true
    const id = paper.readPos?.block
    requestAnimationFrame(() => {
      const el = id && scroller.current?.querySelector(`[data-id="${CSS.escape(id)}"]`)
      if (el) (el as HTMLElement).scrollIntoView({ block: 'start' })
    })
    api.updatePaper(paper.id, { readAt: new Date().toISOString() })
  }, [doc, paper.id, paper.readPos?.block])

  // Track the visible block: TOC highlight, progress, saved position.
  const saveTimer = useRef<number>(undefined)
  const onScroll = useCallback(() => {
    const sc = scroller.current
    if (!sc) return
    const top = sc.getBoundingClientRect().top + 90
    let current: string | undefined
    let firstVisible: string | undefined
    for (const el of sc.querySelectorAll<HTMLElement>('.blk')) {
      const r = el.getBoundingClientRect()
      if (r.top <= top && el.classList.contains('h') && el.dataset.id) current = el.dataset.id
      if (!firstVisible && r.bottom > top) firstVisible = el.dataset.id
      if (r.top > top && firstVisible) break
    }
    setActive(current)
    const ratio = sc.scrollHeight > sc.clientHeight ? sc.scrollTop / (sc.scrollHeight - sc.clientHeight) : 1
    setProgress(ratio)
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      if (firstVisible) api.updatePaper(paper.id, { readPos: { block: firstVisible, ratio } })
    }, 700)
  }, [paper.id])

  const jump = useCallback((id: string) => {
    const sc = scroller.current
    const el = sc?.querySelector(`[data-id="${CSS.escape(id)}"]`) as HTMLElement | null
    if (!sc || !el) return
    setHistory((h) => [...h.slice(-30), sc.scrollTop])
    el.scrollIntoView({ block: el.classList.contains('h') ? 'start' : 'center' })
    el.classList.remove('flash')
    void el.offsetWidth
    el.classList.add('flash')
  }, [])

  const back = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h
      scroller.current?.scrollTo({ top: h[h.length - 1] })
      return h.slice(0, -1)
    })
  }, [])

  // Two-finger swipe right on the trackpad = back, like a browser.
  useEffect(() => {
    const sc = scroller.current
    if (!sc) return
    let acc = 0
    let t: number | undefined
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.5) return
      acc += e.deltaX
      window.clearTimeout(t)
      t = window.setTimeout(() => (acc = 0), 220)
      if (acc < -160) {
        acc = 0
        back()
      }
    }
    sc.addEventListener('wheel', wheel, { passive: true })
    return () => sc.removeEventListener('wheel', wheel)
  }, [back, doc])

  const saveAnnotations = (list: Annotation[]) => {
    setAnnotations(list)
    api.saveAnnotations(paper.id, list)
  }

  const addHighlight = (color: HighlightColor, openNote = false) => {
    if (!sel || sel.multi) return
    const ann: Annotation = {
      id: crypto.randomUUID(),
      block: sel.block,
      lang: sel.lang,
      start: sel.start,
      end: sel.end,
      text: sel.text,
      color,
      createdAt: new Date().toISOString()
    }
    saveAnnotations([...annotations, ann])
    window.getSelection()?.removeAllRanges()
    setSel(undefined)
    if (openNote) setNoteFor({ ann, x: sel.rect.left + sel.rect.width / 2, y: sel.rect.bottom, focus: true })
  }

  const editAnnotation = (a: Annotation, patch: Partial<Annotation>) => {
    const list = annotations.map((x) => (x.id === a.id ? { ...x, ...patch } : x))
    saveAnnotations(list)
    setNoteFor((n) => (n && n.ann.id === a.id ? { ...n, ann: { ...n.ann, ...patch } } : n))
  }

  const askAbout = (prompt?: string) => {
    if (!sel) return
    const quote: Quote = { block: sel.block, text: sel.text, lang: sel.lang, start: sel.start, end: sel.end }
    setPanel(true)
    setTab('chat')
    if (prompt) chat.send(prompt, quote)
    else {
      setDraftQuote(quote)
      setFocusComposer((n) => n + 1)
    }
    window.getSelection()?.removeAllRanges()
    setSel(undefined)
  }

  // Selection inside the article → floating menu; a click on a highlight → its note.
  const onMouseUp = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.popover, button, a')) return
    window.setTimeout(() => {
      const s = window.getSelection()
      if (!s || s.isCollapsed || !s.rangeCount) {
        setSel(undefined)
        const holder = (e.target as HTMLElement).closest('[data-block][data-lang]') as HTMLElement | null
        if (!holder) return
        const off = caretOffset(holder, e.clientX, e.clientY)
        if (off === undefined) return
        const hit = annotations.find((a) => a.block === holder.dataset.block && a.lang === holder.dataset.lang && a.start <= off && off <= a.end)
        if (hit) setNoteFor({ ann: hit, x: e.clientX, y: e.clientY })
        return
      }
      const range = s.getRangeAt(0)
      const text = selectionText(range)
      if (!text) return
      const node = (n: Node) => (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement)
      const a = node(range.startContainer)?.closest('[data-block][data-lang]') as HTMLElement | null
      const b = node(range.endContainer)?.closest('[data-block][data-lang]') as HTMLElement | null
      if (!a) return
      const multi = !b || a !== b
      const { start, end } = multi ? { start: 0, end: 0 } : rangeToOffsets(a, range)
      setSel({
        block: a.dataset.block!,
        lang: a.dataset.lang as 'en' | 'zh',
        start,
        end,
        text,
        multi,
        rect: range.getBoundingClientRect()
      })
    }, 0)
  }

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = (e.target as Element).closest?.('input, textarea')
      if (e.metaKey && e.key === 'j') {
        e.preventDefault()
        setPanel((v) => !v)
      } else if (e.metaKey && e.key === '[') {
        e.preventDefault()
        back()
      } else if (e.metaKey && e.key === '\\') {
        e.preventDefault()
        setToc((v) => !v)
      } else if (sel && !typing && !e.metaKey) {
        const i = ['1', '2', '3', '4'].indexOf(e.key)
        if (i >= 0) addHighlight(COLORS[i])
        else if (e.key === 'n') addHighlight('yellow', true)
        else if (e.key === 'e') askAbout(EXPLAIN)
        else if (e.key === 't' && sel.lang === 'en') askAbout(TRANSLATE)
        else if (e.key === 'a') askAbout()
        else if (e.key === 'Escape') {
          window.getSelection()?.removeAllRanges()
          setSel(undefined)
        } else return
        e.preventDefault()
      } else if (e.key === 'Escape' && !typing && !peek && !zoom && !noteFor) props.onClose()
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  })

  const fontVars = {
    '--read-size': `${settings.fontSize}px`,
    '--read-lh': settings.lineHeight
  } as React.CSSProperties

  const finished = (
    <div className="doc-end">
      <div className="doc-end-mark">❦</div>
      <button
        className={`btn ${paper.finished ? '' : 'primary'}`}
        onClick={() => {
          api.updatePaper(paper.id, { finished: !paper.finished })
          if (!paper.finished) toast('读完了一篇 🎉')
        }}
      >
        <Icon name="check" />
        {paper.finished ? '已读完' : '标记为已读完'}
      </button>
    </div>
  )

  return (
    <div className={`reader font-${settings.readingFont} ${panel ? 'with-panel' : ''} ${toc ? 'with-toc' : ''}`} style={fontVars}>
      <header className="topbar drag reader-bar">
        <button className="icon-btn no-drag" title="回到书架（Esc）" onClick={props.onClose}>
          <Icon name="back" />
        </button>
        <button className={`icon-btn no-drag ${toc ? 'active' : ''}`} title="目录（⌘\）" onClick={() => setToc((v) => !v)}>
          <Icon name="toc" />
        </button>
        <div className="reader-title">{paper.titleZh || paper.title}</div>
        <div className="topbar-actions no-drag">
          <div className="seg">
            {(
              [
                ['zh', '中文'],
                ['en', '原文'],
                ['both', '对照']
              ] as const
            ).map(([v, label]) => (
              <button key={v} className={view === v ? 'on' : ''} onClick={() => props.onSettings({ view: v })}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ position: 'relative' }}>
            <button className={`icon-btn bordered ${typo ? 'active' : ''}`} title="排版" onClick={() => setTypo((v) => !v)}>
              <span className="aa">Aa</span>
            </button>
            {typo && <TypoPanel settings={settings} onChange={props.onSettings} onClose={() => setTypo(false)} />}
          </div>
          <ThemeButton theme={settings.theme} onChange={(theme) => props.onSettings({ theme })} />
          <button
            className="icon-btn bordered"
            title="原文 PDF"
            onClick={() => setPeek(blocks.find((b) => b.id === paper.readPos?.block) ?? blocks[0] ?? ({ id: 'x', type: 'p', attrs: {}, parts: {}, page: 1 } as Block))}
          >
            <Icon name="pdf" />
          </button>
          <button className={`icon-btn bordered ${panel ? 'active' : ''}`} title="侧栏（⌘J）" onClick={() => setPanel((v) => !v)}>
            <Icon name="panel" />
          </button>
        </div>
        <div className="read-bar" style={{ width: `${progress * 100}%` }} />
      </header>

      <div className="reader-body">
        {toc && (
          <nav className="toc">
            <div className="toc-inner">
              <div className="toc-title faint">目录</div>
              {headings.map((h) => (
                <button
                  key={h.id}
                  className={`toc-item l${h.attrs.level ?? '1'} ${active === h.id ? 'on' : ''}`}
                  onClick={() => jump(h.id)}
                  title={(view === 'en' ? h.parts.en : h.parts.zh ?? h.parts.en) ?? ''}
                >
                  {h.attrs.num && <span className="toc-num">{h.attrs.num}</span>}
                  <span>{(view === 'en' ? h.parts.en : h.parts.zh ?? h.parts.en)?.replace(/\$[^$]*\$/g, '…')}</span>
                </button>
              ))}
            </div>
          </nav>
        )}

        <div className="scroller" ref={scroller} onScroll={onScroll} onMouseUp={onMouseUp}>
          {!doc ? (
            <div className="doc-loading faint">正在打开…</div>
          ) : (
            <Article
              paper={paper}
              blocks={blocks}
              view={view}
              annotations={annotations}
              onJump={jump}
              onPeek={setPeek}
              onZoom={setZoom}
              onGuide={() => {
                setPanel(true)
                setTab('guide')
              }}
              footer={finished}
              toast={toast}
            />
          )}
        </div>

        {panel && doc && (
          <SidePanel
            paper={paper}
            tab={tab}
            setTab={setTab}
            summary={doc.summary}
            blocks={blocks}
            annotations={annotations}
            chat={chat}
            draftQuote={draftQuote}
            clearDraftQuote={() => setDraftQuote(undefined)}
            chatModel={settings.chatModel}
            claudeReady={!!props.claude?.loggedIn}
            onOpenSettings={props.onOpenSettings}
            onJump={jump}
            onJumpAnnotation={(a) => jump(a.block)}
            onEditAnnotation={editAnnotation}
            onDeleteAnnotation={(a) => saveAnnotations(annotations.filter((x) => x.id !== a.id))}
            onSaveAsNote={(q, text) => {
              const existing = annotations.find((a) => a.block === q.block && a.start === q.start && a.end === q.end && a.lang === q.lang)
              if (existing) editAnnotation(existing, { note: [existing.note, text].filter(Boolean).join('\n\n') })
              else if (q.lang && q.start !== undefined && q.end !== undefined && q.end > q.start)
                saveAnnotations([
                  ...annotations,
                  { id: crypto.randomUUID(), block: q.block, lang: q.lang, start: q.start, end: q.end, text: q.text, color: 'blue', note: text, createdAt: new Date().toISOString() }
                ])
              else return toast('跨段落的选区不能存为批注')
              toast('已存为批注')
            }}
            focusComposer={focusComposer}
            toast={toast}
          />
        )}
      </div>

      {history.length > 0 && (
        <button className="back-pill" onClick={back} title="⌘[ 或双指右滑">
          <Icon name="undo" size={14} />
          回到刚才的位置
        </button>
      )}

      {sel && (
        <SelectionMenu
          sel={sel}
          onHighlight={(c) => addHighlight(c)}
          onNote={() => addHighlight('yellow', true)}
          onExplain={() => askAbout(EXPLAIN)}
          onTranslate={() => askAbout(TRANSLATE)}
          onAsk={() => askAbout()}
        />
      )}
      {noteFor && (
        <NotePopover
          key={noteFor.ann.id}
          ann={noteFor.ann}
          x={noteFor.x}
          y={noteFor.y}
          autoFocus={noteFor.focus}
          onChange={(patch) => editAnnotation(noteFor.ann, patch)}
          onDelete={() => {
            saveAnnotations(annotations.filter((x) => x.id !== noteFor.ann.id))
            setNoteFor(undefined)
          }}
          onClose={() => setNoteFor(undefined)}
        />
      )}
      {peek && (
        <PdfPeek url={`shiori://paper/${encodeURIComponent(paper.id)}/paper.pdf`} block={peek} pages={paper.pages ?? 1} onClose={() => setPeek(undefined)} />
      )}
      {zoom && <Lightbox src={zoom} onClose={() => setZoom(undefined)} />}
    </div>
  )
}

function TypoPanel({ settings, onChange, onClose }: { settings: Settings; onChange: (p: Partial<Settings>) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, onClose)
  return (
    <div ref={ref} className="popover typo">
      <div className="typo-row">
        <span className="faint">字体</span>
        <div className="seg">
          <button className={settings.readingFont === 'serif' ? 'on' : ''} onClick={() => onChange({ readingFont: 'serif' })}>
            宋体
          </button>
          <button className={settings.readingFont === 'sans' ? 'on' : ''} onClick={() => onChange({ readingFont: 'sans' })}>
            苹方
          </button>
        </div>
      </div>
      <div className="typo-row">
        <span className="faint">字号</span>
        <div className="stepper">
          <button className="icon-btn" onClick={() => onChange({ fontSize: Math.max(14, settings.fontSize - 1) })}>
            <Icon name="minus" size={14} />
          </button>
          <span className="mono">{settings.fontSize}</span>
          <button className="icon-btn" onClick={() => onChange({ fontSize: Math.min(26, settings.fontSize + 1) })}>
            <Icon name="plus" size={14} />
          </button>
        </div>
      </div>
      <div className="typo-row">
        <span className="faint">行距</span>
        <div className="seg">
          {(
            [
              [1.7, '紧凑'],
              [1.85, '适中'],
              [2.05, '宽松']
            ] as const
          ).map(([v, l]) => (
            <button key={v} className={settings.lineHeight === v ? 'on' : ''} onClick={() => onChange({ lineHeight: v })}>
              {l}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
