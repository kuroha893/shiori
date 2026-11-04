import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PaperMeta } from '../../../shared/types'
import { shownVenue, venueSuggestions, venueTag, venueText } from '../../../shared/venue'
import { api } from '../api'
import { Icon } from './Icon'

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
 * A paper's venue, which the owner can click to set it themselves. Suggestions are whole venues, so the track can't
 * contradict the venue. What they type is a draft the tag previews; it is kept only when they save, and cancelling
 * (the button, Esc, or a click elsewhere) leaves everything as it was. Their own venue stays until they restore the
 * found one.
 */
export function PaperVenue({ paper }: { paper: PaperMeta }) {
  const shown = shownVenue(paper)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<{ venue: string; year: string }>()
  const anchor = useRef<HTMLSpanElement>(null)
  const close = () => {
    setOpen(false)
    setDraft(undefined)
  }
  return (
    <>
      <span
        ref={anchor}
        className={`vt-edit ${open ? 'active' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          if (open) close()
          else setOpen(true)
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <VenueTags venue={draft ? draft.venue : shown.venue} year={draft ? draft.year : shown.year} />
      </span>
      {open && <VenueEditor paper={paper} anchor={anchor.current} onDraft={setDraft} onClose={close} />}
    </>
  )
}

function VenueEditor({
  paper,
  anchor,
  onDraft,
  onClose
}: {
  paper: PaperMeta
  anchor: HTMLElement | null
  onDraft: (d: { venue: string; year: string } | undefined) => void
  onClose: () => void
}) {
  const shown = shownVenue(paper)
  // What the fields held when the editor opened, or after a fresh look found something.
  const [base, setBase] = useState(() => ({ venue: venueText(shown.venue, shown.year), year: shown.year ?? '' }))
  const [venue, setVenue] = useState(base.venue)
  const [year, setYear] = useState(base.year)
  // What the owner typed, which the suggestions follow; picking one fills the field but keeps the list as it was.
  const [query, setQuery] = useState<string>()
  const [hi, setHi] = useState(0)
  const [pos, setPos] = useState<React.CSSProperties>()
  const [finding, setFinding] = useState<'busy' | 'none'>()
  const pop = useRef<HTMLDivElement>(null)
  const sug = useRef<HTMLDivElement>(null)

  const dirty = venue.trim() !== base.venue || year !== base.year
  const list = query === undefined ? [] : venueSuggestions(query)

  const edit = (v: string, y: string) => {
    setVenue(v)
    setYear(y)
    onDraft(v.trim() === base.venue && y === base.year ? undefined : { venue: v, year: y })
  }
  // The list stays after a pick, with the pick ticked, so another is one click away.
  const pick = (v: string, i: number) => {
    edit(v, year)
    setHi(i)
  }
  const save = () => {
    const v = venue.trim()
    // Setting what was found anyway isn't an edit of the owner's own.
    const same = v === venueText(paper.venue, paper.year) && year === (paper.year ?? '')
    api.updatePaper(paper.id, { venueEdit: same || !v ? undefined : { venue: v, year: year || undefined } })
    onClose()
  }

  useLayoutEffect(() => {
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    // Room for the editor with its suggestions open (they scroll past three); otherwise it opens upwards.
    const below = window.innerHeight - r.bottom > 260
    setPos({ left: Math.min(r.left, window.innerWidth - 336), ...(below ? { top: r.bottom + 8 } : { bottom: window.innerHeight - r.top + 8 }) })
  }, [anchor])

  // Keyboard moves keep the highlighted suggestion in view.
  useEffect(() => {
    ;(sug.current?.children[hi] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
  }, [hi])

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
            edit(e.target.value, year)
            setQuery(e.target.value)
            setHi(0)
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
              const chosen = list.findIndex((s) => s.venue.toLowerCase() === venue.trim().toLowerCase())
              if (list[hi] && hi !== chosen) pick(list[hi].venue, hi)
              else if (dirty) save()
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
          onChange={(e) => edit(venue, e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && (dirty ? save() : onClose())}
        />
      </div>
      {list.length > 0 && (
        <div className="vt-sug" ref={sug}>
          {list.map((s, i) => (
            <button key={s.venue} className={i === hi ? 'on' : ''} onMouseEnter={() => setHi(i)} onClick={() => pick(s.venue, i)}>
              <VenueTags venue={s.venue} />
              {s.hint && <span className="vt-sug-hint">{s.hint}</span>}
              {s.venue.toLowerCase() === venue.trim().toLowerCase() && <Icon name="check" size={14} className="vt-sug-check" />}
            </button>
          ))}
        </div>
      )}
      <div className={`vt-pop-foot ${dirty ? 'draft' : ''}`}>
        {dirty ? (
          <>
            <button className="btn sm" onClick={onClose}>
              取消
            </button>
            <button className="btn primary sm" onClick={save}>
              保存
            </button>
          </>
        ) : paper.venueEdit ? (
          <button
            className="btn ghost sm"
            onClick={() => {
              api.updatePaper(paper.id, { venueEdit: undefined })
              onClose()
            }}
          >
            恢复自动
          </button>
        ) : (
          <button
            className="btn ghost sm"
            disabled={finding === 'busy'}
            onClick={async () => {
              setFinding('busy')
              const { changed, meta } = await api.findVenue(paper.id).catch(() => ({ changed: false, meta: undefined }))
              if (changed && meta) {
                const found = { venue: venueText(meta.venue, meta.year), year: meta.year ?? '' }
                setBase(found)
                setVenue(found.venue)
                setYear(found.year)
              }
              setFinding(changed ? undefined : 'none')
            }}
          >
            {finding === 'busy' ? '正在查找…' : finding === 'none' ? '没有找到更新' : '重新查找'}
          </button>
        )}
      </div>
    </div>,
    document.body
  )
}
