import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PaperMeta } from '../../../shared/types'
import { shownVenue, venueSuggestions, venueTag, venueText } from '../../../shared/venue'
import { api } from '../api'

const LOGOS = import.meta.glob<string>('../assets/orgs/*.svg', { query: '?raw', import: 'default', eager: true })
const logoSvg = (name: string) => LOGOS[`../assets/orgs/${name}.svg`]

/*
 * The venue pill and the chip after it. Colour comes from the venue family (ML, ACL, AI, CV);
 * other venues are neutral when CCF-B or better, grey when CCF-C or unranked, dashed for preprints.
 * A technical report is solid and neutral, its organisation's logo before the name.
 * The chip is the CCF rank, or Findings / Workshop, which CCF doesn't rank, or Tech Report.
 */
export function VenueTags({ venue, year }: { venue?: string; year?: string }) {
  const t = venueTag(venue, year)
  if (!t) return null
  if (!t.label) return <span className="vt-year-only faint">{t.year}</span>
  const style = t.report
    ? 'report'
    : t.family
      ? `fam fam-${t.family}`
      : t.preprint
        ? 'preprint'
        : t.ccf === 'A' || t.ccf === 'B'
          ? 'ranked'
          : 'other'
  const chip = t.report ? 'Tech Report' : (t.track ?? (t.ccf ? `CCF ${t.ccf}` : undefined))
  const svg = t.logo && logoSvg(t.logo)
  return (
    <span className="vt" title={t.full}>
      <span className={`vt-tag ${style}`}>
        {svg && <span className={`vt-logo ${t.monoDark ? 'mono-dark' : ''}`} dangerouslySetInnerHTML={{ __html: svg }} />}
        <span className="vt-name">{t.label}</span>
        {t.year && <span className="vt-year">{t.year}</span>}
      </span>
      {chip && <span className={`vt-chip ${t.report ? 'report' : t.track ? 'track' : `ccf-${t.ccf!.toLowerCase()}`}`}>{chip}</span>}
    </span>
  )
}

/**
 * A paper's venue, which the owner can click to set it themselves. What they type applies at once; suggestions
 * are whole venues, so the track can't contradict the venue. Their own venue stays until they restore the found one.
 */
export function PaperVenue({ paper }: { paper: PaperMeta }) {
  const shown = shownVenue(paper)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  return (
    <>
      <span
        ref={anchor}
        className={`vt-edit ${open ? 'active' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <VenueTags venue={shown.venue} year={shown.year} />
      </span>
      {open && <VenueEditor paper={paper} anchor={anchor.current} onClose={() => setOpen(false)} />}
    </>
  )
}

function VenueEditor({ paper, anchor, onClose }: { paper: PaperMeta; anchor: HTMLElement | null; onClose: () => void }) {
  const shown = shownVenue(paper)
  const [venue, setVenue] = useState(() => venueText(shown.venue, shown.year))
  const [year, setYear] = useState(shown.year ?? '')
  const [typing, setTyping] = useState(false)
  const [hi, setHi] = useState(0)
  const [pos, setPos] = useState<React.CSSProperties>()
  const [finding, setFinding] = useState<'busy' | 'none'>()
  const pop = useRef<HTMLDivElement>(null)
  const timer = useRef<number>(undefined)
  const edited = useRef(false)
  const venueRef = useRef(venue)
  const yearRef = useRef(year)
  venueRef.current = venue
  yearRef.current = year

  const list = typing ? venueSuggestions(venue) : []

  const save = (v: string, y: string, now = false) => {
    edited.current = true
    window.clearTimeout(timer.current)
    const write = () => api.updatePaper(paper.id, { venueEdit: { venue: v.trim(), year: y.trim() || undefined } })
    if (now) write()
    else timer.current = window.setTimeout(write, 250)
  }
  const pick = (v: string) => {
    setVenue(v)
    setTyping(false)
    save(v, year, true)
  }

  useLayoutEffect(() => {
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    const below = window.innerHeight - r.bottom > 260
    setPos({ left: Math.min(r.left, window.innerWidth - 336), ...(below ? { top: r.bottom + 8 } : { bottom: window.innerHeight - r.top + 8 }) })
  }, [anchor])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (!pop.current?.contains(t) && !anchor?.contains(t)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key, true)
    }
  }, [anchor, onClose])

  // Whatever is still waiting to be written goes out when the editor closes.
  useEffect(
    () => () => {
      if (timer.current) {
        window.clearTimeout(timer.current)
        if (edited.current) api.updatePaper(paper.id, { venueEdit: { venue: venueRef.current.trim(), year: yearRef.current.trim() || undefined } })
      }
    },
    [paper.id]
  )

  return createPortal(
    <div className="popover vt-pop" style={pos} ref={pop} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <div className="vt-pop-row">
        <input
          className="input vt-pop-venue"
          placeholder="会议"
          value={venue}
          autoFocus
          spellCheck={false}
          onChange={(e) => {
            setVenue(e.target.value)
            setTyping(true)
            setHi(0)
            save(e.target.value, year)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && list.length) {
              e.preventDefault()
              setHi((h) => (h + 1) % list.length)
            } else if (e.key === 'ArrowUp' && list.length) {
              e.preventDefault()
              setHi((h) => (h - 1 + list.length) % list.length)
            } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (list[hi]) pick(list[hi].venue)
              else onClose()
            }
          }}
        />
        <input
          className="input vt-pop-year"
          placeholder="年份"
          value={year}
          inputMode="numeric"
          maxLength={4}
          onChange={(e) => {
            const y = e.target.value.replace(/\D/g, '')
            setYear(y)
            save(venue, y)
          }}
          onKeyDown={(e) => e.key === 'Enter' && onClose()}
        />
      </div>
      {list.length > 0 && (
        <div className="vt-sug">
          {list.map((s, i) => (
            <button key={s.venue} className={i === hi ? 'on' : ''} onMouseEnter={() => setHi(i)} onClick={() => pick(s.venue)}>
              <VenueTags venue={s.venue} />
              {s.hint && <span className="vt-sug-hint">{s.hint}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="vt-pop-foot">
        {!paper.venueEdit && (
          <button
            className="btn ghost sm"
            disabled={finding === 'busy'}
            onClick={async () => {
              setFinding('busy')
              const { changed, meta } = await api.findVenue(paper.id).catch(() => ({ changed: false, meta: undefined }))
              if (changed && meta) {
                setVenue(venueText(meta.venue, meta.year))
                setYear(meta.year ?? '')
              }
              setFinding(changed ? undefined : 'none')
            }}
          >
            {finding === 'busy' ? '正在查找…' : finding === 'none' ? '没有找到更新' : '重新查找'}
          </button>
        )}
        {paper.venueEdit && (
          <button
            className="btn ghost sm"
            onClick={() => {
              window.clearTimeout(timer.current)
              timer.current = undefined
              api.updatePaper(paper.id, { venueEdit: undefined })
              onClose()
            }}
          >
            恢复自动
          </button>
        )}
      </div>
    </div>,
    document.body
  )
}
