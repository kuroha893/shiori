import { net } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { CCF } from '../shared/ccf'
import type { PaperMeta } from '../shared/types'
import { venueTag } from '../shared/venue'
import { modelFor, runAgent } from './ai'
import { listPapers, paperDir, readMeta, updateMeta } from './library'
import { venueSearchPrompt } from './prompts'
import { getSettings } from './settings'

/*
 * Where a paper was published, past what its PDF says. Processing reads the venue from the PDF; a paper that is
 * still only a preprint is then looked up on Semantic Scholar, and if that knows nothing the guide run searches
 * the web for it. Papers are often accepted months after they appear on arXiv, so preprints are looked up again,
 * on Semantic Scholar and on the web at once: weekly for their first half year, fortnightly until a year and a
 * half, then no more. The owner can also ask for one paper at any time. Nothing here touches a venue the owner set.
 */

const S2 = process.env.SEMANTIC_SCHOLAR_URL ?? 'https://api.semanticscholar.org/graph/v1'
const FIELDS = 'title,venue,year,publicationVenue,externalIds'
const DAY = 24 * 3600_000

type Notify = (meta: PaperMeta) => void
let notify: Notify = () => {}

type Found = { venue: string; year?: string }

/** A venue that says only that the paper is a preprint, or nothing. */
export const isPreprint = (venue?: string) => {
  const t = venueTag(venue)
  return !t?.label || !!t.preprint
}

/** Still waiting for a venue, and the owner hasn't set one. A technical report is where it belongs. */
export const awaitingVenue = (m: PaperMeta) => !m.venueEdit && isPreprint(m.venue)

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Unavailable extends Error {}

/** Without a key everyone shares one rate limit, so being turned away is ordinary: wait a little and ask again. */
async function ask(path: string): Promise<any> {
  for (const pause of [2_000, 5_000, 10_000, 0]) {
    let res: Response | undefined
    try {
      res = await net.fetch(`${S2}${path}`, { signal: AbortSignal.timeout(15_000) })
    } catch {
      /* offline or timed out; same as busy */
    }
    if (res && res.status !== 429 && res.status < 500) return res.ok ? res.json() : undefined
    if (pause) await wait(pause)
  }
  throw new Unavailable()
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const dblpName = new Map(CCF.filter((r) => r[3]).map((r) => [r[3].toLowerCase(), r[0] || r[4]]))

/**
 * Where Semantic Scholar says a paper was published, if anywhere but a preprint server. Its DBLP key, such as
 * conf/iclr/HuSWALWWC22, gives the venue's year, which its own year field doesn't: that is when the paper first
 * appeared.
 */
async function semanticScholar(m: PaperMeta): Promise<Found | undefined> {
  let p = m.arxiv ? await ask(`/paper/arXiv:${encodeURIComponent(m.arxiv)}?fields=${FIELDS}`) : undefined
  if (!p && m.title) {
    p = (await ask(`/paper/search/match?query=${encodeURIComponent(m.title)}&fields=${FIELDS}`))?.data?.[0]
    // A title match that isn't this paper is worse than none.
    if (p && norm(p.title ?? '') !== norm(m.title)) p = undefined
  }
  if (!p) return undefined
  const name: string = p.publicationVenue?.name || p.venue || ''
  const named = name && !/arxiv|corr|biorxiv|ssrn/i.test(name) ? name : ''
  const year = p.year ? String(p.year) : undefined
  const dblp: string | undefined = p.externalIds?.DBLP
  const [, key, yy] = dblp?.match(/^(?:conf|journals)\/([^/]+)\/.*?(\d{2})$/) ?? []
  if (key && key !== 'corr') return { venue: named || dblpName.get(key) || key.toUpperCase(), year: yy ? String(+yy > 50 ? 1900 + +yy : 2000 + +yy) : year }
  const type = p.publicationVenue?.type
  if (named && (type === 'conference' || type === 'journal')) return { venue: named, year }
  return undefined
}

/** A venue the web search or the guide run wrote to a file; only one with a source counts. */
function readFound(file: string): Found | undefined {
  if (!existsSync(file)) return undefined
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    const venue = String(v.venue ?? '').trim()
    if (venue && v.source && !isPreprint(venue)) return { venue, year: v.year ? String(v.year) : undefined }
  } catch {
    /* a guess we can't read is no loss */
  } finally {
    rmSync(file, { force: true })
  }
  return undefined
}

/** Claude searching the web for the paper, with the model that processes papers. Throws when it couldn't run. */
async function searchWeb(m: PaperMeta): Promise<Found | undefined> {
  if (!m.title) throw new Unavailable()
  const model = await modelFor(getSettings().processModel, 'process')
  const file = join(paperDir(m.id), 'venue-search.json')
  rmSync(file, { force: true })
  const r = await runAgent({
    cwd: paperDir(m.id),
    prompt: venueSearchPrompt({ title: m.title, authors: m.authors, arxiv: m.arxiv, year: m.year }, { file: 'venue-search.json' }),
    model,
    effort: 'medium',
    write: true,
    search: true
  })
  if (r.isError) {
    rmSync(file, { force: true })
    throw new Unavailable()
  }
  return readFound(file)
}

/**
 * Record what was found, unless the owner has set the venue meanwhile; `force` also replaces a venue that isn't a
 * preprint. `asked` is whether any source answered at all; only then does the next look wait its turn.
 */
function apply(id: string, found: Found | undefined, force: boolean, asked = true): PaperMeta | undefined {
  const now = readMeta(id)
  if (!now) return undefined
  const patch: Partial<PaperMeta> = asked ? { venueCheckedAt: new Date().toISOString() } : {}
  if (found && !now.venueEdit && (force || isPreprint(now.venue))) Object.assign(patch, found)
  const meta = updateMeta(id, patch)
  if (meta) notify(meta)
  return meta
}

/** Look a preprint up on Semantic Scholar once, right after processing. False when it couldn't be asked. */
export async function checkVenue(id: string): Promise<boolean> {
  const m = readMeta(id)
  if (!m || !awaitingVenue(m)) return true
  try {
    apply(id, await semanticScholar(m), false)
    return true
  } catch {
    return false
  }
}

/** What the guide run found on the web, in <paper>/venue.json. */
export function applyFoundVenue(id: string, file: string): void {
  const found = readFound(file)
  if (found) apply(id, found, false)
}

const finding = new Set<string>()

/**
 * Semantic Scholar and a web search at once; Semantic Scholar's answer wins when both have one. `force` is the
 * owner asking: it runs for any paper and may correct a venue that isn't a preprint. Resolves with whether the
 * venue changed.
 */
export async function findVenue(id: string, force = false): Promise<boolean> {
  const m = readMeta(id)
  if (!m || finding.has(id) || (!force && !awaitingVenue(m))) return false
  finding.add(id)
  try {
    const [s2, web] = await Promise.allSettled([semanticScholar(m), searchWeb(m)])
    const found = (s2.status === 'fulfilled' && s2.value) || (web.status === 'fulfilled' && web.value) || undefined
    const before = readMeta(id)?.venue
    return apply(id, found, force, s2.status === 'fulfilled' || web.status === 'fulfilled')?.venue !== before
  } finally {
    finding.delete(id)
  }
}

/** When a paper first appeared: the month in its arXiv number (2106.09685 is June 2021), else when it was added. */
function postedAt(m: PaperMeta): number {
  const [, yy, mm] = m.arxiv?.match(/^(\d{2})(\d{2})\./) ?? []
  return yy ? Date.UTC(2000 + +yy, +mm - 1) : Date.parse(m.addedAt)
}

/** Weekly in a preprint's first half year, fortnightly until a year and a half, then never. */
function due(m: PaperMeta, now: number): boolean {
  if (!awaitingVenue(m) || m.status !== 'ready') return false
  const age = now - postedAt(m)
  const every = age < 183 * DAY ? 7 * DAY : age < 548 * DAY ? 14 * DAY : 0
  return !!every && (!m.venueCheckedAt || now - Date.parse(m.venueCheckedAt) >= every)
}

let checking = false

async function round(): Promise<void> {
  if (checking) return
  checking = true
  try {
    for (const m of listPapers()) {
      if (!due(m, Date.now())) continue
      await findVenue(m.id)
      await wait(3000)
    }
  } finally {
    checking = false
  }
}

export function initVenues(onChange: Notify): void {
  notify = onChange
  setTimeout(round, 60_000)
  setInterval(round, 6 * 3600_000)
}
