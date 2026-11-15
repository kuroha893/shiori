import { useEffect, useRef, useState } from 'react'
import type { PaperMeta, QuotaView, QuotaWindow, ServiceQuota } from '../../../shared/types'
import { PROVIDER_NAMES } from '../../../shared/models'
import { api } from '../api'
import { Icon } from './Icon'
import { ServiceLogo } from './ServiceLogo'
import { TaskButton } from './Tasks'

/*
 * The status block in the top bar: the owner's tasks on the left, what is left of the AI allowance on the right.
 * Collapsed, the allowance half shows the tightest of the services Shiori runs on (with that service's mark when it
 * runs on more than one); amber at 25% or less, red at 10% or less. Opened, every connected service with its windows.
 */

export function StatusBlock({ papers }: { papers: PaperMeta[] }) {
  return (
    <div className="sp no-drag">
      <TaskButton papers={papers} />
      <QuotaButton />
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
