import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { SYSTEM_THREAD, type NoticeKind, type PaperMeta, type PetState, type PhoneConversation, type PhoneItem, type PhoneThread, type PhoneView, type RoomNote, type SystemNotice } from '../../../shared/types'
import type { Contact } from '../../../shared/contacts'
import { api, fileUrl } from '../api'
import { ContactAvatar, Menu, ringStyle, useContacts, useDismiss, type MenuItem } from './Chrome'
import { ServiceLogo } from './ServiceLogo'
import { Pomodoro } from './Room'
import { startGlass, PHONE_KINDS } from '../lib/glass'
import { spring, reducedMotion } from '../lib/spring'
import { startInk } from '../lib/ink'
import { titlesOf, useTitleLang } from '../lib/titles'
import brand from '../assets/brand.png'
import art from '../assets/phone-art.png'

/*
 * The phone: where the app and the people reach the owner. Home has the latest message, the apps (Shiori Talk and 番茄钟)
 * and a dock of whoever was in touch last. Shiori Talk holds every conversation: the app's own (notices, each with its
 * one action) and each contact's (her messages and your calls). In 书库 and 会议 it opens from the green ring; in 大厅
 * it waits at the right edge.
 */

type Screen = { app: 'home' } | { app: 'talk'; tab: 'msgs' | 'people' } | { app: 'thread'; id: string } | { app: 'pomodoro' }

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

/** "16:24" today, "昨天", or "11月17日" */
function whenShort(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (dayKey(d) === dayKey(now)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (dayKey(d) === dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function dayBanner(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (dayKey(d) === dayKey(now)) return '今天'
  if (dayKey(d) === dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 1:01:00, or 12:05 under an hour */
const duration = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`)

const KIND_LABEL: Record<NoticeKind, string> = {
  'paper-ready': '翻译完成',
  'paper-failed': '处理失败',
  edition: '会议',
  later: '稍后再看',
  'openreview-public': 'OpenReview',
  'signed-out': '登录',
  'quota-out': '额度',
  model: '模型',
  'openreview-expired': 'OpenReview',
  voice: '声音',
  disk: '存储',
  recovered: '恢复'
}

const DONE_LABEL: Partial<Record<NoticeKind, string>> = {
  'signed-out': '已重新登录',
  'openreview-expired': '已重新登录',
  'quota-out': '已恢复',
  model: '已换回',
  voice: '已恢复',
  disk: '已恢复',
  recovered: '已重试'
}

function actionLabel(n: SystemNotice): string | undefined {
  switch (n.action?.kind) {
    case 'paper':
      return '打开'
    case 'edition':
    case 'later':
      return '去看看'
    case 'login':
    case 'openreview':
      return '登录'
    case 'settings':
      return '去设置'
    case 'retry':
      return '重试'
  }
}

export function usePhone(): PhoneView | undefined {
  const [view, setView] = useState<PhoneView>()
  useEffect(() => {
    api.phoneView().then(setView)
    return api.onPhoneChanged(setView)
  }, [])
  return view
}

function useCall(): PetState {
  const [call, setCall] = useState<PetState>({})
  useEffect(() => {
    api.petState().then(setCall)
    return api.onPetChanged(setCall)
  }, [])
  return call
}

/* ---------- small pieces ---------- */

const TalkMark = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
    <path fill="#fff" d="M20 6c-8.8 0-16 6.1-16 13.6 0 4.3 2.4 8.2 6.1 10.7-.4 2.1-1.5 4-3.2 5.5 3.3-.1 6.2-1.3 8.4-3.2 1.5.4 3.1.6 4.7.6 8.8 0 16-6.1 16-13.6S28.8 6 20 6z" />
    <path fill="#ec6f78" d="M24 6.2h6v10.6l-3-2.4-3 2.4z" />
  </svg>
)

const Tomato = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 34 34" aria-hidden="true">
    <circle cx="17" cy="19" r="12" fill="#e2483a" />
    <ellipse cx="12.5" cy="15" rx="3" ry="2" fill="#fff" opacity="0.35" transform="rotate(-30 12.5 15)" />
    <path d="M17 8.5c-2.2-.2-4.6.6-6 2.2 2 .1 3.4.5 4.4 1.3-.9 1.2-1.3 2.4-1.2 3.8 1.2-.8 2.2-1.6 2.8-2.8.6 1.2 1.6 2 2.8 2.8.1-1.4-.3-2.6-1.2-3.8 1-.8 2.4-1.2 4.4-1.3-1.4-1.6-3.8-2.4-6-2.2z" fill="#3fa65a" />
    <path d="M17 8.6V5.4" stroke="#3fa65a" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)

const PhoneGlyph = ({ size, color = 'currentColor', hang }: { size: number; color?: string; hang?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true" style={hang ? { transform: 'rotate(135deg)' } : undefined}>
    <path d="M6.6 10.8a15.2 15.2 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" />
  </svg>
)

const Back = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 5l-7 7 7 7" />
  </svg>
)

function StatusBar() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 10_000)
    return () => window.clearInterval(t)
  }, [])
  return (
    <div className="ph-status glass-ink">
      <span>
        {pad(now.getHours())}:{pad(now.getMinutes())}
      </span>
      <span className="ph-status-ic">
        <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor" aria-hidden="true">
          <rect x="0" y="8" width="3" height="4" rx="1" />
          <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
          <rect x="10" y="3" width="3" height="9" rx="1" />
          <rect x="15" y="0" width="3" height="12" rx="1" />
        </svg>
        <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor" aria-hidden="true">
          <path d="M8 2.2c2.5 0 4.8 1 6.5 2.6l1.3-1.4C13.7 1.4 11 .2 8 .2S2.3 1.4.2 3.4l1.3 1.4C3.2 3.2 5.5 2.2 8 2.2z" />
          <path d="M8 5.6c1.6 0 3 .6 4.1 1.6l1.3-1.4C12 4.4 10.1 3.6 8 3.6s-4 .8-5.4 2.2l1.3 1.4C5 6.2 6.4 5.6 8 5.6z" />
          <path d="M8 9c.7 0 1.3.3 1.8.7L8 11.8 6.2 9.7C6.7 9.3 7.3 9 8 9z" />
        </svg>
      </span>
    </div>
  )
}

/** A conversation's picture: the app's mark, or the contact's avatar in her ring */
function Who({ id, contacts, size }: { id: string; contacts: Contact[]; size: number }) {
  const c = contacts.find((x) => x.id === id)
  return (
    <span className={`ph-av ${id === SYSTEM_THREAD ? 'sys' : ''}`} style={{ width: size, height: size, ...(c ? ringStyle(c) : {}) }}>
      {id === SYSTEM_THREAD ? <img src={brand} alt="" draggable={false} /> : c ? <ContactAvatar contact={c} /> : null}
    </span>
  )
}

/** a notice's line: a paper by the title the owner reads papers by (the paper as it is now), else as written */
const noticeTitle = (n: SystemNotice, papers: PaperMeta[]): string => {
  const p = n.paper ? papers.find((x) => x.id === n.paper) : undefined
  return p ? titlesOf(p).main : n.title
}

const nameOf = (id: string, contacts: Contact[]) => (id === SYSTEM_THREAD ? 'Shiori' : (contacts.find((c) => c.id === id)?.name ?? ''))

/* ---------- the phone ---------- */

/** Light from the pointer, only on the rim: where the pointer comes near the edge, from inside or out, it lights up. */
function usePointerLight(...parts: React.RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    const els = parts.map((p) => p.current).filter((e): e is HTMLElement => !!e)
    const host = els[0]?.parentElement
    if (!host) return
    let at = { x: -999, y: -999 }
    let want = at
    let frame = 0
    const paint = () => {
      for (const el of els) {
        el.style.setProperty('--px', at.x.toFixed(1))
        el.style.setProperty('--py', at.y.toFixed(1))
      }
    }
    const tick = () => {
      frame = 0
      const far = Math.abs(want.x - at.x) > 400 || Math.abs(want.y - at.y) > 400
      at = far ? want : { x: at.x + (want.x - at.x) * 0.3, y: at.y + (want.y - at.y) * 0.3 }
      paint()
      if (Math.abs(want.x - at.x) > 0.3 || Math.abs(want.y - at.y) > 0.3) frame = requestAnimationFrame(tick)
    }
    const move = (e: PointerEvent) => {
      const r = host.getBoundingClientRect()
      if (!r.width) return
      // in the phone's own pixels, whatever its transform
      const k = host.offsetWidth / r.width
      want = { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k }
      if (!frame) frame = requestAnimationFrame(tick)
    }
    paint()
    window.addEventListener('pointermove', move)
    return () => {
      window.removeEventListener('pointermove', move)
      cancelAnimationFrame(frame)
    }
    // the parts are fixed elements of the phone
  }, [])
}

export function Phone(props: { papers: PaperMeta[]; onAction: (n: SystemNotice) => void; onClose: () => void; className?: string; style?: React.CSSProperties }) {
  const view = usePhone()
  const contacts = useContacts()
  const [screen, setScreen] = useState<Screen>({ app: 'home' })
  const box = useRef<HTMLDivElement>(null)
  const spec = useRef<HTMLElement>(null)
  const bevel = useRef<HTMLElement>(null)
  useEffect(() => startGlass(PHONE_KINDS), [])
  useTitleLang()
  useEffect(() => (box.current ? startInk(box.current) : undefined), [])
  usePointerLight(spec, bevel)
  const home = () => setScreen({ app: 'home' })
  const open = (id: string) => setScreen({ app: 'thread', id })
  return (
    <div className={`ph ${props.className ?? ''}`} style={props.style} ref={box}>
      <div className="ph-ground" />
      <StatusBar />
      {screen.app === 'home' ? (
        <Home view={view} contacts={contacts} papers={props.papers} onOpen={open} onApp={(app) => setScreen(app === 'talk' ? { app: 'talk', tab: 'msgs' } : { app: 'pomodoro' })} onAction={props.onAction} />
      ) : screen.app === 'talk' ? (
        <Talk view={view} contacts={contacts} tab={screen.tab} onTab={(tab) => setScreen({ app: 'talk', tab })} onOpen={open} onClose={home} />
      ) : screen.app === 'thread' ? (
        <Thread
          key={screen.id}
          id={screen.id}
          view={view}
          contacts={contacts}
          papers={props.papers}
          onBack={() => setScreen({ app: 'talk', tab: 'msgs' })}
          onAction={props.onAction}
          onCalling={props.onClose}
        />
      ) : (
        <PomodoroApp contacts={contacts} view={view} onBack={home} />
      )}
      <i className="ph-bevel" ref={bevel}>
        <i />
      </i>
      <i className="ph-edge" />
      <i className="ph-spec" ref={spec} />
    </div>
  )
}

/* ---------- home ---------- */

function Home(props: { view?: PhoneView; contacts: Contact[]; papers: PaperMeta[]; onOpen: (id: string) => void; onApp: (app: 'talk' | 'pomodoro') => void; onAction: (n: SystemNotice) => void }) {
  const { view, contacts } = props
  const dock = (view?.conversations ?? []).filter((c) => c.at).slice(0, 4)
  return (
    <div className="ph-home">
      {view?.latest && <Latest latest={view.latest} contacts={contacts} papers={props.papers} onOpen={props.onOpen} onAction={props.onAction} />}
      <div className="ph-apps">
        <button className="ph-app" onClick={() => props.onApp('talk')}>
          <span className="ph-tile talk">
            <TalkMark size={38} />
            {!!view?.unread && <i className="ph-count">{view.unread}</i>}
          </span>
          <span className="glass-ink">Shiori Talk</span>
        </button>
        <button className="ph-app" onClick={() => props.onApp('pomodoro')}>
          <span className="ph-tile tomato">
            <Tomato size={34} />
          </span>
          <span className="glass-ink">番茄钟</span>
        </button>
      </div>
      {!!dock.length && (
        <div className="ph-dock glass-tray">
          {dock.map((c) => (
            <button key={c.id} className="ph-dock-item" title={nameOf(c.id, contacts)} onClick={() => props.onOpen(c.id)}>
              <Who id={c.id} contacts={contacts} size={54} />
              {!!c.unread && !c.muted && <i className="ph-dot" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The newest message of all, over her picture, or for the app's own, over Shiori's */
function Latest(props: { latest: NonNullable<PhoneView['latest']>; contacts: Contact[]; papers: PaperMeta[]; onOpen: (id: string) => void; onAction: (n: SystemNotice) => void }) {
  const { latest, contacts } = props
  const c = contacts.find((x) => x.id === latest.thread)
  const n = latest.notice
  const picture = n ? art : (c?.portrait ?? c?.avatar)
  const frame = c?.frame
  return (
    <div className={`ph-latest ${n ? 'sys' : ''}`} role="button" tabIndex={0} onClick={() => props.onOpen(latest.thread)}>
      {picture && <img className="ph-latest-pic" src={picture} alt="" draggable={false} style={!n && frame ? { objectPosition: `${frame.x * 100}% ${frame.y * 100}%` } : undefined} />}
      <span className="ph-tag">
        <i />
        Latest Message
      </span>
      <div className="ph-plate">
        <div className="ph-plate-who">
          <Who id={latest.thread} contacts={contacts} size={22} />
          <b>{nameOf(latest.thread, contacts)}</b>
          <time>{whenShort(latest.at)}</time>
        </div>
        {n ? (
          <div className="ph-plate-row">
            <span className="ph-plate-line strong">
              {n.provider && <ServiceLogo provider={n.provider} />}
              {n.kind === 'paper-ready' || n.kind === 'paper-failed' ? `《${noticeTitle(n, props.papers)}》${n.kind === 'paper-ready' ? '翻译完成' : '处理失败'}` : n.title}
            </span>
            {!n.done && actionLabel(n) && (
              <button
                className="ph-plate-act"
                onClick={(e) => {
                  e.stopPropagation()
                  props.onAction(n)
                }}
              >
                {actionLabel(n)}
              </button>
            )}
          </div>
        ) : (
          <div className="ph-plate-line">{latest.note?.zh}</div>
        )}
      </div>
    </div>
  )
}

/* ---------- Shiori Talk ---------- */

function AppBar(props: { children: ReactNode; className?: string }) {
  return <div className={`ph-bar ${props.className ?? ''}`}>{props.children}</div>
}

function Talk(props: { view?: PhoneView; contacts: Contact[]; tab: 'msgs' | 'people'; onTab: (t: 'msgs' | 'people') => void; onOpen: (id: string) => void; onClose: () => void }) {
  const { view, contacts } = props
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>()
  const byId = new Map((view?.conversations ?? []).map((c) => [c.id, c]))
  const muteMenu = (e: React.MouseEvent, id: string) => {
    if (id === SYSTEM_THREAD) return
    e.preventDefault()
    const on = !!byId.get(id)?.muted
    setMenu({ x: e.clientX, y: e.clientY, items: [{ label: on ? '取消免打扰' : '免打扰', icon: on ? 'note' : 'minus', onClick: () => api.phoneMute(id, !on) }] })
  }
  const rows = props.tab === 'msgs' ? (view?.conversations ?? []).filter((c) => c.at) : contacts.map((c) => byId.get(c.id) ?? { id: c.id, unread: 0 })
  return (
    <div className="ph-app-page talk">
      <AppBar>
        <span className="ph-wordmark">
          <TalkMark size={26} />
          Shiori <i>Talk</i>
        </span>
        <button className="ph-bar-x" aria-label="回到桌面" onClick={props.onClose}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </AppBar>
      <div className="ph-talk-body">
        <div className="ph-rail">
          <button className={props.tab === 'people' ? 'on' : ''} aria-label="联系人" onClick={() => props.onTab('people')}>
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="8" r="4" fill="currentColor" />
              <path d="M4 20c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5z" fill="currentColor" />
            </svg>
          </button>
          <button className={props.tab === 'msgs' ? 'on' : ''} aria-label="消息" onClick={() => props.onTab('msgs')}>
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M12 3.5c-5 0-9 3.4-9 7.6 0 2.4 1.3 4.6 3.4 6-.2 1.2-.8 2.3-1.8 3.1 1.9 0 3.5-.7 4.7-1.8.9.2 1.8.3 2.7.3 5 0 9-3.4 9-7.6S17 3.5 12 3.5z" />
            </svg>
            {!!view?.unread && <i className="ph-rail-n">{view.unread}</i>}
          </button>
        </div>
        <div className="ph-list">
          {rows.map((c) => (
            <ConvRow key={c.id} conv={c} contacts={contacts} people={props.tab === 'people'} onOpen={() => props.onOpen(c.id)} onMenu={(e) => muteMenu(e, c.id)} />
          ))}
        </div>
      </div>
      {menu && <Menu {...menu} onClose={() => setMenu(undefined)} />}
    </div>
  )
}

function ConvRow(props: { conv: PhoneConversation; contacts: Contact[]; people: boolean; onOpen: () => void; onMenu: (e: React.MouseEvent) => void }) {
  const { conv, contacts } = props
  const c = contacts.find((x) => x.id === conv.id)
  const line = props.people ? (c?.romaji ?? '') : conv.call !== undefined ? `通话 ${duration(conv.call)}` : (conv.last ?? '')
  return (
    <button className={`ph-row ${conv.muted ? 'muted' : ''}`} onClick={props.onOpen} onContextMenu={props.onMenu}>
      <Who id={conv.id} contacts={contacts} size={50} />
      <span className="ph-row-main">
        <b>{nameOf(conv.id, contacts)}</b>
        <span className="ph-row-last">
          {!props.people && conv.call !== undefined && <PhoneGlyph size={11} />}
          <span className="t">{line}</span>
        </span>
      </span>
      {!props.people && (
        <span className="ph-row-side">
          {conv.at && whenShort(conv.at)}
          {!!conv.unread && <i className="ph-n">{conv.unread}</i>}
          {conv.muted && <MutedGlyph />}
        </span>
      )}
      {props.people && conv.muted && (
        <span className="ph-row-side">
          <MutedGlyph />
        </span>
      )}
    </button>
  )
}

const MutedGlyph = () => (
  <svg className="ph-muted" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="免打扰">
    <path d="M8.7 3A6 6 0 0 1 18 8c0 2.4.4 4.3 1 5.7M17 17H3s3-2 3-9c0-.8.1-1.6.4-2.3" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0M2 2l20 20" />
  </svg>
)

/* ---------- a conversation ---------- */

function useThread(id: string, view?: PhoneView): PhoneThread | undefined {
  const [thread, setThread] = useState<PhoneThread>()
  useEffect(() => {
    api.phoneThread(id).then(setThread)
  }, [id, view])
  return thread
}

function Thread(props: {
  id: string
  view?: PhoneView
  contacts: Contact[]
  papers: PaperMeta[]
  onBack: () => void
  onAction: (n: SystemNotice) => void
  /** a call is starting: the phone steps aside for the call's own screen */
  onCalling: () => void
}) {
  const { id, contacts } = props
  const thread = useThread(id, props.view)
  const call = useCall()
  const scroller = useRef<HTMLDivElement>(null)
  // Where 到此已读 goes is decided when the conversation opens; reading it moves nothing.
  const [readMark, setReadMark] = useState<number | null>()
  useEffect(() => {
    if (!thread) return
    if (readMark === undefined) setReadMark(thread.firstUnread ?? null)
    if (thread.firstUnread !== undefined) api.phoneRead(id)
  }, [thread, id, readMark])
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread?.items.length])
  const c = contacts.find((x) => x.id === id)
  const system = id === SYSTEM_THREAD
  const onCall = call.contact === id
  return (
    <div className="ph-app-page thread">
      <AppBar>
        <button className="ph-bar-back" aria-label="返回" onClick={props.onBack}>
          <Back />
        </button>
        <span className="ph-bar-who">
          <b>{nameOf(id, contacts)}</b>
          {!system && c?.romaji && <small>{c.romaji}</small>}
        </span>
      </AppBar>
      <div className="ph-chat" ref={scroller}>
        {thread && <Items items={thread.items} readMark={readMark ?? undefined} id={id} contacts={contacts} papers={props.papers} onAction={props.onAction} />}
      </div>
      {!system && (
        <div className="ph-dialbar">
          <button
            className={`ph-dial ${onCall ? 'hang' : ''}`}
            onClick={() => {
              api.togglePet(id)
              if (!onCall) props.onCalling()
            }}
          >
            <PhoneGlyph size={15} color="#fff" hang={onCall} />
            {onCall ? '挂断' : '通话'}
          </button>
        </div>
      )}
    </div>
  )
}

function Items(props: { items: PhoneItem[]; readMark?: number; id: string; contacts: Contact[]; papers: PaperMeta[]; onAction: (n: SystemNotice) => void }) {
  const out: ReactNode[] = []
  let day = ''
  let group: RoomNote[] = []
  const flush = (key: string) => {
    if (!group.length) return
    out.push(<NoteGroup key={`g${key}`} notes={group} id={props.id} contacts={props.contacts} />)
    group = []
  }
  props.items.forEach((item, i) => {
    const d = dayBanner(item.at)
    if (d !== day || i === props.readMark) flush(String(i))
    if (d !== day) {
      out.push(
        <div key={`d${i}`} className="ph-ban">
          {d}
        </div>
      )
      day = d
    }
    if (i === props.readMark && i > 0)
      out.push(
        <div key={`r${i}`} className="ph-ban">
          到此已读
        </div>
      )
    if (item.type === 'note') return void group.push(item.note)
    flush(String(i))
    if (item.type === 'call')
      out.push(
        <div key={`c${i}`} className="ph-callrec">
          <span className="ph-callrec-ic">
            <PhoneGlyph size={9} color="#fff" />
          </span>
          通话<b>{duration(item.seconds)}</b>
        </div>
      )
    else out.push(<NoticeCard key={item.notice.id} n={item.notice} papers={props.papers} onAction={props.onAction} />)
  })
  flush('end')
  return <>{out}</>
}

/** Her messages in a row, under her picture and name; only the first bubble has a tail */
function NoteGroup({ notes, id, contacts }: { notes: RoomNote[]; id: string; contacts: Contact[] }) {
  return (
    <div className="ph-grp">
      <Who id={id} contacts={contacts} size={42} />
      <div>
        <div className="ph-grp-name">{nameOf(id, contacts)}</div>
        <div className="ph-msgs">
          {notes.map((n, i) => (
            <div key={n.id} className={`ph-m ${i === 0 ? 'first' : ''}`}>
              {n.zh}
              {n.say && <small>{n.say}</small>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function NoticeCard({ n, papers, onAction }: { n: SystemNotice; papers: PaperMeta[]; onAction: (n: SystemNotice) => void }) {
  const paper = n.paper ? papers.find((p) => p.id === n.paper) : undefined
  const label = actionLabel(n)
  return (
    <div className={`ph-notice ${n.done ? 'done' : ''}`}>
      <div className="ph-notice-lab">
        {KIND_LABEL[n.kind]}
        <time>{whenShort(n.at)}</time>
      </div>
      {n.paper ? (
        <div className="ph-notice-paper">
          {paper?.pages ? <img src={`${fileUrl(paper.id, 'thumb.png')}?v=${paper.pages}`} alt="" draggable={false} /> : <span className="ph-thumb-blank" />}
          <span>
            <b>{noticeTitle(n, papers)}</b>
            {paper && (paper.venueEdit?.venue ?? paper.venue) && <small>{[paper.venueEdit?.venue ?? paper.venue, paper.venueEdit?.year ?? paper.year].filter(Boolean).join(' ')}</small>}
          </span>
        </div>
      ) : (
        <div className="ph-notice-title">
          {n.provider && <ServiceLogo provider={n.provider} />}
          {n.title}
        </div>
      )}
      {n.sub && <div className="ph-notice-sub">{n.sub}</div>}
      <div className="ph-notice-acts">
        {n.count !== undefined && n.kind !== 'recovered' && <span className="ph-cap">+{n.count}</span>}
        {n.kind === 'recovered' && n.count !== undefined && <span className="ph-cap">{n.count} 个任务</span>}
        {n.done ? (
          DONE_LABEL[n.kind] && <span className="ph-done">{DONE_LABEL[n.kind]}</span>
        ) : (
          label && (
            <button className={`ph-act ${n.action?.kind === 'login' || n.action?.kind === 'openreview' || n.action?.kind === 'retry' ? 'strong' : ''}`} onClick={() => onAction(n)}>
              {label}
            </button>
          )
        )}
      </div>
    </div>
  )
}

/* ---------- 番茄钟 ---------- */

function PomodoroApp(props: { contacts: Contact[]; view?: PhoneView; onBack: () => void }) {
  // Calling someone along: whoever was in touch last
  const closest = (props.view?.conversations ?? []).find((c) => c.id !== SYSTEM_THREAD && c.at)?.id
  const writer = props.contacts.find((c) => c.id === closest) ?? props.contacts[0]
  return (
    <div className="ph-app-page pomodoro">
      <AppBar className="tomato">
        <button className="ph-bar-back" aria-label="返回" onClick={props.onBack}>
          <Back />
        </button>
        <span className="ph-bar-who">
          <b>番茄钟</b>
        </span>
      </AppBar>
      <div className="ph-pomo">
        <Pomodoro writer={writer} />
      </div>
    </div>
  )
}

/* ---------- where it lives ---------- */

/** The phone shrunk to hide behind the green ring, as a transform from its open place (origin at its top left). */
function tucked(ph: HTMLElement, ring: HTMLElement): string {
  const w = ph.offsetWidth
  const h = ph.offsetHeight
  // the untransformed box: undo whatever transform is on it now
  const prev = ph.style.transform
  ph.style.transform = 'none'
  const p = ph.getBoundingClientRect()
  ph.style.transform = prev
  const r = ring.getBoundingClientRect()
  const s = (Math.min(r.width / w, r.height / h) * 0.8) || 0.05
  const tx = r.left + r.width / 2 - p.left - (s * w) / 2
  const ty = r.top + r.height / 2 - p.top - (s * h) / 2
  return `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${s.toFixed(4)})`
}

/** the phone's own shadow, and the same with nothing left of it */
const SHADOW = '0 34px 60px -24px rgb(10 14 26 / 0.38), 0 0 0 0.5px rgb(0 0 0 / 0.12)'
const NO_SHADOW = '0 34px 60px -24px rgb(10 14 26 / 0), 0 0 0 0.5px rgb(0 0 0 / 0)'

/** 书库 and 会议: the green ring at the bottom right, with what is unread; the phone springs out of it and back in. */
export function PhoneLauncher(props: { papers: PaperMeta[]; onAction: (n: SystemNotice) => void }) {
  const view = usePhone()
  const call = useCall()
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const ring = useRef<HTMLButtonElement>(null)
  const want = useRef(false)
  const running = useRef<Animation[]>([])

  const move = useCallback((opening: boolean) => {
    const ph = box.current?.querySelector<HTMLElement>('.ph')
    const btn = ring.current
    if (!ph || !btn) return
    // start from wherever it is now, so a second click mid-way turns it around smoothly
    const midway = running.current.length > 0
    const from = midway ? getComputedStyle(ph).transform : opening ? tucked(ph, btn) : 'none'
    const shadow = midway ? getComputedStyle(ph).boxShadow : opening ? NO_SHADOW : SHADOW
    const fades = [...ph.children].map((c) => [c as HTMLElement, midway ? getComputedStyle(c).opacity : opening ? '0' : '1'] as const)
    running.current.forEach((a) => a.cancel())
    running.current = []
    if (reducedMotion()) {
      if (!opening) setShown(false)
      return
    }
    // out: a spring with a little overshoot; in: drawn into the ring, quicker at the end, gone before it gets there
    const go = opening ? spring(210, 21) : { duration: 320, easing: 'cubic-bezier(0.45, 0, 0.8, 0.4)' }
    const fade: KeyframeAnimationOptions = opening
      ? { duration: 200, easing: 'ease-out', fill: 'forwards' }
      : { duration: 200, delay: 90, easing: 'ease-in', fill: 'forwards' }
    ph.style.transformOrigin = '0 0'
    const body = ph.animate({ transform: [from, opening ? 'none' : tucked(ph, btn)] }, { duration: go.duration, easing: go.easing, fill: 'forwards' })
    const rest = [
      ph.animate({ boxShadow: [shadow, opening ? SHADOW : NO_SHADOW] }, fade),
      ...fades.map(([c, start]) => c.animate({ opacity: [start, opening ? '1' : '0'] }, fade))
    ]
    running.current = [body, ...rest]
    body.finished
      .then(() => {
        if (running.current[0] !== body) return
        const done = running.current
        running.current = []
        // tucked away: it goes with the phone (cancelling first would flash it open for a frame)
        if (!opening) return setShown(false)
        // out: nothing may stay applied, a kept animation would cut the glass off from what is behind it
        done.forEach((a) => a.cancel())
        ph.style.transformOrigin = ''
      })
      .catch(() => undefined)
  }, [])

  const toggle = useCallback(
    (next: boolean) => {
      want.current = next
      setOpen(next)
      ring.current?.animate({ transform: ['scale(1)', 'scale(0.86)', 'scale(1.04)', 'scale(1)'], offset: [0, 0.3, 0.7, 1] }, { duration: 380, easing: 'ease-out' })
      if (next && !shown) setShown(true)
      else if (shown) move(next)
    },
    [shown, move]
  )
  // the phone just mounted: spring it out once it has its size
  useLayoutEffect(() => {
    if (shown && want.current) move(true)
  }, [shown, move])

  const close = useCallback(() => toggle(false), [toggle])
  useDismiss(box, close, open)
  return (
    <div className={`call-launcher ph-launcher no-drag ${open ? 'open' : ''} ${call.contact ? 'live' : ''}`} ref={box}>
      {shown && (
        <Phone
          className="ph-pop"
          papers={props.papers}
          onAction={(n) => {
            close()
            props.onAction(n)
          }}
          onClose={close}
        />
      )}
      <button className="call-launch" ref={ring} title="手机" aria-expanded={open} onClick={() => toggle(!open)}>
        <i />
        <i />
        <i />
        {!!view?.unread && <b className="ph-launch-n">{view.unread}</b>}
      </button>
    </div>
  )
}

const NEAR = 90

/** 大厅: the phone waits at the right edge, a strip of it showing; near the edge it leans out, a click brings it in. */
export function PhoneDock(props: { papers: PaperMeta[]; open: boolean; onOpen: (open: boolean) => void; onAction: (n: SystemNotice) => void }) {
  const view = usePhone()
  const [near, setNear] = useState(false)
  useEffect(() => {
    if (props.open) return setNear(false)
    const move = (e: PointerEvent) => setNear(e.clientX > window.innerWidth - NEAR && e.clientY > 70 && e.clientY < window.innerHeight - 60)
    window.addEventListener('pointermove', move)
    return () => window.removeEventListener('pointermove', move)
  }, [props.open])
  return (
    <div
      className="ph-dock-edge"
      data-state={props.open ? 'open' : near ? 'peek' : 'closed'}
      onClick={(e) => {
        if (!props.open) {
          e.stopPropagation()
          props.onOpen(true)
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Phone
        papers={props.papers}
        onAction={(n) => {
          props.onOpen(false)
          props.onAction(n)
        }}
        onClose={() => props.onOpen(false)}
      />
      {!props.open && !!view?.unread && <b className="ph-edge-n">{view.unread}</b>}
    </div>
  )
}
