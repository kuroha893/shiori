import { useEffect, useRef, useState } from 'react'
import type { PaperMeta, QuotaView, QuotaWindow, ServiceQuota } from '../../../shared/types'
import { PROVIDER_NAMES } from '../../../shared/models'
import { api } from '../api'
import { Icon } from './Icon'
import { ServiceLogo } from './ServiceLogo'
import { TaskButton } from './Tasks'
import { clockOf, playerHue, PlayerCapsule, useLeft, usePlayer, useStudy } from './Room'

/*
 * The status block in the top bar: the owner's tasks on the left, what is left of the AI allowance on the right.
 * Collapsed, the allowance half shows the tightest of the services Shiori runs on (with that service's mark when it
 * runs on more than one); amber at 25% or less, red at 10% or less. Opened, every connected service with its windows.
 */

export function StatusBlock({ papers, music = true }: { papers: PaperMeta[]; music?: boolean }) {
  return (
    <div className="sp no-drag">
      {music && <MusicButton />}
      <StudyButton />
      <TaskButton papers={papers} />
      <QuotaButton />
    </div>
  )
}

/** What is playing, outside the room: a small cover and level bars; opened, the room's capsule. Hidden when nothing plays. */
function MusicButton() {
  const p = usePlayer()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!p.np) setOpen(false)
  }, [!!p.np])
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])
  if (!p.np) return null
  return (
    <div className="np-seg" ref={box}>
      <button className={`np-btn ${open ? 'on' : ''} ${p.np.playing ? '' : 'paused'}`} style={playerHue(p.np)} title={p.np.title} onClick={() => setOpen((v) => !v)}>
        {p.cover ? (
          <img src={p.cover} alt="" draggable={false} />
        ) : (
          <span className="np-blank">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V6l10-2v12" />
              <circle cx="6.5" cy="18" r="2.5" />
              <circle cx="16.5" cy="16" r="2.5" />
            </svg>
          </span>
        )}
        <span className="eq">
          <i />
          <i />
          <i />
        </span>
      </button>
      {open && (
        <div className="np-pop">
          <PlayerCapsule p={p} />
        </div>
      )}
    </div>
  )
}

/** While the study timer runs, wherever the owner is: its ring and time left; open, pause or end it. */
function StudyButton() {
  const s = useStudy()
  const left = useLeft(s)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!s) setOpen(false)
  }, [!!s])
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])
  if (!s || left === undefined) return null
  const r = 9.5
  const c = 2 * Math.PI * r
  const share = 1 - left / (s.minutes * 60_000)
  return (
    <div className="st" ref={box}>
      <button className={`st-btn ${open ? 'on' : ''} ${s.endsAt ? '' : 'paused'} ${s.phase === 'rest' ? 'rest' : ''}`} title={s.phase === 'rest' ? '休息' : '专注'} onClick={() => setOpen((v) => !v)}>
        <span className="st-ring">
          <svg viewBox="0 0 22 22" width="22" height="22">
            <circle className="bg" cx="11" cy="11" r={r} />
            <circle className="fg" cx="11" cy="11" r={r} strokeDasharray={`${c * share} ${c}`} />
          </svg>
          <span className="st-ic">
            {!s.endsAt ? (
              <Icon name="pause" size={9} />
            ) : s.phase === 'rest' ? (
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z" />
                <path d="M16 11h1.5a2.5 2.5 0 0 1 0 5H16M9 3v2M12 3v2" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="13" r="7" />
                <path d="M12 10v3l2 1.5M5 4 2.5 6.5M19 4l2.5 2.5" />
              </svg>
            )}
          </span>
        </span>
        <span>{clockOf(left)}</span>
      </button>
      {open && (
        <div className="st-pop">
          <button className="btn sm" onClick={() => (s.endsAt ? api.studyPause() : api.studyResume())}>
            <Icon name={s.endsAt ? 'pause' : 'play'} size={12} />
            {s.endsAt ? '暂停' : '继续'}
          </button>
          <button className="btn sm" onClick={() => api.studyStop()}>
            <Icon name="stop" size={12} />
            结束
          </button>
        </div>
      )}
    </div>
  )
}

type Level = '' | 'amber' | 'red'
const RANK: Record<Level, number> = { '': 0, amber: 1, red: 2 }

export const levelOf = (left: number): Level => (left <= 0.1 ? 'red' : left <= 0.25 ? 'amber' : '')

/** DeepSeek is money: red once it can't be used, amber when little is left. */
const moneyLevel = (b: NonNullable<ServiceQuota['balance']>): Level => (!b.usable || b.amount <= 0 ? 'red' : b.amount < (b.currency === 'USD' ? 1 : 5) ? 'amber' : '')

const money = (b: NonNullable<ServiceQuota['balance']>) => `${b.currency === 'USD' ? '$' : '¥'}${b.amount.toFixed(2)}`
const tightest = (q: ServiceQuota) => Math.min(...(q.windows ?? []).map((w) => w.left))

type Compact = { provider: ServiceQuota['provider']; left?: number; text: string; level: Level }

/** What the collapsed half shows: the tightest window among the services in use; DeepSeek only when it runs low or is all there is. */
export function compactOf(v: QuotaView): Compact | undefined {
  const used = v.services.filter((q) => v.inUse.includes(q.provider) && (q.windows?.length || q.balance))
  const pct = used.filter((q) => q.windows?.length).sort((a, b) => tightest(a) - tightest(b))[0]
  const ds = used.find((q) => q.balance)
  const fromPct = pct && { provider: pct.provider, left: tightest(pct), text: `${Math.round(tightest(pct) * 100)}%`, level: levelOf(tightest(pct)) }
  const fromMoney = ds?.balance && { provider: ds.provider, text: money(ds.balance), level: moneyLevel(ds.balance) }
  if (!fromPct) return fromMoney
  if (fromMoney && RANK[fromMoney.level] > RANK[fromPct.level]) return fromMoney
  return fromPct
}

function Battery({ left, level }: { left: number; level: Level }) {
  return (
    <span className={`bat ${level}`}>
      <b style={{ width: `${Math.max(left > 0 ? 1.5 : 0, Math.round(left * 13))}px` }} />
    </span>
  )
}

function QuotaButton() {
  const [view, setView] = useState<QuotaView>({ services: [], inUse: [] })
  const [open, setOpen] = useState(false)
  const [reading, setReading] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.quota().then(setView)
    return api.onQuotaChanged(setView)
  }, [])

  const read = () => {
    setReading(true)
    api
      .readQuota()
      .then(setView)
      .finally(() => setReading(false))
  }

  // Opening reads every connected service, unless that was just done.
  useEffect(() => {
    if (open && (!view.checkedAt || Date.now() - view.checkedAt > 60_000 || view.services.some((q) => q.failed))) read()
  }, [open])

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])

  const c = compactOf(view)
  if (!c) return null
  return (
    <div className="qb" ref={box}>
      <button className={`qb-btn ${open ? 'on' : ''}`} title="额度" onClick={() => setOpen((v) => !v)}>
        {view.inUse.length > 1 && (
          <span className="qb-mark">
            <ServiceLogo provider={c.provider} />
          </span>
        )}
        <Battery left={c.left ?? (c.level === 'red' ? 0 : c.level === 'amber' ? 0.2 : 1)} level={c.level} />
        <span className={`qb-text ${c.level}`}>{c.text}</span>
      </button>
      {open && (
        <div className="qp">
          <div className="qp-head">
            <b>额度</b>
            <button className={`tq-ib ${reading ? 'spinning' : ''}`} title="刷新" onClick={read}>
              <Icon name="refresh" size={15} />
            </button>
          </div>
          <div className="qp-body">
            {view.services.map((q) => (
              <div className="qp-svc" key={q.provider}>
                <div className="qp-name">
                  <ServiceLogo provider={q.provider} />
                  {PROVIDER_NAMES[q.provider]}
                </div>
                {q.windows?.length ? (
                  q.windows.map((w) => <Row key={w.minutes} w={w} />)
                ) : q.balance ? (
                  <div className="qp-money">
                    <span className="lab">余额</span>
                    <span className={`val ${moneyLevel(q.balance)}`}>{money(q.balance)}</span>
                  </div>
                ) : (
                  <div className="qp-money">
                    <span className="lab" />
                    <span className="val faint">—</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** "5 小时", "本周", or so many hours or days. */
const windowName = (m: number) => (m === 10080 ? '本周' : m <= 1440 ? `${Math.round(m / 60)} 小时` : `${Math.round(m / 1440)} 天`)

/** "20:50 重置" today, "11 月 21 日重置" another day. */
function resetText(at?: number): string {
  if (!at) return ''
  const d = new Date(at)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 重置`
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日重置`
}

function Row({ w }: { w: QuotaWindow }) {
  const level = levelOf(w.left)
  return (
    <div className={`qp-row ${level}`}>
      <span className="lab">{windowName(w.minutes)}</span>
      <span className="bar">
        <i style={{ width: `${w.left * 100}%` }} />
      </span>
      <span className="pct">{Math.round(w.left * 100)}%</span>
      <span className="reset">{resetText(w.resetsAt)}</span>
    </div>
  )
}
