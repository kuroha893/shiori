import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { PaperMeta, Settings } from '../../../shared/types'
import { shownVenue } from '../../../shared/venue'
import { plainText } from '../../../shared/tex'
import { modelLabel, pickModel, type ServiceStatus } from '../../../shared/models'
import { api, fileUrl } from '../api'
import { Icon } from './Icon'
import { CallLauncher, HeartButton, LaterButton, Menu, ThemeButton, type MenuItem } from './Chrome'
import { Conferences, LaterCard, useConfOverview, useLater } from './Conferences'
import { errorText, NameInput, setPaperFolders, Suggestion, useFolders } from './Folders'
import { PaperVenue } from './VenueTags'
import { PaperText } from './PaperText'
import brand from '../assets/brand.png'
import type { Toast } from './App'

type Filter = 'all' | 'todo' | 'busy' | 'ready' | 'done'

const PAPER_DRAG = 'application/x-shiori-paper'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'ready', label: '可阅读' },
  { id: 'busy', label: '处理中' },
  { id: 'todo', label: '未处理' },
  { id: 'done', label: '已读完' }
]

const matches = (p: PaperMeta, f: Filter) =>
  f === 'all' ||
  (f === 'ready' && p.status === 'ready' && !p.finished) ||
  (f === 'busy' && (p.status === 'processing' || p.status === 'queued')) ||
  (f === 'todo' && (p.status === 'new' || p.status === 'error')) ||
  (f === 'done' && !!p.finished)

export function Library(props: {
  papers: PaperMeta[]
  settings: Settings
  services?: ServiceStatus
  onOpen: (id: string) => void
  onSettings: (patch: Partial<Settings>) => void
  onOpenSettings: () => void
  toast: Toast
}) {
  const { papers, settings, services, toast } = props
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [arxiv, setArxiv] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>()
  const folders = useFolders()
  const [space, setSpace] = useState<'lib' | 'conf'>('lib')
  const [chosenPlace, setPlace] = useState<'all' | 'none' | 'liked' | 'later' | string>('all')
  const likedCount = papers.filter((p) => p.likedAt).length
  const later = useLater()
  const laterCount = papers.filter((p) => p.laterAt).length + later.length
  const overview = useConfOverview()
  // The liked and later lists disappear with their last paper.
  const place = (chosenPlace === 'liked' && !likedCount) || (chosenPlace === 'later' && !laterCount) ? 'all' : chosenPlace
  // A PDF that turned up for a 稍后再看 paper stays marked until the owner leaves the list.
  useEffect(() => {
    if (place === 'later') return () => void api.laterSeen()
  }, [place])
  // ⌘1 and ⌘2 switch between the library and the conferences.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!e.metaKey || (e.key !== '1' && e.key !== '2')) return
      e.preventDefault()
      setSpace(e.key === '1' ? 'lib' : 'conf')
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  const [creating, setCreating] = useState<{ paper?: string }>()
  const [renaming, setRenaming] = useState<string>()
  const [dropOn, setDropOn] = useState<string>()

  const processWith = services && pickModel(settings.processModel, services.models, 'process')
  const ready = !!processWith

  const afterImport = (list: PaperMeta[]) => {
    if (!list.length) return
    if (ready) list.filter((m) => m.status === 'new').forEach((m) => api.processPaper(m.id))
    toast(ready ? `已导入 ${list.length} 篇，开始在后台处理` : `已导入 ${list.length} 篇。接入模型服务后即可处理`)
  }

  const importArxiv = async () => {
    if (!arxiv.trim() || busy) return
    setBusy(true)
    try {
      afterImport([await api.importArxiv(arxiv)])
      setArxiv('')
    } catch (e) {
      toast(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (!e.dataTransfer.types.includes('Files')) return
    const files = [...e.dataTransfer.files].filter((f) => f.name.toLowerCase().endsWith('.pdf'))
    if (!files.length) return toast('只支持 PDF 文件')
    afterImport(await api.importFiles(files))
  }

  const inPlace = (p: PaperMeta) =>
    place === 'all' ||
    (place === 'none' ? !p.folders?.length : place === 'liked' ? !!p.likedAt : place === 'later' ? !!p.laterAt : !!p.folders?.includes(place))

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return papers.filter(
      (p) =>
        inPlace(p) &&
        matches(p, filter) &&
        (!q || [plainText(p.title), p.titleZh && plainText(p.titleZh), p.authors.join(' '), shownVenue(p).venue, p.tags.join(' ')].some((s) => s?.toLowerCase().includes(q)))
    )
  }, [papers, filter, query, place])

  const thisMonth = new Date().toISOString().slice(0, 7)
  const stats = {
    total: papers.length,
    done: papers.filter((p) => p.finished).length,
    month: papers.filter((p) => p.readAt?.startsWith(thisMonth)).length
  }

  const fileUnder = (p: PaperMeta, id: string) => {
    const now = p.folders ?? []
    setPaperFolders(p.id, now.includes(id) ? now.filter((f) => f !== id) : [...now, id])
  }

  const openFolderMenu = (p: PaperMeta, x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        ...folders.map((f) => ({ label: f.name, icon: p.folders?.includes(f.id) ? 'check' : 'folder', onClick: () => fileUnder(p, f.id) })),
        { label: '新建分类…', icon: 'plus', onClick: () => setCreating({ paper: p.id }) }
      ]
    })

  const createFolder = async (name: string | undefined, paper?: string) => {
    setCreating(undefined)
    if (!name?.trim()) return
    try {
      const folder = await api.createFolder(name)
      const p = papers.find((x) => x.id === paper)
      if (p) setPaperFolders(p.id, [...(p.folders ?? []), folder.id])
    } catch (e) {
      toast(errorText(e))
    }
  }

  const renameFolder = (id: string, name?: string) => {
    setRenaming(undefined)
    if (name?.trim()) api.renameFolder(id, name).catch((e) => toast(errorText(e)))
  }

  const openFolderActions = (id: string, name: string, x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        { label: '重命名', icon: 'note', onClick: () => setRenaming(id) },
        {
          label: '删除',
          icon: 'trash',
          danger: true,
          onClick: () => {
            if (!confirm(`删除分类「${name}」？里面的论文不会被删除。`)) return
            api.deleteFolder(id)
            if (place === id) setPlace('all')
          }
        }
      ]
    })

  const dropProps = (key: string, onPaper: (p: PaperMeta) => void) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(PAPER_DRAG)) return
      e.preventDefault()
      setDropOn(key)
    },
    onDragLeave: () => setDropOn(undefined),
    onDrop: (e: DragEvent) => {
      const p = papers.find((x) => x.id === e.dataTransfer.getData(PAPER_DRAG))
      setDropOn(undefined)
      if (!p) return
      e.preventDefault()
      e.stopPropagation()
      onPaper(p)
    }
  })

  const openMenu = (p: PaperMeta, x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        { label: '归入分类…', icon: 'folder', onClick: () => openFolderMenu(p, x, y) },
        ...(p.status === 'processing' || p.status === 'queued'
          ? [{ label: '取消处理', icon: 'stop', onClick: () => api.cancelPaper(p.id) }]
          : [{ label: p.processedAt ? '重新处理' : '开始处理', icon: 'refresh', onClick: () => api.processPaper(p.id) }]),
        { label: p.finished ? '标为未读完' : '标为已读完', icon: 'check', onClick: () => api.updatePaper(p.id, { finished: !p.finished }) },
        { label: p.laterAt ? '移出稍后再看' : '稍后再看', icon: 'bookmark', onClick: () => api.updatePaper(p.id, { laterAt: p.laterAt ? undefined : new Date().toISOString() }) },
        { label: '在 Finder 中显示', icon: 'folder', onClick: () => api.revealPaper(p.id) },
        ...(p.arxiv ? [{ label: '打开 arXiv 页面', icon: 'external', onClick: () => api.openExternal(`https://arxiv.org/abs/${p.arxiv}`) }] : []),
        {
          label: '移到废纸篓',
          icon: 'trash',
          danger: true,
          onClick: () => {
            if (confirm(`把「${p.titleZh || p.title}」连同批注和对话移到废纸篓？`)) api.trashPaper(p.id)
          }
        }
      ]
    })

  return (
    <div
      className="lib"
      onDragOver={(e) => {
        e.preventDefault()
        if (e.dataTransfer.types.includes('Files')) setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      <CallLauncher />
      <header className="topbar drag">
        <div className="brand">
          <img className="brand-mark" src={brand} alt="" draggable={false} />
          <span>Shiori</span>
        </div>
        <SpaceSwitch space={space} onChange={setSpace} fresh={space === 'lib' && !!overview?.fresh} />
        <div className="topbar-actions">
          <ThemeButton theme={settings.theme} onChange={(theme) => props.onSettings({ theme })} />
          <button className="icon-btn bordered no-drag" title="设置" onClick={props.onOpenSettings}>
            <Icon name="settings" />
          </button>
        </div>
      </header>

      <div className="lib-body">
      {space === 'conf' ? (
        <Conferences overview={overview} library={papers} ready={ready} onOpenPaper={props.onOpen} toast={toast} />
      ) : (
      <>
      <aside className="lib-side">
          <button className={`lib-side-item ${place === 'all' ? 'on' : ''}`} onClick={() => setPlace('all')}>
            <span>全部论文</span>
            <i>{papers.length}</i>
          </button>
          <button
            className={`lib-side-item ${place === 'none' ? 'on' : ''} ${dropOn === 'none' ? 'drop' : ''}`}
            onClick={() => setPlace('none')}
            title="把论文拖到这里，可以把它移出所有分类"
            {...dropProps('none', (p) => setPaperFolders(p.id, []))}
          >
            <span>未分类</span>
            <i>{papers.filter((p) => !p.folders?.length).length}</i>
          </button>
          {likedCount > 0 && (
            <button className={`lib-side-item ${place === 'liked' ? 'on' : ''}`} onClick={() => setPlace('liked')}>
              <span>我喜欢的论文</span>
              <i>{likedCount}</i>
            </button>
          )}
          {laterCount > 0 && (
            <button
              className={`lib-side-item ${place === 'later' ? 'on' : ''}`}
              onClick={() => setPlace('later')}
            >
              <span>稍后再看</span>
              {later.some((i) => i.pdfNew) ? <b className="lib-side-badge">PDF</b> : <i>{laterCount}</i>}
            </button>
          )}
          <div className="lib-side-head">
            <span>我的分类</span>
            <button className="icon-btn" title="新建分类" onClick={() => setCreating({})}>
              <Icon name="plus" size={14} />
            </button>
          </div>
          {folders.map((f) =>
            renaming === f.id ? (
              <NameInput key={f.id} initial={f.name} onDone={(name) => renameFolder(f.id, name)} />
            ) : (
              <button
                key={f.id}
                className={`lib-side-item ${place === f.id ? 'on' : ''} ${dropOn === f.id ? 'drop' : ''}`}
                onClick={() => setPlace(f.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  openFolderActions(f.id, f.name, e.clientX, e.clientY)
                }}
                {...dropProps(f.id, (p) => !p.folders?.includes(f.id) && fileUnder(p, f.id))}
              >
                <span>{f.name}</span>
                <i>{papers.filter((p) => p.folders?.includes(f.id)).length}</i>
              </button>
            )
          )}
          {creating && <NameInput placeholder="分类名称" onDone={(name) => createFolder(name, creating.paper)} />}
          {!folders.length && !creating && <p className="lib-side-hint faint">点 + 新建分类，再把论文拖进来。</p>}
        </aside>
      <main className="lib-scroll">
        <div className="lib-inner">
          <section className="lib-hero fade-in">
            <h1>论文书架</h1>
            <p className="muted">
              {stats.total ? (
                <>
                  <span>共 <b>{stats.total}</b> 篇</span>
                  <span>已读完 <b>{stats.done}</b> 篇</span>
                  <span>本月读过 <b>{stats.month}</b> 篇</span>
                </>
              ) : (
                '把论文放进来，Shiori 会在后台把它整理成一篇排好版的中文文章。'
              )}
            </p>
          </section>

          {services && !ready && (
            <button className="ai-banner card fade-in" onClick={props.onOpenSettings}>
              <Icon name="sparkles" size={18} />
              <div>
                <b>还没有接入模型服务</b>
                <span className="muted">转写、翻译和问答需要 Claude、ChatGPT 或 DeepSeek 中的一个。点这里完成设置。</span>
              </div>
              <Icon name="next" />
            </button>
          )}

          <section className="import card fade-in">
            <div className="import-row">
              <div className="import-input">
                <Icon name="search" className="faint" />
                <input
                  className="bare"
                  placeholder="粘贴 arXiv 编号或链接，例如 2310.06825"
                  value={arxiv}
                  onChange={(e) => setArxiv(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && importArxiv()}
                />
              </div>
              <button className="btn primary" disabled={!arxiv.trim() || busy} onClick={importArxiv}>
                {busy ? '下载中…' : '导入'}
              </button>
              <span className="import-or faint">或</span>
              <button className="btn" onClick={async () => afterImport(await api.importDialog())}>
                <Icon name="file" />
                选择 PDF
              </button>
            </div>
            <p className="import-hint faint">也可以直接把 PDF 拖进窗口。导入后{processWith ? `自动用 ${modelLabel(processWith)} ` : ''}转写全文并翻译成中文。</p>
          </section>

          {papers.length > 0 && (
            <div className="lib-tools fade-in">
              <div className="seg">
                {FILTERS.map((f) => (
                  <button key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
                    {f.label}
                  </button>
                ))}
              </div>
              <input className="input lib-search" placeholder="搜索标题、作者、会议…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          )}

          <section className="grid">
            {shown.map((p, i) => (
              <PaperCard
                key={p.id}
                paper={p}
                index={i}
                folderNames={folders.filter((f) => p.folders?.includes(f.id)).map((f) => f.name)}
                suggestion={<Suggestion paper={p} folders={folders} toast={toast} />}
                onOpen={() => p.status === 'ready' && props.onOpen(p.id)}
                onProcess={() => (ready ? api.processPaper(p.id) : props.onOpenSettings())}
                onMenu={(x, y) => openMenu(p, x, y)}
              />
            ))}
            {place === 'later' && later.map((item) => <LaterCard key={item.ref} item={item} ready={ready} toast={toast} />)}
          </section>
          {papers.length > 0 && !shown.length && !(place === 'later' && later.length) && <p className="empty faint">没有符合条件的论文</p>}
        </div>
      </main>
      </>
      )}
      </div>

      {dragging && (
        <div className="drop-zone">
          <div>
            <Icon name="file" size={28} />
            <p>松手导入 PDF</p>
          </div>
        </div>
      )}
      {menu && <Menu {...menu} onClose={() => setMenu(undefined)} />}
    </div>
  )
}

function PaperCard({
  paper: p,
  index,
  folderNames,
  suggestion,
  onOpen,
  onProcess,
  onMenu
}: {
  paper: PaperMeta
  index: number
  folderNames: string[]
  suggestion: ReactNode
  onOpen: () => void
  onProcess: () => void
  onMenu: (x: number, y: number) => void
}) {
  const busy = p.status === 'processing' || p.status === 'queued'
  const ratio = p.readPos?.ratio ?? 0
  return (
    <article
      className={`paper card ${p.status === 'ready' ? 'clickable' : ''}`}
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
      onClick={onOpen}
      draggable
      onDragStart={(e) => e.dataTransfer.setData(PAPER_DRAG, p.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <div className="paper-thumb">
        {p.pages ? <img src={`${fileUrl(p.id, 'thumb.png')}?v=${p.pages}`} alt="" draggable={false} /> : <Icon name="file" size={22} />}
      </div>
      <div className="paper-body">
        <PaperText as="h3" text={p.titleZh || p.title} zh={!!p.titleZh} />
        {p.titleZh && <PaperText as="p" className="paper-en" text={p.title} />}
        {p.authors.length > 0 && (
          <p className="paper-authors muted">
            {p.authors.slice(0, 4).join(', ')}
            {p.authors.length > 4 && ` 等 ${p.authors.length} 人`}
          </p>
        )}
        {folderNames.length > 0 && (
          <p className="paper-folders">
            {folderNames.map((n) => (
              <span key={n}>{n}</span>
            ))}
          </p>
        )}
        {suggestion}
        <div className="paper-foot">
          {shownVenue(p).venue || shownVenue(p).year ? <PaperVenue paper={p} /> : <span className="mono faint">{p.pages ? `${p.pages} 页` : ''}</span>}
          <span className="spacer" />
          {p.status === 'ready' &&
            (p.finished ? (
              <span className="pill ok">
                <Icon name="check" size={12} />
                已读完
              </span>
            ) : ratio > 0.01 ? (
              <span className="read-progress" title={`读到 ${Math.round(ratio * 100)}%`}>
                <i style={{ width: `${Math.round(ratio * 100)}%` }} />
              </span>
            ) : (
              <span className="pill">未开始</span>
            ))}
          {busy && (
            <span className="pill busy">
              <span className="dot" />
              {p.status === 'queued' ? '排队中' : `${Math.round((p.progress ?? 0) * 100)}%`}
            </span>
          )}
          {p.status === 'error' && (
            <span className="pill err" title={p.error}>
              <span className="dot" />
              处理失败
            </span>
          )}
          {(p.status === 'new' || p.status === 'error') && (
            <button
              className="btn sm"
              onClick={(e) => {
                e.stopPropagation()
                onProcess()
              }}
            >
              <Icon name="play" size={12} />
              {p.status === 'error' ? '重试' : '处理'}
            </button>
          )}
          <LaterButton paper={p} />
          <HeartButton paper={p} />
          <button
            className="icon-btn more"
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              onMenu(r.left - 150, r.bottom + 4)
            }}
          >
            <Icon name="more" />
          </button>
        </div>
        {busy && (
          <div className="paper-stage">
            <span className="faint">{p.stage}</span>
            <span className="bar">
              <i style={{ width: `${Math.max(3, Math.round((p.progress ?? 0) * 100))}%` }} />
            </span>
          </div>
        )}
        {p.status === 'error' && p.error && <p className="paper-error">{p.error}</p>}
      </div>
    </article>
  )
}

/**
 * 书库 or 会议. The switch waits above the top bar and drops down when the pointer comes near the top middle, staying a
 * moment after it leaves. The top bar drags the window and gets no mouse events, so the zone that wakes it is no-drag.
 */
function SpaceSwitch({ space, onChange, fresh }: { space: 'lib' | 'conf'; onChange: (s: 'lib' | 'conf') => void; fresh: boolean }) {
  const [open, setOpen] = useState(false)
  const timers = useRef<{ show?: number; hide?: number }>({})
  const clear = () => {
    window.clearTimeout(timers.current.show)
    window.clearTimeout(timers.current.hide)
  }
  const show = () => {
    clear()
    timers.current.show = window.setTimeout(() => setOpen(true), 60)
  }
  const hide = (after: number) => {
    clear()
    timers.current.hide = window.setTimeout(() => setOpen(false), after)
  }
  useEffect(() => clear, [])
  return (
    <>
      <div className={`space-zone no-drag ${fresh ? 'fresh' : ''} ${open ? 'open' : ''}`} onMouseEnter={show} onMouseLeave={() => hide(2000)}>
        <i className="space-handle" />
      </div>
      <div className={`seg space-switch no-drag ${open ? 'open' : ''}`} onMouseEnter={show} onMouseLeave={() => hide(2000)}>
        {(['lib', 'conf'] as const).map((s) => (
          <button
            key={s}
            className={space === s ? 'on' : ''}
            onClick={() => {
              onChange(s)
              hide(700)
            }}
          >
            {s === 'lib' ? '书库' : '会议'}
          </button>
        ))}
      </div>
    </>
  )
}
