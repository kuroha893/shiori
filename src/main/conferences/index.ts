import { ipcMain, net, shell } from 'electron'
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PaperMeta } from '../../shared/types'
import type {
  Activity,
  ConfOverview,
  ConfPaper,
  Conference,
  Edition,
  EditionSummary,
  EditionView,
  Follow,
  LaterItem,
  ListedPaper,
  PaperQuery,
  Phase
} from '../../shared/conferences'
import { editionRef, normTitle, searchScore } from '../../shared/conferences'
import { TIDY_VERSION, applyFixes, tidyTex } from '../../shared/tex'
import { importDownloaded, listPapers as libraryPapers, readMeta, updateMeta } from '../library'
import { loadFolders } from '../folders'
import { callEvent } from '../call'
import { prepare } from '../jobs'
import * as S from './store'
import { LINKS_VERSION, findAmbiguous, leftoversOf, mergeChannel, mergeSame, runChannel, scriptFile } from './scripts'
import * as T from './tasks'
import { findArxiv } from './arxiv'
import * as OR from '../openreview'

/*
 * Keeps every followed conference up to date. Whatever is due runs in two lanes, one for fetch scripts and one for
 * Claude, each a job at a time; after each job the plan is made again, so one step leads to the next: set up →
 * find the decision date → find channels → fetch → theme map → sort papers → mark the owner's directions.
 *
 * Phases, from the decision date: waiting (Claude checks the date weekly), two hot weeks (scripts and a Claude
 * patrol daily), settling (scripts weekly, Claude only for broken scripts), complete (every paper has its abstract
 * and PDF, or five months have passed): nothing more. Only while Shiori is open; a missed day is caught up on.
 */

const DAY = 24 * 3600_000
const HOT_DAYS = 14

type Send = (channel: string, payload?: unknown) => void
let send: Send = () => {}
let paperChanged: (meta: PaperMeta) => void = () => {}

/* ---------- lanes ---------- */

const activity = new Map<string, Activity>()
/** Jobs that failed, and when; a failed job waits six hours before it is tried again. */
const failedAt = new Map<string, number>()

class Lane {
  private queue: { key: string; run: () => Promise<void> }[] = []
  running?: string
  has = (key: string) => this.running === key || this.queue.some((j) => j.key === key)
  add(key: string, run: () => Promise<void>): void {
    if (this.has(key)) return
    const failed = failedAt.get(key)
    if (failed && Date.now() - failed < 6 * 3600_000) return
    this.queue.push({ key, run })
    void this.pump()
  }
  drop(prefix: string): void {
    this.queue = this.queue.filter((j) => !j.key.includes(prefix))
  }
  private async pump(): Promise<void> {
    if (this.running || !this.queue.length) return
    const job = this.queue.shift()!
    this.running = job.key
    try {
      await job.run()
      failedAt.delete(job.key)
    } catch (e) {
      failedAt.set(job.key, Date.now())
      console.error('[conferences]', job.key, e)
    } finally {
      this.running = undefined
      changed()
      setTimeout(plan, 500)
      void this.pump()
    }
  }
}

const ai = new Lane()
const fetcher = new Lane()
/** Asking OpenReview and arXiv where a paper can be downloaded, slowly, so fetches don't wait on it */
const looker = new Lane()

let changedTimer: NodeJS.Timeout | undefined
/** The renderer reloads what it shows; at most once a second. */
function changed(): void {
  if (changedTimer) return
  changedTimer = setTimeout(() => {
    changedTimer = undefined
    send('conf:changed')
  }, 1000)
}

function busy(key: string, a: Activity | undefined): void {
  if (a) activity.set(key, a)
  else activity.delete(key)
  changed()
}

/** Runs a job with its activity shown, recording a failure on the edition. */
async function step(e: Edition, label: string, run: () => Promise<void>): Promise<void> {
  const ref = editionRef(e.conf, e.year)
  busy(ref, { label })
  try {
    await run()
    S.updateEdition(e.conf, e.year, { error: undefined })
  } catch (err) {
    const msg = String((err as Error)?.message || err)
    if (T.stillThere(e)) {
      S.updateEdition(e.conf, e.year, { error: msg.slice(0, 300) })
      S.logEdition(e.conf, e.year, `出错：${msg.slice(0, 120)}`)
    }
    throw err
  } finally {
    busy(ref, undefined)
  }
}

/* ---------- phases ---------- */

export function phase(e: Edition, now = Date.now()): Phase {
  if (e.complete) return 'complete'
  if (!e.released) return 'waiting'
  if (e.past) return 'settling'
  const since = now - Date.parse(e.releaseDate ?? e.createdAt)
  return since < HOT_DAYS * DAY ? 'hot' : 'settling'
}

const ago = (iso: string | undefined, now: number) => (iso ? now - Date.parse(iso) : Infinity)

/** An older edition is an archive once a newer one of the same conference has papers. */
function isArchived(e: Edition, editions: Edition[]): boolean {
  return editions.some((x) => x.year > e.year && S.loadPapers(x.conf, x.year).length > 0)
}

function conference(id: string): Conference | undefined {
  return S.loadConferences()?.find((c) => c.id === id)
}

/* ---------- the plan ---------- */

const stale = (e: Edition) => (e.tidied ?? 0) < TIDY_VERSION

/** Editions whose stored text predates the current TeX rules are read again first, followed or not. */
function tidyStale(): void {
  for (const c of S.loadConferences() ?? []) for (const e of S.listEditions(c.id)) if (stale(e)) fetcher.add(`tidy:${editionRef(e.conf, e.year)}`, () => retidy(e.conf, e.year))
}

export function plan(): void {
  const confs = S.loadConferences()
  if (!confs) return
  const now = Date.now()
  tidyStale()
  for (const c of confs) {
    // A script edited since the last fetch runs again, whatever the phase and even when the conference is no longer
    // followed: someone changed it on purpose.
    // So does every edition last fetched before merging kept all of a paper's PDF links.
    for (const e of S.listEditions(c.id))
      if (!stale(e) && e.fetchedAt && e.channels.length && ((e.links ?? 0) < LINKS_VERSION || e.channels.some((ch) => editedSince(scriptFile(e, ch), e.fetchedAt!))))
        fetcher.add(`fetch:${editionRef(e.conf, e.year)}`, () => fetchEdition(e.conf, e.year))
    // Where papers only OpenReview has stand: asked daily until OpenReview shows them, with the owner signed in.
    if (OR.isSignedIn())
      for (const e of S.listEditions(c.id)) {
        if (!e.fetchedAt || e.openReview?.public) continue
        if (ago(e.openReview?.at, now) >= DAY && S.loadPapers(e.conf, e.year).some(gatedOnly))
          looker.add(`openreview:${editionRef(e.conf, e.year)}`, () => checkOpenReview(e.conf, e.year))
        else if (e.openReview && copiesDue(e).length) looker.add(`copies:${editionRef(e.conf, e.year)}`, () => lookForCopies(e.conf, e.year))
      }
    if (!c.tracking) continue
    if (!c.setupAt) {
      ai.add(`setup:${c.id}`, () => setup(c.id))
      continue
    }
    let editions = S.listEditions(c.id)
    // The next edition is looked for once the latest has settled.
    const newest = editions[0]
    if (newest && newest.released && !newest.past && phase(newest, now) !== 'hot' && !editions.some((x) => x.year > newest.year)) {
      S.createEdition(c.id, c.name, newest.year + 1)
      editions = S.listEditions(c.id)
    }
    for (const e of editions) if (!stale(e)) planEdition(c, e, editions, now)
  }
  // Directions still waiting for their keywords.
  for (const f of S.loadFollows()) if (f.pending) ai.add(`describe:${f.id}`, () => describe(f.id))
}

function planEdition(c: Conference, e: Edition, editions: Edition[], now: number): void {
  const ref = editionRef(e.conf, e.year)
  const ph = phase(e, now)
  const archived = isArchived(e, editions)
  const count = S.loadPapers(e.conf, e.year).length

  if (!archived && ph === 'waiting') {
    const expected = e.releaseDate && Date.parse(e.releaseDate) <= now + DAY
    if (ago(e.checkedDateAt, now) >= (expected ? DAY : 7 * DAY)) ai.add(`date:${ref}`, () => checkDate(e.conf, e.year))
    return
  }
  if (!e.released) return

  if (!archived && ph !== 'complete') {
    // No channels yet: look again daily while hot, weekly after.
    if (!e.discoveredAt || (!e.channels.length && ago(e.discoveredAt, now) >= (ph === 'hot' ? DAY : 7 * DAY)))
      ai.add(`discover:${ref}`, () => discover(e.conf, e.year))
    else if (e.channels.length && ago(e.fetchedAt, now) >= (ph === 'hot' ? 20 * 3600_000 : 7 * DAY))
      fetcher.add(`fetch:${ref}`, () => fetchEdition(e.conf, e.year))
    else if (e.fetchedAt && ph === 'hot' && ago(e.patrolledAt, now) >= 20 * 3600_000) ai.add(`patrol:${ref}`, () => patrolEdition(e.conf, e.year, true))
    else if (e.fetchedAt && (e.channels.some((ch) => ch.error) || e.ambiguous?.length) && ago(e.patrolledAt, now) >= DAY)
      ai.add(`patrol:${ref}`, () => patrolEdition(e.conf, e.year, false))
  }

  if (count >= 30 && (!e.themesAt || (ph === 'hot' && e.themesFor && count >= e.themesFor * 2))) {
    ai.add(`themes:${ref}`, () => themes(e.conf, e.year))
    return
  }
  if (e.themesAt && S.loadPapers(e.conf, e.year).some((p) => !p.branch)) ai.add(`assign:${ref}`, () => assign(e.conf, e.year))
  if (count && e.themesAt) {
    for (const f of S.loadFollows()) if (!f.pending && !e.followsDone?.includes(f.id)) ai.add(`follow:${ref}:${f.id}`, () => tagFollow(e.conf, e.year, f.id))
  }
  if (S.loadPapers(e.conf, e.year).some((p) => p.leftovers?.length)) ai.add(`lookup:${ref}`, () => lookUp(e.conf, e.year))
}

function editedSince(file: string, since: string): boolean {
  try {
    return statSync(file).mtimeMs > Date.parse(since)
  } catch {
    return false
  }
}

/* ---------- jobs ---------- */

async function setup(id: string): Promise<void> {
  const c = conference(id)
  if (!c) return
  busy(id, { label: '查找会议' })
  try {
    const r = await T.setupConference(c)
    const list = S.loadConferences() ?? []
    // The name Claude found may be the usual spelling of what was typed.
    S.saveConferences(list.map((x) => (x.id === id ? { ...x, name: r.name || x.name, fullName: r.fullName, setupAt: new Date().toISOString(), setupError: undefined } : x)))
    if (r.mark) await saveMark(id, r.mark).catch(() => {})
    const name = r.name || c.name
    if (r.latest) {
      const e = S.createEdition(id, name, r.latest.year, { released: true, releaseDate: r.latest.releaseDate, releaseSource: r.latest.source, checkedDateAt: new Date().toISOString() })
      S.logEdition(e.conf, e.year, r.latest.releaseDate ? `录用结果在 ${r.latest.releaseDate} 公布` : '录用结果已公布')
    }
    if (r.next) {
      S.createEdition(id, name, r.next.year, { releaseDate: r.next.releaseDate, releaseSource: r.next.source, checkedDateAt: new Date().toISOString() })
      if (r.next.releaseDate) S.logEdition(id, r.next.year, `${r.next.estimated ? '预计' : ''}${r.next.releaseDate} 公布录用结果`)
    }
  } catch (e) {
    S.updateConference(id, { setupError: String((e as Error).message || e).slice(0, 200) })
    throw e
  } finally {
    busy(id, undefined)
  }
}

const MARK_TYPES: Record<string, string> = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' }

/** Downloads the conference's graphic mark into its folder. */
async function saveMark(id: string, url: string): Promise<void> {
  if (!/^https?:\/\//.test(url)) return
  const res = await net.fetch(url, { signal: AbortSignal.timeout(30_000) })
  const ext = MARK_TYPES[(res.headers.get('content-type') ?? '').split(';')[0].trim()] ?? url.match(/\.(svg|png|webp|jpg)(\?|$)/i)?.[1]?.toLowerCase()
  if (!res.ok || !ext) return
  const bytes = Buffer.from(await res.arrayBuffer())
  if (!bytes.length || bytes.length > 2_000_000) return
  const dir = S.confDir(id)
  for (const f of readdirSync(dir)) if (f.startsWith('mark.')) rmSync(join(dir, f), { force: true })
  writeFileSync(join(dir, `mark.${ext}`), bytes)
  S.updateConference(id, { mark: `mark.${ext}` })
}

/** The downloaded mark of a conference, for shiori://conf/<id>/mark. */
export function markFile(id: string): string | undefined {
  const c = conference(id)
  return c?.mark && !c.mark.includes('/') ? join(S.confDir(id), c.mark) : undefined
}

async function checkDate(conf: string, year: number): Promise<void> {
  const e = S.readEdition(conf, year)
  if (!e) return
  await step(e, '确认日期', async () => {
    const r = await T.checkDate(e, conference(conf)?.fullName)
    if (r.nextYear && !S.loadPapers(conf, year).length) {
      // No edition this year: wait for the next one instead.
      await shell.trashItem(S.editionDir(conf, year)).catch(() => {})
      S.forgetEdition(conf, year)
      const c = conference(conf)
      S.createEdition(conf, c?.name ?? conf, r.nextYear)
      return
    }
    const before = e.releaseDate
    S.updateEdition(conf, year, { released: r.released, releaseDate: r.releaseDate ?? e.releaseDate, releaseSource: r.source ?? e.releaseSource, checkedDateAt: new Date().toISOString() })
    if (r.released) S.logEdition(conf, year, `录用结果已公布${r.releaseDate ? `（${r.releaseDate}）` : ''}`)
    else if (r.releaseDate && r.releaseDate !== before) S.logEdition(conf, year, `预计 ${r.releaseDate} 公布录用结果${r.note ? `：${r.note}` : ''}`)
  })
}

async function discover(conf: string, year: number): Promise<void> {
  const e = S.readEdition(conf, year)
  if (!e) return
  await step(e, '寻找渠道', async () => {
    const channels = await T.discover(e, conference(conf)?.fullName, { effort: 'medium', onRound: () => busy(editionRef(conf, year), { label: '测试脚本' }) })
    S.updateEdition(conf, year, { channels, discoveredAt: new Date().toISOString() })
    S.logEdition(conf, year, channels.length ? `找到 ${channels.length} 个渠道：${channels.map((c) => c.name).join('、')}` : '还没有地方列出论文')
  })
  if (S.readEdition(conf, year)?.channels.length) await fetchEdition(conf, year)
}

/** Run every channel's script and merge what they found. */
export async function fetchEdition(conf: string, year: number): Promise<void> {
  const e = S.readEdition(conf, year)
  if (!e || !e.channels.length) return
  const ref = editionRef(conf, year)
  await step(e, '抓取', async () => {
    const before = S.loadPapers(conf, year).length
    const total = { added: 0, abstracts: 0, pdfs: 0 }
    const pdfKeys: string[] = []
    const channels = [...e.channels]
    for (const [i, ch] of channels.entries()) {
      busy(ref, { label: '抓取', progress: i / channels.length })
      const run = await runChannel(e, ch)
      const now = new Date().toISOString()
      if (run.ok && run.papers.length) {
        const s = mergeChannel(e, ch.id, run.papers)
        total.added += s.added
        total.abstracts += s.abstracts
        total.pdfs += s.pdfs
        pdfKeys.push(...s.pdfKeys)
        channels[i] = { ...ch, ranAt: now, count: run.papers.length, error: undefined, failures: 0 }
      } else {
        // Finding nothing is a failure only for a channel that found something before.
        const failed = !run.ok || !!ch.count
        channels[i] = { ...ch, ranAt: now, ...(failed ? { error: run.error ?? '这次一篇也没找到', failures: (ch.failures ?? 0) + 1 } : { count: 0 }) }
      }
    }
    const papers = S.loadPapers(conf, year)
    const latest = S.readEdition(conf, year)!
    const ambiguous = [...(latest.ambiguous ?? []), ...findAmbiguous({ ...latest, channels })]
    S.updateEdition(conf, year, { channels, fetchedAt: new Date().toISOString(), ambiguous, links: LINKS_VERSION })
    const parts = [
      total.added && `新增 ${total.added} 篇`,
      total.abstracts && `新增摘要 ${total.abstracts} 篇`,
      total.pdfs && `新增 PDF ${total.pdfs} 篇`
    ].filter(Boolean)
    S.logEdition(conf, year, parts.length ? `抓取完成，共 ${papers.length} 篇：${parts.join('，')}` : `抓取完成，没有变化（共 ${papers.length} 篇）`)
    if (!before && papers.length && !e.past) callEvent(`${e.name} 的录用论文出来了，已经抓到 ${papers.length} 篇`)
    if (pdfKeys.length) pdfArrived(conf, year, pdfKeys)
    checkComplete(conf, year)
  })
}

function checkComplete(conf: string, year: number): void {
  const e = S.readEdition(conf, year)
  if (!e || e.complete || phase(e) === 'hot') return
  const papers = S.loadPapers(conf, year)
  const full = papers.length > 0 && papers.filter((p) => p.abstract && p.pdf).length >= papers.length * 0.98
  const old = e.past ? ago(e.createdAt, Date.now()) > 30 * DAY : ago(e.releaseDate, Date.now()) > 150 * DAY
  if (full || old) {
    S.updateEdition(conf, year, { complete: true })
    S.logEdition(conf, year, full ? '摘要和 PDF 都齐了，这一届就此定稿' : '已经很久没有变化，这一届就此定稿')
  }
}

/** Asks OpenReview, as the signed-in owner, whether it shows the edition's papers yet; a few of them, as one may be withdrawn. */
async function checkOpenReview(conf: string, year: number): Promise<void> {
  const gated = S.loadPapers(conf, year).filter(gatedOnly)
  if (!gated.length) return
  let shown = false
  for (const p of [...new Set([gated[0], gated[gated.length >> 1], gated[gated.length - 1]])]) {
    const v = await OR.visible(linksOf(p)[0])
    if (v === undefined) return
    if ((shown = v)) break
  }
  const was = S.readEdition(conf, year)?.openReview?.public
  if (shown && was === false) return published(conf, year)
  S.updateEdition(conf, year, { openReview: { public: shown, at: new Date().toISOString() } })
  changed()
  if (was !== shown) send('later:changed')
}

/**
 * Papers only OpenReview has, in an edition it doesn't show yet, that the owner may want: in 稍后再看, in a followed
 * direction, or already marked (looked at again weekly, as authors often put a copy on arXiv later).
 */
function copiesDue(e: Edition): ConfPaper[] {
  if (e.openReview?.public !== false) return []
  const later = new Set(S.loadLater().map((i) => i.ref))
  const ref = editionRef(e.conf, e.year)
  return S.loadPapers(e.conf, e.year).filter(
    (p) => !p.arxiv && gatedOnly(p) && (later.has(`${ref}/${p.key}`) || p.follows?.length || p.noCopy) && ago(p.noCopy, Date.now()) >= 7 * DAY
  )
}

/** Looks for an arXiv copy of each paper copiesDue lists; one found is imported from there, none marks the row. */
async function lookForCopies(conf: string, year: number): Promise<void> {
  const e = S.readEdition(conf, year)
  if (!e) return
  const due = copiesDue(e)
  const ref = editionRef(conf, year)
  const later = S.loadLater()
  let failed: unknown
  for (const [i, p] of due.entries()) {
    const arxiv = await findArxiv(p).catch((err) => {
      failed = err
      return null
    })
    if (arxiv === null) continue
    const item = later.find((x) => x.ref === `${ref}/${p.key}`)
    if (arxiv && p.noCopy && item) {
      item.pdfNew = true
      S.saveLater(later)
      callEvent(`稍后再看里的《${item.titleZh || item.title}》在 arXiv 上找到了，可以导入了`)
    }
    markPaper(e, p.key, arxiv ? { arxiv } : { noCopy: new Date().toISOString() }, true)
    if (item) send('later:changed')
    if (i % 10 === 9) changed()
  }
  changed()
  // A search that failed is tried again in six hours rather than straight away.
  if (failed) throw failed
}

/** 稍后再看 papers whose PDF just appeared: say so once. */
function pdfArrived(conf: string, year: number, keys: string[]): void {
  const later = S.loadLater()
  const papers = new Map(S.loadPapers(conf, year).map((p) => [p.key, p]))
  let any = false
  for (const item of later) {
    const [c, y, key] = item.ref.split('/')
    if (c !== conf || +y !== year || !keys.includes(key) || item.pdf) continue
    item.pdf = papers.get(key)?.pdf
    item.pdfNew = true
    any = true
    callEvent(`稍后再看里的《${item.titleZh || item.title}》有 PDF 了，可以导入了`)
  }
  if (any) {
    S.saveLater(later)
    send('later:changed')
  }
}

async function patrolEdition(conf: string, year: number, search: boolean): Promise<void> {
  const e = S.readEdition(conf, year)
  if (!e) return
  await step(e, search ? '巡查' : '修脚本', async () => {
    const r = await T.patrol(e, { effort: 'medium', search, onRound: () => busy(editionRef(conf, year), { label: '测试脚本' }) })
    const merged = r.same.length ? mergeSame(e, r.same) : 0
    const decided = new Set([...r.same, ...r.different].map((p) => [...p].sort().join()))
    const latest = S.readEdition(conf, year)!
    const changedChannels = JSON.stringify(r.channels.map((c) => c.id)) !== JSON.stringify(latest.channels.map((c) => c.id)) || r.channels.some((c) => !c.error && latest.channels.find((x) => x.id === c.id)?.error)
    S.updateEdition(conf, year, {
      channels: r.channels,
      patrolledAt: new Date().toISOString(),
      officialCount: r.officialCount ?? latest.officialCount,
      ambiguous: (latest.ambiguous ?? []).filter((p) => !decided.has([...p].sort().join())),
      distinct: [...(latest.distinct ?? []), ...r.different]
    })
    const notes = [r.note, merged && `合并了 ${merged} 篇重复的论文`, r.officialCount && !latest.officialCount && `官方公布录用 ${r.officialCount} 篇`].filter(Boolean)
    if (notes.length) S.logEdition(conf, year, notes.join('；'))
    // New or repaired channels are run at once.
    if (changedChannels) S.updateEdition(conf, year, { fetchedAt: undefined })
  })
}

async function themes(conf: string, year: number): Promise<void> {
  const e = S.readEdition(conf, year)
  if (!e) return
  await step(e, '归纳主题', async () => {
    const list = await T.makeThemes(e)
    const count = S.loadPapers(conf, year).length
    // A new map changes the branches; directions made from the old one are looked for again.
    const keep = S.loadFollows().filter((f) => f.from?.edition !== editionRef(conf, year)).map((f) => f.id)
    S.updateEdition(conf, year, (x) => ({ themesAt: new Date().toISOString(), themesFor: count, followsDone: (x.followsDone ?? []).filter((id) => keep.includes(id)) }))
    S.logEdition(conf, year, `归纳出 ${list.length} 个主题`)
  })
}

async function assign(conf: string, year: number): Promise<void> {
  const e = S.readEdition(conf, year)
  if (!e) return
  const ref = editionRef(conf, year)
  await step(e, '归类', async () => {
    const n = await T.assignPapers(e, { onProgress: (done, total) => busy(ref, { label: '归类', progress: total ? done / total : 0 }) })
    if (n) S.logEdition(conf, year, `归类了 ${n} 篇论文`)
  })
}

/** Claude looks up what the rules couldn't read; to the owner it is part of sorting. */
async function lookUp(conf: string, year: number): Promise<void> {
  const e = S.readEdition(conf, year)
  if (!e) return
  const ref = editionRef(conf, year)
  await step(e, '归类', async () => {
    await T.lookUpLeftovers(e, { onProgress: (done, total) => busy(ref, { label: '归类', progress: done / total }) })
  })
}

/** Stored text read again with the current TeX rules and Claude's answers; its 稍后再看 entries and imported library papers follow. */
async function retidy(conf: string, year: number): Promise<void> {
  if (!S.readEdition(conf, year)) return
  const list = S.loadPapers(conf, year)
  for (const p of list) {
    const read = (s: string) => applyFixes(tidyTex(s), p.fixes)
    p.title = read(p.title)
    if (p.abstract) p.abstract = read(p.abstract)
    if (p.titleZh) p.titleZh = read(p.titleZh)
    if (p.abstractZh) p.abstractZh = read(T.dropTitleLine(p.abstractZh))
    p.leftovers = leftoversOf(p)
  }
  if (list.length) S.savePapers(conf, year, list)
  const ref = editionRef(conf, year)
  const byKey = new Map(list.map((p) => [p.key, p]))
  const later = S.loadLater()
  let laterChanged = false
  for (const item of later) {
    const p = item.ref.startsWith(`${ref}/`) ? byKey.get(item.ref.slice(ref.length + 1)) : undefined
    if (!p || (item.title === p.title && item.titleZh === p.titleZh && item.abstract === p.abstract)) continue
    Object.assign(item, { title: p.title, titleZh: p.titleZh, abstract: p.abstract })
    laterChanged = true
  }
  if (laterChanged) {
    S.saveLater(later)
    send('later:changed')
  }
  for (const m of libraryPapers()) {
    if (m.source?.edition !== ref) continue
    const patch = { title: tidyTex(m.title), titleZh: m.titleZh && tidyTex(m.titleZh), abstract: m.abstract && tidyTex(m.abstract) }
    if (patch.title === m.title && patch.titleZh === m.titleZh && patch.abstract === m.abstract) continue
    const meta = updateMeta(m.id, patch)
    if (meta) paperChanged(meta)
  }
  S.updateEdition(conf, year, { tidied: TIDY_VERSION })
}

async function tagFollow(conf: string, year: number, followId: string): Promise<void> {
  const e = S.readEdition(conf, year)
  const f = S.loadFollows().find((x) => x.id === followId)
  if (!e || !f) return
  await step(e, '整理方向', async () => {
    await T.tagFollow(e, f)
  })
}

async function describe(followId: string): Promise<void> {
  const f = S.loadFollows().find((x) => x.id === followId)
  if (!f?.pending) return
  busy(`follow:${f.id}`, { label: '写关键词' })
  try {
    const folder = loadFolders().find((x) => x.name === f.name)
    const titles = folder ? libraryPapers().filter((p) => p.folders?.includes(folder.id)).map((p) => p.title).slice(0, 30) : undefined
    const d = await T.describeFollow(f.name, titles)
    S.saveFollows(S.loadFollows().map((x) => (x.id === f.id ? { ...x, note: d.note, keywords: d.keywords, pending: undefined } : x)))
  } finally {
    busy(`follow:${f.id}`, undefined)
  }
}

/* ---------- what the renderer sees ---------- */

function summarize(e: Edition, editions: Edition[]): EditionSummary {
  const papers = S.loadPapers(e.conf, e.year)
  const archived = isArchived(e, editions)
  return {
    conf: e.conf,
    year: e.year,
    name: e.name,
    phase: phase(e),
    archived,
    past: e.past,
    releaseDate: e.releaseDate,
    released: e.released,
    count: papers.length,
    officialCount: e.officialCount,
    withAbstract: papers.filter((p) => p.abstract).length,
    withPdf: papers.filter((p) => p.pdf).length,
    channels: e.channels,
    activity: activity.get(editionRef(e.conf, e.year)),
    error: e.error,
    log: (e.log ?? []).slice(-12),
    fresh: archived ? 0 : papers.filter((p) => p.follows?.length && p.followedAt && p.followedAt > (e.seenAt ?? '')).length,
    themes: !!e.themesAt,
    assigned: papers.filter((p) => p.branch).length,
    unpublished: e.openReview?.public === false || undefined,
    noCopy: e.openReview?.public === false ? papers.filter((p) => unpublished(e, p)).length : 0
  }
}

function overview(): ConfOverview {
  const confs = S.loadConferences()
  if (!confs) return { conferences: [], follows: [], fresh: 0, followFresh: {}, followState: {}, started: false }
  const conferences = confs.map((c) => {
    const editions = S.listEditions(c.id)
    return { ...c, editions: editions.map((e) => summarize(e, editions)), activity: activity.get(c.id) }
  })
  const fresh = conferences.reduce((n, c) => n + c.editions.reduce((m, e) => m + e.fresh, 0), 0)
  const follows = S.loadFollows().map((f) => ({ ...f, pending: f.pending || activity.has(`follow:${f.id}`) || undefined }))
  const followFresh: Record<string, number> = {}
  for (const c of confs) {
    const editions = S.listEditions(c.id)
    for (const e of editions) {
      if (isArchived(e, editions)) continue
      for (const p of S.loadPapers(e.conf, e.year)) {
        if (!p.follows?.length || !p.followedAt || p.followedAt <= (e.seenAt ?? '')) continue
        for (const id of p.follows) followFresh[id] = (followFresh[id] ?? 0) + 1
      }
    }
  }
  // Editions a direction is looked for in: those of followed conferences with a theme map.
  const due = confs.filter((c) => c.tracking).flatMap((c) => S.listEditions(c.id)).filter((e) => e.released && e.themesAt && S.loadPapers(e.conf, e.year).length)
  const followState: Record<string, Activity> = {}
  for (const f of follows) {
    if (f.pending) followState[f.id] = { label: '写关键词' }
    else {
      const done = due.filter((e) => e.followsDone?.includes(f.id)).length
      if (done < due.length) followState[f.id] = { label: '整理', progress: done / due.length }
    }
  }
  return { conferences, follows, fresh, followFresh, followState, started: true }
}

function editionView(conf: string, year: number): EditionView | undefined {
  const e = S.readEdition(conf, year)
  if (!e) return undefined
  const editions = S.listEditions(conf)
  const papers = S.loadPapers(conf, year)
  const branchCounts: Record<string, number> = {}
  const tracks = new Map<string, number>()
  const kinds = new Map<string, number>()
  for (const p of papers) {
    if (p.branch) branchCounts[p.branch] = (branchCounts[p.branch] ?? 0) + 1
    if (p.track) tracks.set(p.track, (tracks.get(p.track) ?? 0) + 1)
    if (p.kind) kinds.set(p.kind, (kinds.get(p.kind) ?? 0) + 1)
  }
  const sorted = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }))
  return {
    edition: summarize(e, editions),
    themes: S.loadThemes(conf, year),
    branchCounts,
    follows: S.loadFollows().map((f) => ({
      id: f.id,
      count: papers.filter((p) => p.follows?.includes(f.id)).length,
      fresh: papers.filter((p) => p.follows?.includes(f.id) && p.followedAt && p.followedAt > (e.seenAt ?? '')).length
    })),
    tracks: sorted(tracks),
    kinds: sorted(kinds),
    followsDone: e.followsDone ?? [],
    years: editions.filter((x) => S.loadPapers(x.conf, x.year).length || x.year === year).map((x) => x.year)
  }
}

const KIND_ORDER = ['oral', 'spotlight', 'poster']
const kindRank = (k?: string) => {
  const i = KIND_ORDER.indexOf((k ?? '').toLowerCase())
  return i < 0 ? KIND_ORDER.length : i
}

/** The library's papers by conference listing and by title, to mark what is already there. */
function libraryIndex() {
  const bySource = new Map<string, PaperMeta>()
  const byTitle = new Map<string, PaperMeta>()
  for (const m of libraryPapers()) {
    if (m.source) bySource.set(`${m.source.edition}/${m.source.key}`, m)
    byTitle.set(normTitle(m.title), m)
  }
  return (ref: string, title: string) => bySource.get(ref) ?? byTitle.get(normTitle(title))
}

function queryPapers(q: PaperQuery): ListedPaper[] {
  const confs = S.loadConferences() ?? []
  const editions = q.edition
    ? [S.readEdition(q.edition.split('/')[0], +q.edition.split('/')[1])].filter((e): e is Edition => !!e)
    : confs.flatMap((c) => S.listEditions(c.id))
  const inLibrary = libraryIndex()
  const later = new Set(S.loadLater().map((i) => i.ref))
  const search = q.search?.trim()
  const out: (ListedPaper & { score: number })[] = []
  for (const e of editions) {
    const ref = editionRef(e.conf, e.year)
    let branches: Set<string> | undefined
    const group = q.group
    if (group?.type === 'theme') branches = new Set(S.loadThemes(e.conf, e.year).find((t) => t.id === group.id)?.branches.map((b) => b.id) ?? [])
    for (const p of S.loadPapers(e.conf, e.year)) {
      const g = q.group
      if (g?.type === 'branch' && p.branch !== g.id) continue
      if (g?.type === 'theme' && !branches!.has(p.branch ?? '')) continue
      if (g?.type === 'follow' && !p.follows?.includes(g.id)) continue
      if (q.track && p.track !== q.track) continue
      if (q.kind && p.kind !== q.kind) continue
      const score = search ? searchScore(search, p) : 1
      if (!score) continue
      const pref = `${ref}/${p.key}`
      const lib = inLibrary(pref, p.title)
      const { abstract, abstractZh, pdfs: _, ...bare } = p
      out.push({
        ...(q.lean ? bare : { ...bare, abstract, abstractZh }),
        edition: ref,
        editionName: e.name,
        inLibrary: lib?.id,
        later: later.has(pref) || !!lib?.laterAt,
        fresh: !!(p.follows?.length && p.followedAt && p.followedAt > (e.seenAt ?? '')),
        unpublished: unpublished(e, p) ? p.noCopy : undefined,
        score
      })
    }
  }
  if (search) out.sort((a, b) => b.score - a.score || b.edition.localeCompare(a.edition))
  else out.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.title.localeCompare(b.title))
  return (search && !q.edition ? out.slice(0, 500) : out).map(({ score: _, ...p }) => p)
}

/** One paper with everything, for a row the owner opened. */
function listedPaper(ref: string): ListedPaper | undefined {
  const found = findPaper(ref)
  if (!found) return undefined
  const { e, p } = found
  const lib = libraryIndex()(ref, p.title)
  return {
    ...p,
    edition: editionRef(e.conf, e.year),
    editionName: e.name,
    inLibrary: lib?.id,
    later: S.loadLater().some((i) => i.ref === ref) || !!lib?.laterAt,
    fresh: !!(p.follows?.length && p.followedAt && p.followedAt > (e.seenAt ?? '')),
    unpublished: unpublished(e, p) ? p.noCopy : undefined
  }
}

function findPaper(ref: string): { e: Edition; p: ConfPaper } | undefined {
  const [conf, year, key] = ref.split('/')
  const e = S.readEdition(conf, +year)
  const p = e && S.loadPapers(conf, +year).find((x) => x.key === key)
  return e && p ? { e, p } : undefined
}

/** How the library names the venue: Findings and the like keep their track. */
function venueOf(e: Edition, p: ConfPaper): string {
  const name = e.name.replace(/\s+\d{4}$/, '')
  if (p.track && /findings/i.test(p.track)) return `Findings of ${name}`
  if (p.track && /workshop/i.test(p.track)) return `${name} Workshop`
  return name
}

async function download(url: string): Promise<Buffer> {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`下载 PDF 失败（${res.status}）`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.subarray(0, 4).toString() !== '%PDF') throw new Error('下载到的文件不是 PDF')
  return bytes
}

const linksOf = (p: ConfPaper) => [...new Set([p.pdf, ...(p.pdfs ?? [])])].filter((u): u is string => !!u)

/** Every link is OpenReview's: whether it downloads depends on OpenReview showing the edition. */
const gatedOnly = (p: ConfPaper) => {
  const all = linksOf(p)
  return all.length > 0 && all.every(OR.isOpenReview)
}

/** OpenReview doesn't show it yet and a look found no copy elsewhere. */
const unpublished = (e: Edition, p: ConfPaper) => e.openReview?.public === false && !!p.noCopy && !p.arxiv && gatedOnly(p)

/** Records what a look found about where one paper can be downloaded, and tells the pages unless asked not to. */
function markPaper(e: Edition, key: string, found: { arxiv?: string; noCopy?: string }, quiet = false): void {
  const list = S.loadPapers(e.conf, e.year)
  const p = list.find((x) => x.key === key)
  if (!p) return
  if (found.arxiv) {
    p.arxiv = found.arxiv
    delete p.noCopy
  } else if (found.noCopy) p.noCopy = found.noCopy
  S.savePapers(e.conf, e.year, list)
  if (quiet) return
  changed()
  if (S.loadLater().some((i) => i.ref === `${editionRef(e.conf, e.year)}/${key}`)) send('later:changed')
}

/** OpenReview shows the edition now: its marks go, and 稍后再看 papers that had no copy say their PDF is out. */
function published(conf: string, year: number): void {
  const e = S.readEdition(conf, year)
  if (!e) return
  S.updateEdition(conf, year, { openReview: { public: true, at: new Date().toISOString() } })
  S.logEdition(conf, year, '论文在 OpenReview 上公开了')
  const papers = new Map(S.loadPapers(conf, year).map((p) => [p.key, p]))
  const later = S.loadLater()
  const ref = editionRef(conf, year)
  let any = false
  for (const item of later) {
    const [c, y, key] = item.ref.split('/')
    if (`${c}/${y}` !== ref || !papers.get(key)?.noCopy) continue
    item.pdfNew = true
    any = true
  }
  if (any) S.saveLater(later)
  send('later:changed')
  callEvent(`${e.name} 的论文在 OpenReview 上公开了`)
  changed()
}

/**
 * Where the PDF comes from, in turn: links that download as they are (proceedings, PMLR), OpenReview through the
 * owner's signed-in session, arXiv (the id the data gives, or one found by title). A paper only OpenReview has,
 * with the owner not signed in, answers { signIn: true }: the page asks them to sign in, then imports again.
 */
async function importPaper(ref: string): Promise<PaperMeta | { signIn: true }> {
  const found = findPaper(ref)
  if (!found) throw new Error('找不到这篇论文')
  const { e, p } = found
  const existing = libraryIndex()(ref, p.title)
  if (existing) return existing
  const all = linksOf(p)
  const gated = all.filter(OR.isOpenReview)
  if (!all.length && !p.arxiv) throw new Error('这篇还没有 PDF')
  let bytes: Buffer | undefined
  let error: unknown
  let hidden = false
  const attempt = async (get: () => Promise<Buffer | undefined>) => {
    if (bytes) return
    try {
      bytes = await get()
    } catch (err) {
      error = err
      if (err instanceof OR.NotPublic) hidden = true
    }
  }
  for (const url of all.filter((u) => !OR.isOpenReview(u))) await attempt(() => download(url))
  if (gated.length && (await OR.account())) {
    await attempt(() => OR.fetchPdf(gated[0]))
    if (bytes && e.openReview?.public === false) published(e.conf, e.year)
  }
  let arxiv = p.arxiv
  if (!bytes) {
    arxiv ??= await findArxiv(p).catch(() => undefined)
    if (arxiv) await attempt(() => download(`https://arxiv.org/pdf/${arxiv}`))
    if (bytes && arxiv !== p.arxiv) markPaper(e, p.key, { arxiv })
  }
  if (!bytes && gated.length && !(await OR.account())) return { signIn: true }
  if (!bytes && hidden && !arxiv) {
    markPaper(e, p.key, { noCopy: new Date().toISOString() })
    if (e.openReview?.public !== false) {
      S.updateEdition(e.conf, e.year, { openReview: { public: false, at: new Date().toISOString() } })
      send('later:changed')
    }
  }
  if (!bytes) throw error ?? new Error('下载 PDF 失败')
  const later = S.loadLater()
  const item = later.find((i) => i.ref === ref)
  let meta = importDownloaded(bytes, {
    title: p.title,
    titleZh: p.titleZh,
    authors: p.authors,
    abstract: p.abstract,
    arxiv,
    venue: venueOf(e, p),
    year: String(e.year),
    source: { edition: editionRef(e.conf, e.year), key: p.key },
    laterAt: item?.addedAt
  })
  if (item) {
    S.saveLater(later.filter((i) => i.ref !== ref))
    send('later:changed')
  }
  paperChanged(meta)
  await prepare(meta.id).catch(() => {})
  meta = readMeta(meta.id) ?? meta
  paperChanged(meta)
  return meta
}

function setLater(ref: string, on: boolean): void {
  const found = findPaper(ref)
  const later = S.loadLater().filter((i) => i.ref !== ref)
  const lib = found && libraryIndex()(ref, found.p.title)
  if (lib) {
    const meta = updateMeta(lib.id, { laterAt: on ? new Date().toISOString() : undefined })
    if (meta) paperChanged(meta)
  } else if (on && found) {
    const { e, p } = found
    const item: LaterItem = {
      ref,
      title: p.title,
      titleZh: p.titleZh,
      authors: p.authors,
      venue: venueOf(e, p),
      year: String(e.year),
      abstract: p.abstract,
      url: p.url,
      pdf: p.pdf ?? (p.arxiv ? `https://arxiv.org/pdf/${p.arxiv}` : undefined),
      addedAt: new Date().toISOString()
    }
    later.unshift(item)
  }
  S.saveLater(later)
  send('later:changed')
}

/* ---------- directions ---------- */

function addFollow(f: Omit<Follow, 'id' | 'addedAt'>): Follow {
  const list = S.loadFollows()
  const same = list.find((x) => x.name.trim().toLowerCase() === f.name.trim().toLowerCase())
  if (same) throw new Error(`已经关注了「${same.name}」`)
  const follow: Follow = { ...f, id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, addedAt: new Date().toISOString() }
  S.saveFollows([...list, follow])
  changed()
  setTimeout(plan, 100)
  return follow
}

function followFromMap(edition: string, o: { branch?: string; theme?: string }): Follow {
  const [conf, year] = edition.split('/')
  const themes = S.loadThemes(conf, +year)
  const theme = themes.find((t) => t.id === (o.theme ?? o.branch?.split('.')[0]))
  const branch = theme?.branches.find((b) => b.id === o.branch)
  if (!theme || (o.branch && !branch)) throw new Error('找不到这个主题')
  const f = addFollow({
    name: branch?.name ?? theme.name,
    note: branch?.note ?? theme.note,
    keywords: branch?.keywords ?? [...new Set(theme.branches.flatMap((b) => b.keywords))],
    from: { edition, branch: branch?.id, theme: branch ? undefined : theme.id }
  })
  // Its papers in this edition are known already.
  const e = S.readEdition(conf, +year)
  if (e) void T.tagFollow(e, f).then(changed)
  return f
}

function deleteFollow(id: string): void {
  S.saveFollows(S.loadFollows().filter((f) => f.id !== id))
  for (const c of S.loadConferences() ?? [])
    for (const e of S.listEditions(c.id)) {
      const papers = S.loadPapers(e.conf, e.year)
      if (!papers.some((p) => p.follows?.includes(id))) continue
      for (const p of papers) if (p.follows?.includes(id)) p.follows = p.follows.filter((x) => x !== id)
      S.savePapers(e.conf, e.year, papers)
      S.updateEdition(e.conf, e.year, (x) => ({ followsDone: (x.followsDone ?? []).filter((f) => f !== id) }))
    }
  ai.drop(`:${id}`)
  changed()
}

/** Changing a direction's keywords means looking for its papers again. */
function updateFollow(id: string, patch: Partial<Pick<Follow, 'name' | 'note' | 'keywords'>>): void {
  const list = S.loadFollows()
  const f = list.find((x) => x.id === id)
  if (!f) return
  const keywordsChanged = patch.keywords && patch.keywords.join() !== f.keywords.join()
  S.saveFollows(list.map((x) => (x.id === id ? { ...x, ...patch, ...(keywordsChanged ? { from: undefined } : {}) } : x)))
  if (keywordsChanged)
    for (const c of S.loadConferences() ?? [])
      for (const e of S.listEditions(c.id)) {
        const papers = S.loadPapers(e.conf, e.year)
        for (const p of papers) if (p.follows?.includes(id)) p.follows = p.follows.filter((x) => x !== id)
        S.savePapers(e.conf, e.year, papers)
        S.updateEdition(e.conf, e.year, (x) => ({ followsDone: (x.followsDone ?? []).filter((y) => y !== id) }))
      }
  changed()
  setTimeout(plan, 100)
}

/* ---------- conferences ---------- */

function start(): void {
  if (S.loadConferences()) return
  const now = new Date().toISOString()
  S.saveConferences(S.DEFAULT_CONFERENCES.map(([id, name]) => ({ id, name, tracking: true, addedAt: now })))
  plan()
}

function addConference(name: string): Conference {
  const clean = name.trim()
  if (!clean) throw new Error('请输入会议名称')
  const list = S.loadConferences() ?? []
  const id = S.confId(clean)
  const same = list.find((c) => c.id === id || c.name.toLowerCase() === clean.toLowerCase())
  if (same) {
    if (!same.tracking) S.updateConference(same.id, { tracking: true })
    plan()
    return same
  }
  const c: Conference = { id, name: clean, tracking: true, addedAt: new Date().toISOString() }
  S.saveConferences([...list, c])
  plan()
  return c
}

async function deleteConference(id: string): Promise<void> {
  ai.drop(id)
  fetcher.drop(id)
  if (existsSync(S.confDir(id))) await shell.trashItem(S.confDir(id))
  for (const e of S.listEditions(id)) S.forgetEdition(e.conf, e.year)
  S.saveConferences((S.loadConferences() ?? []).filter((c) => c.id !== id))
  S.saveLater(S.loadLater().filter((i) => !i.ref.startsWith(`${id}/`)))
  send('later:changed')
}

function addPast(id: string, year: number): void {
  const c = conference(id)
  if (!c) throw new Error('找不到这个会议')
  if (S.readEdition(id, year)) throw new Error(`${c.name} ${year} 已经在了`)
  S.createEdition(id, c.name, year, { released: true, past: true })
  S.logEdition(id, year, '手动添加的往届')
  plan()
}

async function deleteEdition(conf: string, year: number): Promise<void> {
  ai.drop(`${conf}/${year}`)
  fetcher.drop(`${conf}/${year}`)
  await shell.trashItem(S.editionDir(conf, year))
  S.forgetEdition(conf, year)
  S.saveLater(S.loadLater().filter((i) => !i.ref.startsWith(`${conf}/${year}/`)))
  send('later:changed')
}

/** The owner asked: fetch now, and while papers are still coming, have Claude look around too. */
function refreshEdition(conf: string, year: number): void {
  const e = S.readEdition(conf, year)
  if (!e) return
  failedAt.forEach((_, k) => k.includes(`${conf}/${year}`) && failedAt.delete(k))
  if (!e.released) return void ai.add(`date:${conf}/${year}`, () => checkDate(conf, year))
  if (!e.channels.length) return void ai.add(`discover:${conf}/${year}`, () => discover(conf, year))
  fetcher.add(`fetch:${conf}/${year}`, () => fetchEdition(conf, year))
  if (!e.complete) ai.add(`patrol:${conf}/${year}`, () => patrolEdition(conf, year, true))
}

export function initConferences(o: { send: Send; paperChanged: (meta: PaperMeta) => void }): void {
  send = o.send
  paperChanged = o.paperChanged
  setTimeout(tidyStale, 1500)
  setTimeout(plan, 20_000)
  setInterval(plan, 30 * 60_000)
  OR.onAccountChange(() => setTimeout(plan, 1000))

  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, async (_e, ...args) => {
      const r = await fn(...args)
      changed()
      return r
    })
  ipcMain.handle('conf:overview', () => overview())
  handle('conf:start', start)
  handle('conf:add', addConference)
  handle('conf:setTracking', (id: string, on: boolean) => {
    S.updateConference(id, { tracking: on })
    if (on) plan()
    else {
      ai.drop(id)
      fetcher.drop(id)
    }
  })
  handle('conf:delete', deleteConference)
  handle('conf:retry', (id: string) => {
    failedAt.forEach((_, k) => k.includes(id) && failedAt.delete(k))
    S.updateConference(id, { setupError: undefined })
    plan()
  })
  handle('conf:addPast', addPast)
  handle('conf:deleteEdition', deleteEdition)
  handle('conf:refresh', refreshEdition)
  ipcMain.handle('conf:edition', (_e, conf: string, year: number) => editionView(conf, year))
  ipcMain.handle('conf:papers', (_e, q: PaperQuery) => queryPapers(q))
  ipcMain.handle('conf:paper', (_e, ref: string) => listedPaper(ref))
  handle('conf:seen', (conf: string, year: number) => S.updateEdition(conf, year, { seenAt: new Date().toISOString() }) && undefined)
  ipcMain.handle('conf:keywords', (_e, text: string) => T.queryKeywords(text))
  ipcMain.handle('conf:translate', async (_e, ref: string) => {
    const found = findPaper(ref)
    if (!found?.p.abstract) throw new Error('这篇还没有摘要')
    if (found.p.abstractZh) return found.p.abstractZh
    const zh = applyFixes(await T.translateAbstract(found.p.title, found.p.abstract), found.p.fixes)
    const list = S.loadPapers(found.e.conf, found.e.year)
    const p = list.find((x) => x.key === found.p.key)
    if (p) {
      p.abstractZh = zh
      S.savePapers(found.e.conf, found.e.year, list)
    }
    return zh
  })
  ipcMain.handle('conf:import', (_e, ref: string) => importPaper(ref))

  handle('follows:add', (name: string) => {
    const clean = name.trim()
    if (!clean) throw new Error('请输入方向名称')
    return addFollow({ name: clean, keywords: [], pending: true })
  })
  handle('follows:fromFolders', () => {
    const have = new Set(S.loadFollows().map((f) => f.name.toLowerCase()))
    for (const folder of loadFolders()) if (!have.has(folder.name.toLowerCase())) addFollow({ name: folder.name, keywords: [], pending: true })
  })
  handle('follows:fromMap', followFromMap)
  handle('follows:update', updateFollow)
  handle('follows:delete', deleteFollow)

  ipcMain.handle('later:list', () =>
    S.loadLater().map((i) => {
      const found = findPaper(i.ref)
      return found && unpublished(found.e, found.p) ? { ...i, unpublished: found.p.noCopy } : i
    })
  )
  ipcMain.handle('later:set', (_e, ref: string, on: boolean) => setLater(ref, on))
  ipcMain.handle('later:remove', (_e, ref: string) => {
    S.saveLater(S.loadLater().filter((i) => i.ref !== ref))
    send('later:changed')
  })
  ipcMain.handle('later:seen', () => {
    const list = S.loadLater()
    if (!list.some((i) => i.pdfNew)) return
    S.saveLater(list.map(({ pdfNew: _, ...i }) => i))
    send('later:changed')
  })
}
