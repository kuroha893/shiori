import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppendixState, PaperMeta, TaskKind } from '../shared/types'
import { parseDoc } from '../shared/doc'
import { listPapers, paperDir, readDocSource, readMeta, updateMeta } from './library'
import { glossaryPrompt } from './glossary'
import { modelFor, runAgent, type Activity } from './ai'
import { parseModel } from '../shared/models'
import { appendixCarryOnNote, appendixPrompt, carryOnNote, guidePrompt, processPrompt, resumePrompt, verifyPrompt, type Source } from './prompts'
import { getSettings } from './settings'
import { workerCall } from './worker'
import { applyFoundVenue, awaitingVenue, checkVenue, isPreprint } from './venue'
import { addTask, cancelTasks, registerRunner, TaskError, type TaskContext } from './tasks'

type Notify = (meta: PaperMeta) => void

let notify: Notify = () => {}
/** The paper being processed now, and how to tell the task list what it is doing */
let current: { id: string; ctx: TaskContext } | undefined

export function initJobs(onChange: Notify): void {
  notify = onChange
  registerRunner('process', {
    run: processTask,
    queued: (id) => set(id, { status: 'queued', stage: '等待处理', progress: 0, error: undefined, kept: keptOf(id) }),
    stopped: (id) => set(id, { status: 'queued', stage: '等待处理', progress: 0, kept: keptOf(id) }),
    dropped: (id) => unqueue(id)
  })
  registerRunner('guide', {
    run: guideTask,
    queued: (id) => set(id, { guideWriting: true, guideError: undefined }),
    // also a paper stopped after processing, in its guide stage: readable, only the guide waits
    stopped: (id) => set(id, { guideWriting: true }),
    dropped: (id) => set(id, { guideWriting: undefined })
  })
  registerRunner('appendix', {
    run: appendixTask,
    queued: (id) => setAppendix(id, { state: 'queued', error: undefined }),
    stopped: (id) => setAppendix(id, { state: 'queued' }),
    dropped: (id) => setAppendix(id, { state: undefined, progress: undefined, error: undefined })
  })
}

/** The tasks the papers say are waiting, for a library from before the task list. */
export function pendingFromPapers(): { paper: string; kind: TaskKind }[] {
  const out: { paper: string; kind: TaskKind }[] = []
  for (const p of listPapers()) {
    if (p.status === 'processing' || p.status === 'queued') out.push({ paper: p.id, kind: 'process' })
    else if (p.guideWriting) out.push({ paper: p.id, kind: 'guide' })
    if (p.status === 'ready' && (p.appendix?.state === 'queued' || p.appendix?.state === 'writing')) out.push({ paper: p.id, kind: 'appendix' })
  }
  return out
}

/** The parts of the transcription on disk: doc/01.md, doc/02.md, ... */
const docParts = (id: string): string[] => {
  try {
    return readdirSync(join(paperDir(id), 'doc'))
      .filter((f) => /^\d+\.md$/.test(f))
      .sort()
      .map((f) => `doc/${f}`)
  } catch {
    return []
  }
}

/**
 * What an unfinished run leaves to carry on from: its share of the work, when parts of the transcription are on
 * disk. A finished paper being processed again keeps nothing; 重新处理 drops it beforehand.
 */
function keptOf(id: string): number | undefined {
  const meta = readMeta(id)
  if (!meta || meta.status === 'ready' || !docParts(id).length) return undefined
  return meta.kept ?? meta.progress ?? 0.3
}

/** Process a paper from the start, dropping what an interrupted run left. */
export function restart(id: string): void {
  cancelTasks(id, ['appendix'])
  if (readMeta(id)?.kept !== undefined) set(id, { kept: undefined })
  if (readMeta(id)?.status !== 'ready') for (const d of ['doc', 'figures']) rmSync(join(paperDir(id), d), { recursive: true, force: true })
  enqueue(id)
}

function set(id: string, patch: Partial<PaperMeta>): void {
  const meta = updateMeta(id, patch)
  if (meta) notify(meta)
  if (current?.id === id && patch.stage && meta?.status === 'processing') current.ctx.report(patch.stage, patch.progress)
}

/** Change the appendix's state, while the paper still waits for its appendix. */
function setAppendix(id: string, patch: Partial<AppendixState>): void {
  const a = readMeta(id)?.appendix
  if (a) set(id, { appendix: { ...a, ...patch } })
}

/** Back to how it was before it was queued. */
function unqueue(id: string): void {
  const meta = readMeta(id)
  if (meta && meta.status !== 'ready') set(id, { status: meta.processedAt ? 'ready' : 'new', stage: undefined, progress: undefined })
  if (meta?.guideWriting) set(id, { guideWriting: undefined })
}

export const pdfUrl = (id: string) => `shiori://paper/${encodeURIComponent(id)}/paper.pdf`

/** Only Claude reads the PDF itself; the others work from its text layer and the page images. */
export const sourceFor = (model: string): Source => (parseModel(model).provider === 'claude' ? 'pdf' : 'pages')

/** paper.txt, the PDF's text layer; papers processed before it existed get it when first needed. */
export async function ensurePaperText(id: string): Promise<void> {
  const file = join(paperDir(id), 'paper.txt')
  if (!existsSync(file)) writeFileSync(file, await workerCall<string>('text', { url: pdfUrl(id) }))
}

/** Page count and first-page thumbnail; cheap, done on import. */
export async function prepare(id: string): Promise<void> {
  const url = pdfUrl(id)
  const { pages } = await workerCall<{ pages: number }>('info', { url })
  const thumb = await workerCall<Uint8Array>('render', { url, page: 1, width: 520 })
  writeFileSync(join(paperDir(id), 'thumb.png'), thumb)
  set(id, { pages })
}

/** Process a paper: queued at the end of the owner's task list. */
export const enqueue = (id: string) => void addTask(id, 'process')

/** Write the guide again: next in the task list. */
export const startGuide = (id: string) => void addTask(id, 'guide')

/** Translate the appendix left out when the paper was processed: next in the task list. */
export const startAppendix = (id: string) => void addTask(id, 'appendix')

/** The owner cancelled processing from the paper itself. */
export function cancel(id: string): void {
  cancelTasks(id)
  unqueue(id)
}

/** Processing, then where it was published, then the guide, as one task. */
async function processTask(id: string, ctx: TaskContext): Promise<void> {
  current = { id, ctx }
  try {
    await runJob(id, ctx.signal)
  } catch (e: any) {
    // Stopped or cancelled: whoever stopped it has set the paper's state.
    if (!ctx.signal.aborted) set(id, { status: 'error', stage: undefined, error: String(e?.message || e), kept: keptOf(id) })
    throw e
  } finally {
    current = undefined
  }
  ctx.requeueAs('guide')
  // A paper still only a preprint is looked up first, so the guide run searches the web only if that found nothing.
  ctx.report('正在查找发表信息', 0.95)
  await checkVenue(id)
  if (ctx.signal.aborted) throw new Error('已停止')
  ctx.report('正在写导读', 0.96)
  set(id, { guideWriting: true, guideError: undefined })
  await guideStage(id, ctx, true)
}

/** Rewrite the guide; the paper stays readable, and an old guide stays until the new one is done. */
async function guideTask(id: string, ctx: TaskContext): Promise<void> {
  ctx.report('正在写导读')
  await guideStage(id, ctx, false)
}

async function guideStage(id: string, ctx: TaskContext, inProcessing: boolean): Promise<void> {
  try {
    await writeGuide(id, ctx.signal)
    set(id, { guideWriting: undefined })
  } catch (e: any) {
    // Stopped: it waits in the queue as a guide task, still marked as being written.
    if (ctx.signal.aborted) throw e
    const msg = String(e?.message || e)
    set(id, { guideWriting: undefined, guideError: msg })
    throw inProcessing ? new TaskError(msg, 'guide') : e
  }
}

async function cropAll(id: string): Promise<string[]> {
  const blocks = parseDoc(readDocSource(id)).filter((b) => (b.type === 'fig' || b.type === 'tab') && b.page && b.bbox)
  mkdirSync(join(paperDir(id), 'figures'), { recursive: true })
  for (const b of blocks) {
    const png = await workerCall<Uint8Array>('crop', { url: pdfUrl(id), page: b.page, bbox: b.bbox })
    writeFileSync(join(paperDir(id), 'figures', `${b.id}.png`), png)
  }
  return blocks.map((b) => b.id)
}

async function runJob(id: string, signal: AbortSignal): Promise<void> {
  const dir = paperDir(id)
  const model = await modelFor(getSettings().processModel, 'process')
  const source = sourceFor(model)
  const before = readMeta(id)
  const parts = docParts(id)
  // Carry on from an interrupted run, unless the model changed: one article in two hands reads oddly.
  const resume = before?.kept !== undefined && parts.length > 0 && before.processModel === model
  const skipAppendix = getSettings().appendix === 'skip'
  set(id, { status: 'processing', stage: '渲染页面', progress: resume ? before!.kept : 0.02, error: undefined, kept: undefined, appendix: undefined })

  if (resume) rmSync(join(dir, 'figures'), { recursive: true, force: true })
  else {
    // Start clean: a previous run may have left partial output.
    for (const d of ['doc', 'figures', 'pages']) rmSync(join(dir, d), { recursive: true, force: true })
    for (const f of ['info.json', 'summary.md', 'paper.txt']) rmSync(join(dir, f), { force: true })
  }

  const url = pdfUrl(id)
  const { pages } = await workerCall<{ pages: number }>('info', { url })
  mkdirSync(join(dir, 'pages'), { recursive: true })
  mkdirSync(join(dir, 'doc'), { recursive: true })
  const page = (p: number) => join(dir, 'pages', `p${String(p).padStart(2, '0')}.png`)
  for (let p = 1; p <= pages; p++) {
    if (signal.aborted) throw new Error('已取消')
    if (resume && existsSync(page(p))) continue
    writeFileSync(page(p), await workerCall<Uint8Array>('render', { url, page: p, width: 1100, grid: true }))
  }
  if (!existsSync(join(dir, 'paper.txt'))) writeFileSync(join(dir, 'paper.txt'), await workerCall<string>('text', { url }))

  set(id, { pages, stage: resume ? `正在转写和翻译（第 ${parts.length + 1} 部分）` : '正在读论文', progress: resume ? before!.kept : 0.05, processModel: model })

  // Progress: pages read count for the first ~30%, written doc parts for the rest.
  let pagesRead = 0
  let partsWritten = parts.length
  const written = new Set<string>(parts.map((p) => join(dir, p)))
  const expectedParts = Math.max(3, Math.round(pages / 2.5))
  const readUpTo = (n: number) => {
    pagesRead = Math.min(pages, Math.max(pagesRead, n))
    // Carrying on, the bar stays where the last run left it while the paper is read again.
    set(id, { stage: `正在读论文（${pagesRead}/${pages} 页）`, ...(resume ? {} : { progress: 0.05 + 0.25 * (pagesRead / pages) }) })
  }
  const onActivity = (a: Activity) => {
    // A stopped run's last events would write over the state whoever stopped it set.
    if (signal.aborted) return
    if (a.kind === 'read' && /paper\.pdf(#|$)/.test(a.path)) {
      const m = a.path.match(/#(\d+)\s*-\s*(\d+)/)
      readUpTo(m ? +m[2] : pages)
    } else if (a.kind === 'read' && /pages\/p\d+\.png$/.test(a.path)) {
      const page = parseInt(a.path.match(/p(\d+)\.png$/)![1], 10)
      // Working from images, the pages are the reading; with the PDF read, they are for the figure boxes.
      if (source === 'pages' && !partsWritten) readUpTo(page)
      else set(id, { stage: `正在定位图表（第 ${page} 页）` })
    } else if (a.kind === 'write' && /doc\/\d+\.md$/.test(a.path) && !written.has(a.path)) {
      written.add(a.path)
      partsWritten++
      set(id, {
        stage: `正在转写和翻译（第 ${partsWritten} 部分）`,
        progress: Math.min(0.85, 0.3 + 0.55 * (partsWritten / expectedParts))
      })
    }
  }

  const glossary = glossaryPrompt()
  // Development only: SHIORI_FAKE_CLAUDE=<dir> copies <dir>/<paper id>/ in place of Claude's output.
  const fake = globalThis.process.env.SHIORI_FAKE_CLAUDE
  if (fake) {
    cpSync(join(fake, id), dir, { recursive: true })
    set(id, { stage: '（开发模式）使用预置转写稿', progress: 0.85 })
    return finish(id, dir, [])
  }
  const viaCli = parseModel(model).provider !== 'openai'
  const run = { cwd: dir, model, effort: getSettings().processEffort, write: true, keep: true, onActivity, signal }
  let first: Awaited<ReturnType<typeof runAgent>> | undefined
  // The same Claude Code session, which still has the paper in mind; ChatGPT's threads don't outlive the app.
  // Only a session that is gone starts a new one; any other failure stops here with the progress kept.
  if (resume && viaCli && before?.processSession) {
    first = await runAgent({ ...run, prompt: resumePrompt(parts), session: before.processSession })
    if (first.isError && /no conversation found/i.test(first.text)) first = undefined
  }
  if (!first) {
    // Its id is kept from the start, so a run cut off halfway can be resumed.
    const session = randomUUID()
    if (viaCli) set(id, { processSession: session })
    first = await runAgent({ ...run, prompt: processPrompt({ pages, glossary, source, skipAppendix }) + (resume ? carryOnNote(parts) : ''), id: session })
  }
  set(id, { processSession: first.session })
  if (first.isError) throw new Error(first.text || '处理失败')
  if (!parseDoc(readDocSource(id)).length) throw new Error('没有写出正文，可以重新处理试试')

  set(id, { stage: '正在裁剪图表', progress: 0.9 })
  const figs = await cropAll(id)
  await finish(id, dir, figs, async () => {
    const check = await runAgent({
      cwd: dir,
      prompt: verifyPrompt(figs, parseModel(model).provider === 'openai' ? 'apply_patch' : undefined),
      model,
      effort: getSettings().processEffort,
      write: true,
      session: first.session,
      signal
    })
    if (!check.isError && !/^\s*NONE\s*$/i.test(check.text)) await cropAll(id)
  })
}

async function finish(id: string, dir: string, figs: string[], verify?: () => Promise<void>): Promise<void> {
  if (!figs.length) figs = await cropAll(id)
  else if (verify) {
    set(id, { stage: '正在检查图表裁剪', progress: 0.93 })
    await verify()
  }
  const patch: Partial<PaperMeta> = {}
  const infoPath = join(dir, 'info.json')
  if (existsSync(infoPath)) {
    try {
      const info = JSON.parse(readFileSync(infoPath, 'utf8'))
      if (info.title) patch.title = info.title
      if (info.title_zh) patch.titleZh = info.title_zh
      if (Array.isArray(info.authors) && info.authors.length) patch.authors = info.authors
      // A PDF that names no venue doesn't undo one found elsewhere, such as arXiv's journal reference.
      if (info.venue && !(isPreprint(info.venue) && !isPreprint(readMeta(id)?.venue))) {
        patch.venue = info.venue
        if (info.year) patch.year = String(info.year)
      }
      // Left out of a run told to skip it, unless the run wrote it anyway (sections A, B, ...).
      const from = Number(info.appendix_page)
      const pages = readMeta(id)?.pages ?? Infinity
      const written = parseDoc(readDocSource(id)).some((b) => b.type === 'h' && /^[A-Z](\.|$)/.test(b.attrs.num ?? ''))
      if (Number.isInteger(from) && from >= 1 && from <= pages && !written) patch.appendix = { from, parts: docParts(id).length }
    } catch {
      /* keep what we had */
    }
  }
  set(id, { ...patch, status: 'ready', stage: undefined, progress: 1, kept: undefined, processedAt: new Date().toISOString() })
}

async function writeGuide(id: string, signal: AbortSignal): Promise<void> {
  const dir = paperDir(id)
  const next = join(dir, 'summary.next.md')
  const venue = join(dir, 'venue.json')
  rmSync(next, { force: true })
  rmSync(venue, { force: true })
  const meta = readMeta(id)
  const model = await modelFor(getSettings().processModel, 'process')
  const source = sourceFor(model)
  if (source === 'pages') await ensurePaperText(id)
  const result = await runAgent({
    cwd: dir,
    prompt: guidePrompt({
      glossary: glossaryPrompt(),
      source,
      preprint: meta && awaitingVenue(meta) ? { arxiv: meta.arxiv } : undefined
    }),
    model,
    effort: getSettings().processEffort,
    write: true,
    search: true,
    files: ['summary.next.md', 'venue.json'],
    signal
  })
  if (result.isError) throw new Error(result.text || '处理失败')
  if (!existsSync(next)) throw new Error('没有写出导读')
  renameSync(next, join(dir, 'summary.md'))
  applyFoundVenue(id, venue)
}


/** The appendix of a paper processed without it, written as more doc parts after the main text's. */
async function appendixTask(id: string, ctx: TaskContext): Promise<void> {
  const meta = readMeta(id)
  // Processed again, or written meanwhile: nothing left to do.
  if (meta?.status !== 'ready' || !meta.appendix) return
  try {
    await writeAppendix(id, meta.appendix, ctx)
  } catch (e: any) {
    // Stopped: it waits in the queue again, with what it wrote kept.
    if (!ctx.signal.aborted) setAppendix(id, { state: 'error', error: String(e?.message || e) })
    throw e
  }
  set(id, { appendix: undefined })
}

async function writeAppendix(id: string, a: AppendixState, ctx: TaskContext): Promise<void> {
  const { signal } = ctx
  const dir = paperDir(id)
  const all = docParts(id)
  const mainCount = a.parts ?? all.length
  const main = all.slice(0, mainCount)
  const done = all.slice(mainCount)
  const report = (stage: string, progress?: number) => {
    if (signal.aborted) return
    if (progress !== undefined) setAppendix(id, { state: 'writing', progress })
    ctx.report(stage, progress ?? readMeta(id)?.appendix?.progress)
  }
  setAppendix(id, { parts: mainCount, state: 'writing', error: undefined, progress: done.length ? (a.progress ?? 0.3) : 0.02 })
  ctx.report('正在翻译附录', readMeta(id)?.appendix?.progress)

  const model = await modelFor(getSettings().processModel, 'process')
  const source = sourceFor(model)
  const url = pdfUrl(id)
  const { pages } = await workerCall<{ pages: number }>('info', { url })
  const from = Math.min(Math.max(1, a.from), pages)
  // The page images are kept from processing; any gone are rendered again.
  mkdirSync(join(dir, 'pages'), { recursive: true })
  for (let p = Math.max(1, from - 1); p <= pages; p++) {
    if (signal.aborted) throw new Error('已停止')
    const file = join(dir, 'pages', `p${String(p).padStart(2, '0')}.png`)
    if (!existsSync(file)) writeFileSync(file, await workerCall<Uint8Array>('render', { url, page: p, width: 1100, grid: true }))
  }
  if (source === 'pages') await ensurePaperText(id)

  const blocks = parseDoc(readDocSource(id))
  const top = (re: RegExp) => Math.max(0, ...blocks.map((b) => Number(b.id.match(re)?.[1] ?? 0)))
  const last = { p: top(/^p-(\d+)$/), l: top(/^l-(\d+)$/), eq: top(/^eq-u(\d+)$/) }
  const refs = main.find((f) => /^@@ ref /m.test(readFileSync(join(dir, f), 'utf8')))
  const next = `doc/${String(all.length + 1).padStart(2, '0')}.md`

  // Progress: appendix pages read for the first ~30%, written parts for the rest.
  const span = pages - from + 1
  const expected = Math.max(1, Math.round(span / 2.5))
  const written = new Set(all.map((f) => join(dir, f)))
  let partsWritten = done.length
  const onActivity = (act: Activity) => {
    if (signal.aborted) return
    if (act.kind === 'read' && /paper\.pdf(#|$)/.test(act.path) && !partsWritten) {
      const m = act.path.match(/#(\d+)\s*-\s*(\d+)/)
      const upTo = m ? Math.min(pages, +m[2]) : pages
      report(`正在读附录（${Math.max(0, upTo - from + 1)}/${span} 页）`, 0.05 + 0.25 * Math.min(1, Math.max(0, upTo - from + 1) / span))
    } else if (act.kind === 'read' && /pages\/p\d+\.png$/.test(act.path)) {
      const page = parseInt(act.path.match(/p(\d+)\.png$/)![1], 10)
      if (source === 'pages' && !partsWritten) report(`正在读附录（${Math.max(0, page - from + 1)}/${span} 页）`, 0.05 + 0.25 * Math.min(1, Math.max(0, page - from + 1) / span))
      else report(`正在定位图表（第 ${page} 页）`)
    } else if (act.kind === 'write' && /doc\/\d+\.md$/.test(act.path) && !written.has(act.path)) {
      written.add(act.path)
      partsWritten++
      report(`正在翻译附录（第 ${partsWritten} 部分）`, Math.min(0.85, 0.3 + 0.55 * (partsWritten / expected)))
    }
  }

  const viaCli = parseModel(model).provider !== 'openai'
  const run = { cwd: dir, model, effort: getSettings().processEffort, write: true, keep: true, onActivity, signal }
  let first: Awaited<ReturnType<typeof runAgent>> | undefined
  if (done.length && viaCli && a.session) {
    first = await runAgent({ ...run, prompt: resumePrompt(done), session: a.session })
    if (first.isError && /no conversation found/i.test(first.text)) first = undefined
  }
  if (!first) {
    const session = randomUUID()
    if (viaCli) setAppendix(id, { session })
    const prompt = appendixPrompt({ pages, from, glossary: glossaryPrompt(), source, parts: main, refs, next, last }) + (done.length ? appendixCarryOnNote(done) : '')
    first = await runAgent({ ...run, prompt, id: session })
  }
  if (viaCli && first.session) setAppendix(id, { session: first.session })
  if (first.isError) throw new Error(first.text || '翻译附录失败')
  const added = docParts(id).slice(mainCount)
  const text = added.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')
  if (!parseDoc(text).length) throw new Error('没有写出附录，可以重试')

  report('正在裁剪图表', 0.9)
  const figs = parseDoc(text).filter((b) => (b.type === 'fig' || b.type === 'tab') && b.page && b.bbox).map((b) => b.id)
  await cropAll(id)
  if (figs.length && !signal.aborted) {
    report('正在检查图表裁剪', 0.93)
    const check = await runAgent({
      cwd: dir,
      prompt: verifyPrompt(figs, parseModel(model).provider === 'openai' ? 'apply_patch' : undefined),
      model,
      effort: getSettings().processEffort,
      write: true,
      session: first.session,
      signal
    })
    if (!check.isError && !/^\s*NONE\s*$/i.test(check.text)) await cropAll(id)
  }
  if (signal.aborted) throw new Error('已停止')
}
