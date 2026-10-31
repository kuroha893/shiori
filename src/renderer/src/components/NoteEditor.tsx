import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import DragHandle from '@tiptap/extension-drag-handle-react'
import type { Node as PMNode } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { BlockMath } from '@tiptap/extension-mathematics'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Color, TextStyle } from '@tiptap/extension-text-style'
import { Highlight } from '@tiptap/extension-highlight'
import { Image } from '@tiptap/extension-image'
import { Placeholder } from '@tiptap/extensions'
import katex from 'katex'
import { api } from '../api'
import { Icon } from './Icon'
import { useDismiss } from './Chrome'
import { Callout, NOTE_COLORS, NoteInlineMath, cleanPastedHtml, looksLikeMarkdown, slashCommands, type SlashItem } from '../lib/noteExtensions'

type Chain = ReturnType<Editor['chain']>

// Every way a block can be turned into another; shared by the "/" menu, the selection bar and the block handle.
const BLOCK_TYPES: { id: string; label: string; badge: string; keys: string; to: (c: Chain) => Chain }[] = [
  { id: 'paragraph', label: '正文', badge: 'T', keys: 'text zhengwen', to: (c) => c.clearNodes() },
  { id: 'h1', label: '一级标题', badge: 'H1', keys: 'h1 title biaoti', to: (c) => c.clearNodes().setHeading({ level: 1 }) },
  { id: 'h2', label: '二级标题', badge: 'H2', keys: 'h2 title biaoti', to: (c) => c.clearNodes().setHeading({ level: 2 }) },
  { id: 'h3', label: '三级标题', badge: 'H3', keys: 'h3 title biaoti', to: (c) => c.clearNodes().setHeading({ level: 3 }) },
  { id: 'bulletList', label: '无序列表', badge: '•', keys: 'ul list bullet liebiao wuxu', to: (c) => c.clearNodes().toggleBulletList() },
  { id: 'orderedList', label: '有序列表', badge: '1.', keys: 'ol list number liebiao youxu', to: (c) => c.clearNodes().toggleOrderedList() },
  { id: 'taskList', label: '待办', badge: '☑', keys: 'todo task check daiban', to: (c) => c.clearNodes().toggleTaskList() },
  { id: 'blockquote', label: '引用', badge: '❝', keys: 'quote yinyong', to: (c) => c.clearNodes().toggleBlockquote() },
  { id: 'callout', label: '高亮块', badge: '!', keys: 'callout highlight gaoliang', to: (c) => c.clearNodes().toggleCallout() },
  { id: 'codeBlock', label: '代码块', badge: '</>', keys: 'code daima', to: (c) => c.clearNodes().toggleCodeBlock() }
]

const blockTypeOf = (editor: Editor) => {
  const heading = [1, 2, 3].find((level) => editor.isActive('heading', { level }))
  if (heading) return `h${heading}`
  return BLOCK_TYPES.find((t) => t.id !== 'paragraph' && !t.id.startsWith('h') && editor.isActive(t.id))?.id ?? 'paragraph'
}

const COLOR_NAMES: Record<string, string> = { gray: '灰', red: '红', orange: '橙', yellow: '黄', green: '绿', blue: '蓝', purple: '紫' }

interface MathDraft {
  kind: 'inline' | 'block'
  latex: string
  /** Position of the formula being edited; a new one goes at the cursor */
  pos?: number
  x: number
  y: number
}

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

export function NoteEditor({ paperId, active, toast }: { paperId: string; active: boolean; toast: (t: string) => void }) {
  const [initial, setInitial] = useState<object | null>()
  useEffect(() => {
    api.loadNote(paperId).then(setInitial)
  }, [paperId])
  if (initial === undefined) return null
  return <LoadedNote paperId={paperId} initial={initial} active={active} toast={toast} />
}

function LoadedNote({ paperId, initial, active, toast }: { paperId: string; initial: object | null; active: boolean; toast: (t: string) => void }) {
  const [slash, setSlash] = useState<{ items: SlashItem[]; index: number; left: number; top: number; bottom: number; pick: (item: SlashItem) => void }>()
  const slashRef = useRef(slash)
  slashRef.current = slash
  const [math, setMath] = useState<MathDraft>()
  const editorRef = useRef<Editor>(null)
  const filePicker = useRef<HTMLInputElement>(null)

  // Autosave. The latest document is kept aside so the last save still works while the editor is being torn down.
  const latest = useRef<object>(undefined)
  const timer = useRef<number>(undefined)
  const flush = useRef(() => {})
  flush.current = () => {
    window.clearTimeout(timer.current)
    if (!latest.current) return
    const doc = latest.current
    latest.current = undefined
    api.saveNote(paperId, doc).catch(() => toast('笔记没有保存成功'))
  }
  useEffect(() => {
    const save = () => flush.current()
    window.addEventListener('beforeunload', save)
    return () => {
      window.removeEventListener('beforeunload', save)
      save()
    }
  }, [])

  const openMath = (kind: MathDraft['kind'], latex = '', pos?: number) => {
    const editor = editorRef.current
    if (!editor) return
    const at = editor.view.coordsAtPos(pos ?? editor.state.selection.from)
    setMath({ kind, latex, pos, x: at.left, y: at.bottom })
  }

  const insertImages = async (files: File[], pos?: number) => {
    for (const file of files) {
      const ext = IMAGE_EXT[file.type]
      if (!ext) {
        toast('只能放 PNG、JPG、GIF 或 WebP 图片')
        continue
      }
      try {
        const rel = await api.saveNoteImage(paperId, ext, await file.arrayBuffer())
        const src = `shiori://paper/${encodeURIComponent(paperId)}/${rel}`
        const content = { type: 'image', attrs: { src } }
        const editor = editorRef.current
        if (pos === undefined) editor?.chain().focus().insertContent(content).run()
        else editor?.chain().focus().insertContentAt(pos, content).run()
      } catch {
        toast('图片没有存成功')
      }
    }
  }

  const slashItems = useMemo<SlashItem[]>(
    () => [
      ...BLOCK_TYPES.map((t) => ({
        id: t.id,
        label: t.label,
        badge: t.badge,
        keys: t.keys,
        run: (editor: Editor, range: { from: number; to: number }) => void t.to(editor.chain().focus().deleteRange(range)).run()
      })),
      {
        id: 'hr',
        label: '分割线',
        badge: '—',
        keys: 'hr divider line fengexian',
        run: (editor, range) => void editor.chain().focus().deleteRange(range).setHorizontalRule().run()
      },
      {
        id: 'table',
        label: '表格',
        badge: '▦',
        keys: 'table biaoge',
        run: (editor, range) => void editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
      },
      {
        id: 'image',
        label: '图片',
        badge: '▣',
        keys: 'image picture tupian',
        run: (editor, range) => {
          editor.chain().focus().deleteRange(range).run()
          filePicker.current?.click()
        }
      },
      {
        id: 'mathBlock',
        label: '公式块',
        badge: '∑',
        keys: 'math latex equation gongshi',
        run: (editor, range) => {
          editor.chain().focus().deleteRange(range).run()
          openMath('block')
        }
      },
      {
        id: 'mathInline',
        label: '行内公式',
        badge: 'x²',
        keys: 'math latex inline gongshi hangnei',
        run: (editor, range) => {
          editor.chain().focus().deleteRange(range).run()
          openMath('inline')
        }
      }
    ],
    []
  )

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: true, autolink: true },
        dropcursor: { color: 'hsl(200 60% 60%)', width: 2 }
      }),
      Markdown,
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: true, cellMinWidth: 60 } }),
      Image.configure({ resize: { enabled: true, minWidth: 60, minHeight: 40, alwaysPreserveAspectRatio: true } }),
      Callout,
      NoteInlineMath.configure({
        katexOptions: { throwOnError: false },
        onClick: (node, pos) => openMath('inline', node.attrs.latex, pos)
      }),
      BlockMath.configure({
        katexOptions: { throwOnError: false },
        onClick: (node, pos) => openMath('block', node.attrs.latex, pos)
      }),
      Placeholder.configure({
        placeholder: ({ node }) => (node.type.name === 'heading' ? `${node.attrs.level} 级标题` : '输入内容，或输入 / 插入标题、待办、表格、公式…')
      }),
      slashCommands({
        items: (query) => {
          const q = query.toLowerCase()
          return slashItems.filter((item) => item.label.includes(q) || item.keys.includes(q))
        },
        open: (props) => {
          const rect = props.clientRect?.()
          if (!rect || !props.items.length) return setSlash(undefined)
          setSlash((old) => ({
            items: props.items,
            index: old && old.items.length === props.items.length ? old.index : 0,
            left: Math.min(rect.left, window.innerWidth - 216),
            top: rect.top,
            bottom: rect.bottom,
            pick: (item) => props.command(item)
          }))
        },
        key: ({ event }) => {
          const menu = slashRef.current
          if (!menu || event.isComposing) return false
          const n = menu.items.length
          if (event.key === 'ArrowDown') setSlash({ ...menu, index: (menu.index + 1) % n })
          else if (event.key === 'ArrowUp') setSlash({ ...menu, index: (menu.index + n - 1) % n })
          else if (event.key === 'Enter') menu.pick(menu.items[menu.index])
          else if (event.key === 'Escape') setSlash(undefined)
          else return false
          return true
        },
        close: () => setSlash(undefined),
        blockMath: () => openMath('block')
      })
    ],
    []
  )

  const editor = useEditor({
    extensions,
    content: initial ?? undefined,
    editorProps: {
      transformPastedHTML: cleanPastedHtml,
      handlePaste: (_view, event) => {
        const data = event.clipboardData
        if (!data) return false
        const images = [...data.files].filter((f) => f.type.startsWith('image/'))
        const text = data.getData('text/plain')
        if (images.length && !text) {
          insertImages(images)
          return true
        }
        const inCode = editorRef.current?.isActive('codeBlock')
        if (text && !data.getData('text/html') && !inCode && looksLikeMarkdown(text)) {
          const instance = editorRef.current
          const parsed = instance?.markdown?.parse(text)
          if (parsed) return instance!.chain().focus().insertContent(parsed).run()
        }
        return false
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false
        const images = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'))
        if (!images.length) return false
        event.preventDefault()
        insertImages(images, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos)
        return true
      }
    },
    onUpdate: ({ editor }) => {
      latest.current = editor.getJSON()
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => flush.current(), 400)
    }
  })
  editorRef.current = editor

  // Opening the tab puts the cursor in the note; an empty one is ready to type in.
  useEffect(() => {
    if (active && editor.isEmpty) editor.commands.focus('end')
  }, [active, editor])

  const exportMd = () => {
    const prefix = `shiori://paper/${encodeURIComponent(paperId)}/`
    navigator.clipboard.writeText(editor.getMarkdown().split(prefix).join(''))
    toast('笔记已按 Markdown 复制到剪贴板')
  }

  return (
    <div className="note-pane" hidden={!active}>
      <div className="side-scroll note-scroll" onClick={(e) => e.target === e.currentTarget && editor.commands.focus('end')}>
        <EditorContent editor={editor} className="note-doc" />
      </div>
      <BlockHandle editor={editor} />
      <SelectionBar
        editor={editor}
        onMath={() => {
          const { from, to } = editor.state.selection
          openMath('inline', editor.state.doc.textBetween(from, to, ' '))
        }}
      />
      <TableBar editor={editor} />
      {slash && (
        <div
          className="popover note-menu slash"
          style={slash.top > window.innerHeight - 340 ? { left: slash.left, bottom: window.innerHeight - slash.top + 6 } : { left: slash.left, top: slash.bottom + 6 }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {slash.items.map((item, i) => (
            <button
              key={item.id}
              className={i === slash.index ? 'on' : ''}
              ref={(el) => {
                if (i === slash.index) el?.scrollIntoView({ block: 'nearest' })
              }}
              onMouseEnter={() => setSlash({ ...slash, index: i })}
              onClick={() => slash.pick(item)}
            >
              <span className="note-badge">{item.badge}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
      {math && (
        <MathPopover
          key={`${math.kind}-${math.pos}`}
          draft={math}
          onCancel={() => {
            setMath(undefined)
            editor.commands.focus()
          }}
          onDone={(latex) => {
            setMath(undefined)
            const chain = editor.chain().focus()
            const type = math.kind === 'inline' ? 'inlineMath' : 'blockMath'
            if (math.pos === undefined) {
              if (latex) chain.insertContent({ type, attrs: { latex } }).run()
            } else if (latex) {
              if (math.kind === 'inline') chain.updateInlineMath({ latex, pos: math.pos }).run()
              else chain.updateBlockMath({ latex, pos: math.pos }).run()
            } else if (math.kind === 'inline') chain.deleteInlineMath({ pos: math.pos }).run()
            else chain.deleteBlockMath({ pos: math.pos }).run()
          }}
        />
      )}
      <input
        ref={filePicker}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          insertImages([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <div className="side-foot">
        <button className="btn sm" onClick={exportMd}>
          <Icon name="copy" size={13} />
          导出为 Markdown
        </button>
      </div>
    </div>
  )
}

const NESTED_HANDLE = { edgeDetection: 'none' } as const

/** Feishu's handle left of each block: drag to move, click for what can be done to the block. */
function BlockHandle({ editor }: { editor: Editor }) {
  const [target, setTarget] = useState<{ node: PMNode; pos: number }>()
  const [menu, setMenu] = useState<{ node: PMNode; pos: number; x: number; y: number }>()
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, () => setMenu(undefined), !!menu)

  // Runs on the block the menu was opened for; the cursor moves there first, because commands act on the selection.
  const onBlock = (fn: (c: Chain) => Chain) => {
    if (!menu) return
    setMenu(undefined)
    const inside = menu.node.isTextblock ? menu.pos + 1 : menu.pos + 2
    fn(editor.chain().focus().setTextSelection(Math.min(inside, editor.state.doc.content.size))).run()
  }
  const remove = () => {
    if (!menu) return
    setMenu(undefined)
    editor.chain().focus().deleteRange({ from: menu.pos, to: menu.pos + menu.node.nodeSize }).run()
  }
  const duplicate = () => {
    if (!menu) return
    setMenu(undefined)
    editor.chain().focus().insertContentAt(menu.pos + menu.node.nodeSize, menu.node.toJSON()).run()
  }
  const convertible = menu && (menu.node.isTextblock || ['bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem', 'blockquote', 'callout'].includes(menu.node.type.name))

  return (
    <>
      <DragHandle
        editor={editor}
        className="note-handle"
        nested={NESTED_HANDLE}
        onNodeChange={({ node, pos }) => setTarget(node && pos >= 0 ? { node, pos } : undefined)}
      >
        {/* A <button> here would swallow the drag that starts on it. */}
        <div
          className="note-grip"
          title="拖动移动，点击打开菜单"
          onClick={(e) => {
            if (!target) return
            const rect = e.currentTarget.getBoundingClientRect()
            // The handle only reports hovering over a new block; edits since then may have changed this one.
            const node = editor.state.doc.nodeAt(target.pos)
            if (node) setMenu({ node, pos: target.pos, x: rect.right + 4, y: rect.top })
          }}
        >
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
            <circle cx="2.5" cy="2.5" r="1.2" />
            <circle cx="7.5" cy="2.5" r="1.2" />
            <circle cx="2.5" cy="7" r="1.2" />
            <circle cx="7.5" cy="7" r="1.2" />
            <circle cx="2.5" cy="11.5" r="1.2" />
            <circle cx="7.5" cy="11.5" r="1.2" />
          </svg>
        </div>
      </DragHandle>
      {menu && (
        <div ref={ref} className="popover note-menu" style={{ left: Math.min(menu.x, window.innerWidth - 216), top: Math.min(menu.y, window.innerHeight - 420) }}>
          {convertible && (
            <>
              <div className="note-menu-title faint">转换为</div>
              {BLOCK_TYPES.map((t) => (
                <button key={t.id} onClick={() => onBlock(t.to)}>
                  <span className="note-badge">{t.badge}</span>
                  {t.label}
                </button>
              ))}
              <div className="note-menu-sep" />
            </>
          )}
          {menu.node.type.name === 'callout' && (
            <>
              <div className="note-swatches">
                {NOTE_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`note-swatch bg-${c} ${menu.node.attrs.color === c ? 'on' : ''}`}
                    title={COLOR_NAMES[c]}
                    onClick={() => onBlock((chain) => chain.updateAttributes('callout', { color: c }))}
                  />
                ))}
              </div>
              <div className="note-menu-sep" />
            </>
          )}
          <button onClick={duplicate}>
            <Icon name="copy" size={13} />
            创建副本
          </button>
          <button className="danger" onClick={remove}>
            <Icon name="trash" size={13} />
            删除
          </button>
        </div>
      )}
    </>
  )
}

// BubbleMenu tells its plugin about changed props with a transaction on every render, so these stay constant
// and whatever must follow the editor's state lives in a child, never around the menu itself.
const BAR_OPTIONS = { strategy: 'fixed', placement: 'top', offset: 8, flip: true, shift: { padding: 8 } } as const
// Above the table: just below it, the bar would cover the line people click to keep writing.
const TABLE_BAR_OPTIONS = { ...BAR_OPTIONS, placement: 'top-end' } as const

const showSelectionBar = ({ editor, state, from, to }: { editor: Editor; state: Editor['state']; from: number; to: number }) => {
  // The link field inside the bar takes the focus without closing the bar.
  const focused = editor.view.hasFocus() || document.activeElement?.closest('.note-bubble')
  if (from === to || !editor.isEditable || !focused) return false
  if (editor.isActive('codeBlock') || editor.isActive('image')) return false
  return state.doc.textBetween(from, to, ' ', ' ').trim().length > 0 || !state.selection.empty
}

function SelectionBar({ editor, onMath }: { editor: Editor; onMath: () => void }) {
  return (
    <BubbleMenu editor={editor} pluginKey="noteSelection" className="note-bubble" options={BAR_OPTIONS} shouldShow={showSelectionBar}>
      <SelectionTools editor={editor} onMath={onMath} />
    </BubbleMenu>
  )
}

function SelectionTools({ editor, onMath }: { editor: Editor; onMath: () => void }) {
  const [panel, setPanel] = useState<'type' | 'color' | 'link'>()
  const [url, setUrl] = useState('')
  // The editor doesn't re-render React by itself; the bar follows every selection and formatting change.
  const range = useEditorState({
    editor,
    selector: ({ editor, transactionNumber }) => ({ at: `${editor.state.selection.from}-${editor.state.selection.to}`, transactionNumber }),
    equalityFn: (a, b) => a.transactionNumber === b?.transactionNumber
  }).at
  // A new selection closes an open sub-panel; formatting the current one doesn't.
  useEffect(() => setPanel(undefined), [range])

  const toggle = (name: 'type' | 'color' | 'link') => setPanel((p) => (p === name ? undefined : name))
  const mark = (label: React.ReactNode, title: string, name: string, run: (c: Chain) => Chain) => (
    <button className={editor.isActive(name) ? 'on' : ''} title={title} onClick={() => run(editor.chain().focus()).run()}>
      {label}
    </button>
  )
  const current = BLOCK_TYPES.find((t) => t.id === blockTypeOf(editor))

  const applyLink = () => {
    const href = url.trim()
    const chain = editor.chain().focus().extendMarkRange('link')
    if (href) chain.setLink({ href: /^[a-z]+:/i.test(href) ? href : `https://${href}` }).run()
    else chain.unsetLink().run()
    setPanel(undefined)
  }

  return (
    <>
      {/* Clicks keep the text selected; the link field below is the one thing that takes focus. */}
      <div className="note-bar" onMouseDown={(e) => (e.target as HTMLElement).tagName !== 'INPUT' && e.preventDefault()}>
        <button className={`wide ${panel === 'type' ? 'on' : ''}`} title="转换" onClick={() => toggle('type')}>
          {current?.badge}
          <Icon name="down" size={11} />
        </button>
        <i />
        {mark(<b>B</b>, '加粗 ⌘B', 'bold', (c) => c.toggleBold())}
        {mark(<em>I</em>, '斜体 ⌘I', 'italic', (c) => c.toggleItalic())}
        {mark(<u>U</u>, '下划线 ⌘U', 'underline', (c) => c.toggleUnderline())}
        {mark(<s>S</s>, '删除线', 'strike', (c) => c.toggleStrike())}
        {mark(<code>{'<>'}</code>, '行内代码', 'code', (c) => c.toggleCode())}
        <button
          className={editor.isActive('link') || panel === 'link' ? 'on' : ''}
          title="链接"
          onClick={() => {
            setUrl(editor.getAttributes('link').href ?? '')
            toggle('link')
          }}
        >
          <Icon name="external" size={13} />
        </button>
        <button title="行内公式" onClick={onMath}>
          ∑
        </button>
        <button className={panel === 'color' ? 'on' : ''} title="颜色" onClick={() => toggle('color')}>
          <span className="note-a">A</span>
        </button>
      </div>
      {panel === 'type' && (
        <div className="note-bar-panel note-menu" onMouseDown={(e) => e.preventDefault()}>
          {BLOCK_TYPES.map((t) => (
            <button
              key={t.id}
              className={current?.id === t.id ? 'on' : ''}
              onClick={() => {
                t.to(editor.chain().focus()).run()
                setPanel(undefined)
              }}
            >
              <span className="note-badge">{t.badge}</span>
              {t.label}
            </button>
          ))}
        </div>
      )}
      {panel === 'link' && (
        <div className="note-bar-panel note-link">
          <input
            className="input"
            autoFocus
            placeholder="粘贴链接，留空则移除"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') applyLink()
              else if (e.key === 'Escape') {
                setPanel(undefined)
                editor.commands.focus()
              }
            }}
          />
        </div>
      )}
      {panel === 'color' && (
        <div className="note-bar-panel note-colors" onMouseDown={(e) => e.preventDefault()}>
          <div className="faint">文字颜色</div>
          <div className="note-swatches">
            <button className="note-swatch" title="默认" onClick={() => editor.chain().focus().unsetColor().run()}>
              A
            </button>
            {NOTE_COLORS.map((c) => (
              <button
                key={c}
                className={`note-swatch fg-${c} ${editor.isActive('textStyle', { color: `var(--note-${c})` }) ? 'on' : ''}`}
                title={COLOR_NAMES[c]}
                onClick={() => editor.chain().focus().setColor(`var(--note-${c})`).run()}
              >
                A
              </button>
            ))}
          </div>
          <div className="faint">背景颜色</div>
          <div className="note-swatches">
            <button className="note-swatch" title="无" onClick={() => editor.chain().focus().unsetHighlight().run()}>
              <Icon name="x" size={12} />
            </button>
            {NOTE_COLORS.map((c) => (
              <button
                key={c}
                className={`note-swatch bg-${c} ${editor.isActive('highlight', { color: `var(--note-${c}-bg)` }) ? 'on' : ''}`}
                title={COLOR_NAMES[c]}
                onClick={() => editor.chain().focus().setHighlight({ color: `var(--note-${c}-bg)` }).run()}
              />
            ))}
          </div>
        </div>
      )}
    </>
  )
}

const TableBar = memo(function TableBar({ editor }: { editor: Editor }) {
  const action = (label: string, title: string, run: (c: Chain) => Chain, danger = false) => (
    <button className={`wide ${danger ? 'danger' : ''}`} title={title} onClick={() => run(editor.chain().focus()).run()}>
      {label}
    </button>
  )
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="noteTable"
      className="note-bubble"
      options={TABLE_BAR_OPTIONS}
      shouldShow={({ editor, state }) => editor.isActive('table') && state.selection.empty && editor.view.hasFocus()}
      getReferencedVirtualElement={() => {
        const { $from } = editor.state.selection
        for (let d = $from.depth; d > 0; d--) {
          if ($from.node(d).type.name === 'table') {
            const el = editor.view.nodeDOM($from.before(d)) as HTMLElement | null
            if (el) return { getBoundingClientRect: () => el.getBoundingClientRect() }
          }
        }
        return null
      }}
    >
      <div className="note-bar" onMouseDown={(e) => e.preventDefault()}>
        {action('+ 行', '在下方加一行', (c) => c.addRowAfter())}
        {action('+ 列', '在右侧加一列', (c) => c.addColumnAfter())}
        <i />
        {action('− 行', '删除当前行', (c) => c.deleteRow())}
        {action('− 列', '删除当前列', (c) => c.deleteColumn())}
        <i />
        {action('删除表格', '删除整个表格', (c) => c.deleteTable(), true)}
      </div>
    </BubbleMenu>
  )
})

function MathPopover({ draft, onDone, onCancel }: { draft: MathDraft; onDone: (latex: string) => void; onCancel: () => void }) {
  const [latex, setLatex] = useState(draft.latex)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, () => onDone(latex.trim()))
  const preview = useMemo(
    () => (latex.trim() ? katex.renderToString(latex, { throwOnError: false, displayMode: draft.kind === 'block' }) : ''),
    [latex, draft.kind]
  )
  return (
    <div ref={ref} className="popover note-math" style={{ left: Math.min(draft.x, window.innerWidth - 336), top: Math.min(draft.y + 6, window.innerHeight - 220) }}>
      <textarea
        className="textarea code"
        rows={draft.kind === 'block' ? 3 : 1}
        autoFocus
        spellCheck={false}
        placeholder={draft.kind === 'block' ? 'LaTeX，比如 \\sum_{i=1}^n x_i' : 'LaTeX，比如 x^2'}
        value={latex}
        onChange={(e) => setLatex(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            onDone(latex.trim())
          } else if (e.key === 'Escape') onCancel()
        }}
      />
      {preview && <div className="note-math-preview" dangerouslySetInnerHTML={{ __html: preview }} />}
      <div className="faint note-math-hint">↩ 完成 · ⇧↩ 换行 · Esc 取消</div>
    </div>
  )
}
