import { useMemo, useState, type DragEvent, type ReactNode } from 'react'
import type { ClaudeStatus, PaperMeta, Settings } from '../../../shared/types'
import { api, fileUrl } from '../api'
import { Icon } from './Icon'
import { Menu, PetButton, ThemeButton, type MenuItem } from './Chrome'
import { errorText, NameInput, setPaperFolders, Suggestion, useFolders } from './Folders'
import { VenueTags } from './VenueTags'
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
  claude?: ClaudeStatus
  onOpen: (id: string) => void
  onSettings: (patch: Partial<Settings>) => void
  onOpenSettings: () => void
  toast: Toast
}) {
  const { papers, settings, claude, toast } = props
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [arxiv, setArxiv] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>()
  const folders = useFolders()
  const [place, setPlace] = useState<'all' | 'none' | string>('all')
  const [creating, setCreating] = useState<{ paper?: string }>()
  const [renaming, setRenaming] = useState<string>()
  const [dropOn, setDropOn] = useState<string>()

  const ready = !!claude?.loggedIn

  const afterImport = (list: PaperMeta[]) => {
    if (!list.length) return
    if (ready) list.filter((m) => m.status === 'new').forEach((m) => api.processPaper(m.id))
    toast(ready ? `已导入 ${list.length} 篇，开始在后台处理` : `已导入 ${list.length} 篇。连接 Claude 后即可处理`)
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
    place === 'all' || (place === 'none' ? !p.folders?.length : !!p.folders?.includes(place))

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return papers.filter(
      (p) =>
        inPlace(p) &&
        matches(p, filter) &&
        (!q || [p.title, p.titleZh, p.authors.join(' '), p.venue, p.tags.join(' ')].some((s) => s?.toLowerCase().includes(q)))
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
        { label: '新建方向…', icon: 'plus', onClick: () => setCreating({ paper: p.id }) }
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
            if (!confirm(`删除方向「${name}」？里面的论文不会被删除。`)) return
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
        { label: '归入方向…', icon: 'folder', onClick: () => openFolderMenu(p, x, y) },
        ...(p.status === 'processing' || p.status === 'queued'
          ? [{ label: '取消处理', icon: 'stop', onClick: () => api.cancelPaper(p.id) }]
          : [{ label: p.processedAt ? '重新处理' : '开始处理', icon: 'refresh', onClick: () => api.processPaper(p.id) }]),
        { label: p.finished ? '标为未读完' : '标为已读完', icon: 'check', onClick: () => api.updatePaper(p.id, { finished: !p.finished }) },
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
      <PetButton />
      <header className="topbar drag">
        <div className="brand">
          <span className="brand-mark">栞</span>
          <span>Shiori</span>
        </div>
        <div className="topbar-actions">
          <ThemeButton theme={settings.theme} onChange={(theme) => props.onSettings({ theme })} />
          <button className="icon-btn bordered no-drag" title="设置" onClick={props.onOpenSettings}>
            <Icon name="settings" />
          </button>
        </div>
      </header>

      <div className="lib-body">
      {papers.length > 0 && (
        <aside className="lib-side">
          <button className={`lib-side-item ${place === 'all' ? 'on' : ''}`} onClick={() => setPlace('all')}>
            <span>全部论文</span>
            <i>{papers.length}</i>
          </button>
          <button
            className={`lib-side-item ${place === 'none' ? 'on' : ''} ${dropOn === 'none' ? 'drop' : ''}`}
            onClick={() => setPlace('none')}
            title="把论文拖到这里，可以把它移出所有方向"
            {...dropProps('none', (p) => setPaperFolders(p.id, []))}
          >
            <span>未分类</span>
            <i>{papers.filter((p) => !p.folders?.length).length}</i>
          </button>
          <div className="lib-side-head">
            <span>研究方向</span>
            <button className="icon-btn" title="新建方向" onClick={() => setCreating({})}>
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
          {creating && <NameInput placeholder="方向名称" onDone={(name) => createFolder(name, creating.paper)} />}
          {!folders.length && !creating && <p className="lib-side-hint faint">点 + 新建方向，再把论文拖进来。</p>}
        </aside>
      )}
      <main className="lib-scroll">
        <div className="lib-inner">
          <section className="lib-hero fade-in">
            <h1>论文书架</h1>
            <p className="muted">
              {stats.total ? (
                <>
                  共 <b>{stats.total}</b> 篇 · 已读完 <b>{stats.done}</b> 篇 · 本月读过 <b>{stats.month}</b> 篇
                </>
              ) : (
                '把论文放进来，Claude 会在后台把它整理成一篇排好版的中文文章。'
              )}
            </p>
          </section>

          {claude && !ready && (
            <button className="claude-banner card fade-in" onClick={props.onOpenSettings}>
              <Icon name="sparkles" size={18} />
              <div>
                <b>{claude.error === 'not-installed' ? '还没有安装 Claude Code' : '还没有登录 Claude Code'}</b>
                <span className="muted">转写、翻译和问答都通过你的 Claude 订阅完成。点这里完成设置。</span>
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
            <p className="import-hint faint">也可以直接把 PDF 拖进窗口。导入后自动用 {modelName(settings.processModel)} 转写全文并翻译成中文。</p>
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
          </section>
          {papers.length > 0 && !shown.length && <p className="empty faint">没有符合条件的论文</p>}
        </div>
      </main>
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

export const modelName = (m: string) => ({ opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' })[m] ?? m

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
        <h3>{p.titleZh || p.title}</h3>
        {p.titleZh && <p className="paper-en">{p.title}</p>}
        {p.authors.length > 0 && (
          <p className="paper-authors muted">
            {p.authors.slice(0, 4).join(', ')}
            {p.authors.length > 4 && ` 等 ${p.authors.length} 人`}
          </p>
        )}
        {folderNames.length > 0 && <p className="paper-folders">{folderNames.join(' · ')}</p>}
        {suggestion}
        <div className="paper-foot">
          {p.venue || p.year ? <VenueTags venue={p.venue} year={p.year} /> : <span className="mono faint">{p.pages ? `${p.pages} 页` : ''}</span>}
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
