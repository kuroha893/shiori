import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { PaperMeta, Settings, SystemNotice } from '../../../shared/types'
import { shownVenue } from '../../../shared/venue'
import { plainText } from '../../../shared/tex'
import { pickModel, type ServiceStatus } from '../../../shared/models'
import { api } from '../api'
import { Icon } from './Icon'
import { Menu, ThemeButton, type MenuItem } from './Chrome'
import { PhoneLauncher } from './Phone'
import { StatusBlock } from './Quota'
import { Conferences, LaterCard, useConfOverview, useLater } from './Conferences'
import { errorText, NameInput, setPaperFolders, useFolders } from './Folders'
import { dayLabel, ImportButton, PAPER_DRAG, PaperCard, Shelf, ShelfSearch, ShelfTools, StickyGroups, type ItemProps } from './Shelf'
import { Room } from './Room'
import brand from '../assets/brand.png'
import { titlesOf } from '../lib/titles'
import type { Toast } from './App'

/** 书库, 大厅 or 会议; kept by the app so closing a paper goes back to where it was opened. The switch holds 书库 and
 * 会议; the brand at the top of the library goes to 大厅. */
export type Space = 'lib' | 'room' | 'conf'
const SPACES: { id: Space; label: string }[] = [
  { id: 'lib', label: '书库' },
  { id: 'conf', label: '会议' }
]

export function Library(props: {
  papers: PaperMeta[]
  settings: Settings
  services?: ServiceStatus
  onOpen: (id: string) => void
  onSettings: (patch: Partial<Settings>) => void
  onOpenSettings: () => void
  toast: Toast
  space: Space
  onSpace: (s: Space) => void
}) {
  const { papers, settings, services, toast, space, onSpace: setSpace } = props
  const [confStart, setConfStart] = useState<{ conf: string; year: number }>()
  const [query, setQuery] = useState('')
  const [dragging, setDragging] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>()
  const folders = useFolders()
  const [chosenPlace, setPlace] = useState<'all' | 'none' | 'liked' | 'later' | string>('all')
  const likedCount = papers.filter((p) => p.likedAt).length
  const later = useLater()
  const laterCount = papers.filter((p) => p.laterAt).length + later.length
  const overview = useConfOverview()
  /** A notice's button in the phone: open what it is about, or sign in */
  const phoneAction = (n: SystemNotice) => {
    const a = n.action
    if (!a) return
    if (a.kind === 'paper') return props.onOpen(a.paper)
    if (a.kind === 'edition') {
      setConfStart({ conf: a.conf, year: a.year })
      return setSpace('conf')
    }
    if (a.kind === 'later') {
      setPlace('later')
      return setSpace('lib')
    }
    if (a.kind === 'login') return a.provider === 'deepseek' ? props.onOpenSettings() : void api.serviceLogin(a.provider)
    if (a.kind === 'openreview') return void api.openReviewSignIn()
    if (a.kind === 'settings') return props.onOpenSettings()
    if (a.kind === 'retry') return void api.phoneAct(n.id)
  }
  // The liked and later lists disappear with their last paper.
  const place = (chosenPlace === 'liked' && !likedCount) || (chosenPlace === 'later' && !laterCount) ? 'all' : chosenPlace
  // A PDF that turned up for a 稍后再看 paper stays marked until the owner leaves the list.
  useEffect(() => {
    if (place === 'later') return () => void api.laterSeen()
  }, [place])
  // ⌘1 and ⌘2 switch between the spaces, in the switch's order.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const s = e.metaKey && SPACES[Number(e.key) - 1]
      if (!s) return
      e.preventDefault()
      setSpace(s.id)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  const [creating, setCreating] = useState<{ paper?: string }>()
  const [renaming, setRenaming] = useState<string>()
  const [dropOn, setDropOn] = useState<string>()
  // The top bar's search lines up with the papers' left edge, wherever the centred column and the scrollbar put it.
  const inner = useRef<HTMLDivElement>(null)
  const [shelfLeft, setShelfLeft] = useState<number>()
  // 会议 puts its own search here (it knows what it searches: everything, or one edition)
  const [confSearch, setConfSearch] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = inner.current
    if (!el) return
    const measure = () => setShelfLeft(Math.round(el.getBoundingClientRect().left))
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [space])

  const processWith = services && pickModel(settings.processModel, services.models, 'process')
  const ready = !!processWith

  const afterImport = (list: PaperMeta[]) => {
    if (!list.length) return
    if (ready) list.filter((m) => m.status === 'new').forEach((m) => api.processPaper(m.id))
    toast(ready ? `已导入 ${list.length} 篇，开始在后台处理` : `已导入 ${list.length} 篇。接入模型服务后即可处理`)
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
        (!q || [plainText(p.title), p.titleZh && plainText(p.titleZh), p.authors.join(' '), shownVenue(p).venue, p.tags.join(' ')].some((s) => s?.toLowerCase().includes(q)))
    )
  }, [papers, query, place])

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
          : [{ label: p.processedAt || p.kept !== undefined ? '重新处理' : '开始处理', icon: 'refresh', onClick: () => api.processPaper(p.id, true) }]),
        { label: p.finished ? '标为未读完' : '标为已读完', icon: 'check', onClick: () => api.updatePaper(p.id, { finished: !p.finished }) },
        { label: p.laterAt ? '移出稍后再看' : '稍后再看', icon: 'bookmark', onClick: () => api.updatePaper(p.id, { laterAt: p.laterAt ? undefined : new Date().toISOString() }) },
        { label: '在 Finder 中显示', icon: 'folder', onClick: () => api.revealPaper(p.id) },
        ...(p.arxiv ? [{ label: '打开 arXiv 页面', icon: 'external', onClick: () => api.openExternal(`https://arxiv.org/abs/${p.arxiv}`) }] : []),
        {
          label: '移到废纸篓',
          icon: 'trash',
          danger: true,
          onClick: () => {
            if (confirm(`把「${titlesOf(p).main}」连同批注和对话移到废纸篓？`)) api.trashPaper(p.id)
          }
        }
      ]
    })

  const item: ItemProps = {
    onOpen: (p) => props.onOpen(p.id),
    onProcess: (p) => (ready ? api.processPaper(p.id) : props.onOpenSettings()),
    onMenu: (p, x, y) => openMenu(p, x, y),
    folderNames: (p) => folders.filter((f) => p.folders?.includes(f.id)).map((f) => f.name)
  }

  return (
    <div
      className={`lib ${space === 'room' ? 'in-room' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        if (e.dataTransfer.types.includes('Files')) setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      {space !== 'room' && <PhoneLauncher papers={papers} onAction={phoneAction} />}
      <header className="topbar drag">
        {space === 'lib' && <ShelfSearch left={shelfLeft} query={query} onQuery={setQuery} />}
        {space === 'conf' && <div className="lib-bar-slot" ref={setConfSearch} />}
        <div className="topbar-actions">
          {space === 'lib' && (
            <ShelfTools
              view={settings.libraryView}
              group={settings.libraryGroup}
              arrange={place !== 'later'}
              onView={(libraryView) => props.onSettings({ libraryView })}
              onGroup={(libraryGroup) => props.onSettings({ libraryGroup })}
              importer={<ImportButton onImported={afterImport} onOpen={props.onOpen} toast={toast} />}
            />
          )}
          <StatusBlock papers={papers} music={space !== 'room'} />
          <ThemeButton theme={settings.theme} onChange={(theme) => props.onSettings({ theme })} />
          <button className="icon-btn bordered no-drag" title="设置" onClick={props.onOpenSettings}>
            <Icon name="settings" />
          </button>
        </div>
        {/*
          Last in the bar: the window's drag area is worked out in document order, later regions over earlier ones, and
          drag is inherited, so the tools' row (drag between its pieces) would otherwise cover the switch's no-drag zone.
        */}
        <SpaceSwitch space={space} onChange={setSpace} fresh={space !== 'conf' && !!overview?.fresh} />
      </header>

      <div className="lib-body">
      {space === 'room' ? (
        <Room papers={papers} wall={settings.wallpaperIn.includes('room')} onOpenPaper={props.onOpen} onAction={phoneAction} />
      ) : space === 'conf' ? (
        <Conferences key={confStart ? `${confStart.conf}/${confStart.year}` : 'home'} start={confStart} searchSlot={confSearch} overview={overview} library={papers} ready={ready} onOpenPaper={props.onOpen} toast={toast} />
      ) : (
      <>
      <aside className="lib-side">
          <div className="brand drag">
            <button className="brand-home no-drag" onClick={() => setSpace('room')}>
              <img className="brand-mark" src={brand} alt="" draggable={false} />
              <span>Shiori</span>
            </button>
          </div>
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
        <div className="lib-inner" ref={inner}>
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

          {place !== 'later' ? (
            <Shelf papers={shown} view={settings.libraryView} group={settings.libraryGroup} {...item} />
          ) : (
            <LaterDays
              marked={[
                ...shown.map((p) => ({ at: p.laterAt ?? '', node: (i: number) => <PaperCard key={p.id} paper={p} index={i} {...item} /> })),
                ...later.map((it) => ({ at: it.addedAt, node: () => <LaterCard key={it.ref} item={it} ready={ready} toast={toast} /> }))
              ]}
            />
          )}
          {!papers.length ? (
            <p className="empty faint">暂无论文</p>
          ) : (
            !shown.length && !(place === 'later' && later.length) && <p className="empty faint">没有符合条件的论文</p>
          )}
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

/** 稍后再看, newest first, one group per day it was marked on. */
function LaterDays({ marked }: { marked: { at: string; node: (i: number) => React.ReactNode }[] }) {
  const groups = useMemo(() => {
    const now = new Date()
    const out: { key: string; items: typeof marked }[] = []
    for (const m of [...marked].sort((a, b) => b.at.localeCompare(a.at))) {
      const key = dayLabel(new Date(m.at), now)
      if (out.at(-1)?.key === key) out.at(-1)!.items.push(m)
      else out.push({ key, items: [m] })
    }
    return out
  }, [marked])
  let i = 0
  return <StickyGroups groups={groups.map((g) => ({ key: g.key, count: g.items.length, body: <div className="grid">{g.items.map((m) => m.node(i++))}</div> }))} />
}

/**
 * 书库 or 会议. The switch waits above the top bar and drops down when the pointer comes near the top middle, staying a
 * moment after it leaves. The top bar drags the window and gets no mouse events, so the zone that wakes it is no-drag.
 */
function SpaceSwitch({ space, onChange, fresh }: { space: Space; onChange: (s: Space) => void; fresh: boolean }) {
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
  // In 大厅 it stays down: the lobby has nothing else to lead out of it.
  const pinned = space === 'room'
  return (
    <>
      {!pinned && (
        <div className={`space-zone no-drag ${fresh ? 'fresh' : ''} ${open ? 'open' : ''}`} onMouseEnter={show} onMouseLeave={() => hide(2000)}>
          <i className="space-handle" />
        </div>
      )}
      <div className={`seg space-switch no-drag ${open || pinned ? 'open' : ''}`} onMouseEnter={show} onMouseLeave={() => hide(2000)}>
        {SPACES.map((s) => (
          <button
            key={s.id}
            className={`${space === s.id ? 'on' : ''} ${s.id === 'conf' && fresh ? 'fresh' : ''}`}
            onClick={() => {
              onChange(s.id)
              hide(700)
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
    </>
  )
}
