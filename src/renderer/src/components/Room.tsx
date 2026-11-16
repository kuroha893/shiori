import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { JournalDay, NowPlaying, PaperMeta, RoomLink, RoomNote, RoomView, StudyPlan, StudyState } from '../../../shared/types'
import type { Contact } from '../../../shared/contacts'
import { api, fileUrl } from '../api'
import { ContactAvatar, Menu, useContacts, type MenuItem } from './Chrome'
import { Icon } from './Icon'
import { PaperText } from './PaperText'

/*
 * 小窝: the owner's wallpaper, a clock, what is playing, and two drawers that wait at the edges with bookmarks sticking
 * out. Left is the owner's own (the paper being read, a highlight, 稍后再看; the journal); right is the contact's
 * (her notes; studying together).
 */

type Side = 'left' | 'right'
type DrawerState = 'closed' | 'peek' | 'open'

const WEEK = '日一二三四五六'
const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export function Room(props: { papers: PaperMeta[]; onOpenPaper: (id: string) => void; onLink: (l: RoomLink) => void }) {
  const { papers } = props
  const [view, setView] = useState<RoomView>()
  const [drawers, setDrawers] = useState<Record<Side, DrawerState>>({ left: 'closed', right: 'closed' })
  const [pages, setPages] = useState<Record<Side, string>>({ left: 'read', right: 'notes' })
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>()
  const contacts = useContacts()
  const writer = contacts.find((c) => c.id === view?.contact)

  useEffect(() => {
    api.roomView().then(setView)
    api.roomVisit()
    const off = api.onRoomChanged(setView)
    // Coming back to the app while in the room counts as coming in, and looks again.
    const back = () => {
      api.roomVisit()
      api.roomView().then(setView)
    }
    window.addEventListener('focus', back)
    return () => {
      off()
      window.removeEventListener('focus', back)
    }
  }, [])

  const anyOpen = drawers.left === 'open' || drawers.right === 'open'
  const setDrawer = useCallback((side: Side, s: DrawerState) => setDrawers((d) => (d[side] === s ? d : { ...d, [side]: s })), [])
  const closeAll = () => setDrawers({ left: 'closed', right: 'closed' })

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAll()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  // Her notes count as read once their page has been open.
  const notesShown = drawers.right === 'open' && pages.right === 'notes'
  useEffect(() => {
    if (notesShown) return () => void api.roomRead()
  }, [notesShown])

  // Opening a drawer shows the latest.
  useEffect(() => {
    if (anyOpen) api.roomView().then(setView)
  }, [anyOpen])

  const unread = !!view?.notes.some((n) => !n.read)

  const wallMenu = (x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        { label: '更换壁纸…', icon: 'image', onClick: () => api.chooseWallpaper() },
        ...(view?.wallpaper ? [{ label: '移除壁纸', icon: 'trash', onClick: () => api.clearWallpaper() }] : [])
      ]
    })

  return (
    <div
      className={`room ${anyOpen ? 'focus' : ''}`}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) closeAll()
      }}
      onContextMenu={(e) => {
        if (e.target !== e.currentTarget) return
        e.preventDefault()
        wallMenu(e.clientX, e.clientY)
      }}
    >
      <Wall url={view?.wallpaper} />
      <Clock wallpaper={view?.wallpaper} />
      <Player docked={anyOpen} />

      <Drawer
        side="left"
        state={drawers.left}
        onState={(s) => setDrawer('left', s)}
        page={pages.left}
        onPage={(p) => setPages((x) => ({ ...x, left: p }))}
        marks={[
          { id: 'read', mark: <Icon name="book" size={16} /> },
          { id: 'journal', mark: <Icon name="calendar" size={16} /> }
        ]}
      >
        {pages.left === 'read' ? <Reading view={view} papers={papers} onOpen={props.onOpenPaper} /> : <Journal papers={papers} onOpen={props.onOpenPaper} />}
      </Drawer>

      <Drawer
        side="right"
        state={drawers.right}
        onState={(s) => setDrawer('right', s)}
        page={pages.right}
        onPage={(p) => setPages((x) => ({ ...x, right: p }))}
        marks={[
          { id: 'notes', mark: writer ? <ContactAvatar contact={writer} /> : <Icon name="note" size={16} />, her: true, dot: unread, busy: !!view?.writing },
          {
            id: 'study',
            mark: (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="13.5" r="7" />
                <path d="M12 10v3.5l2.2 1.6M10 3h4" />
              </svg>
            )
          }
        ]}
      >
        {pages.right === 'notes' ? <Notes view={view} writer={writer} onLink={props.onLink} /> : <Study writer={writer} />}
      </Drawer>

      {menu && <Menu {...menu} onClose={() => setMenu(undefined)} />}
    </div>
  )
}

/* ---------- wallpaper and clock ---------- */

/** The room's wallpaper, kept current; other pages can wear it too */
export function useWallpaper(): string | undefined {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    api.roomView().then((v) => setUrl(v.wallpaper))
    return api.onRoomChanged((v) => setUrl(v.wallpaper))
  }, [])
  return url
}

function Wall({ url }: { url?: string }) {
  return <div className={`room-wall ${url ? '' : 'plain'}`} style={url ? { backgroundImage: `url("${url}")` } : undefined} />
}

/** Dark or light ink for text straight on the wallpaper, from how bright the picture is behind it. */
function useInk(url: string | undefined, target: React.RefObject<HTMLElement | null>): 'on-light' | 'on-dark' {
  const [ink, setInk] = useState<'on-light' | 'on-dark'>('on-light')
  useEffect(() => {
    if (!url) return setInk('on-light')
    const img = new Image()
    let gone = false
    const measure = () => {
      const el = target.current
      if (gone || !el || !img.naturalWidth) return
      // The wall overhangs the window by 60px each way so its blurred edge stays out of sight.
      const W = window.innerWidth + 120
      const H = window.innerHeight + 120
      const s = Math.max(W / img.naturalWidth, H / img.naturalHeight)
      const ox = -60 + (W - img.naturalWidth * s) / 2
      const oy = -60 + (H - img.naturalHeight * s) / 2
      const r = el.getBoundingClientRect()
      const c = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
      if (!c) return
      c.canvas.width = 32
      c.canvas.height = 16
      c.drawImage(img, (r.left - ox) / s, (r.top - oy) / s, r.width / s, r.height / s, 0, 0, 32, 16)
      const px = c.getImageData(0, 0, 32, 16).data
      const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      let sum = 0
      for (let i = 0; i < px.length; i += 4) sum += 0.2126 * lin(px[i]) + 0.7152 * lin(px[i + 1]) + 0.0722 * lin(px[i + 2])
      setInk(sum / (px.length / 4) > 0.36 ? 'on-light' : 'on-dark')
    }
    img.crossOrigin = 'anonymous'
    img.onload = measure
    img.src = url
    window.addEventListener('resize', measure)
    return () => {
      gone = true
      window.removeEventListener('resize', measure)
    }
  }, [url])
  return ink
}

function Clock({ wallpaper }: { wallpaper?: string }) {
  const [now, setNow] = useState(() => new Date())
  const ref = useRef<HTMLDivElement>(null)
  const ink = useInk(wallpaper, ref)
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 5000)
    return () => window.clearInterval(t)
  }, [])
  return (
    <div className={`room-clock ${ink}`} ref={ref}>
      <div className="hm">
        {pad(now.getHours())}:{pad(now.getMinutes())}
      </div>
      <div className="d">
        {now.getMonth() + 1} 月 {now.getDate()} 日 周{WEEK[now.getDay()]}
      </div>
    </div>
  )
}

/* ---------- drawers ---------- */

const NEAR = 110
const PEEK = 96

function Drawer(props: {
  side: Side
  state: DrawerState
  onState: (s: DrawerState) => void
  page: string
  onPage: (p: string) => void
  marks: { id: string; mark: ReactNode; her?: boolean; dot?: boolean; busy?: boolean }[]
  children: ReactNode
}) {
  const { side, state, onState } = props
  const body = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number>()
  const leave = useRef<number>(undefined)

  // Passing near the edge peeks the drawer out a little.
  useEffect(() => {
    if (state === 'open') return
    const move = (e: PointerEvent) => {
      const near = side === 'left' ? e.clientX < NEAR : e.clientX > window.innerWidth - NEAR
      const inside = near && e.clientY > 70 && e.clientY < window.innerHeight - 80
      if (inside) {
        window.clearTimeout(leave.current)
        if (state === 'closed') onState('peek')
      } else if (state === 'peek') {
        window.clearTimeout(leave.current)
        leave.current = window.setTimeout(() => onState('closed'), 350)
      }
    }
    window.addEventListener('pointermove', move)
    return () => window.removeEventListener('pointermove', move)
  }, [state, side, onState])

  // The drawer's width decides how far it hides; measured once it is on the page.
  const [measured, setMeasured] = useState(0)
  useLayoutEffect(() => setMeasured(body.current?.offsetWidth ?? 0), [])
  const width = () => (body.current?.offsetWidth || measured || 440) + 20
  const sign = side === 'left' ? -1 : 1
  const shut = () => sign * width()
  const at = drag ?? (state === 'open' ? 0 : state === 'peek' ? sign * (width() - PEEK) : shut())

  // Click to open or close, or drag it out and let go past a third.
  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, [contenteditable], .room-scroll')) return
    if (state === 'open' && !(e.target as HTMLElement).closest('.room-grip')) return
    const sx = e.clientX
    const from = at
    let moved = false
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const move = (m: PointerEvent) => {
      if (Math.abs(m.clientX - sx) > 4) moved = true
      const v = from + m.clientX - sx
      setDrag(sign < 0 ? Math.min(0, Math.max(shut(), v)) : Math.max(0, Math.min(shut(), v)))
    }
    const up = (u: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      setDrag(undefined)
      if (!moved) return onState(state === 'open' ? 'closed' : 'open')
      const v = from + u.clientX - sx
      onState(1 - Math.abs(v) / Math.abs(shut()) > 0.35 ? 'open' : 'closed')
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    // The state is an attribute: class names like "peek" or "open" are taken elsewhere in the app.
    <div className={`room-drawer ${side} ${drag !== undefined ? 'dragging' : ''}`} data-state={state} style={{ transform: `translateX(${at}px)` }}>
      <div className="room-body" ref={body} onPointerDown={down}>
        <div className="room-scroll" key={props.page}>
          {props.children}
        </div>
        <span className="room-grip" />
      </div>
      <div className="room-marks">
        {props.marks.map((m) => (
          <button
            key={m.id}
            className={`room-mark ${props.page === m.id ? 'on' : ''} ${m.her ? 'her' : ''}`}
            onPointerEnter={() => state !== 'open' && props.onPage(m.id)}
            onClick={() => {
              // The open page's own bookmark puts the drawer away again.
              if (state === 'open' && props.page === m.id) return onState('closed')
              props.onPage(m.id)
              onState('open')
            }}
          >
            {m.mark}
            {m.busy ? <span className="room-typing"><i /><i /><i /></span> : m.dot && <span className="room-dot" />}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ---------- left: reading ---------- */

function Reading({ view, papers, onOpen }: { view?: RoomView; papers: PaperMeta[]; onOpen: (id: string) => void }) {
  const reading = papers.find((p) => p.id === view?.reading)
  const quoted = view?.quote && papers.find((p) => p.id === view.quote!.paper)
  const later = papers
    .filter((p) => p.laterAt)
    .sort((a, b) => (b.laterAt ?? '').localeCompare(a.laterAt ?? ''))
    .slice(0, 8)
  if (!reading && !(view?.quote && quoted) && !later.length) return <div className="room-empty">暂无在读</div>
  return (
    <>
      {reading && (
        <div className="room-card room-reading" onClick={() => onOpen(reading.id)}>
          {reading.pages ? <img src={`${fileUrl(reading.id, 'thumb.png')}?v=${reading.pages}`} alt="" draggable={false} /> : <span className="thumb" />}
          <div className="t">
            <PaperText as="div" className="zh" text={reading.titleZh || reading.title} zh={!!reading.titleZh} />
            {reading.titleZh && <PaperText as="div" className="en" text={reading.title} />}
            <span className="bar">
              <i style={{ width: `${Math.round((reading.readPos?.ratio ?? 0) * 100)}%` }} />
            </span>
          </div>
          <span className="go">
            <Icon name="play" size={13} />
          </span>
        </div>
      )}
      {view?.quote && quoted && (
        <div className="room-card room-quote" onClick={() => onOpen(quoted.id)}>
          <p>{view.quote.text}</p>
          <PaperText as="div" className="src" text={quoted.titleZh || quoted.title} />
        </div>
      )}
      {later.length > 0 && (
        <div className="room-card room-shelf">
          {later.map((p) => (
            <button key={p.id} className="p" onClick={() => onOpen(p.id)}>
              {p.pages ? <img src={`${fileUrl(p.id, 'thumb.png')}?v=${p.pages}`} alt="" draggable={false} /> : <span className="thumb" />}
              <PaperText as="span" text={p.titleZh || p.title} zh={!!p.titleZh} />
            </button>
          ))}
        </div>
      )}
    </>
  )
}

/* ---------- left: journal ---------- */

const duration = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ''}` : m ? `${m} 分钟` : '')

function Journal({ papers, onOpen }: { papers: PaperMeta[]; onOpen: (id: string) => void }) {
  const today = new Date()
  const [month, setMonth] = useState({ y: today.getFullYear(), m: today.getMonth() + 1 })
  const [days, setDays] = useState<JournalDay[]>([])
  const [chosen, setChosen] = useState(dayKey(today))
  const [stamped, setStamped] = useState<string>()

  useEffect(() => {
    let live = true
    const load = () => api.journal(month.y, month.m).then((d) => live && setDays(d))
    load()
    // A study session that just ended stamps today.
    const off = api.onStudyChanged((s) => {
      if (s) return
      load()
      setStamped(dayKey(new Date()))
    })
    return () => {
      live = false
      off()
    }
  }, [month.y, month.m])

  const byDay = useMemo(() => new Map(days.map((d) => [d.date, d])), [days])
  const first = (new Date(month.y, month.m - 1, 1).getDay() + 6) % 7
  const count = new Date(month.y, month.m, 0).getDate()
  const total = days.reduce((s, d) => s + d.minutes, 0)
  const studied = days.filter((d) => d.minutes > 0).length
  const day = byDay.get(chosen)
  const shift = (n: number) => setMonth(({ y, m }) => (m + n < 1 ? { y: y - 1, m: 12 } : m + n > 12 ? { y: y + 1, m: 1 } : { y, m: m + n }))
  const isFuture = (d: number) => new Date(month.y, month.m - 1, d) > today

  return (
    <>
      <div className="room-card room-month">
        <div className="mh">
          <button className="icon-btn" onClick={() => shift(-1)}>
            <Icon name="back" size={14} />
          </button>
          <b>
            {month.y !== today.getFullYear() && `${month.y} 年 `}
            {month.m} 月
          </b>
          <button className="icon-btn" onClick={() => shift(1)} disabled={month.y === today.getFullYear() && month.m === today.getMonth() + 1}>
            <Icon name="next" size={14} />
          </button>
          <span className="sum">{studied > 0 && `${studied} 天  ${duration(total)}`}</span>
        </div>
        <div className="cal">
          {'一二三四五六日'.split('').map((d) => (
            <i key={d}>{d}</i>
          ))}
          {Array.from({ length: first }, (_, i) => (
            <span key={`b${i}`} />
          ))}
          {Array.from({ length: count }, (_, i) => {
            const d = i + 1
            const key = `${month.y}-${pad(month.m)}-${pad(d)}`
            const e = byDay.get(key)
            const m = e?.minutes ?? 0
            return (
              <button
                key={key}
                disabled={isFuture(d)}
                className={[m ? 'stamp' : e?.papers.length ? 'read' : '', key === dayKey(today) ? 'today' : '', key === chosen ? 'sel' : '', key === stamped ? 'new' : ''].join(' ')}
                style={{ '--a': m ? Math.min(1, 0.35 + m / 160) : 0, '--r': `${((d * 37) % 30) - 15}deg` } as React.CSSProperties}
                onClick={() => setChosen(key)}
              >
                <span>{d}</span>
              </button>
            )
          })}
        </div>
      </div>
      {day && (day.papers.length > 0 || day.minutes > 0) && (
        <div className="room-card room-day">
          <div className="jd">
            {chosen === dayKey(today) ? '今天' : `周${WEEK[new Date(chosen).getDay()]}`}
            <span>
              {+chosen.slice(5, 7)} 月 {+chosen.slice(8)} 日
            </span>
            {day.minutes > 0 && <em>{duration(day.minutes)}</em>}
          </div>
          {day.papers.map((jp) => {
            const meta = papers.find((p) => p.id === jp.id)
            const moreQ = jp.questions.length - 1
            const moreH = jp.highlights.length - 1
            const more = [moreH > 0 && `还划了 ${moreH} 句`, moreQ > 0 && `问了 ${moreQ} 个`].filter(Boolean).join('，')
            return (
              <div key={jp.id} className="jpaper">
                <button className="jp" onClick={() => onOpen(jp.id)}>
                  {meta?.pages ? <img src={`${fileUrl(jp.id, 'thumb.png')}?v=${meta.pages}`} alt="" draggable={false} /> : <span className="thumb" />}
                  <PaperText as="span" text={jp.title} zh />
                </button>
                {jp.questions[0] && <div className="jq q">{jp.questions[0]}</div>}
                {jp.highlights[0] && <div className="jq h">{jp.highlights[0]}</div>}
                {more && <div className="jmore">{more.replace(/^问了/, '还问了')}</div>}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

/* ---------- right: her notes ---------- */

const time = (iso: string) => {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (dayKey(d) === dayKey(today)) return '今天'
  if (dayKey(d) === dayKey(yesterday)) return '昨天'
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

function Notes({ view, writer, onLink }: { view?: RoomView; writer?: Contact; onLink: (l: RoomLink) => void }) {
  if (!view) return null
  if (!view.notes.length && !view.writing) return <div className="room-empty">暂无留言</div>
  let lastDay = ''
  return (
    <>
      {view.writing && (
        <div className="room-note writing">
          <span className="room-typing">
            <i />
            <i />
            <i />
          </span>
        </div>
      )}
      {view.notes.map((n) => {
        const label = dayLabel(n.at)
        const head = label !== lastDay && (lastDay || label !== '今天') ? label : undefined
        lastDay = label
        return (
          <div key={n.id} className="room-note-wrap">
            {head && <div className="room-day-label">{head}</div>}
            <NoteCard note={n} writer={writer} onLink={onLink} />
          </div>
        )
      })}
    </>
  )
}

function NoteCard({ note, writer, onLink }: { note: RoomNote; writer?: Contact; onLink: (l: RoomLink) => void }) {
  return (
    <div className={`room-note ${note.kind} ${note.read ? 'read' : ''}`} style={writer?.hue !== undefined ? ({ '--hue': writer.hue } as React.CSSProperties) : undefined}>
      {note.say && <div className="o">{note.say}</div>}
      <div className="z">{note.zh}</div>
      <div className="foot">
        <span className="when">{time(note.at)}</span>
        {note.links.map((l, i) => (
          <button key={i} className="act" onClick={() => onLink(l)}>
            {l.kind === 'paper' ? '打开' : l.kind === 'edition' ? '去看看' : '看看'}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ---------- right: studying together ---------- */

const R = 45
const C = 2 * Math.PI * R

export function useStudy(): StudyState | null {
  const [s, setS] = useState<StudyState | null>(null)
  useEffect(() => {
    api.study().then(setS)
    return api.onStudyChanged(setS)
  }, [])
  return s
}

/** Milliseconds left, ticking while it runs */
export function useLeft(s: StudyState | null): number | undefined {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!s?.endsAt) return
    const t = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [s?.endsAt])
  if (!s) return undefined
  return s.endsAt ? Math.max(0, s.endsAt - Date.now()) : (s.left ?? 0)
}

export const clockOf = (ms: number) => {
  const sec = Math.ceil(ms / 1000)
  return `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`
}

function Study({ writer }: { writer?: Contact }) {
  const s = useStudy()
  const left = useLeft(s)
  const [plan, setPlan] = useState<StudyPlan>()
  const [together, setTogether] = useState(true)
  useEffect(() => {
    api.studyPlan().then(setPlan)
  }, [])
  if (!plan) return null
  const shown = left ?? plan.focus * 60_000
  const share = s ? 1 - shown / (s.minutes * 60_000) : 0
  const p = s?.plan ?? plan
  const set = (k: keyof StudyPlan) => (v: number) => setPlan((x) => x && { ...x, [k]: v })
  return (
    <div className={`room-card room-timer ${s?.phase === 'rest' ? 'rest' : ''}`}>
      <div className="dial">
        <svg viewBox="0 0 100 100">
          <circle className="track" cx="50" cy="50" r={R} />
          <circle className="arc" cx="50" cy="50" r={R} strokeDasharray={C} strokeDashoffset={C * share} />
        </svg>
        <div className="t">
          {s && <span className="ph">{s.phase === 'rest' ? '休息' : '专注'}</span>}
          <span>{clockOf(shown)}</span>
          {s && s.plan.rounds > 1 && (
            <span className="rounds">
              {Array.from({ length: s.plan.rounds }, (_, i) => (
                <i key={i} className={i < s.round - 1 ? 'done' : i === s.round - 1 ? 'now' : ''} />
              ))}
            </span>
          )}
        </div>
      </div>
      <div className={`plan ${s ? 'quiet' : ''}`}>
        <PlanNumber value={p.focus} unit="分" min={1} max={300} onChange={set('focus')} fixed={!!s} />
        <span className="op">+</span>
        <PlanNumber value={p.rest} unit="分" min={0} max={60} onChange={set('rest')} fixed={!!s} />
        <span className="op">×</span>
        <PlanNumber value={p.rounds} unit="轮" min={1} max={12} onChange={set('rounds')} fixed={!!s} />
      </div>
      <div className="go-row">
        {!s && writer && (
          <button className={`with ${together ? 'on' : ''}`} aria-label={`和${writer.name}一起`} onClick={() => setTogether((v) => !v)}>
            <ContactAvatar contact={writer} />
          </button>
        )}
        {!s ? (
          <button className="start" onClick={() => api.studyStart(plan, together && writer ? writer.id : undefined)}>
            <Icon name="play" size={13} />
            开始
          </button>
        ) : (
          <>
            <button className="start" onClick={() => (s.endsAt ? api.studyPause() : api.studyResume())}>
              <Icon name={s.endsAt ? 'pause' : 'play'} size={13} />
              {s.endsAt ? '暂停' : '继续'}
            </button>
            <button className="stop" aria-label="结束" onClick={() => api.studyStop()}>
              <Icon name="stop" size={13} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** One number of the plan: type it, or nudge it with the arrow keys or the wheel. */
function PlanNumber(props: { value: number; unit: string; min: number; max: number; fixed: boolean; onChange: (v: number) => void }) {
  const { value, min, max, onChange } = props
  const [text, setText] = useState(String(value))
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => setText(String(value)), [value])
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)))
  const commit = () => {
    const v = parseInt(text, 10)
    const next = Number.isFinite(v) ? clamp(v) : value
    setText(String(next))
    if (next !== value) onChange(next)
  }
  const nudge = (d: number) => onChange(clamp(value + d))
  // The wheel must not scroll the drawer while it changes the number.
  useEffect(() => {
    const el = ref.current
    if (!el || props.fixed) return
    const wheel = (e: WheelEvent) => {
      if (document.activeElement !== el) return
      e.preventDefault()
      nudge(e.deltaY < 0 ? 1 : -1)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  })
  if (props.fixed)
    return (
      <span className="n">
        {value}
        <small>{props.unit}</small>
      </span>
    )
  return (
    <label className="n">
      <input
        ref={ref}
        value={text}
        inputMode="numeric"
        size={Math.max(1, text.length)}
        onChange={(e) => {
          const t = e.target.value.replace(/\D/g, '').slice(0, 3)
          setText(t)
          // The dial follows while typing, as long as the number makes sense.
          const v = parseInt(t, 10)
          if (v >= min && v <= max) onChange(v)
        }}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            nudge(e.key === 'ArrowUp' ? 1 : -1)
          }
        }}
      />
      <small>{props.unit}</small>
    </label>
  )
}

/* ---------- what is playing ---------- */

/** Players' own colours, for the level bars and the progress line */
const PLAYER_HUE: Record<string, string> = {
  'com.netease.163music': '#e60026',
  'com.tencent.QQMusicMac': '#31c27c',
  'com.spotify.client': '#1db954',
  'com.apple.Music': '#fa2d48'
}

export interface PlayerState {
  np?: NowPlaying
  cover: string | null
  icon: string | null
  /** How far into the song, 0 to 1 */
  share: number
  act: (c: 'play' | 'pause' | 'next' | 'previous') => void
}

/** What macOS says is playing, looked at every second and a half while the window is visible, with its buttons. */
export function usePlayer(): PlayerState {
  const [np, setNp] = useState<NowPlaying>()
  const [cover, setCover] = useState<string | null>(null)
  const [icon, setIcon] = useState<string | null>(null)
  const [, tick] = useState(0)
  // Right after a button, a look that was already on its way would bring back the old state.
  const settled = useRef(0)

  useEffect(() => {
    let live = true
    let first = true
    const look = async () => {
      if (document.hidden) return
      const asked = Date.now()
      const r = await api.nowPlaying(first)
      if (!live || asked < settled.current) return
      first = false
      setNp(r)
      if (r && r.cover !== undefined) setCover(r.cover)
    }
    look()
    const t = window.setInterval(look, 1500)
    const t2 = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => {
      live = false
      window.clearInterval(t)
      window.clearInterval(t2)
    }
  }, [])

  const app = np?.app
  useEffect(() => {
    setIcon(null)
    if (app) api.playerIcon(app).then(setIcon)
  }, [app])

  const elapsed = np?.elapsed !== undefined ? np.elapsed + (np.playing ? (Date.now() - np.at) / 1000 : 0) : undefined
  const share = elapsed !== undefined && np?.duration ? Math.min(1, elapsed / np.duration) : 0
  const act = (c: 'play' | 'pause' | 'next' | 'previous') => {
    if (!np) return
    settled.current = Date.now() + 60_000
    if (c === 'play' || c === 'pause') setNp({ ...np, playing: c === 'play', elapsed, at: Date.now() })
    api.playerSend(c).then(async () => {
      const r = await api.nowPlaying(false)
      settled.current = Date.now()
      if (!r) return setNp(undefined)
      setNp(r)
      if (r.cover !== undefined) setCover(r.cover)
    })
  }
  return { np, cover, icon, share, act }
}

/** The player's colour, for its level bars and progress line */
export const playerHue = (np?: NowPlaying) => (np && PLAYER_HUE[np.app] ? ({ '--np': PLAYER_HUE[np.app] } as React.CSSProperties) : undefined)

function Player({ docked }: { docked: boolean }) {
  const p = usePlayer()
  return <PlayerCapsule p={p} className={docked ? 'docked' : ''} />
}

/** Cover with the player's icon, title and artist, the three buttons and a progress line: in the room, and opened
 * from the top bar elsewhere. */
export function PlayerCapsule({ p, className = '' }: { p: PlayerState; className?: string }) {
  const { np, cover, icon, share, act } = p
  if (!np) return null
  return (
    <div className={`room-player ${className} ${np.playing ? '' : 'paused'}`} style={playerHue(np)}>
      <button className="art" onClick={() => api.showPlayer(np.app)} title={np.appName}>
        {icon && <img className="app" src={icon} alt="" draggable={false} />}
        {cover ? (
          <img src={cover} alt="" />
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18V6l10-2v12" />
            <circle cx="6.5" cy="18" r="2.5" />
            <circle cx="16.5" cy="16" r="2.5" />
          </svg>
        )}
      </button>
      <button className="meta" onClick={() => api.showPlayer(np.app)}>
        <span className="title">
          <span className="eq">
            <i />
            <i />
            <i />
          </span>
          <span className="name">{np.title}</span>
        </span>
        {np.artist && <span className="artist">{np.artist}</span>}
      </button>
      <span className="ctl">
        <button aria-label="上一首" onClick={() => act('previous')}>
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 5.5a1 1 0 0 1 2 0v13a1 1 0 0 1-2 0zM19 6.2v11.6a1 1 0 0 1-1.55.83L9.6 13.2a1.4 1.4 0 0 1 0-2.4l7.85-5.43A1 1 0 0 1 19 6.2z" />
          </svg>
        </button>
        <button className="pp" aria-label={np.playing ? '暂停' : '播放'} onClick={() => act(np.playing ? 'pause' : 'play')}>
          {np.playing ? (
            <svg viewBox="0 0 24 24" fill="currentColor">
              <rect x="6.5" y="5" width="4" height="14" rx="1.3" />
              <rect x="13.5" y="5" width="4" height="14" rx="1.3" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
            </svg>
          )}
        </button>
        <button aria-label="下一首" onClick={() => act('next')}>
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M18 5.5a1 1 0 0 0-2 0v13a1 1 0 0 0 2 0zM5 6.2v11.6a1 1 0 0 0 1.55.83l7.85-5.43a1.4 1.4 0 0 0 0-2.4L6.55 5.37A1 1 0 0 0 5 6.2z" />
          </svg>
        </button>
      </span>
      <span className="prog">
        <i style={{ width: `${share * 100}%` }} />
      </span>
    </div>
  )
}
