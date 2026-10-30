import { shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { Annotation, ChatState, PaperMeta, PaperDoc } from '../shared/types'
import { getSettings } from './settings'
import { parseDoc } from '../shared/doc'

export const root = () => getSettings().libraryPath
export const papersDir = () => join(root(), 'papers')
export const paperDir = (id: string) => join(papersDir(), id)

export const DEFAULT_PROFILE = `# 我的研究者档案

<!-- Claude 在讲解和翻译时会读这份档案。随时改。 -->

- 身份：即将读研的学生，本科软件工程
- 方向：
- 已经比较熟悉的：
- 还不熟悉、需要讲细一点的：
- 讲解偏好：用中文，先讲直觉再讲公式，符号要说明含义
`

export const DEFAULT_GLOSSARY = `# 术语表

<!-- 翻译时会遵循这里的译法。一行一个：英文 → 中文；写"不译"则保留英文。 -->

embodied AI → 具身智能
Transformer → 不译
token → 不译
fine-tuning → 微调
benchmark → 基准
ablation study → 消融实验
`

export function ensureLibrary(): void {
  mkdirSync(papersDir(), { recursive: true })
  const profile = join(root(), 'profile.md')
  if (!existsSync(profile)) writeFileSync(profile, DEFAULT_PROFILE)
  const glossary = join(root(), 'glossary.md')
  if (!existsSync(glossary)) writeFileSync(glossary, DEFAULT_GLOSSARY)
}

/** Resolve a path inside a paper folder, refusing anything that escapes it. */
export function paperFile(id: string, rel: string): string {
  const dir = resolve(paperDir(id))
  const full = resolve(dir, rel)
  if (full !== dir && !full.startsWith(dir + sep)) throw new Error('path outside paper folder')
  return full
}

export function readMeta(id: string): PaperMeta | undefined {
  try {
    return JSON.parse(readFileSync(join(paperDir(id), 'meta.json'), 'utf8'))
  } catch {
    return undefined
  }
}

export function writeMeta(meta: PaperMeta): void {
  writeFileSync(join(paperDir(meta.id), 'meta.json'), JSON.stringify(meta, null, 2))
}

export function updateMeta(id: string, patch: Partial<PaperMeta>): PaperMeta | undefined {
  const meta = readMeta(id)
  if (!meta) return undefined
  const next = { ...meta, ...patch }
  writeMeta(next)
  return next
}

export function listPapers(): PaperMeta[] {
  ensureLibrary()
  const out: PaperMeta[] = []
  for (const name of readdirSync(papersDir())) {
    if (name.startsWith('.')) continue
    const meta = readMeta(name)
    if (meta) out.push(meta)
  }
  return out.sort((a, b) => (b.addedAt > a.addedAt ? 1 : -1))
}

function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/\.pdf$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return s || 'paper'
}

function newMeta(id: string, title: string, extra: Partial<PaperMeta> = {}): PaperMeta {
  return { id, title, authors: [], tags: [], addedAt: new Date().toISOString(), status: 'new', ...extra }
}

export function importPdf(path: string): PaperMeta {
  ensureLibrary()
  const hash = createHash('sha1').update(readFileSync(path)).digest('hex').slice(0, 6)
  const id = `${slug(basename(path))}-${hash}`
  const existing = readMeta(id)
  if (existing) return existing
  mkdirSync(paperDir(id), { recursive: true })
  copyFileSync(path, join(paperDir(id), 'paper.pdf'))
  const meta = newMeta(id, basename(path).replace(/\.pdf$/i, ''))
  writeMeta(meta)
  return meta
}

/** Accepts 2310.06825, 2310.06825v2, arxiv.org/abs/..., arxiv.org/pdf/..., and old-style ids like cs/0112017 */
export function parseArxivId(input: string): string | undefined {
  const s = input.trim()
  const m =
    s.match(/arxiv\.org\/(?:abs|pdf|html)\/([\w.\-/]+?)(?:\.pdf)?(?:[?#].*)?$/i) ||
    s.match(/^(?:arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?)$/i) ||
    s.match(/^(?:arxiv:)?([a-z\-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/i)
  return m?.[1]
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

export async function importArxiv(input: string): Promise<PaperMeta> {
  const arxiv = parseArxivId(input)
  if (!arxiv) throw new Error('认不出这个 arXiv 编号或链接')
  ensureLibrary()
  const id = arxiv.replace(/\//g, '_')
  const existing = readMeta(id)
  if (existing) return existing

  const feed = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxiv)}`)
  if (!feed.ok) throw new Error(`arXiv 返回 ${feed.status}`)
  const xml = await feed.text()
  const entry = xml.split('<entry>')[1]
  if (!entry || /<title>Error<\/title>/.test(entry)) throw new Error('arXiv 上找不到这篇论文')
  const pick = (tag: string) => decode(entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? '')
  const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => decode(m[1]))
  const venue = decode(entry.match(/<arxiv:journal_ref[^>]*>([\s\S]*?)<\/arxiv:journal_ref>/)?.[1] ?? '') || 'arXiv'

  const pdf = await fetch(`https://arxiv.org/pdf/${arxiv}`)
  if (!pdf.ok) throw new Error(`下载 PDF 失败（${pdf.status}）`)
  const bytes = Buffer.from(await pdf.arrayBuffer())
  if (bytes.subarray(0, 4).toString() !== '%PDF') throw new Error('下载到的文件不是 PDF')

  mkdirSync(paperDir(id), { recursive: true })
  writeFileSync(join(paperDir(id), 'paper.pdf'), bytes)
  const meta = newMeta(id, pick('title'), {
    authors,
    arxiv,
    venue,
    year: pick('published').slice(0, 4),
    abstract: pick('summary')
  })
  writeMeta(meta)
  return meta
}

export async function trashPaper(id: string): Promise<void> {
  await shell.trashItem(paperDir(id))
}

export function revealPaper(id: string): void {
  shell.showItemInFolder(join(paperDir(id), 'paper.pdf'))
}

/** Concatenate doc/01.md, doc/02.md, ... in order. */
export function readDocSource(id: string): string {
  const dir = join(paperDir(id), 'doc')
  if (!existsSync(dir)) return ''
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
}

export function loadDoc(id: string): PaperDoc {
  const summaryPath = join(paperDir(id), 'summary.md')
  return {
    blocks: parseDoc(readDocSource(id)),
    summary: existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : undefined
  }
}

async function readJson<T>(id: string, name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(join(paperDir(id), name), 'utf8'))
  } catch {
    return fallback
  }
}

export const loadAnnotations = (id: string) => readJson<Annotation[]>(id, 'annotations.json', [])
export const saveAnnotations = (id: string, list: Annotation[]) =>
  writeFile(join(paperDir(id), 'annotations.json'), JSON.stringify(list, null, 2))

export const loadChat = (id: string) => readJson<ChatState>(id, 'chat.json', { messages: [] })
export const saveChat = (id: string, chat: ChatState) =>
  writeFile(join(paperDir(id), 'chat.json'), JSON.stringify(chat, null, 2))

export function readRootText(name: 'profile.md' | 'glossary.md'): string {
  ensureLibrary()
  return readFileSync(join(root(), name), 'utf8')
}

export function writeRootText(name: 'profile.md' | 'glossary.md', text: string): void {
  ensureLibrary()
  writeFileSync(join(root(), name), text)
}

export function fileExists(id: string, rel: string): boolean {
  try {
    return statSync(paperFile(id, rel)).isFile()
  } catch {
    return false
  }
}
