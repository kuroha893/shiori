/*
 * Conference papers: the latest edition of each followed conference, fetched by small scripts Claude writes and
 * looked after by Claude, grouped by the owner's own directions and by a map of the edition's themes.
 * Everything lives in <library>/conferences.
 */

import { plainText } from './tex'

export interface Conference {
  /** Lower-case short name, also its folder: "neurips", "emnlp" */
  id: string
  /** As the field writes it: "NeurIPS" */
  name: string
  fullName?: string
  /** Stopped conferences keep their data but are no longer fetched */
  tracking: boolean
  addedAt: string
  /** When Claude first found its editions; until then it is being set up */
  setupAt?: string
  setupError?: string
  /** Its graphic mark as downloaded into its folder, for conferences Shiori has none for */
  mark?: string
}

/** A place an edition's papers are listed: a script Shiori runs, or papers Claude wrote down once. */
export interface Channel {
  id: string
  name: string
  url?: string
  kind: 'script' | 'data'
  /** What it gives beyond titles */
  provides?: ('authors' | 'abstract' | 'pdf' | 'kind' | 'track')[]
  note?: string
  addedAt: string
  ranAt?: string
  /** Papers in its last good run */
  count?: number
  error?: string
  /** Runs in a row that failed or found nothing after finding something before */
  failures?: number
}

export type Phase = 'waiting' | 'hot' | 'settling' | 'complete'

export interface Edition {
  conf: string
  year: number
  /** "NeurIPS 2026" */
  name: string
  /** Whether decisions are out, and when they came (or are expected) */
  released?: boolean
  releaseDate?: string
  releaseSource?: string
  /** How many papers the conference says it accepted, when it says */
  officialCount?: number
  /** Added by hand for a past year */
  past?: boolean
  /** Every paper has its abstract and PDF, or long enough has passed: nothing is fetched any more */
  complete?: boolean
  channels: Channel[]
  createdAt: string
  checkedDateAt?: string
  discoveredAt?: string
  fetchedAt?: string
  patrolledAt?: string
  themesAt?: string
  /** Papers when the theme map was made */
  themesFor?: number
  /** Directions already looked for in this edition */
  followsDone?: string[]
  /** When the owner last opened it; newer papers in their directions count as new */
  seenAt?: string
  /** Pairs of papers that may be one paper listed twice, for Claude to decide */
  ambiguous?: [string, string][]
  /** Pairs Claude said are different papers */
  distinct?: [string, string][]
  /** The last few things that happened, newest last */
  log?: { at: string; text: string }[]
  error?: string
  /** The version of the TeX rules its stored text was last read with */
  tidied?: number
  /** The version of the link rules its papers' PDF links were last merged with */
  links?: number
  /** The version of the duplicate rules its papers were last looked through with */
  pairs?: number
  /** Whether OpenReview lets a signed-in reader see its papers yet, and when Shiori last asked */
  openReview?: { public: boolean; at: string }
}

export interface ConfPaper {
  /** From the normalised title */
  key: string
  title: string
  titleZh?: string
  authors: string[]
  abstract?: string
  abstractZh?: string
  /** As the conference names them: "Main", "Findings", "Datasets & Benchmarks"; "Oral", "Spotlight", "Poster" */
  track?: string
  kind?: string
  area?: string
  url?: string
  pdf?: string
  /** Other PDF links other channels gave (the proceedings, PMLR) */
  pdfs?: string[]
  /** When a look last found no copy to download: OpenReview keeps it hidden and arXiv doesn't have it */
  noCopy?: string
  arxiv?: string
  /** Channels that list it */
  sources: string[]
  firstSeen: string
  pdfSeen?: string
  /** Theme-map branch, and the owner's directions it belongs to */
  branch?: string
  follows?: string[]
  /** When sorting first put it in one of the owner's directions; later than that counts as new to them */
  followedAt?: string
  /** What Claude found the authors' own macros and broken formulas stand for (null: not found), applied to all its text */
  fixes?: Record<string, string | null>
  /** What no rule could read in its title and abstract (\ours, $\tilde$) and Claude hasn't been asked about */
  leftovers?: string[]
  /** When Claude read the paper itself for the macros its abstract and the web left unexplained; nothing is asked after that */
  readFull?: string
  /** When Shiori last tried to get the paper for that and couldn't */
  fullTried?: string
}

export interface ThemeBranch {
  id: string
  name: string
  note: string
  keywords: string[]
}

export interface Theme {
  id: string
  name: string
  note: string
  branches: ThemeBranch[]
}

/** A direction the owner follows, across editions. */
export interface Follow {
  id: string
  name: string
  note?: string
  /** English keywords, for finding candidates before Claude decides */
  keywords: string[]
  addedAt: string
  /** Made from a theme-map branch or theme, whose papers it starts with */
  from?: { edition: string; branch?: string; theme?: string }
  /** Claude is still writing its keywords */
  pending?: boolean
}

/** 稍后再看 for a conference paper not in the library; a library paper keeps it as laterAt instead. */
export interface LaterItem {
  /** "<conf>/<year>/<key>" */
  ref: string
  title: string
  titleZh?: string
  authors: string[]
  venue: string
  year: string
  abstract?: string
  url?: string
  pdf?: string
  addedAt: string
  /** The PDF appeared after it was marked and the owner hasn't seen it yet */
  pdfNew?: boolean
  /** No copy to download anywhere for now: when one was last looked for */
  unpublished?: string
}

/* ---------- what the renderer gets ---------- */

export interface EditionSummary {
  conf: string
  year: number
  name: string
  phase: Phase
  archived: boolean
  past?: boolean
  releaseDate?: string
  released?: boolean
  count: number
  officialCount?: number
  withAbstract: number
  withPdf: number
  channels: Channel[]
  /** What Shiori or Claude is doing for it right now */
  activity?: Activity
  error?: string
  log: { at: string; text: string }[]
  /** Papers in the owner's directions since they last looked */
  fresh: number
  themes: boolean
  assigned: number
  /** OpenReview doesn't show its papers yet */
  unpublished?: boolean
  /** Papers with no copy to download anywhere for now */
  noCopy: number
}

/** A job in progress: a short name for it, and how far it got when that is known (0 to 1) */
export interface Activity {
  label: string
  progress?: number
}

export interface ConferenceSummary extends Conference {
  editions: EditionSummary[]
  activity?: Activity
}

export interface ConfOverview {
  conferences: ConferenceSummary[]
  follows: Follow[]
  /** New papers in the owner's directions, over editions still current */
  fresh: number
  /** The same, per direction */
  followFresh: Record<string, number>
  /** Directions Claude is still working on: writing keywords, or picking papers edition by edition */
  followState: Record<string, Activity>
  /** The feature starts working only once the owner has opened it */
  started: boolean
}

export interface GroupCount {
  id: string
  count: number
  fresh: number
}

export interface EditionView {
  edition: EditionSummary
  themes: Theme[]
  branchCounts: Record<string, number>
  follows: GroupCount[]
  tracks: { name: string; count: number }[]
  kinds: { name: string; count: number }[]
  /** Directions whose papers in this edition have been picked */
  followsDone: string[]
  /** Other editions of the same conference, newest first */
  years: number[]
}

export type PaperGroup =
  | { type: 'all' }
  | { type: 'branch'; id: string }
  | { type: 'theme'; id: string }
  | { type: 'follow'; id: string }

export interface PaperQuery {
  /** "<conf>/<year>"; none searches every edition */
  edition?: string
  group?: PaperGroup
  /** Alternatives separated by |, each a set of words that must all appear */
  search?: string
  track?: string
  kind?: string
  /** Leave out abstracts, for lists of a whole edition */
  lean?: boolean
}

export interface ListedPaper extends ConfPaper {
  edition: string
  editionName: string
  /** The library paper it was imported as, or that has the same title */
  inLibrary?: string
  later: boolean
  fresh: boolean
  /** No copy to download anywhere for now: when one was last looked for */
  unpublished?: string
}

/* ---------- helpers ---------- */

export const editionRef = (conf: string, year: number) => `${conf}/${year}`

/** Titles compared without case, punctuation or spacing. */
export const normTitle = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '')

const words = (s: string) => s.toLowerCase().match(/[a-z0-9][a-z0-9\-+.]*/g) ?? []

/** The search: any alternative whose words all appear; a title hit ranks above an abstract hit. 0 = no match. */
export function searchScore(query: string, p: { title: string; abstract?: string; titleZh?: string }): number {
  const title = plainText(p.title).toLowerCase()
  const zh = p.titleZh ?? ''
  const abstract = plainText(p.abstract ?? '').toLowerCase()
  let best = 0
  for (const alt of query.split('|')) {
    const raw = alt.trim()
    if (!raw) continue
    const ws = words(raw)
    const cjk = raw.match(/[㐀-鿿]+/g) ?? []
    if (!ws.length && !cjk.length) continue
    let score = 0
    let ok = true
    for (const w of ws) {
      // Whole words, so "rl" doesn't match "world"; a plural or -ing still counts.
      const re = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      if (re.test(title)) score += 3
      else if (re.test(abstract)) score += 1
      else {
        ok = false
        break
      }
    }
    for (const c of cjk) {
      if (zh.includes(c)) score += 3
      else ok = false
    }
    if (!ok) continue
    if (ws.length > 1 && title.includes(ws.join(' '))) score += 2
    best = Math.max(best, score)
  }
  return best
}

export const hasCjk = (s: string) => /[㐀-鿿]/.test(s)
