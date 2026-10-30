import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PaperMeta } from '../shared/types'
import { parseDoc } from '../shared/doc'
import { listPapers, paperDir, readDocSource, readMeta, readRootText, updateMeta } from './library'
import { glossaryPrompt } from './glossary'
import { runClaude } from './claude'
import { guidePrompt, processPrompt, verifyPrompt } from './prompts'
import { getSettings } from './settings'
import { workerCall } from './worker'

type Notify = (meta: PaperMeta) => void

let notify: Notify = () => {}
let running: { id: string; abort: AbortController } | undefined
const queue: string[] = []
const guides = new Map<string, AbortController>()

export function initJobs(onChange: Notify): void {
  notify = onChange
  // A job interrupted by quitting starts over.
  for (const p of listPapers()) {
    if (p.status === 'processing' || p.status === 'queued') {
      set(p.id, { status: 'queued', stage: '等待处理', progress: 0 })
      queue.push(p.id)
    } else if (p.guideWriting) {
      set(p.id, { guideWriting: undefined })
      startGuide(p.id)
    }
  }
  pump()
}

function set(id: string, patch: Partial<PaperMeta>): void {
  const meta = updateMeta(id, patch)
  if (meta) notify(meta)
}

export const pdfUrl = (id: string) => `shiori://paper/${encodeURIComponent(id)}/paper.pdf`

/** Page count and first-page thumbnail; cheap, done on import. */
export async function prepare(id: string): Promise<void> {
  const url = pdfUrl(id)
  const { pages } = await workerCall<{ pages: number }>('info', { url })
  const thumb = await workerCall<Uint8Array>('render', { url, page: 1, width: 520 })
  writeFileSync(join(paperDir(id), 'thumb.png'), thumb)
  set(id, { pages })
}

export function enqueue(id: string): void {
  if (running?.id === id || queue.includes(id)) return
  guides.get(id)?.abort()
  queue.push(id)
  set(id, { status: 'queued', stage: '等待处理', progress: 0, error: undefined })
  pump()
}

export function cancel(id: string): void {
  const i = queue.indexOf(id)
  if (i >= 0) queue.splice(i, 1)
  if (running?.id === id) running.abort.abort()
  guides.get(id)?.abort()
  const meta = readMeta(id)
  if (meta && meta.status !== 'ready') set(id, { status: meta.processedAt ? 'ready' : 'new', stage: undefined, progress: undefined })
}

function pump(): void {
  if (running || !queue.length) return
  const id = queue.shift()!
  const abort = new AbortController()
  running = { id, abort }
  runJob(id, abort.signal)
    .catch((e) => {
      if (abort.signal.aborted) return
      set(id, { status: 'error', stage: undefined, error: String(e?.message || e) })
    })
    .finally(() => {
      running = undefined
      pump()
    })
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
  const settings = getSettings()
  set(id, { status: 'processing', stage: '渲染页面', progress: 0.02, error: undefined })

  // Start clean: a previous run may have left partial output.
  for (const d of ['doc', 'figures', 'pages']) rmSync(join(dir, d), { recursive: true, force: true })
  for (const f of ['info.json', 'summary.md']) rmSync(join(dir, f), { force: true })

  const url = pdfUrl(id)
  const { pages } = await workerCall<{ pages: number }>('info', { url })
  mkdirSync(join(dir, 'pages'), { recursive: true })
  mkdirSync(join(dir, 'doc'), { recursive: true })
  for (let p = 1; p <= pages; p++) {
    if (signal.aborted) throw new Error('已取消')
    const png = await workerCall<Uint8Array>('render', { url, page: p, width: 1100, grid: true })
    writeFileSync(join(dir, 'pages', `p${String(p).padStart(2, '0')}.png`), png)
  }

  const sessionId = randomUUID()
  set(id, { pages, stage: 'Claude 正在读论文', progress: 0.05, processSession: sessionId, processModel: settings.processModel })

  // Progress: pages read count for the first ~30%, written doc parts for the rest.
  let pagesRead = 0
  let partsWritten = 0
  const expectedParts = Math.max(3, Math.round(pages / 2.5))
  const onEvent = (event: any) => {
    if (event.type !== 'assistant') return
    for (const c of event.message?.content ?? []) {
      if (c.type !== 'tool_use') continue
      const input = c.input ?? {}
      const file = String(input.file_path ?? '')
      if (c.name === 'Read' && file.endsWith('paper.pdf')) {
        const m = String(input.pages ?? '').match(/(\d+)\s*-\s*(\d+)/)
        pagesRead = Math.min(pages, m ? Math.max(pagesRead, +m[2]) : pages)
        set(id, { stage: `Claude 正在读论文（${pagesRead}/${pages} 页）`, progress: 0.05 + 0.25 * (pagesRead / pages) })
      } else if (c.name === 'Read' && /pages\/p\d+\.png$/.test(file)) {
        set(id, { stage: `正在定位图表（第 ${parseInt(file.match(/p(\d+)\.png$/)![1], 10)} 页）` })
      } else if (c.name === 'Write' && /doc\/\d+\.md$/.test(file)) {
        partsWritten++
        set(id, {
          stage: `正在转写和翻译（第 ${partsWritten} 部分）`,
          progress: Math.min(0.85, 0.3 + 0.55 * (partsWritten / expectedParts))
        })
      }
    }
  }

  const glossary = glossaryPrompt()
  const profile = readRootText('profile.md')
  // Development only: SHIORI_FAKE_CLAUDE=<dir> copies <dir>/<paper id>/ in place of Claude's output.
  const fake = globalThis.process.env.SHIORI_FAKE_CLAUDE
  if (fake) {
    cpSync(join(fake, id), dir, { recursive: true })
    set(id, { stage: '（开发模式）使用预置转写稿', progress: 0.85 })
    return finish(id, dir, [])
  }
  const first = await runClaude({
    cwd: dir,
    prompt: processPrompt({ pages, glossary, profile }),
    model: settings.processModel,
    tools: ['Read', 'Write', 'Edit', 'Glob'],
    sessionId,
    writable: true,
    onEvent,
    signal
  })
  if (first.isError) throw new Error(first.text || 'Claude 处理失败')
  if (!parseDoc(readDocSource(id)).length) throw new Error('Claude 没有写出正文，可以重新处理试试')

  set(id, { stage: '正在裁剪图表', progress: 0.9 })
  const figs = await cropAll(id)
  await finish(id, dir, figs, async () => {
    const check = await runClaude({
      cwd: dir,
      prompt: verifyPrompt(figs),
      model: settings.processModel,
      tools: ['Read', 'Edit', 'Glob'],
      sessionId,
      resume: true,
      writable: true,
      signal
    })
    if (!check.isError && !/^\s*NONE\s*$/i.test(check.text)) await cropAll(id)
  })
  startGuide(id)
}

async function finish(id: string, dir: string, figs: string[], verify?: () => Promise<void>): Promise<void> {
  if (!figs.length) figs = await cropAll(id)
  else if (verify) {
    set(id, { stage: 'Claude 正在检查图表裁剪', progress: 0.93 })
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
      if (info.venue) patch.venue = info.venue
      if (info.year) patch.year = String(info.year)
    } catch {
      /* keep what we had */
    }
  }
  set(id, { ...patch, status: 'ready', stage: undefined, progress: 1, processedAt: new Date().toISOString() })
}

/** Write or rewrite the guide in the background; the paper stays readable, and an old guide stays until the new one is done. */
export function startGuide(id: string): void {
  if (guides.has(id)) return
  const abort = new AbortController()
  guides.set(id, abort)
  set(id, { guideWriting: true, guideError: undefined })
  writeGuide(id, abort.signal)
    .then(() => set(id, { guideWriting: undefined }))
    .catch((e) => set(id, { guideWriting: undefined, guideError: abort.signal.aborted ? undefined : String(e?.message || e) }))
    .finally(() => guides.delete(id))
}

async function writeGuide(id: string, signal: AbortSignal): Promise<void> {
  const dir = paperDir(id)
  const next = join(dir, 'summary.next.md')
  rmSync(next, { force: true })
  const result = await runClaude({
    cwd: dir,
    prompt: guidePrompt({ glossary: glossaryPrompt(), profile: readRootText('profile.md') }),
    model: getSettings().processModel,
    tools: ['Read', 'Glob', 'Write', 'WebSearch'],
    allowedTools: ['WebSearch'],
    sessionId: randomUUID(),
    writable: true,
    signal
  })
  if (result.isError) throw new Error(result.text || 'Claude 处理失败')
  if (!existsSync(next)) throw new Error('Claude 没有写出导读')
  renameSync(next, join(dir, 'summary.md'))
}

export const isRunning = (id: string) => running?.id === id
