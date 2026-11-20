import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ArxivPeek, LibraryGroup, LibraryView, PaperMeta } from '../../../shared/types'
import { shownVenue, venueTag } from '../../../shared/venue'
import { api, fileUrl } from '../api'
import { Icon } from './Icon'
import { HeartButton, Kept, LaterButton, useDismiss } from './Chrome'
import { PaperVenue, VenueTags } from './VenueTags'
import { PaperText, PaperTitle } from './PaperText'
import { errorText } from './Folders'

/*
 * 书库's shelf: the papers of a place, shown as covers, cards or a list, either in one run (newest import first) or in
 * groups with a heading that sticks while you are inside the group. The view and the grouping are chosen in the top
 * bar, as in Finder's toolbar.
 */

export const PAPER_DRAG = 'application/x-shiori-paper'

export const GROUPS: { id: LibraryGroup; label: string }[] = [
  { id: 'none', label: '无' },
  { id: 'added', label: '导入时间' },
  { id: 'venue', label: '会议' },
  { id: 'year', label: '年份' },
  { id: 'state', label: '阅读状态' }
]

const VIEWS: { id: LibraryView; icon: string; label: string }[] = [
  { id: 'cover', icon: 'covers', label: '封面' },
  { id: 'card', icon: 'cards', label: '卡片' },
  { id: 'list', icon: 'list', label: '列表' }
]

/** 今天, 昨天, or the day itself; the year only when it isn't this one. */
export function dayLabel(d: Date, now: Date): string {
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const back = Math.round((day(now) - day(d)) / 864e5)
  if (back === 0) return '今天'
  if (back === 1) return '昨天'
  return `${d.getFullYear() !== now.getFullYear() ? `${d.getFullYear()} 年 ` : ''}${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

const newest = (a: string | undefined, b: string | undefined) => (b ?? '').localeCompare(a ?? '')
const reading = (p: PaperMeta) => p.status === 'ready' && !p.finished && (p.readPos?.ratio ?? 0) > 0.01

/** Where a paper goes when grouped by venue: the conference and its year; preprints, reports and the rest at the end. */
function venueGroup(p: PaperMeta): { key: string; year: string; tail: number } {
  const v = shownVenue(p)
  const t = venueTag(v.venue, v.year)
  if (!t?.label || t.preprint) return t?.preprint ? { key: '预印本', year: '', tail: 1 } : { key: '其他', year: '', tail: 3 }
  if (t.report) return { key: '技术报告', year: '', tail: 2 }
  return { key: t.year ? `${t.label} ${t.year}` : t.label, year: t.year ?? '', tail: 0 }
}

export interface Group {
  key: string
  papers: PaperMeta[]
}

/** The papers in groups, in the order they show; undefined for no grouping. */
export function groupPapers(papers: PaperMeta[], by: LibraryGroup): Group[] | undefined {
  if (by === 'none') return undefined
  const groups = new Map<string, PaperMeta[]>()
  const add = (key: string, p: PaperMeta) => groups.set(key, [...(groups.get(key) ?? []), p])
  const byAdded = [...papers].sort((a, b) => newest(a.addedAt, b.addedAt))
  if (by === 'added') {
    const now = new Date()
    for (const p of byAdded) add(dayLabel(new Date(p.addedAt), now), p)
    return [...groups].map(([key, papers]) => ({ key, papers }))
  }
  if (by === 'venue') {
    const info = new Map<string, { year: string; tail: number }>()
    for (const p of byAdded) {
      const g = venueGroup(p)
      info.set(g.key, g)
      add(g.key, p)
    }
    // Newest year first, then the larger group; preprints, technical reports and unknown venues last.
    return [...groups]
      .sort(([a, pa], [b, pb]) => {
        const x = info.get(a)!
        const y = info.get(b)!
        return x.tail - y.tail || y.year.localeCompare(x.year) || pb.length - pa.length || a.localeCompare(b)
      })
      .map(([key, papers]) => ({ key, papers }))
  }
  if (by === 'year') {
    for (const p of byAdded) add(shownVenue(p).year?.slice(0, 4) || '年份不详', p)
    return [...groups]
      .sort(([a], [b]) => (a === '年份不详' ? 1 : b === '年份不详' ? -1 : b.localeCompare(a)))
      .map(([key, papers]) => ({ key, papers }))
  }
  // 阅读状态: what you are reading first, the last read on top; then the unread, the last imported on top; then the finished.
  const lastRead = (a: PaperMeta, b: PaperMeta) => newest(a.readAt ?? a.addedAt, b.readAt ?? b.addedAt)
  return [
    { key: '在读', papers: papers.filter(reading).sort(lastRead) },
    { key: '未读', papers: byAdded.filter((p) => !reading(p) && !p.finished) },
    { key: '读完', papers: papers.filter((p) => p.finished).sort(lastRead) }
  ].filter((g) => g.papers.length)
}

/**
 * Groups, each under a heading that sticks as a frosted bar while you are inside it (稍后再看 uses them too). The stuck
 * state is set on the DOM directly, since it changes with every scroll.
 */
export function StickyGroups({ groups }: { groups: { key: string; count: number; body: ReactNode }[] }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const scroller = root.current?.closest('.lib-scroll')
    if (!scroller) return
    const spy = () => {
      const top = scroller.getBoundingClientRect().top
      for (const s of root.current!.querySelectorAll<HTMLElement>(':scope > .later-day')) {
        const h = s.querySelector<HTMLElement>(':scope > .later-th')!
        const r = s.getBoundingClientRect()
        const stuck = r.top < top + 1 && r.bottom > top
        if (stuck !== h.classList.contains('stuck')) {
          // The stuck bar is shorter; make up the difference below it so the papers don't jump (see Stream in 会议).
          const before = h.getBoundingClientRect().height
          h.classList.toggle('stuck', stuck)
          h.style.marginBottom = stuck ? `${before - h.getBoundingClientRect().height}px` : ''
        }
      }
    }
    spy()
    scroller.addEventListener('scroll', spy, { passive: true })
    return () => scroller.removeEventListener('scroll', spy)
  }, [groups])
  return (
    <div className="later-days" ref={root}>
      {groups.map((g) => (
        <section key={g.key} className="later-day">
          <div className="later-th">
            <span className="later-th-label">
              <h2>{g.key}</h2>
              <span className="n">{g.count}</span>
            </span>
          </div>
          {g.body}
        </section>
      ))}
    </div>
  )
}

export interface ItemProps {
  onOpen: (p: PaperMeta) => void
  onProcess: (p: PaperMeta) => void
  onMenu: (p: PaperMeta, x: number, y: number) => void
  folderNames: (p: PaperMeta) => string[]
}

/** The papers of a place, as the owner chose to see them. */
export function Shelf({ papers, view, group, ...item }: { papers: PaperMeta[]; view: LibraryView; group: LibraryGroup } & ItemProps) {
  const groups = useMemo(() => groupPapers(papers, group), [papers, group])
  let i = 0
  const body = (list: PaperMeta[]) =>
    view === 'cover' ? (
      <div className="cv-grid">
        {list.map((p) => (
          <PaperCover key={p.id} paper={p} {...item} />
        ))}
      </div>
    ) : view === 'list' ? (
      <div className="ls">
        {list.map((p) => (
          <PaperRow key={p.id} paper={p} {...item} />
        ))}
      </div>
    ) : (
      <div className="grid">
        {list.map((p) => (
          <PaperCard key={p.id} paper={p} index={i++} {...item} />
        ))}
      </div>
    )
  if (!groups) return body(papers)
  return <StickyGroups groups={groups.map((g) => ({ key: g.key, count: g.papers.length, body: body(g.papers) }))} />
}

/** Opening, dragging into a direction, and the right-click menu: the same on a cover, a card and a row. */
const handles = (p: PaperMeta, { onOpen, onMenu }: ItemProps) => ({
  onClick: () => p.status === 'ready' && onOpen(p),
  draggable: true,
  onDragStart: (e: React.DragEvent) => e.dataTransfer.setData(PAPER_DRAG, p.id),
  onContextMenu: (e: React.MouseEvent) => {
    e.preventDefault()
    onMenu(p, e.clientX, e.clientY)
  }
})

const thumb = (p: PaperMeta) => (p.pages ? <img src={`${fileUrl(p.id, 'thumb.png')}?v=${p.pages}`} alt="" draggable={false} /> : <Icon name="file" size={22} />)

/** Where a paper stands: read so far, finished, being processed, failed, or waiting for 处理. */
function PaperState({ paper: p, onProcess, quiet }: { paper: PaperMeta; onProcess: (p: PaperMeta) => void; quiet?: boolean }) {
  const ratio = p.readPos?.ratio ?? 0
  const busy = p.status === 'processing' || p.status === 'queued'
  return (
    <>
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
        ) : quiet ? null : (
          <span className="pill">未开始</span>
        ))}
      {busy && (
        <span className="pill busy">
          {p.status === 'queued' && p.kept !== undefined ? <Kept share={p.kept} bare /> : <span className="dot" />}
          {p.status === 'queued' ? '排队中' : `${Math.round((p.progress ?? 0) * 100)}%`}
        </span>
      )}
      {p.status === 'error' && (
        <span className="pill err" title={p.error}>
          {p.kept !== undefined ? (
            <Kept share={p.kept} />
          ) : (
            <>
              <span className="dot" />
              处理失败
            </>
          )}
        </span>
      )}
      {p.status === 'new' && p.kept !== undefined && (
        <span className="pill">
          <Kept share={p.kept} />
        </span>
      )}
      {(p.status === 'new' || p.status === 'error') && (
        <button
          className="btn sm"
          onClick={(e) => {
            e.stopPropagation()
            onProcess(p)
          }}
        >
          <Icon name="play" size={12} />
          {p.kept !== undefined ? '继续' : p.status === 'error' ? '重试' : '处理'}
        </button>
      )}
    </>
  )
}

const MoreButton = ({ paper, onMenu }: { paper: PaperMeta; onMenu: ItemProps['onMenu'] }) => (
  <button
    className="icon-btn more"
    onClick={(e) => {
      e.stopPropagation()
      const r = e.currentTarget.getBoundingClientRect()
      onMenu(paper, r.left - 150, r.bottom + 4)
    }}
  >
    <Icon name="more" />
  </button>
)

/** 封面: the first page large, the Chinese title under it. */
function PaperCover({ paper: p, ...item }: { paper: PaperMeta } & ItemProps) {
  const ratio = p.finished ? 1 : (p.readPos?.ratio ?? 0)
  const v = shownVenue(p)
  return (
    <div className={`cv ${p.status === 'ready' ? 'clickable' : ''}`} {...handles(p, item)}>
      <div className="cv-thumb">
        {thumb(p)}
        {p.status === 'ready' && ratio > 0.01 && <span className={`cv-read ${p.finished ? 'done' : ''}`} style={{ width: `${Math.round(ratio * 100)}%` }} />}
        {p.likedAt && (
          <span className="cv-heart">
            <Icon name="heart" size={14} />
          </span>
        )}
        {p.status !== 'ready' && (
          <span className="cv-state">
            <PaperState paper={p} onProcess={item.onProcess} />
          </span>
        )}
      </div>
      <div className="cv-meta">
        <PaperTitle as="h4" paper={p} />
        {(v.venue || v.year) && <VenueTags venue={v.venue} year={v.year} chip={false} />}
      </div>
    </div>
  )
}

/** 列表: one line a paper, like Finder's list. */
function PaperRow({ paper: p, ...item }: { paper: PaperMeta } & ItemProps) {
  const added = new Date(p.addedAt)
  return (
    <div className={`ls-row ${p.status === 'ready' ? 'clickable' : ''}`} {...handles(p, item)}>
      <span className="ls-thumb">{thumb(p)}</span>
      <div className="ls-title">
        <PaperTitle as="b" paper={p} />
        {p.authors.length > 0 && (
          <span className="muted">
            {p.authors.slice(0, 3).join(', ')}
            {p.authors.length > 3 && ` 等 ${p.authors.length} 人`}
          </span>
        )}
      </div>
      <span className="ls-venue">{(shownVenue(p).venue || shownVenue(p).year) && <PaperVenue paper={p} />}</span>
      <span className="ls-state">
        <PaperState paper={p} onProcess={item.onProcess} quiet />
      </span>
      <span className="ls-date faint">
        {added.getMonth() + 1} 月 {added.getDate()} 日
      </span>
      <span className="ls-actions">
        <LaterButton paper={p} />
        <HeartButton paper={p} />
        <MoreButton paper={p} onMenu={item.onMenu} />
      </span>
    </div>
  )
}

/** 卡片: everything at a glance. */
export function PaperCard({ paper: p, index, ...item }: { paper: PaperMeta; index: number } & ItemProps) {
  const busy = p.status === 'processing' || p.status === 'queued'
  const folders = item.folderNames(p)
  return (
    <article className={`paper card ${p.status === 'ready' ? 'clickable' : ''}`} style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }} {...handles(p, item)}>
      <div className="paper-thumb">{thumb(p)}</div>
      <div className="paper-body">
        <PaperTitle as="h3" paper={p} />
        <PaperTitle as="p" className="paper-en" paper={p} other />
        {p.authors.length > 0 && (
          <p className="paper-authors muted">
            {p.authors.slice(0, 4).join(', ')}
            {p.authors.length > 4 && ` 等 ${p.authors.length} 人`}
          </p>
        )}
        {folders.length > 0 && (
          <p className="paper-folders">
            {folders.map((n) => (
              <span key={n}>{n}</span>
            ))}
          </p>
        )}
        <div className="paper-foot">
          {shownVenue(p).venue || shownVenue(p).year ? <PaperVenue paper={p} /> : <span className="mono faint">{p.pages ? `${p.pages} 页` : ''}</span>}
          <span className="spacer" />
          <PaperState paper={p} onProcess={item.onProcess} />
          <LaterButton paper={p} />
          <HeartButton paper={p} />
          <MoreButton paper={p} onMenu={item.onMenu} />
        </div>
        {busy && !(p.status === 'queued' && p.kept !== undefined) && (
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

/** 书库's search, at the left of the top bar where the papers' column starts. */
export function ShelfSearch({ left, query, onQuery }: { left?: number; query: string; onQuery: (q: string) => void }) {
  return (
    <div className="lib-bar" style={left === undefined ? undefined : ({ '--shelf-left': `${left}px` } as React.CSSProperties)}>
      <label className="lib-find no-drag">
        <Icon name="search" size={15} />
        <input placeholder="搜索" value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onQuery('')} />
      </label>
    </div>
  )
}

/**
 * 书库's tools, as pieces in the top bar's glass tray before the status area, as in Finder's toolbar: how papers show,
 * what they are grouped by, and 导入. In 稍后再看, which has its own layout, only 导入 stays.
 */
export function ShelfTools(props: {
  view: LibraryView
  group: LibraryGroup
  arrange: boolean
  onView: (v: LibraryView) => void
  onGroup: (g: LibraryGroup) => void
  importer: ReactNode
}) {
  const [grouping, setGrouping] = useState(false)
  const groupBy = useRef<HTMLDivElement>(null)
  useDismiss(groupBy, () => setGrouping(false), grouping)
  return (
    <>
      {props.arrange && (
        <>
          <div className="seg lib-views no-drag">
            {VIEWS.map((v) => (
              <button key={v.id} className={props.view === v.id ? 'on' : ''} title={v.label} onClick={() => props.onView(v.id)}>
                <Icon name={v.icon} size={16} />
              </button>
            ))}
          </div>
          <div className="lib-groupby no-drag" ref={groupBy}>
            <button className={`icon-btn bordered lib-group-btn ${grouping ? 'active' : ''}`} title="分组" onClick={() => setGrouping((o) => !o)}>
              <Icon name="groups" size={16} />
              <Icon name="down" size={11} />
            </button>
            {grouping && (
              <GroupMenu
                group={props.group}
                onPick={(g) => {
                  setGrouping(false)
                  props.onGroup(g)
                }}
              />
            )}
          </div>
        </>
      )}
      {props.importer}
    </>
  )
}

function GroupMenu({ group, onPick }: { group: LibraryGroup; onPick: (g: LibraryGroup) => void }) {
  const item = (g: (typeof GROUPS)[number]) => (
    <button key={g.id} onClick={() => onPick(g.id)}>
      <span className="ck">{group === g.id && <Icon name="check" size={14} />}</span>
      {g.label}
    </button>
  )
  return (
    <div className="popover menu group-menu">
      {item(GROUPS[0])}
      <hr />
      {GROUPS.slice(1).map(item)}
    </div>
  )
}

/**
 * 导入: an arXiv id or link (taken from the clipboard when one is there), shown as the paper it points to before it is
 * imported, or the paper itself when the library has it already; and PDFs from disk.
 */
export function ImportButton({ onImported, onOpen, toast }: { onImported: (list: PaperMeta[]) => void; onOpen: (id: string) => void; toast: (t: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, () => setOpen(false), open)
  return (
    <div className="imp no-drag" ref={ref}>
      <button className="btn primary imp-btn" onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" size={15} />
        <span className="imp-label">导入</span>
      </button>
      {open && <ImportPop onClose={() => setOpen(false)} onImported={onImported} onOpen={onOpen} toast={toast} />}
    </div>
  )
}

function ImportPop({ onClose, onImported, onOpen, toast }: { onClose: () => void; onImported: (list: PaperMeta[]) => void; onOpen: (id: string) => void; toast: (t: string) => void }) {
  const [text, setText] = useState('')
  const [look, setLook] = useState<{ for: string; peek?: ArxivPeek; error?: string }>()
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    api.clipboardArxiv().then((t) => t && setText((now) => now || t))
  }, [])

  // Look the paper up once typing pauses; a reply for older text is dropped.
  useEffect(() => {
    const t = text.trim()
    if (!t) return setLook(undefined)
    const timer = window.setTimeout(() => {
      setLook({ for: t })
      api
        .peekArxiv(t)
        .then((peek) => setLook((l) => (l?.for === t ? { for: t, peek, error: peek ? undefined : '认不出这个编号或链接' } : l)))
        .catch((e) => setLook((l) => (l?.for === t ? { for: t, error: errorText(e) } : l)))
    }, 300)
    return () => window.clearTimeout(timer)
  }, [text])

  const peek = look?.for === text.trim() ? look.peek : undefined
  const go = async () => {
    if (!peek || busy) return
    if (peek.paper) {
      onClose()
      return onOpen(peek.paper)
    }
    setBusy(true)
    try {
      onImported([await api.importArxiv(text)])
      onClose()
    } catch (e) {
      toast(errorText(e))
      setBusy(false)
    }
  }

  return (
    <div className="popover imp-pop">
      <div className="imp-field">
        <VenueTags venue="arXiv" chip={false} />
        <input
          ref={input}
          placeholder="编号或链接"
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) go()
            if (e.key === 'Escape') onClose()
          }}
        />
      </div>
      {look && (
        <div className="imp-prev">
          {peek ? (
            <>
              <div>
                <PaperText as="b" text={peek.title} zh={!!peek.paper} />
                <span>
                  {peek.authors.slice(0, 3).join(', ')}
                  {peek.authors.length > 3 && ` 等 ${peek.authors.length} 人`}
                </span>
              </div>
              <button className="btn primary sm" disabled={busy} onClick={go}>
                {peek.paper ? '打开' : busy ? '下载中…' : '导入'}
              </button>
            </>
          ) : look.error ? (
            <span className="imp-err">{look.error}</span>
          ) : (
            <div className="imp-wait">
              <i />
              <i />
            </div>
          )}
        </div>
      )}
      <button
        className="imp-pdf"
        onClick={async () => {
          onClose()
          onImported(await api.importDialog())
        }}
      >
        <Icon name="file" size={16} />
        选择 PDF
      </button>
    </div>
  )
}
