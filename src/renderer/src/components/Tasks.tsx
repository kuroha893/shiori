import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { PaperMeta, Task, TaskKind, TaskList } from '../../../shared/types'
import { api, fileUrl } from '../api'
import { Icon } from './Icon'
import { PaperText } from './PaperText'
import { Kept } from './Chrome'

/*
 * The owner's AI tasks, like a music player's queue: a button in the top bar with the running task's progress, and a
 * list under it. The running task is on top; the queue below can be reordered by dragging any row; failed tasks wait
 * at the bottom. The queue stops at once from the running row, or once the running task is done from the head.
 */

const KIND: Record<TaskKind, [string, string]> = {
  process: ['file', '处理论文'],
  guide: ['sparkles', '导读'],
  venue: ['search', '发表信息']
}

const EMPTY: TaskList = { queue: [], failed: [], paused: false, stopAfter: false }

export function TaskButton({ papers }: { papers: PaperMeta[] }) {
  const [list, setList] = useState<TaskList>(EMPTY)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  // While a row is being dragged, updates wait so the rows don't move under the pointer.
  const dragging = useRef(false)
  const pending = useRef<TaskList>(undefined)

  useEffect(() => {
    api.tasks().then(setList)
    return api.onTasksChanged((l) => {
      if (dragging.current) pending.current = l
      else setList(l)
    })
  }, [])

  const count = (list.running ? 1 : 0) + list.queue.length
  const empty = !count && !list.failed.length
  useEffect(() => {
    if (empty) setOpen(false)
  }, [empty])

  // Outside clicks and Esc close the list; Esc stops here so the reader stays open.
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

  if (empty) return null
  const onlyFailed = !count
  return (
    <div className="tq no-drag" ref={box}>
      <button className={`tq-btn ${open ? 'on' : ''}`} title="任务" onClick={() => setOpen((v) => !v)}>
        <Status list={list} />
        {onlyFailed ? <span className="tq-nred">{list.failed.length}</span> : <span>{count}</span>}
        {!onlyFailed && list.failed.length > 0 && <i className="tq-red" />}
      </button>
      {open && (
        <TaskPanel
          list={list}
          papers={papers}
          onDrag={(on) => {
            dragging.current = on
            if (!on && pending.current) {
              setList(pending.current)
              pending.current = undefined
            }
          }}
          onOrder={(keys) => {
            setList((l) => {
              const base = pending.current ?? l
              pending.current = undefined
              const byKey = new Map(base.queue.map((t) => [t.key, t]))
              const queue = keys.map((k) => byKey.get(k)).filter((t): t is Task => !!t)
              return { ...base, queue: [...queue, ...base.queue.filter((t) => !keys.includes(t.key))] }
            })
            api.taskAct({ type: 'order', keys })
          }}
        />
      )}
    </div>
  )
}

/**
 * The ring is the running task's progress; the middle says what state the list is in: empty while it runs (a glint
 * circles the ring), the hourglass when it will pause after this one, ⏸ when it has paused, ! when only failed tasks
 * are left.
 */
function Status({ list }: { list: TaskList }) {
  const r = 9.5
  const c = 2 * Math.PI * r
  const run = list.running
  const p = Math.max(0, Math.min(1, run?.progress ?? 0))
  const state = run ? (list.stopAfter ? 'halting' : 'running') : list.queue.length ? 'paused' : 'failed'
  return (
    <span className={`tq-st ${state}`}>
      <svg className="tq-ring" viewBox="0 0 22 22" width="22" height="22">
        <circle className="bg" cx="11" cy="11" r={r} />
        {p > 0 && <circle className="fg" cx="11" cy="11" r={r} strokeDasharray={`${c * p} ${c}`} />}
        {state === 'running' && <circle className={`glint ${run?.progress === undefined ? 'alone' : ''}`} cx="11" cy="11" r={r} strokeDasharray={`4 ${c - 4}`} />}
      </svg>
      <span className="tq-mid">
        {state === 'halting' ? <Hourglass size={12} running /> : state === 'paused' ? <Icon name="pause" size={10} /> : state === 'failed' ? '!' : null}
      </span>
    </span>
  )
}

function TaskPanel(props: { list: TaskList; papers: PaperMeta[]; onDrag: (on: boolean) => void; onOrder: (keys: string[]) => void }) {
  const { list, papers } = props
  const byId = new Map(papers.map((p) => [p.id, p]))
  const listRef = useRef<HTMLDivElement>(null)
  const rows = useRef(new Map<string, HTMLDivElement>())
  // Where each row was drawn before a change, so rows slide to their new places
  const flip = useRef<Map<string, number>>(undefined)

  const snapshot = () => {
    const m = new Map<string, number>()
    for (const [key, el] of rows.current) m.set(key, el.offsetTop + (new DOMMatrixReadOnly(getComputedStyle(el).transform).m42 || 0))
    flip.current = m
  }
  const act = (a: Parameters<typeof api.taskAct>[0]) => {
    snapshot()
    api.taskAct(a)
  }

  useLayoutEffect(() => {
    const before = flip.current
    if (!before) return
    flip.current = undefined
    for (const [key, el] of rows.current) {
      const was = before.get(key)
      if (was === undefined) continue
      const dy = was - el.offsetTop
      if (Math.abs(dy) > 0.5) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 200, easing: 'ease' })
    }
  }, [list])

  const ref = (key: string) => (el: HTMLDivElement | null) => {
    if (el) rows.current.set(key, el)
    else rows.current.delete(key)
  }

  /* ---------- dragging a queued row ---------- */
  const drag = useRef<{ el: HTMLDivElement; els: HTMLDivElement[]; from: number; to: number; y0: number; s0: number; y: number; on: boolean; timer?: number }>(undefined)

  const follow = () => {
    const d = drag.current
    const box = listRef.current
    if (!d || !box) return
    const step = d.el.offsetHeight
    const dy = Math.max(-d.from * step, Math.min((d.els.length - 1 - d.from) * step, d.y - d.y0 + box.scrollTop - d.s0))
    d.el.style.transform = `translateY(${dy}px)`
    d.to = Math.max(0, Math.min(d.els.length - 1, d.from + Math.round(dy / step)))
    d.els.forEach((el, i) => {
      if (el === d.el) return
      const shift = d.from < d.to && i > d.from && i <= d.to ? -step : d.to < d.from && i >= d.to && i < d.from ? step : 0
      el.style.transform = shift ? `translateY(${shift}px)` : ''
    })
  }
  const autoscroll = () => {
    const d = drag.current
    const box = listRef.current
    if (!d || !box) return
    const b = box.getBoundingClientRect()
    const edge = 44
    const v = d.y < b.top + edge ? -Math.ceil((b.top + edge - d.y) / 4) : d.y > b.bottom - edge ? Math.ceil((d.y - (b.bottom - edge)) / 4) : 0
    if (!v) return
    const was = box.scrollTop
    box.scrollTop += v
    if (box.scrollTop !== was) follow()
  }
  const down = (e: React.PointerEvent<HTMLDivElement>, key: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    const els = list.queue.map((t) => rows.current.get(t.key)).filter((x): x is HTMLDivElement => !!x)
    const el = rows.current.get(key)!
    drag.current = { el, els, from: els.indexOf(el), to: els.indexOf(el), y0: e.clientY, s0: listRef.current!.scrollTop, y: e.clientY, on: false }
    el.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    d.y = e.clientY
    if (!d.on) {
      if (Math.abs(e.clientY - d.y0) < 4) return
      d.on = true
      props.onDrag(true)
      listRef.current!.classList.add('dragging')
      d.el.classList.add('lifted')
      d.timer = window.setInterval(autoscroll, 16)
    }
    follow()
  }
  const up = () => {
    const d = drag.current
    drag.current = undefined
    if (!d?.on) return
    window.clearInterval(d.timer)
    const keys = list.queue.map((t) => t.key)
    keys.splice(d.to, 0, ...keys.splice(d.from, 1))
    snapshot()
    for (const el of d.els) el.style.transform = ''
    d.el.classList.remove('lifted')
    listRef.current!.classList.remove('dragging')
    props.onDrag(false)
    props.onOrder(keys)
  }

  const row = (t: Task, cls: string, actions: React.ReactNode, extra?: React.ReactNode, drag?: boolean) => {
    const p = byId.get(t.paper)
    if (!p) return null
    return (
      <div
        key={t.key}
        ref={ref(t.key)}
        className={`tq-row ${cls}`}
        onPointerDown={drag ? (e) => down(e, t.key) : undefined}
        onPointerMove={drag ? move : undefined}
        onPointerUp={drag ? up : undefined}
        onPointerCancel={drag ? up : undefined}
      >
        <span className="tq-grip">
          <Icon name="grip" size={14} />
        </span>
        <span className="tq-thumb">{p.pages ? <img src={`${fileUrl(p.id, 'thumb.png')}?v=${p.pages}`} alt="" draggable={false} /> : <Icon name="file" size={14} />}</span>
        <div className="tq-main">
          <PaperText as="div" className="tq-title" text={p.titleZh || p.title} zh={!!p.titleZh} />
          <div className="tq-meta">
            <span className="tq-kind">
              <Icon name={KIND[t.kind][0]} size={12} />
              {KIND[t.kind][1]}
            </span>
            {extra}
          </div>
        </div>
        <div className="tq-acts">{actions}</div>
      </div>
    )
  }
  const btn = (icon: string, title: string, onClick: () => void) => (
    <button className="tq-ib" title={title} onClick={onClick}>
      <Icon name={icon} size={15} />
    </button>
  )

  const r = list.running
  /** What an interrupted run of this paper left, to carry on from */
  const kept = (t: Task) => {
    const share = t.kind === 'process' ? byId.get(t.paper)?.kept : undefined
    return share !== undefined ? <Kept share={share} /> : undefined
  }
  const resume = list.paused && !r && list.queue.length > 0
  return (
    <div className="tq-pop">
      <div className="tq-head">
        <b>任务</b>
        <span className="tq-count">{(r ? 1 : 0) + list.queue.length || ''}</span>
        <span className="spacer" />
        {r ? (
          <button className={`tq-cap ${list.stopAfter ? 'on' : ''}`} onClick={() => api.taskAct({ type: 'stopAfter', on: !list.stopAfter })}>
            <Hourglass size={14} running={list.stopAfter} />
            完成后暂停
          </button>
        ) : resume ? (
          <button className="tq-cap" onClick={() => api.taskAct({ type: 'resume' })}>
            <Icon name="play" size={12} />
            继续
          </button>
        ) : null}
        {list.queue.length > 0 &&
          btn('trash', '清空排队', () => {
            if (confirm(`清空排队的 ${list.queue.length} 个任务？`)) act({ type: 'clear' })
          })}
      </div>
      <div className="tq-list" ref={listRef}>
        {r && (
          <div className={`tq-run ${list.stopAfter ? 'halting' : ''}`}>
            {row(
              r,
              'run',
              <button className="tq-stop" title="立刻停止" onClick={() => act({ type: 'stopNow' })}>
                <i />
              </button>,
              r.progress === undefined ? (
                <>
                  {r.stage && <span className="tq-stage">{r.stage}</span>}
                  <span className="tq-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                </>
              ) : (
                r.stage && <span className="tq-stage">{r.stage}</span>
              )
            )}
            {r.progress !== undefined && (
              <div className="tq-bar">
                <i style={{ width: `${Math.max(2, r.progress * 100)}%` }} />
              </div>
            )}
          </div>
        )}
        {r && list.queue.length > 0 && <div className="tq-sep" />}
        {list.queue.map((t) =>
          row(
            t,
            'q',
            <>
              {btn('top', '置顶', () => act({ type: 'top', key: t.key }))}
              {btn('x', '移除', () => act({ type: 'remove', key: t.key }))}
            </>,
            kept(t),
            true
          )
        )}
        {list.failed.length > 0 && (r || list.queue.length > 0) && <div className="tq-sep" />}
        {list.failed.map((t) =>
          row(
            t,
            'err',
            <>
              {kept(t) ? btn('play', '继续', () => act({ type: 'retry', key: t.key })) : btn('refresh', '重试', () => act({ type: 'retry', key: t.key }))}
              {btn('x', '移除', () => act({ type: 'remove', key: t.key }))}
            </>,
            <>
              <span className="tq-err" title={t.error}>
                失败
              </span>
              {kept(t)}
            </>
          )
        )}
      </div>
    </div>
  )
}

/** Upright with the sand below; while on, it turns over, the sand runs down, and it turns over again. */
function Hourglass({ size, running }: { size: number; running: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  return (
    <svg className={`hg ${running ? 'run' : ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={size < 14 ? 2.4 : 2} strokeLinecap="round" strokeLinejoin="round">
      <defs>
        <clipPath id={`${id}t`}>
          <path d="M7.9 3h8.2v3.4L12 11.6 7.9 6.4z" />
        </clipPath>
        <clipPath id={`${id}b`}>
          <path d="M7.9 21h8.2v-3.4L12 12.4l-4.1 5.2z" />
        </clipPath>
      </defs>
      <g className="hg-turn">
        <g clipPath={`url(#${id}t)`}>
          <rect className="hg-sand-top" x="0" y="3" width="24" height="9" />
        </g>
        <g clipPath={`url(#${id}b)`}>
          <rect className="hg-sand-bot" x="0" y="12" width="24" height="9" />
        </g>
        <line className="hg-stream" x1="12" y1="12" x2="12" y2="20.5" />
        <path d="M5 22h14 M5 2h14" />
        <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
        <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
      </g>
    </svg>
  )
}
