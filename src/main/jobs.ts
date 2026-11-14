import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PaperMeta } from '../shared/types'
import { parseDoc } from '../shared/doc'
import { listPapers, paperDir, readDocSource, readMeta, updateMeta } from './library'
import { findFolder, loadFolders } from './folders'
import { glossaryPrompt } from './glossary'
import { modelFor, runAgent, type Activity } from './ai'
import { parseModel } from '../shared/models'
import { guidePrompt, processPrompt, verifyPrompt, type Source } from './prompts'
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
    queued: (id) => set(id, { status: 'queued', stage: '等待处理', progress: 0, error: undefined }),
    stopped: (id) => set(id, { status: 'queued', stage: '等待处理', progress: 0 }),
    dropped: (id) => unqueue(id)
  })
  registerRunner('guide', {
    run: guideTask,
    queued: (id) => set(id, { guideWriting: true, guideError: undefined }),
    // also a paper stopped after processing, in its guide stage: readable, only the guide waits
    stopped: (id) => set(id, { guideWriting: true }),
    dropped: (id) => set(id, { guideWriting: undefined })
  })
}

/** The tasks the papers say are waiting, for a library from before the task list. */
export function pendingFromPapers(): { paper: string; kind: 'process' | 'guide' }[] {
  const out: { paper: string; kind: 'process' | 'guide' }[] = []
  for (const p of listPapers()) {
    if (p.status === 'processing' || p.status === 'queued') out.push({ paper: p.id, kind: 'process' })
    else if (p.guideWriting) out.push({ paper: p.id, kind: 'guide' })
  }
  return out
}

function set(id: string, patch: Partial<PaperMeta>): void {
  const meta = updateMeta(id, patch)
  if (meta) notify(meta)
  if (current?.id === id && patch.stage && meta?.status === 'processing') current.ctx.report(patch.stage, patch.progress)
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
    if (!ctx.signal.aborted) set(id, { status: 'error', stage: undefined, error: String(e?.message || e) })
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
  set(id, { status: 'processing', stage: '渲染页面', progress: 0.02, error: undefined })

  // Start clean: a previous run may have left partial output.
  for (const d of ['doc', 'figures', 'pages']) rmSync(join(dir, d), { recursive: true, force: true })
  for (const f of ['info.json', 'summary.md', 'paper.txt']) rmSync(join(dir, f), { force: true })

  const url = pdfUrl(id)
  const { pages } = await workerCall<{ pages: number }>('info', { url })
  mkdirSync(join(dir, 'pages'), { recursive: true })
  mkdirSync(join(dir, 'doc'), { recursive: true })
  for (let p = 1; p <= pages; p++) {
    if (signal.aborted) throw new Error('已取消')
    const png = await workerCall<Uint8Array>('render', { url, page: p, width: 1100, grid: true })
    writeFileSync(join(dir, 'pages', `p${String(p).padStart(2, '0')}.png`), png)
  }
  writeFileSync(join(dir, 'paper.txt'), await workerCall<string>('text', { url }))

  set(id, { pages, stage: '正在读论文', progress: 0.05, processSession: undefined, processModel: model })

  // Progress: pages read count for the first ~30%, written doc parts for the rest.
  let pagesRead = 0
  let partsWritten = 0
  const written = new Set<string>()
  const expectedParts = Math.max(3, Math.round(pages / 2.5))
  const readUpTo = (n: number) => {
    pagesRead = Math.min(pages, Math.max(pagesRead, n))
    set(id, { stage: `正在读论文（${pagesRead}/${pages} 页）`, progress: 0.05 + 0.25 * (pagesRead / pages) })
  }
  const onActivity = (a: Activity) => {
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
  const first = await runAgent({
    cwd: dir,
    prompt: processPrompt({ pages, glossary, source }),
    model,
    effort: getSettings().processEffort,
    write: true,
    keep: true,
    onActivity,
    signal
  })
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
    } catch {
      /* keep what we had */
    }
  }
  set(id, { ...patch, status: 'ready', stage: undefined, progress: 1, processedAt: new Date().toISOString() })
}

async function writeGuide(id: string, signal: AbortSignal): Promise<void> {
  const dir = paperDir(id)
  const next = join(dir, 'summary.next.md')
  const suggestion = join(dir, 'suggestion.json')
  const venue = join(dir, 'venue.json')
  rmSync(next, { force: true })
  rmSync(suggestion, { force: true })
  rmSync(venue, { force: true })
  const meta = readMeta(id)
  const model = await modelFor(getSettings().processModel, 'process')
  const source = sourceFor(model)
  if (source === 'pages') await ensurePaperText(id)
  const result = await runAgent({
    cwd: dir,
    prompt: guidePrompt({
      glossary: glossaryPrompt(),
      folders: loadFolders().map((f) => f.name),
      source,
      preprint: meta && awaitingVenue(meta) ? { arxiv: meta.arxiv } : undefined
    }),
    model,
    effort: getSettings().processEffort,
    write: true,
    search: true,
    files: ['summary.next.md', 'suggestion.json', 'venue.json'],
    signal
  })
  if (result.isError) throw new Error(result.text || '处理失败')
  if (!existsSync(next)) throw new Error('没有写出导读')
  renameSync(next, join(dir, 'summary.md'))
  applySuggestion(id, suggestion)
  applyFoundVenue(id, venue)
}

/** A paper already filed by the owner gets no suggestion. */
function applySuggestion(id: string, file: string): void {
  try {
    const name = String(JSON.parse(readFileSync(file, 'utf8')).name ?? '').trim()
    if (name && !readMeta(id)?.folders?.length) set(id, { suggestion: { name, folderId: findFolder(name)?.id } })
  } catch {
    /* the guide is what matters; no suggestion this time */
  }
  rmSync(file, { force: true })
}

