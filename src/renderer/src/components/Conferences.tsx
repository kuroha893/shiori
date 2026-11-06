import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PaperMeta } from '../../../shared/types'
import type { Activity, ConfOverview, Conference, ConferenceSummary, EditionSummary, EditionView, Follow, LaterItem, ListedPaper, PaperQuery } from '../../../shared/conferences'
import { hasCjk } from '../../../shared/conferences'
import { api } from '../api'
import { Icon } from './Icon'
import { Menu, useDismiss, type MenuItem } from './Chrome'
import { errorText, useFolders } from './Folders'
import { VenueTags } from './VenueTags'
import { PaperText } from './PaperText'
import type { Toast } from './App'

/*
 * 会议, a space of its own beside the library. Its home lists the owner's directions and the latest edition of each
 * conference; an edition is one long stream of its papers, theme after theme, with its table of contents in the
 * sidebar's place.
 */

export function useConfOverview(): ConfOverview | undefined {
  const [overview, setOverview] = useState<ConfOverview>()
  useEffect(() => {
    const load = () => api.confOverview().then(setOverview)
    load()
    return api.onConfChanged(load)
  }, [])
  return overview
}

export function useLater(): LaterItem[] {
  const [items, setItems] = useState<LaterItem[]>([])
  useEffect(() => {
    const load = () => api.laterList().then(setItems)
    load()
    return api.onLaterChanged(load)
  }, [])
  return items
}

interface Props {
  overview?: ConfOverview
  library: PaperMeta[]
  ready: boolean
  onOpenPaper: (id: string) => void
  toast: Toast
}

type View = { kind: 'home' } | { kind: 'edition'; conf: string; year: number }

/** Renders the sidebar (inside an edition) and the main area. */
export function Conferences(props: Props) {
  const { overview } = props
  const [view, setView] = useState<View>({ kind: 'home' })

  useEffect(() => {
    if (overview && !overview.started) api.confStart()
  }, [overview?.started])

  // Leaving an edition marks its new papers as seen, so they stay marked while the owner looks around in it.
  const current = view.kind === 'edition' ? `${view.conf}/${view.year}` : undefined
  useEffect(() => {
    if (!current) return
    const [conf, year] = current.split('/')
    return () => void api.confSeen(conf, +year)
  }, [current])

  if (!overview) return <main className="lib-scroll" />
  if (view.kind === 'edition') {
    const c = overview.conferences.find((x) => x.id === view.conf)
    if (c) return <EditionPage key={current} {...props} c={c} year={view.year} onYear={(year) => setView({ ...view, year })} onBack={() => setView({ kind: 'home' })} />
  }
  return <Home {...props} overview={overview} onOpen={(e) => setView({ kind: 'edition', conf: e.conf, year: e.year })} />
}

/* ---------- marks ---------- */

// Marks for the default conferences ship with the app; others are downloaded when Claude sets them up.
const BUNDLED = import.meta.glob<string>('../assets/confs/*.svg', { query: '?raw', import: 'default', eager: true })
// ACL's conferences carry the ACL mark.
const ACL_FAMILY = ['acl', 'emnlp', 'naacl', 'eacl', 'aacl']

async function markBlob(c: Conference): Promise<Blob | undefined> {
  const svg = BUNDLED[`../assets/confs/${ACL_FAMILY.includes(c.id) ? 'acl' : c.id}.svg`]
  if (svg) return new Blob([svg], { type: 'image/svg+xml' })
  if (!c.mark) return undefined
  const res = await fetch(`shiori://conf/${encodeURIComponent(c.id)}/mark?v=${encodeURIComponent(c.mark)}`)
  return res.ok ? res.blob() : undefined
}

/**
 * A mark comes drawn for a light or a dark ground. For each theme, neutral ink that would vanish is turned to the
 * other end, keeping its hue; coloured parts stay as they are.
 */
async function recolor(blob: Blob): Promise<{ light: string; dark: string }> {
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    await new Promise((ok, fail) => {
      img.onload = ok
      img.onerror = fail
      img.src = url
    })
    // An SVG sized in percent has no natural size; draw it square.
    const nw = img.naturalWidth || 240
    const nh = img.naturalHeight || 240
    const scale = 240 / nh
    const make = (dark: boolean) => {
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(nw * scale))
      c.height = 240
      const g = c.getContext('2d')!
      g.drawImage(img, 0, 0, c.width, c.height)
      const px = g.getImageData(0, 0, c.width, c.height)
      const d = px.data
      for (let i = 0; i < d.length; i += 4) {
        if (!d[i + 3]) continue
        const r = d[i] / 255
        const gr = d[i + 1] / 255
        const b = d[i + 2] / 255
        const max = Math.max(r, gr, b)
        const min = Math.min(r, gr, b)
        const l = (max + min) / 2
        if (dark ? l >= 0.45 : l <= 0.7) continue
        const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1))
        if (!dark && s > 0.3) continue
        let h = 0
        if (max !== min) h = max === r ? ((gr - b) / (max - min)) % 6 : max === gr ? (b - r) / (max - min) + 2 : (r - gr) / (max - min) + 4
        h = ((h % 6) + 6) % 6
        const L = dark ? 0.93 - l * 0.4 : 0.12 + (1 - l) * 0.4
        const C = (1 - Math.abs(2 * L - 1)) * Math.min(s, 0.6)
        const X = C * (1 - Math.abs((h % 2) - 1))
        const m = L - C / 2
        const [R, G, B] = h < 1 ? [C, X, 0] : h < 2 ? [X, C, 0] : h < 3 ? [0, C, X] : h < 4 ? [0, X, C] : h < 5 ? [X, 0, C] : [C, 0, X]
        d[i] = (R + m) * 255
        d[i + 1] = (G + m) * 255
        d[i + 2] = (B + m) * 255
      }
      g.putImageData(px, 0, 0)
      return c.toDataURL()
    }
    return { light: make(false), dark: make(true) }
  } finally {
    URL.revokeObjectURL(url)
  }
}

const marks = new Map<string, Promise<{ light: string; dark: string } | undefined>>()
function useMark(c: Conference) {
  const key = `${c.id}/${c.mark ?? ''}`
  const [mark, setMark] = useState<{ light: string; dark: string }>()
  useEffect(() => {
    if (!marks.has(key)) marks.set(key, markBlob(c).then((b) => (b ? recolor(b) : undefined)).catch(() => undefined))
    let live = true
    marks.get(key)!.then((m) => live && setMark(m))
    return () => {
      live = false
    }
  }, [key])
  return mark
}

/** The conference's mark, its name and the year. */
function ConfName({ c, year, big }: { c: Conference; year?: number; big?: boolean }) {
  const mark = useMark(c)
  return (
    <span className={`cf-name ${big ? 'big' : ''}`} title={c.fullName}>
      {mark && (
        <span className="cf-mark">
          <img className="on-light" src={mark.light} alt="" draggable={false} />
          <img className="on-dark" src={mark.dark} alt="" draggable={false} />
        </span>
      )}
      <b>{c.name}</b>
      {year && <span className="cf-name-year">{year}</span>}
    </span>
  )
}

/* ---------- small pieces ---------- */

const day = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/** 今天, 昨天, or the day, as the call history writes them. */
const recent = (iso: string) => {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((start(new Date()) - start(new Date(iso))) / 86_400_000)
  return days === 0 ? '今天' : days === 1 ? '昨天' : day(iso)
}

/** 暂未公开, with the day the paper was last looked for beneath it. */
function Closed({ at }: { at: string }) {
  return (
    <span className="cf-closed">
      <span className="cf-cap sm">
        <Icon name="lock" size={11} />
        暂未公开
      </span>
      <span className="cf-closed-when">
        <Icon name="history" size={11} />
        {recent(at)}
      </span>
    </span>
  )
}

const stamp = (iso: string) => {
  const d = new Date(iso)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

function Wave() {
  return (
    <span className="cf-wave">
      <i />
      <i />
      <i />
    </span>
  )
}

/** What a job is doing: a short name, and a bar when its progress is known. */
function Busy({ a }: { a: Activity }) {
  return (
    <span className="cf-cap">
      <Wave />
      {a.label}
      {a.progress !== undefined && (
        <span className="cf-bar">
          <i style={{ width: `${Math.round(a.progress * 100)}%` }} />
        </span>
      )}
    </span>
  )
}

function Fresh({ n, sm }: { n: number; sm?: boolean }) {
  return (
    <span className={`cf-cap fresh ${sm ? 'sm' : ''}`} title="新论文">
      +{n}
      <Icon name="file" size={sm ? 11 : 12} />
    </span>
  )
}

/** The edition to open for a conference: the newest with papers, else the newest with results out, else the newest. */
const mainEdition = (c: ConferenceSummary) =>
  c.editions.find((e) => e.count > 0 && !e.archived) ?? c.editions.find((e) => e.released && !e.past) ?? c.editions.find((e) => e.count > 0) ?? c.editions[0]

/* ---------- search ---------- */

/** English is matched as it is typed. Chinese is turned into English phrases by Claude on Enter, shown as chips. */
function useSearch() {
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [keywords, setKeywords] = useState<string[]>()
  const [turning, setTurning] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (hasCjk(text)) return
    setKeywords(undefined)
    const t = window.setTimeout(() => setQuery(text.trim()), 220)
    return () => window.clearTimeout(t)
  }, [text])
  const useKeywords = (list: string[]) => {
    setKeywords(list)
    setQuery([...list, text.trim()].filter(Boolean).join(' | '))
  }
  const submit = async () => {
    if (!hasCjk(text) || turning) return
    setTurning(true)
    setError(undefined)
    try {
      useKeywords((await api.confKeywords(text.trim())).split('|').map((k) => k.trim()).filter(Boolean))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setTurning(false)
    }
  }
  const clear = () => {
    setText('')
    setQuery('')
    setKeywords(undefined)
    setError(undefined)
  }
  return { text, setText, query, keywords, turning, error, submit, clear, useKeywords }
}

function SearchBar({ s }: { s: ReturnType<typeof useSearch> }) {
  const [adding, setAdding] = useState('')
  return (
    <div className="cf-search-box">
      <div className="import-input">
        <Icon name="search" className="faint" />
        <input
          className="bare"
          placeholder="搜索论文"
          value={s.text}
          onChange={(e) => s.setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) s.submit()
            if (e.key === 'Escape') s.clear()
          }}
        />
        {s.turning && <Wave />}
        {s.text && !s.turning && (
          <button className="icon-btn" onClick={s.clear}>
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
      {s.error && <p className="cf-search-err">{s.error}</p>}
      {s.keywords && (
        <div className="cf-keywords">
          {s.keywords.map((k) => (
            <span key={k} className="cf-kw">
              {k}
              <button onClick={() => s.useKeywords(s.keywords!.filter((x) => x !== k))}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
          <input
            className="cf-kw add"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || !adding.trim()) return
              s.useKeywords([...s.keywords!, adding.trim()])
              setAdding('')
            }}
            placeholder="+"
          />
        </div>
      )}
    </div>
  )
}

/* ---------- home ---------- */

function Home(props: Props & { overview: ConfOverview; onOpen: (e: EditionSummary) => void }) {
  const { overview, onOpen, toast } = props
  const s = useSearch()
  const [open, setOpen] = useState<{ id: string; rename?: boolean }>()
  const follow = overview.follows.find((f) => f.id === open?.id)
  const [adding, setAdding] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>()
  const [past, setPast] = useState<ConferenceSummary>()
  const [records, setRecords] = useState<EditionSummary>()

  const add = async () => {
    if (!adding.trim()) return
    try {
      await api.confAdd(adding)
      setAdding('')
    } catch (e) {
      toast(errorText(e))
    }
  }

  const openMenu = (c: ConferenceSummary, x: number, y: number) => {
    const e = mainEdition(c)
    setMenu({ x, y, items: confMenu(c, e, { onPast: () => setPast(c), onRecords: () => e && setRecords(e), toast }) })
  }

  // Latest first: the edition whose results came out most recently.
  const rows = [...overview.conferences].sort((a, b) => (mainEdition(b)?.releaseDate ?? b.addedAt).localeCompare(mainEdition(a)?.releaseDate ?? a.addedAt))

  return (
    <main className="lib-scroll">
      <div className="lib-inner cf">
        <section className="lib-hero fade-in">
          <h1>会议</h1>
        </section>
        <section className="card cf-search fade-in">
          <SearchBar s={s} />
        </section>

        {s.query ? (
          <Results {...props} query={{ search: s.query, lean: true }} />
        ) : follow ? (
          <FollowPage {...props} key={follow.id} f={follow} state={overview.followState[follow.id]} rename={!!open?.rename} onBack={() => setOpen(undefined)} />
        ) : (
          <>
            <Follows overview={overview} onOpen={(id, rename) => setOpen({ id, rename })} toast={toast} />
            <div className="cf-head">
              <h2>最新会议</h2>
            </div>
            <section className="card cf-confs">
              {rows.map((c) => (
                <ConfRow
                  key={c.id}
                  c={c}
                  onOpen={onOpen}
                  onMenu={(x, y) => openMenu(c, x, y)}
                  onRecords={(e) => setRecords(e)}
                />
              ))}
              <div className="cf-add">
                <Icon name="plus" size={15} />
                <input
                  className="bare"
                  placeholder="添加会议"
                  value={adding}
                  onChange={(e) => setAdding(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && add()}
                />
              </div>
            </section>
          </>
        )}
      </div>
      {menu && <Menu {...menu} onClose={() => setMenu(undefined)} />}
      {past && <PastYear c={past} onClose={() => setPast(undefined)} toast={toast} />}
      {records && <Records e={records} onClose={() => setRecords(undefined)} />}
    </main>
  )
}

/** The actions on a conference, from its row or from an edition's sidebar. */
function confMenu(c: ConferenceSummary, e: EditionSummary | undefined, o: { onPast: () => void; onRecords: () => void; toast: Toast; inEdition?: boolean; onDeleted?: () => void }): MenuItem[] {
  return [
    ...(c.tracking && e && !e.past && e.phase !== 'complete' ? [{ label: '立即检查', icon: 'refresh', onClick: () => api.confRefresh(e.conf, e.year) }] : []),
    { label: '补抓往届', icon: 'history', onClick: o.onPast },
    ...(e ? [{ label: '渠道与记录', icon: 'list', onClick: o.onRecords }] : []),
    c.tracking
      ? { label: '停止跟踪', icon: 'pause', onClick: () => api.confSetTracking(c.id, false) }
      : { label: '恢复跟踪', icon: 'play', onClick: () => api.confSetTracking(c.id, true) },
    o.inEdition && e
      ? {
          label: '删除这一届',
          icon: 'trash',
          danger: true,
          onClick: () => {
            if (!confirm(`删除 ${e.name} 已经抓到的论文？文件会移到废纸篓。`)) return
            api.confDeleteEdition(e.conf, e.year).then(() => o.onDeleted?.())
          }
        }
      : {
          label: '删除会议',
          icon: 'trash',
          danger: true,
          onClick: () => confirm(`删除「${c.name}」和已经抓到的所有论文？文件会移到废纸篓。`) && api.confDelete(c.id).catch((err) => o.toast(errorText(err)))
        }
  ]
}

function ConfRow({ c, onOpen, onMenu, onRecords }: { c: ConferenceSummary; onOpen: (e: EditionSummary) => void; onMenu: (x: number, y: number) => void; onRecords: (e: EditionSummary) => void }) {
  const e = mainEdition(c)
  const next = c.editions.find((x) => e && x.year > e.year && x.phase === 'waiting')
  const activity = c.activity ?? e?.activity ?? next?.activity
  const error = c.setupError ?? e?.error
  const open = e && e.count > 0 ? () => onOpen(e) : undefined
  return (
    <div
      className={`cf-conf ${open ? 'go' : ''} ${c.tracking ? '' : 'off'}`}
      onClick={open}
      onContextMenu={(ev) => {
        ev.preventDefault()
        onMenu(ev.clientX, ev.clientY)
      }}
    >
      <div className="cf-conf-name">
        <ConfName c={c} year={e?.year} />
      </div>
      <div className="cf-count">{e && e.count > 0 && <>{e.count}<small>篇</small></>}</div>
      <span className="spacer" />
      {e && e.fresh > 0 && <Fresh n={e.fresh} />}
      {activity && <Busy a={activity} />}
      {error && !activity && (
        <button
          className="cf-cap err"
          title={error}
          onClick={(ev) => {
            ev.stopPropagation()
            if (c.setupError) api.confRetry(c.id)
            else if (e) onRecords(e)
          }}
        >
          <Icon name={c.setupError ? 'refresh' : 'x'} size={12} />
          {c.setupError ? '重试' : '出错'}
        </button>
      )}
      {c.tracking && next?.releaseDate && (
        <span className="cf-cap" title="下一届预计公布">
          <Icon name="calendar" size={13} />
          <s>{next.year}</s>
          {day(next.releaseDate)}
        </span>
      )}
      {!c.tracking && (
        <span className="cf-cap icon stopped" title="已停止跟踪">
          <Icon name="unlink" size={14} />
        </span>
      )}
      <button
        className="icon-btn more"
        onClick={(ev) => {
          ev.stopPropagation()
          const r = ev.currentTarget.getBoundingClientRect()
          onMenu(r.right - 190, r.bottom + 4)
        }}
      >
        <Icon name="more" />
      </button>
    </div>
  )
}

function PastYear({ c, onClose, toast }: { c: ConferenceSummary; onClose: () => void; toast: Toast }) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, onClose)
  const [year, setYear] = useState(String(new Date().getFullYear() - 1))
  const submit = async () => {
    try {
      await api.confAddPast(c.id, +year)
      onClose()
    } catch (e) {
      toast(errorText(e))
    }
  }
  return (
    <div className="cf-modal-back">
      <div ref={ref} className="cf-modal card">
        <ConfName c={c} />
        <div className="cf-modal-row">
          <input className="input" autoFocus value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          <button className="btn primary" disabled={year.length !== 4} onClick={submit}>
            补抓
          </button>
        </div>
      </div>
    </div>
  )
}

/** Where an edition's papers come from, and what was done. */
function Records({ e, onClose }: { e: EditionSummary; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, onClose)
  return (
    <div className="cf-modal-back">
      <div ref={ref} className="cf-modal cf-records card">
        <b>{e.name}</b>
        {e.error && <p className="cf-records-err">{e.error}</p>}
        <div className="cf-channels">
          {e.channels.map((c) => (
            <div key={c.id} className="cf-channel">
              <span>{c.name}</span>
              {c.url && (
                <a className="faint" onClick={() => api.openExternal(c.url!)}>
                  <Icon name="external" size={12} />
                </a>
              )}
              <span className="spacer" />
              {c.error ? <span className="cf-records-err" title={c.error}>{c.error.slice(0, 60)}</span> : <span className="faint">{c.count ?? 0}</span>}
            </div>
          ))}
        </div>
        <div className="cf-log">
          {[...e.log].reverse().map((l, i) => (
            <p key={i}>
              <span className="mono faint">{stamp(l.at)}</span>
              {l.text}
            </p>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ---------- the owner's directions ---------- */

function Follows({ overview, onOpen, toast }: { overview: ConfOverview; onOpen: (id: string, rename?: boolean) => void; toast: Toast }) {
  const folders = useFolders()
  const { follows } = overview
  const [adding, setAdding] = useState<string>()
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>()
  const have = new Set(follows.map((f) => f.name.toLowerCase()))
  const missing = folders.filter((f) => !have.has(f.name.toLowerCase()))
  const add = async (name?: string) => {
    setAdding(undefined)
    if (!name?.trim()) return
    try {
      await api.followAdd(name)
    } catch (e) {
      toast(errorText(e))
    }
  }
  return (
    <>
      <div className="cf-head">
        <h2>关注的方向</h2>
        <span className="spacer" />
        {missing.length > 0 && (
          <button className="btn sm ghost" onClick={() => api.followFromFolders()}>
            导入我的分类
          </button>
        )}
      </div>
      <section className="cf-follows">
        {follows.map((f) => (
          <button
            key={f.id}
            className={`cf-chip ${overview.followState[f.id] ? 'pending' : ''}`}
            onClick={() => onOpen(f.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, items: followMenu(f, { onRename: () => onOpen(f.id, true) }) })
            }}
          >
            {f.name}
            {overview.followState[f.id] ? <Wave /> : overview.followFresh[f.id] ? <Fresh n={overview.followFresh[f.id]} sm /> : null}
          </button>
        ))}
        {adding !== undefined ? (
          <input
            className="input cf-chip-input"
            autoFocus
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onBlur={() => add(adding)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setAdding(undefined)
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) add(adding)
            }}
          />
        ) : (
          <button className="cf-chip add" onClick={() => setAdding('')}>
            <Icon name="plus" size={13} />
          </button>
        )}
      </section>
      {menu && <Menu {...menu} onClose={() => setMenu(undefined)} />}
    </>
  )
}

/** What can be done with a direction, from its chip, its page or an edition's sidebar. */
function followMenu(f: Follow, o: { onRename: () => void; onGone?: () => void }): MenuItem[] {
  return [
    { label: '改名', icon: 'note', onClick: o.onRename },
    {
      label: '不再关注',
      icon: 'trash',
      danger: true,
      onClick: () => {
        if (!confirm(`不再关注「${f.name}」？`)) return
        api.followDelete(f.id)
        o.onGone?.()
      }
    }
  ]
}

/** A name edited in place: Enter or leaving keeps it, Esc drops it. */
function RenameInput({ value, onDone, className }: { value: string; onDone: (name?: string) => void; className?: string }) {
  const [text, setText] = useState(value)
  const done = useRef(false)
  const finish = (name?: string) => {
    if (done.current) return
    done.current = true
    onDone(name?.trim() && name.trim() !== value ? name.trim() : undefined)
  }
  return (
    <input
      className={`input cf-rename ${className ?? ''}`}
      autoFocus
      value={text}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => finish(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) finish(text)
        if (e.key === 'Escape') finish()
      }}
    />
  )
}

/** A direction's own page: its papers across editions as Claude finds them, and its keywords, which can be changed. */
function FollowPage(props: Props & { f: Follow; state?: Activity; rename: boolean; onBack: () => void }) {
  const { f, state, toast } = props
  const [renaming, setRenaming] = useState(props.rename)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>()
  const [adding, setAdding] = useState('')
  const setKeywords = (keywords: string[]) => api.followUpdate(f.id, { keywords }).catch((e) => toast(errorText(e)))
  const rename = (name?: string) => {
    setRenaming(false)
    if (name) api.followUpdate(f.id, { name }).catch((e) => toast(errorText(e)))
  }
  return (
    <>
      <Results
        {...props}
        query={{ group: { type: 'follow', id: f.id }, lean: true }}
        live
        working={!!state}
        head={(n) => (
          <>
            <div className="cf-list-head cf-fhead">
              <button className="icon-btn" onClick={props.onBack}>
                <Icon name="back" size={15} />
              </button>
              {renaming ? <RenameInput value={f.name} onDone={rename} /> : <h2>{f.name}</h2>}
              <span className="n">{n}</span>
              {state && <Busy a={state} />}
              <span className="spacer" />
              <button
                className="icon-btn"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setMenu({ x: r.right - 190, y: r.bottom + 4, items: followMenu(f, { onRename: () => setRenaming(true), onGone: props.onBack }) })
                }}
              >
                <Icon name="more" />
              </button>
            </div>
            {state?.label !== '写关键词' && (
              <div className="cf-fkw">
                {f.keywords.map((k) => (
                  <span key={k} className="cf-kw quiet">
                    {k}
                    <button onClick={() => setKeywords(f.keywords.filter((x) => x !== k))}>
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                ))}
                <input
                  className="cf-kw add"
                  value={adding}
                  placeholder="+"
                  onChange={(e) => setAdding(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing || !adding.trim()) return
                    setKeywords([...f.keywords, adding.trim()])
                    setAdding('')
                  }}
                />
              </div>
            )}
          </>
        )}
      />
      {menu && <Menu {...menu} onClose={() => setMenu(undefined)} />}
    </>
  )
}

/* ---------- streams of papers ---------- */

interface Sub {
  id: string
  name: string
  papers: ListedPaper[]
}
interface Section {
  id: string
  name: string
  count: number
  subs: Sub[]
}

/**
 * Sections one after another; each section's header sticks while you are inside it and names the subsection you are
 * in. The sticky state is set on the DOM directly, since it changes with every scroll.
 */
function Stream(props: Props & { sections: Section[]; defaults?: { kind?: string; track?: string }; onPlace?: (section?: string, sub?: string) => void; showEdition?: boolean; empty?: ReactNode }) {
  const { sections, onPlace } = props
  const root = useRef<HTMLDivElement>(null)
  const last = useRef('')
  useEffect(() => {
    const scroller = root.current?.closest('.lib-scroll')
    if (!scroller) return
    const spy = () => {
      const top = scroller.getBoundingClientRect().top
      let current: HTMLElement | undefined
      let currentSub = ''
      for (const s of root.current!.querySelectorAll<HTMLElement>(':scope > .cf-section')) {
        const h = s.querySelector<HTMLElement>(':scope > .cf-th')!
        const r = s.getBoundingClientRect()
        const stuck = r.top < top + 1 && r.bottom > top
        h.classList.toggle('stuck', stuck)
        if (r.top < top + h.offsetHeight + 4) current = s
        let label = ''
        if (stuck) {
          h.querySelector<HTMLElement>('.cf-th-prog i')!.style.width = `${Math.min(1, Math.max(0, (top + h.offsetHeight - r.top) / r.height)) * 100}%`
          const hb = h.getBoundingClientRect().bottom
          let sub: HTMLElement | undefined
          for (const d of s.querySelectorAll<HTMLElement>(':scope > .cf-div')) {
            if (d.getBoundingClientRect().top < hb + 8) sub = d
            else break
          }
          if (sub) label = sub.dataset.name ?? ''
          if (s === current) currentSub = sub?.dataset.id ?? ''
        }
        const b = h.querySelector<HTMLElement>('.cf-th-sub')!
        if (b.dataset.label !== label) {
          b.dataset.label = label
          b.classList.toggle('on', !!label)
          b.querySelector('span')!.textContent = label
        }
      }
      current ??= root.current!.querySelector<HTMLElement>(':scope > .cf-section') ?? undefined
      const place = `${current?.dataset.id ?? ''}/${currentSub}`
      if (place !== last.current) {
        last.current = place
        onPlace?.(current?.dataset.id, currentSub || undefined)
      }
    }
    spy()
    scroller.addEventListener('scroll', spy, { passive: true })
    return () => scroller.removeEventListener('scroll', spy)
  }, [sections, onPlace])

  if (!sections.some((s) => s.count)) return <>{props.empty === undefined ? <p className="cf-none"><Icon name="search" size={18} /></p> : props.empty}</>
  return (
    <div ref={root} className="cf-stream">
      {sections
        .filter((s) => s.count)
        .map((s) => (
          <section key={s.id} className="cf-section" data-id={s.id}>
            <header className="cf-th">
              <div className="cf-th-row">
                <h2>{s.name}</h2>
                <span className="n">{s.count}</span>
                <span className="cf-th-sub">
                  <Icon name="next" size={13} />
                  <span />
                </span>
              </div>
              <div className="cf-th-prog">
                <i />
              </div>
            </header>
            {s.subs
              .filter((b) => b.papers.length)
              .map((b) => (
                <SubBlock key={b.id} b={b} props={props} />
              ))}
          </section>
        ))}
    </div>
  )
}

function SubBlock({ b, props }: { b: Sub; props: Parameters<typeof Stream>[0] }) {
  return (
    <>
      {b.name && (
        <div className="cf-div" data-id={b.id} data-name={b.name}>
          <span>{b.name}</span>
          <i>{b.papers.length}</i>
        </div>
      )}
      {b.papers.map((p) => (
        <PaperRow key={`${p.edition}/${p.key}`} p={p} lib={p.inLibrary ? props.library.find((m) => m.id === p.inLibrary) : undefined} defaults={props.defaults} showEdition={props.showEdition} ready={props.ready} onOpenPaper={props.onOpenPaper} toast={props.toast} />
      ))}
    </>
  )
}

const KIND_CLASS: Record<string, string> = { oral: 'oral', spotlight: 'spot' }

const PaperRow = memo(function PaperRow({
  p,
  lib,
  defaults,
  showEdition,
  ready,
  onOpenPaper,
  toast
}: {
  p: ListedPaper
  lib?: PaperMeta
  defaults?: { kind?: string; track?: string }
  showEdition?: boolean
  ready: boolean
  onOpenPaper: (id: string) => void
  toast: Toast
}) {
  const ref = `${p.edition}/${p.key}`
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState<ListedPaper>()
  const [zh, setZh] = useState<string>()
  const [translating, setTranslating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [later, setLater] = useState(p.later)
  useEffect(() => setLater(p.later), [p.later])
  const canImport = !!(p.pdf || p.arxiv)

  const toggle = () => {
    if (!open && !full) api.confPaper(ref).then((x) => x && setFull(x))
    setOpen(!open)
  }
  const translate = async () => {
    setTranslating(true)
    try {
      setZh(await api.confTranslate(ref))
    } catch (e) {
      toast(errorText(e))
    } finally {
      setTranslating(false)
    }
  }
  const doImport = async () => {
    setImporting(true)
    try {
      const meta = await importPaper(ref, toast)
      if (ready && meta?.status === 'new') api.processPaper(meta.id)
    } catch (e) {
      toast(errorText(e))
    } finally {
      setImporting(false)
    }
  }

  const kind = p.kind && p.kind !== defaults?.kind ? KIND_CLASS[p.kind.toLowerCase()] ?? 'track' : undefined
  const track = p.track && p.track !== defaults?.track ? p.track : undefined
  const abstractZh = zh ?? full?.abstractZh
  return (
    <article className={`cf-paper ${open ? 'open' : ''}`} onClick={toggle}>
      <div className="cf-paper-main">
        <h3>
          {p.fresh && <i className="cf-dot" />}
          <PaperText text={p.titleZh || p.title} zh={!!p.titleZh} />
        </h3>
        {p.titleZh && <PaperText className="cf-paper-en" text={p.title} />}
        <div className="cf-meta">
          {showEdition && <span className="cf-tag edition">{p.editionName}</span>}
          {kind && <span className={`cf-tag ${kind}`}>{p.kind}</span>}
          {track && <span className="cf-tag track">{track}</span>}
          <span className="cf-authors">{p.authors.slice(0, 3).join(', ')}</span>
          {p.authors.length > 3 && <span className="cf-plus">+{p.authors.length - 3}</span>}
        </div>
      </div>
      <div className={`cf-act ${p.unpublished && !p.inLibrary ? 'closed' : ''}`} onClick={(e) => e.stopPropagation()}>
        {p.inLibrary ? (
          <button className="cf-inlib" disabled={lib?.status !== 'ready'} title={lib?.status === 'error' ? lib.error : undefined} onClick={() => lib && onOpenPaper(lib.id)}>
            <Icon name="check" size={12} />
            已在书库
          </button>
        ) : (
          <>
            <button
              className={`icon-btn cf-later ${later ? 'on' : ''}`}
              title="稍后再看"
              onClick={() => {
                setLater(!later)
                api.laterSet(ref, !later)
              }}
            >
              <Icon name="bookmark" />
            </button>
            {p.unpublished && <Closed at={p.unpublished} />}
            <button className="btn sm" disabled={!canImport || importing} onClick={doImport}>
              {importing ? <Wave /> : '导入'}
            </button>
          </>
        )}
      </div>
      {open && (
        <div className="cf-abs" onClick={(e) => e.stopPropagation()}>
          {full?.abstract && abstractZh && <PaperText as="p" className="zh" text={abstractZh} zh />}
          {full?.abstract && <PaperText as="p" className={abstractZh ? 'en' : 'en only'} text={full.abstract} />}
          {!full && (
            <div className="cf-skel">
              <i />
              <i />
              <i style={{ width: '46%' }} />
            </div>
          )}
          <div className="cf-links">
            {full?.abstract && !abstractZh && (
              <button className="cf-link" disabled={translating} onClick={translate}>
                {translating ? <Wave /> : <Icon name="lang" size={12} />}
                中文
              </button>
            )}
            {p.url && (
              <a className="cf-link" onClick={() => api.openExternal(p.url!)}>
                <Icon name="external" size={12} />
                论文页面
              </a>
            )}
            {p.pdf && (
              <a className="cf-link" onClick={() => api.openExternal(p.pdf!)}>
                <Icon name="pdf" size={12} />
                PDF
              </a>
            )}
            {p.arxiv && (
              <a className="cf-link" onClick={() => api.openExternal(`https://arxiv.org/abs/${p.arxiv}`)}>
                <Icon name="external" size={12} />
                arXiv
              </a>
            )}
          </div>
        </div>
      )}
    </article>
  )
})

/** Search results or one direction, across every edition, an edition to a section. */
/**
 * Search results or one direction, across every edition, an edition to a section. A direction Claude is still working
 * on reloads as its papers come in, and shows a skeleton rather than nothing.
 */
function Results(props: Props & { query: PaperQuery; head?: (n: number) => ReactNode; live?: boolean; working?: boolean }) {
  const { query, head, live, working } = props
  const [papers, setPapers] = useState<ListedPaper[]>()
  const key = JSON.stringify(query)
  useEffect(() => {
    let alive = true
    setPapers(undefined)
    const load = () => api.confPapers(query).then((x) => alive && setPapers(x))
    load()
    const off = live ? api.onConfChanged(load) : undefined
    return () => {
      alive = false
      off?.()
    }
  }, [key, live])
  const sections = useMemo(() => {
    const by = new Map<string, Section>()
    for (const p of papers ?? []) {
      let s = by.get(p.edition)
      if (!s) by.set(p.edition, (s = { id: p.edition, name: p.editionName, count: 0, subs: [{ id: p.edition, name: '', papers: [] }] }))
      s.count++
      s.subs[0].papers.push(p)
    }
    return [...by.values()].sort((a, b) => b.id.split('/')[1].localeCompare(a.id.split('/')[1]) || b.count - a.count)
  }, [papers])
  return (
    <>
      {head ? (
        head(papers?.length ?? 0)
      ) : (
        <div className="cf-list-head">
          <span className="n">{papers?.length ?? ''}</span>
        </div>
      )}
      {!papers ? <Skeleton /> : <Stream {...props} sections={sections} defaults={{ kind: 'Poster', track: 'Main' }} empty={working ? <Skeleton /> : query.group ? null : undefined} />}
    </>
  )
}

function Skeleton() {
  return (
    <div className="cf-skel wide">
      <i />
      <i />
      <i style={{ width: '60%' }} />
    </div>
  )
}

/* ---------- one edition ---------- */

function EditionPage(props: Props & { c: ConferenceSummary; year: number; onYear: (year: number) => void; onBack: () => void }) {
  const { c, year, toast } = props
  const ref = `${c.id}/${year}`
  const [view, setView] = useState<EditionView>()
  const [papers, setPapers] = useState<ListedPaper[]>()
  const [kind, setKind] = useState<string>()
  const [track, setTrack] = useState<string>()
  const [follow, setFollow] = useState<string>()
  const [matches, setMatches] = useState<Set<string>>()
  const [place, setPlace] = useState<{ section?: string; sub?: string }>({})
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>()
  const [past, setPast] = useState(false)
  const [records, setRecords] = useState(false)
  const [renaming, setRenaming] = useState<string>()
  const s = useSearch()
  const mainRef = useRef<HTMLElement>(null)
  const sig = useRef('')

  // The whole edition is loaded once and again only when its papers change, not on every status update.
  const load = useCallback(async () => {
    const v = await api.confEdition(c.id, year)
    if (!v) return
    setView(v)
    const next = [v.edition.count, v.edition.assigned, v.edition.themes, v.follows.map((f) => f.count).join(), v.edition.unpublished, v.edition.noCopy].join('/')
    if (next === sig.current) return
    sig.current = next
    setPapers(await api.confPapers({ edition: ref, lean: true }))
  }, [ref])
  useEffect(() => {
    load()
    return api.onConfChanged(load)
  }, [load])
  // A paper imported meanwhile shows as in the library.
  const libraryIds = props.library.map((p) => p.id).join()
  useEffect(() => {
    if (sig.current) api.confPapers({ edition: ref, lean: true }).then(setPapers)
  }, [libraryIds])

  useEffect(() => {
    if (!s.query) return setMatches(undefined)
    let live = true
    api.confPapers({ edition: ref, search: s.query, lean: true }).then((x) => live && setMatches(new Set(x.map((p) => p.key))))
    return () => {
      live = false
    }
  }, [s.query, ref])

  const base = useCallback((p: ListedPaper) => (!matches || matches.has(p.key)) && (!follow || !!p.follows?.includes(follow)), [matches, follow])
  const shown = useMemo(() => (papers ?? []).filter((p) => base(p) && (!kind || p.kind === kind) && (!track || p.track === track)), [papers, base, kind, track])

  const sections = useMemo<Section[]>(() => {
    if (!view) return []
    const byBranch = new Map<string, ListedPaper[]>()
    for (const p of shown) {
      const k = p.branch ?? ''
      if (!byBranch.has(k)) byBranch.set(k, [])
      byBranch.get(k)!.push(p)
    }
    const known = new Set(view.themes.flatMap((t) => t.branches.map((b) => b.id)))
    const list: Section[] = view.themes.map((t) => {
      const subs = t.branches.map((b) => ({ id: b.id, name: b.name, papers: byBranch.get(b.id) ?? [] }))
      return { id: t.id, name: t.name, count: subs.reduce((n, x) => n + x.papers.length, 0), subs }
    })
    const rest = shown.filter((p) => !p.branch || !known.has(p.branch))
    if (rest.length) list.push({ id: '_rest', name: view.themes.length ? '未归类' : '全部论文', count: rest.length, subs: [{ id: '_rest', name: '', papers: rest }] })
    return list
  }, [view, shown])

  const onPlace = useCallback((section?: string, sub?: string) => setPlace({ section, sub }), [])

  if (!view) return <main className="lib-scroll" />
  const e = view.edition
  const scroller = () => mainRef.current
  const defaults = { kind: view.kinds[0]?.name, track: view.tracks[0]?.name }

  const chipCount = (key: 'kind' | 'track', v: string) =>
    (papers ?? []).filter((p) => base(p) && p[key] === v && (key === 'kind' ? !track || p.track === track : !kind || p.kind === kind)).length
  const filtered = (p: ListedPaper) => (!matches || matches.has(p.key)) && (!kind || p.kind === kind) && (!track || p.track === track)

  // Rows off screen are laid out at an estimated height, so land, let them measure, and correct.
  const jump = (sel: string, under: boolean, tries = 4) => {
    const sc = scroller()
    const el = sc?.querySelector<HTMLElement>(sel)
    if (!sc || !el) return
    const bar = under ? (sc.querySelector<HTMLElement>('.cf-th.stuck')?.offsetHeight ?? 50) + 4 : 0
    const delta = el.getBoundingClientRect().top - sc.getBoundingClientRect().top - bar
    if (Math.abs(delta) < 2 || !tries) return
    sc.scrollTop += delta
    window.setTimeout(() => jump(sel, under, tries - 1), 40)
  }
  const toStream = () => {
    const sc = scroller()
    const top = sc?.querySelector<HTMLElement>('.cf-stream-top')?.offsetTop ?? 0
    if (sc && sc.scrollTop > top) sc.scrollTop = top - 20
  }

  const followed = (o: { theme?: string; branch?: string }) => props.overview?.follows.some((f) => f.from?.edition === ref && (o.branch ? f.from.branch === o.branch : f.from.theme === o.theme && !f.from.branch))
  // A theme or branch not followed yet offers to be, on hover.
  const followable = (o: { theme?: string; branch?: string }) => (followed(o) ? undefined : () => api.followFromMap(ref, o).catch((err) => toast(errorText(err))))
  // Claude is still picking this edition's papers for a direction.
  const working = (id: string) => !!props.overview?.followState[id] && !view.followsDone.includes(id)
  const rename = (f: Follow, name?: string) => {
    setRenaming(undefined)
    if (name) api.followUpdate(f.id, { name }).catch((err) => toast(errorText(err)))
  }
  const menuFor = (f: Follow, x: number, y: number) =>
    setMenu({ x, y, items: followMenu(f, { onRename: () => setRenaming(f.id), onGone: () => follow === f.id && setFollow(undefined) }) })

  const follows = props.overview?.follows ?? []
  const freshOf = (id: string) => view.follows.find((f) => f.id === id)?.fresh ?? 0
  const followHead = follows.find((f) => f.id === follow)

  return (
    <>
      <aside className="lib-side cf-side">
        <button className="cf-back" onClick={props.onBack}>
          <Icon name="back" size={14} />
          会议
        </button>
        <div className="cf-side-title">
          <ConfName c={c} year={year} big />
          <span className="spacer" />
          <button
            className="icon-btn"
            onClick={(ev) => {
              const r = ev.currentTarget.getBoundingClientRect()
              setMenu({ x: r.right - 190, y: r.bottom + 4, items: confMenu(c, e, { onPast: () => setPast(true), onRecords: () => setRecords(true), toast, inEdition: true, onDeleted: props.onBack }) })
            }}
          >
            <Icon name="more" size={15} />
          </button>
        </div>
        {(view.years.length > 1 || e.activity || e.error || e.unpublished) && (
          <div className="cf-side-state">
            {view.years.length > 1 && (
              <div className="seg">
                {view.years.map((y) => (
                  <button key={y} className={y === year ? 'on' : ''} onClick={() => props.onYear(y)}>
                    {y}
                  </button>
                ))}
              </div>
            )}
            {e.activity && <Busy a={e.activity} />}
            {e.unpublished && (
              <span className="cf-cap">
                <Icon name="lock" size={12} />
                OpenReview 暂未公开
              </span>
            )}
            {e.error && !e.activity && (
              <button className="cf-cap err" title={e.error} onClick={() => setRecords(true)}>
                <Icon name="x" size={12} />
                出错
              </button>
            )}
          </div>
        )}
        <nav className="cf-nav">
          <NavItem
            label="全部论文"
            n={(papers ?? []).filter(filtered).length}
            on={!follow && !place.section}
            onClick={() => {
              setFollow(undefined)
              scroller()?.scrollTo({ top: 0 })
            }}
          />
          {follows.length > 0 && <div className="cf-nav-label">关注的方向</div>}
          {follows.map((f) => (
            <NavItem
              key={f.id}
              label={f.name}
              editing={renaming === f.id ? <RenameInput value={f.name} onDone={(name) => rename(f, name)} /> : undefined}
              n={(papers ?? []).filter((p) => p.follows?.includes(f.id) && filtered(p)).length}
              hideCount={working(f.id)}
              on={follow === f.id}
              extra={working(f.id) ? <Wave /> : freshOf(f.id) > 0 ? <Fresh n={freshOf(f.id)} sm /> : undefined}
              onClick={() => {
                setFollow(follow === f.id ? undefined : f.id)
                toStream()
              }}
              onContextMenu={(ev) => {
                ev.preventDefault()
                menuFor(f, ev.clientX, ev.clientY)
              }}
            />
          ))}
          {sections.length > 0 && view.themes.length > 0 && <div className="cf-nav-label">主题</div>}
          {!follow &&
            sections.map((t) => (
              <div key={t.id}>
                <NavItem
                  label={t.name}
                  n={t.count}
                  on={place.section === t.id}
                  onClick={() => jump(`.cf-section[data-id="${t.id}"]`, false)}
                  onFollow={t.id === '_rest' ? undefined : followable({ theme: t.id })}
                />
                {place.section === t.id && t.subs.length > 1 && (
                  <div className="cf-nav-sub">
                    {t.subs.map((b) => (
                      <NavItem
                        key={b.id}
                        sub
                        label={b.name}
                        n={b.papers.length}
                        on={place.sub === b.id}
                        onClick={() => jump(`.cf-div[data-id="${b.id}"]`, true)}
                        onFollow={b.id === '_rest' ? undefined : followable({ branch: b.id })}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          {follow &&
            sections.map((t) => (
              <NavItem key={t.id} label={t.name} n={t.count} on={place.section === t.id} onClick={() => jump(`.cf-section[data-id="${t.id}"]`, false)} />
            ))}
        </nav>
      </aside>

      <main className="lib-scroll" ref={mainRef}>
        <div className="lib-inner cf cf-edition">
          <section className="cf-search tight">
            <SearchBar s={s} />
          </section>
          {(view.kinds.length > 1 || view.tracks.length > 1) && (
            <div className="cf-filters">
              {view.kinds.length > 1 &&
                view.kinds.map((x) => <Chip key={x.name} name={x.name} n={chipCount('kind', x.name)} on={kind === x.name} onClick={() => setKind(kind === x.name ? undefined : x.name)} />)}
              {view.kinds.length > 1 && view.tracks.length > 1 && <span className="sep" />}
              {view.tracks.length > 1 &&
                view.tracks.map((x) => <Chip key={x.name} name={x.name} n={chipCount('track', x.name)} on={track === x.name} onClick={() => setTrack(track === x.name ? undefined : x.name)} />)}
            </div>
          )}
          <div className="cf-stream-top" />
          {followHead && (
            <div className="cf-list-head cf-fhead">
              {renaming === followHead.id ? <RenameInput value={followHead.name} onDone={(name) => rename(followHead, name)} /> : <h2>{followHead.name}</h2>}
              <span className="n">{shown.length}</span>
              {working(followHead.id) && <Busy a={props.overview!.followState[followHead.id]} />}
              <span className="spacer" />
              <button
                className="icon-btn"
                onClick={(ev) => {
                  const r = ev.currentTarget.getBoundingClientRect()
                  menuFor(followHead, r.right - 190, r.bottom + 4)
                }}
              >
                <Icon name="more" />
              </button>
            </div>
          )}
          {papers ? (
            <Stream {...props} sections={sections} defaults={defaults} onPlace={onPlace} empty={followHead ? (working(followHead.id) ? <Skeleton /> : null) : undefined} />
          ) : (
            <Skeleton />
          )}
        </div>
      </main>
      {menu && <Menu {...menu} onClose={() => setMenu(undefined)} />}
      {past && <PastYear c={c} onClose={() => setPast(false)} toast={toast} />}
      {records && <Records e={e} onClose={() => setRecords(false)} />}
    </>
  )
}

function NavItem({
  label,
  editing,
  n,
  hideCount,
  on,
  sub,
  extra,
  onClick,
  onContextMenu,
  onFollow
}: {
  label: string
  editing?: ReactNode
  n: number
  hideCount?: boolean
  on: boolean
  sub?: boolean
  extra?: ReactNode
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  onFollow?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Keep the place being read in sight in the nav.
  useEffect(() => {
    if (on) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [on])
  return (
    <div ref={ref} role="button" className={`cf-nav-item ${sub ? 'sub' : ''} ${on ? 'on' : ''} ${n || hideCount ? '' : 'empty'} ${onFollow ? 'followable' : ''}`} onClick={onClick} onContextMenu={onContextMenu}>
      {editing ?? <span>{label}</span>}
      {extra}
      {!hideCount && <i>{n}</i>}
      {onFollow && (
        <button
          className="cf-nav-follow"
          title="关注"
          onClick={(e) => {
            e.stopPropagation()
            onFollow()
          }}
        >
          <Icon name="plus" size={13} />
        </button>
      )}
    </div>
  )
}

function Chip({ name, n, on, onClick }: { name: string; n: number; on: boolean; onClick: () => void }) {
  return (
    <button className={`cf-f ${on ? 'on' : ''}`} disabled={!n && !on} onClick={onClick}>
      {name}
      <i>{n}</i>
    </button>
  )
}

/** Imports a conference paper. One only OpenReview has asks the owner to sign in there first, then carries on. */
async function importPaper(ref: string, toast: Toast): Promise<PaperMeta | undefined> {
  const first = await api.confImport(ref)
  if (!('signIn' in first)) return first
  const signIn = api.openReviewSignIn()
  toast('需要登录 OpenReview', signIn)
  if (!(await signIn)) return undefined
  const again = await api.confImport(ref)
  if ('signIn' in again) throw new Error('登录后 OpenReview 仍然拒绝下载')
  return again
}

/* ---------- 稍后再看 ---------- */

/** A conference paper marked 稍后再看 that isn't in the library yet. */
export function LaterCard({ item, ready, toast }: { item: LaterItem; ready: boolean; toast: Toast }) {
  const [importing, setImporting] = useState(false)
  const doImport = async () => {
    setImporting(true)
    try {
      const meta = await importPaper(item.ref, toast)
      if (ready && meta?.status === 'new') api.processPaper(meta.id)
    } catch (e) {
      toast(errorText(e))
    } finally {
      setImporting(false)
    }
  }
  return (
    <article className="paper card later-card">
      <div className="paper-body">
        <PaperText as="h3" text={item.titleZh || item.title} zh={!!item.titleZh} />
        {item.titleZh && <PaperText as="p" className="paper-en" text={item.title} />}
        <p className="paper-authors muted">
          {item.authors.slice(0, 3).join(', ')}
          {item.authors.length > 3 && <span className="cf-plus">+{item.authors.length - 3}</span>}
        </p>
        {item.abstract && <PaperText as="p" className="later-abstract muted" text={item.abstract} />}
        <div className="paper-foot">
          <VenueTags venue={item.venue} year={item.year} />
          <span className="spacer" />
          {item.pdfNew && !item.unpublished && <span className="pill ok">PDF 已出</span>}
          {item.unpublished && <Closed at={item.unpublished} />}
          <button className="btn sm" disabled={!item.pdf || importing} onClick={doImport}>
            {importing ? <Wave /> : '导入'}
          </button>
          <button className="icon-btn later on" title="移出稍后再看" onClick={() => api.laterRemove(item.ref)}>
            <Icon name="bookmark" />
          </button>
        </div>
      </div>
    </article>
  )
}
