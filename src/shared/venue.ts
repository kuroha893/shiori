import { CCF, type CcfRow } from './ccf'

/*
 * Turns a free-text venue ("NIPS 2017", "Findings of the Association for Computational Linguistics:
 * EMNLP 2024", "Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition")
 * into a tag: a short label, the venue family that colours it, the CCF rank, and Findings/Workshop.
 */

export type Family = 'ml' | 'acl' | 'ai' | 'cv'

export interface VenueTag {
  label: string
  year?: string
  family?: Family
  ccf?: 'A' | 'B' | 'C'
  /** Findings and workshop papers are not ranked by CCF; the track replaces the rank */
  track?: 'Findings' | 'Workshop'
  preprint?: boolean
  /** The venue as written, for the tooltip */
  full: string
}

// Families the owner reads most, in match order: the ACL chapters before ACL itself.
const FAMILIES: { label: string; family: Family; ccf?: string; re: RegExp }[] = [
  { label: 'NeurIPS', family: 'ml', ccf: 'NeurIPS', re: /\bneurips\b|\bnips\b|neural information processing systems/i },
  { label: 'ICML', family: 'ml', ccf: 'ICML', re: /\bicml\b|international conference on machine learning/i },
  { label: 'ICLR', family: 'ml', ccf: 'ICLR', re: /\biclr\b|learning representations/i },
  { label: 'NAACL', family: 'acl', ccf: 'NAACL', re: /\bnaacl\b|north american chapter of the association for computational/i },
  { label: 'EACL', family: 'acl', re: /\beacl\b|european chapter of the association for computational/i },
  { label: 'AACL', family: 'acl', re: /\baacl\b|asia-pacific chapter of the association for computational/i },
  { label: 'EMNLP', family: 'acl', ccf: 'EMNLP', re: /\bemnlp\b|empirical methods in natural language processing/i },
  { label: 'ACL', family: 'acl', ccf: 'ACL', re: /\bacl\b|association for computational linguistics/i },
  { label: 'AAAI', family: 'ai', ccf: 'AAAI', re: /\baaai\b/i },
  { label: 'IJCAI', family: 'ai', ccf: 'IJCAI', re: /\bijcai\b|international joint conference on artificial intelligence/i },
  { label: 'CVPR', family: 'cv', ccf: 'CVPR', re: /\bcvpr\b|computer vision and pattern recognition/i },
  { label: 'ICCV', family: 'cv', ccf: 'ICCV', re: /\biccv\b|international conference on computer vision/i },
  { label: 'ECCV', family: 'cv', ccf: 'ECCV', re: /\beccv\b|european conference on computer vision/i }
]

// Common names that differ from the CCF abbreviation.
const ALIASES: [RegExp, string][] = [
  [/\bkdd\b|knowledge discovery and data mining/i, 'SIGKDD'],
  [/\bacm multimedia\b|\bacm mm\b/i, 'ACM MM'],
  [/\bthe web conference\b|\bwww\b/i, 'WWW'],
  [/\bsigir\b/i, 'SIGIR']
]
const DISPLAY: Record<string, string> = { SIGKDD: 'KDD' }

const byAbbr = new Map<string, CcfRow[]>()
for (const row of CCF) {
  if (!row[0]) continue
  const k = row[0].toUpperCase()
  byAbbr.set(k, [...(byAbbr.get(k) ?? []), row])
}
const named = CCF.filter((r) => r[4].length >= 18).sort((a, b) => b[4].length - a[4].length)

/** Prefer the conference when an abbreviation names both (WWW), unless the text says journal. */
function pick(rows: CcfRow[] | undefined, text: string): CcfRow | undefined {
  if (!rows?.length) return undefined
  const journal = /\b(journal|transactions|letters)\b/i.test(text)
  return rows.find((r) => r[2] === (journal ? 'J' : 'C')) ?? rows[0]
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function findCcf(text: string): CcfRow | undefined {
  for (const [re, abbr] of ALIASES) if (re.test(text)) return pick(byAbbr.get(abbr), text)
  const bare = text.replace(/[^A-Za-z0-9&\- ]/g, ' ').trim()
  // The whole string is an abbreviation ("TPAMI", "JMLR"), or contains one as a word (≥ 4 letters,
  // written in capitals, to avoid matching ordinary words).
  const exact = pick(byAbbr.get(bare.toUpperCase()), text)
  if (exact) return exact
  for (const word of bare.split(/\s+/)) {
    if (word.length >= 4 && word === word.toUpperCase() && /[A-Z]/.test(word)) {
      const hit = pick(byAbbr.get(word), text)
      if (hit) return hit
    }
  }
  const lower = text.toLowerCase()
  return named.find((r) => new RegExp(`\\b${esc(r[4].toLowerCase())}\\b`).test(lower))
}

const rankOf = (abbr: string) => byAbbr.get(abbr.toUpperCase())?.[0]?.[1]

/** Strip years, ordinals and boilerplate to get a short label for venues we don't know. */
function shortLabel(text: string): string {
  return text
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/[-'’ ]\d{2}\s*$/, '')
    .replace(/\b\d+(st|nd|rd|th)\b/gi, '')
    .replace(/^\s*(proceedings of( the)?|advances in)\s+/i, '')
    .replace(/[\s,:;·\-–—()]+$/g, '')
    .replace(/^[\s,:;·\-–—()]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function venueTag(venue?: string, year?: string): VenueTag | undefined {
  const full = (venue ?? '').trim()
  if (!full) return year ? { label: '', year, full: '' } : undefined
  // "NeurIPS 2023", or the short form "IJCAI-23" / "ICML '24"
  const short = full.match(/[-'’ ](\d{2})\s*$/)?.[1]
  const y = year || full.match(/\b(19|20)\d{2}\b/)?.[0] || (short ? `20${short}` : undefined)
  const track = /\bfindings\b/i.test(full) ? 'Findings' : /\bworkshops?\b/i.test(full) ? 'Workshop' : undefined

  const fam = FAMILIES.find((f) => f.re.test(full))
  if (fam) return { label: fam.label, year: y, family: fam.family, ccf: fam.ccf ? rankOf(fam.ccf) : undefined, track, full }

  const row = findCcf(full)
  if (row) return { label: DISPLAY[row[0]] ?? (row[0] || shortLabel(full)), year: y, ccf: row[1], track, full }

  if (/^\s*(arxiv|corr|preprint)\b/i.test(full) || /\barxiv preprint\b/i.test(full)) return { label: 'arXiv', year: y, preprint: true, full }

  return { label: shortLabel(full) || full, year: y, track, full }
}
