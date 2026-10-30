import { venueTag } from '../../../shared/venue'

/*
 * The venue pill and the chip after it. Colour comes from the venue family (ML, ACL, AI, CV);
 * other venues are neutral when CCF-B or better, grey when CCF-C or unranked, dashed for preprints.
 * The chip is the CCF rank, or Findings / Workshop, which CCF doesn't rank.
 */
export function VenueTags({ venue, year }: { venue?: string; year?: string }) {
  const t = venueTag(venue, year)
  if (!t) return null
  if (!t.label) return <span className="vt-year-only faint">{t.year}</span>
  const style = t.family ? `fam fam-${t.family}` : t.preprint ? 'preprint' : t.ccf === 'A' || t.ccf === 'B' ? 'ranked' : 'other'
  const chip = t.track ?? (t.ccf ? `CCF ${t.ccf}` : undefined)
  return (
    <span className="vt" title={t.full}>
      <span className={`vt-tag ${style}`}>
        <span className="vt-name">{t.label}</span>
        {t.year && <span className="vt-year">{t.year}</span>}
      </span>
      {chip && <span className={`vt-chip ${t.track ? 'track' : `ccf-${t.ccf!.toLowerCase()}`}`}>{chip}</span>}
    </span>
  )
}
