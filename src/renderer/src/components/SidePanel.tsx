import { useCallback, useEffect, useRef, useState } from 'react'
import type { Annotation, Block, ChatMessage, PaperMeta } from '../../../shared/types'
import { api } from '../api'
import { renderMarkdown } from '../lib/markdown'
import { Icon } from './Icon'
import { modelName } from './Library'
import { NoteEditor } from './NoteEditor'

// 'notes' are the annotations (批注), 'memo' is the free-form note (笔记).
export type Tab = 'guide' | 'chat' | 'notes' | 'memo'
export type Quote = { block: string; text: string; lang?: 'en' | 'zh'; start?: number; end?: number }

export interface ChatApi {
  messages: ChatMessage[]
  streaming: string | undefined
  status: string | undefined
  busy: boolean
  send: (text: string, quote?: Quote, model?: string) => void
  stop: () => void
  reset: () => void
}

export function useChat(paperId: string): ChatApi {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState<string>()
  const [status, setStatus] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.loadChat(paperId).then((c: { messages: ChatMessage[] }) => setMessages(c.messages))
    return api.onChatEvent((e) => {
      if (e.paper !== paperId) return
      if (e.kind === 'delta') {
        setStatus(undefined)
        setStreaming((s) => (s ?? '') + e.text)
      } else if (e.kind === 'status') setStatus(e.text)
      else if (e.kind === 'done') {
        setMessages((m) => [...m, e.message])
        setStreaming(undefined)
        setStatus(undefined)
        setBusy(false)
      }
    })
  }, [paperId])

  const send = useCallback(
    (text: string, quote?: Quote, model?: string) => {
      if (busy || !text.trim()) return
      const msg: ChatMessage = { id: crypto.randomUUID(), role: 'user', text, quote, createdAt: new Date().toISOString() }
      setMessages((m) => [...m, msg])
      setBusy(true)
      setStreaming('')
      setStatus('正在思考…')
      api.ask(paperId, { text, quote: quote && { block: quote.block, text: quote.text }, model }).catch((e: Error) => {
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: 'assistant', text: `出错了：${e.message}`, createdAt: new Date().toISOString(), error: true }])
        setStreaming(undefined)
        setStatus(undefined)
        setBusy(false)
      })
    },
    [busy, paperId]
  )

  return {
    messages,
    streaming,
    status,
    busy,
    send,
    stop: () => api.stopAsking(paperId),
    reset: () => {
      api.resetChat(paperId)
      setMessages([])
    }
  }
}

interface Props {
  paper: PaperMeta
  width: number
  fontSize: number
  onWidth: (width: number) => void
  tab: Tab
  setTab: (t: Tab) => void
  summary?: string
  blocks: Block[]
  annotations: Annotation[]
  chat: ChatApi
  draftQuote?: Quote
  clearDraftQuote: () => void
  chatModel: string
  claudeReady: boolean
  onOpenSettings: () => void
  onJump: (id: string) => void
  onJumpAnnotation: (a: Annotation) => void
  onEditAnnotation: (a: Annotation, patch: Partial<Annotation>) => void
  onDeleteAnnotation: (a: Annotation) => void
  onSaveAsNote: (quote: Quote, text: string) => void
  focusComposer: number
  toast: (t: string) => void
}

const DEFAULT_WIDTH = 400
const MIN_WIDTH = 300

/** Drag handle on the panel's left edge; the width only reaches React (and settings) on release. */
function Resizer({ panel, onWidth }: { panel: React.RefObject<HTMLElement | null>; onWidth: (width: number) => void }) {
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = panel.current
    if (!el) return
    e.preventDefault()
    // Capture keeps the drag alive outside the window; the listeners on window work whatever the target is.
    e.currentTarget.setPointerCapture(e.pointerId)
    document.body.classList.add('resizing-side')
    const right = el.getBoundingClientRect().right
    let width = el.offsetWidth
    const move = (ev: PointerEvent) => {
      width = Math.max(MIN_WIDTH, Math.round(right - ev.clientX))
      el.style.setProperty('--side-width', `${width}px`)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.classList.remove('resizing-side')
      // The CSS max-width may have held it narrower than the pointer asked for.
      onWidth(el.offsetWidth)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
  return <div className="side-resize" title="拖动调整宽度，双击恢复" onPointerDown={start} onDoubleClick={() => onWidth(DEFAULT_WIDTH)} />
}

export function SidePanel(p: Props) {
  const count = p.annotations.length
  const panel = useRef<HTMLElement>(null)
  // The note stays mounted once opened, so its undo history and scroll survive switching tabs.
  const [memoOpened, setMemoOpened] = useState(false)
  if (p.tab === 'memo' && !memoOpened) setMemoOpened(true)
  const panelVars = { '--side-width': `${p.width}px`, '--side-size': `${p.fontSize}px` } as React.CSSProperties
  return (
    <aside className="side" ref={panel} style={panelVars}>
      <Resizer panel={panel} onWidth={p.onWidth} />
      <div className="side-tabs">
        <div className="seg">
          <button className={p.tab === 'guide' ? 'on' : ''} onClick={() => p.setTab('guide')}>
            导读
          </button>
          <button className={p.tab === 'chat' ? 'on' : ''} onClick={() => p.setTab('chat')}>
            问答
          </button>
          <button className={p.tab === 'notes' ? 'on' : ''} onClick={() => p.setTab('notes')}>
            批注{count ? ` ${count}` : ''}
          </button>
          <button className={p.tab === 'memo' ? 'on' : ''} onClick={() => p.setTab('memo')}>
            笔记
          </button>
        </div>
        {p.tab === 'guide' && p.summary && (
          <button className="btn ghost sm" disabled={p.paper.guideWriting || !p.claudeReady} title="根据全文重新写一版导读" onClick={() => api.writeGuide(p.paper.id)}>
            {p.paper.guideWriting ? '正在重写…' : '重写'}
          </button>
        )}
        {p.tab === 'chat' && p.chat.messages.length > 0 && (
          <button className="btn ghost sm" title="清空对话，开始新的会话" onClick={() => confirm('清空这篇论文的对话记录？') && p.chat.reset()}>
            新对话
          </button>
        )}
      </div>
      {p.tab === 'guide' && <Guide summary={p.summary} paper={p.paper} claudeReady={p.claudeReady} onJump={p.onJump} />}
      {p.tab === 'chat' && <Chat {...p} />}
      {p.tab === 'notes' && <Notes {...p} />}
      {memoOpened && <NoteEditor paperId={p.paper.id} active={p.tab === 'memo'} toast={p.toast} />}
    </aside>
  )
}

function useRefLinks(onJump: (id: string) => void) {
  return (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a[data-ref]') as HTMLAnchorElement | null
    if (a) {
      e.preventDefault()
      onJump(a.dataset.ref!)
    }
  }
}

function Guide({ summary, paper, claudeReady, onJump }: { summary?: string; paper: PaperMeta; claudeReady: boolean; onJump: (id: string) => void }) {
  const click = useRefLinks(onJump)
  if (!summary) {
    if (paper.guideWriting) return <div className="side-empty faint">正在写导读，写好后会显示在这里。</div>
    return (
      <div className="side-empty faint">
        <p>{paper.guideError ? `导读没有写成：${paper.guideError}` : '这篇论文还没有导读。'}</p>
        {paper.status === 'ready' && (
          <button className="btn sm" disabled={!claudeReady} onClick={() => api.writeGuide(paper.id)}>
            写导读
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="side-scroll md guide" onClick={click}>
      {paper.guideError && <p className="faint">这次重写没有成功，下面仍是原来的导读：{paper.guideError}</p>}
      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(summary) }} />
    </div>
  )
}

const SUGGESTIONS = ['这篇论文最核心的贡献是什么？', '用直觉讲讲方法部分', '实验结果可信吗？有什么局限？', '读懂这篇需要哪些前置知识？']

function Chat(p: Props) {
  const { chat } = p
  const [text, setText] = useState('')
  const [model, setModel] = useState(p.chatModel)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const click = useRefLinks(p.onJump)

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight })
  }, [chat.messages.length, chat.streaming])

  useEffect(() => {
    if (p.focusComposer) input.current?.focus()
  }, [p.focusComposer])

  const submit = () => {
    if (!text.trim() || chat.busy) return
    chat.send(text.trim(), p.draftQuote, model)
    setText('')
    p.clearDraftQuote()
  }

  if (!p.claudeReady)
    return (
      <div className="side-empty">
        <p className="faint">问答需要先连接 Claude Code。</p>
        <button className="btn" onClick={p.onOpenSettings}>
          去设置
        </button>
      </div>
    )

  return (
    <>
      <div className="side-scroll chat-list" ref={list} onClick={click}>
        {chat.messages.length === 0 && !chat.busy && (
          <div className="chat-hello">
            <p className="faint">选中正文里的任意文字可以直接提问。也可以从这里开始：</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="suggest" onClick={() => chat.send(s, undefined, model)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {chat.messages.map((m, i) => (
          <Message
            key={m.id}
            m={m}
            onJump={p.onJump}
            onSave={
              m.role === 'assistant' && !m.error && chat.messages[i - 1]?.quote
                ? () => p.onSaveAsNote(chat.messages[i - 1].quote as Quote, m.text)
                : undefined
            }
            toast={p.toast}
          />
        ))}
        {chat.busy && (
          <div className="msg assistant">
            {chat.streaming ? (
              <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(chat.streaming) }} />
            ) : (
              <div className="thinking faint">
                <span className="dots">
                  <i />
                  <i />
                  <i />
                </span>
                {chat.status}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="composer">
        {p.draftQuote && (
          <div className="quote-chip">
            <span>{p.draftQuote.text}</span>
            <button className="icon-btn" onClick={p.clearDraftQuote}>
              <Icon name="x" size={13} />
            </button>
          </div>
        )}
        <textarea
          ref={input}
          className="composer-input"
          rows={1}
          placeholder={p.draftQuote ? '关于这段，想问什么？' : '问点什么…'}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = Math.min(160, e.target.scrollHeight) + 'px'
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-foot">
          <div className="seg mini">
            {['opus', 'sonnet', 'haiku'].map((m) => (
              <button key={m} className={model === m ? 'on' : ''} onClick={() => setModel(m)}>
                {modelName(m)}
              </button>
            ))}
          </div>
          <span className="faint hint">↩ 发送 · ⇧↩ 换行</span>
          {chat.busy ? (
            <button className="icon-btn bordered" title="停止" onClick={chat.stop}>
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <button className="icon-btn send" disabled={!text.trim()} onClick={submit} title="发送">
              <Icon name="send" size={15} />
            </button>
          )}
        </div>
      </div>
    </>
  )
}

function Message({ m, onJump, onSave, toast }: { m: ChatMessage; onJump: (id: string) => void; onSave?: () => void; toast: (t: string) => void }) {
  if (m.role === 'user')
    return (
      <div className="msg user">
        {m.quote && (
          <button className="msg-quote" onClick={() => onJump(m.quote!.block)}>
            {m.quote.text}
          </button>
        )}
        <div className="bubble">{m.text}</div>
      </div>
    )
  return (
    <div className={`msg assistant ${m.error ? 'error' : ''}`}>
      <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
      <div className="msg-actions">
        <span className="faint mono">{m.model && modelName(m.model)}</span>
        <button
          className="btn ghost sm"
          onClick={() => {
            navigator.clipboard.writeText(m.text)
            toast('已复制')
          }}
        >
          <Icon name="copy" size={12} />
          复制
        </button>
        {onSave && (
          <button className="btn ghost sm" onClick={onSave}>
            <Icon name="note" size={12} />
            存为批注
          </button>
        )}
      </div>
    </div>
  )
}

function Notes(p: Props) {
  const order = new Map(p.blocks.map((b, i) => [b.id, i]))
  const list = [...p.annotations].sort((a, b) => (order.get(a.block) ?? 0) - (order.get(b.block) ?? 0) || a.start - b.start)
  const [editing, setEditing] = useState<string>()
  const [draft, setDraft] = useState('')

  const exportMd = () => {
    const title = p.paper.titleZh || p.paper.title
    const lines = [`# ${title}`, '']
    if (p.paper.titleZh) lines.push(`*${p.paper.title}*`, '')
    for (const a of list) {
      lines.push(`> ${a.text.replace(/\n+/g, ' ')}`, '')
      if (a.note) lines.push(a.note, '')
    }
    navigator.clipboard.writeText(lines.join('\n'))
    p.toast('批注已按 Markdown 复制到剪贴板')
  }

  if (!list.length) return <div className="side-empty faint">选中文字后按 1–4 高亮，按 N 写批注。</div>

  return (
    <>
      <div className="side-scroll notes">
        {list.map((a) => (
          <div key={a.id} className={`note-item bar-${a.color}`}>
            <button className="note-quote" onClick={() => p.onJumpAnnotation(a)}>
              {a.text}
            </button>
            {editing === a.id ? (
              <textarea
                className="textarea"
                rows={3}
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  p.onEditAnnotation(a, { note: draft.trim() || undefined })
                  setEditing(undefined)
                }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter' && e.metaKey) (e.target as HTMLTextAreaElement).blur()
                }}
              />
            ) : a.note ? (
              <div
                className="md note-text"
                onClick={() => {
                  setDraft(a.note ?? '')
                  setEditing(a.id)
                }}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(a.note) }}
              />
            ) : null}
            <div className="note-actions">
              <span className="faint mono">{new Date(a.createdAt).toLocaleDateString('zh-CN')}</span>
              <span className="spacer" />
              {editing !== a.id && (
                <button
                  className="btn ghost sm"
                  onClick={() => {
                    setDraft(a.note ?? '')
                    setEditing(a.id)
                  }}
                >
                  {a.note ? '编辑' : '写批注'}
                </button>
              )}
              <button className="icon-btn" title="删除" onClick={() => p.onDeleteAnnotation(a)}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="side-foot">
        <button className="btn sm" onClick={exportMd}>
          <Icon name="copy" size={13} />
          导出为 Markdown
        </button>
      </div>
    </>
  )
}
