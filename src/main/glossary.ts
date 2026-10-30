import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GlossaryEntry } from '../shared/types'
import { DEFAULT_GLOSSARY, root } from './library'

/* The glossary lives in <library>/glossary.json and goes into every processing and chat prompt. */

const file = () => join(root(), 'glossary.json')
const key = (en: string) => en.trim().toLowerCase()

function fromMarkdown(md: string): GlossaryEntry[] {
  const out: GlossaryEntry[] = []
  for (const raw of md.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const m = raw.trim().match(/^[-*]?\s*(.+?)\s*(?:→|->|=>|：)\s*(.+)$/)
    if (!m || m[1].startsWith('#')) continue
    const keep = /^(不译|保留|keep)$/i.test(m[2].trim())
    out.push({ id: randomUUID(), en: m[1].trim(), zh: keep ? undefined : m[2].trim(), keep: keep || undefined })
  }
  return out
}

function save(entries: GlossaryEntry[]): void {
  entries.sort((a, b) => a.en.localeCompare(b.en, 'en', { sensitivity: 'base' }))
  writeFileSync(file(), JSON.stringify(entries, null, 2))
}

export function loadGlossary(): GlossaryEntry[] {
  if (existsSync(file())) {
    try {
      const data = JSON.parse(readFileSync(file(), 'utf8'))
      return Array.isArray(data) ? data : (data.entries ?? [])
    } catch {
      renameSync(file(), file() + '.broken')
    }
  }
  // First run with the structured glossary: carry over the old plain-text one.
  const md = join(root(), 'glossary.md')
  const entries = fromMarkdown(existsSync(md) ? readFileSync(md, 'utf8') : DEFAULT_GLOSSARY)
  save(entries)
  if (existsSync(md)) renameSync(md, join(root(), 'glossary-old.md'))
  return entries
}

export function saveEntry(entry: Omit<GlossaryEntry, 'id'> & { id?: string }): GlossaryEntry[] {
  const entries = loadGlossary()
  const en = entry.en.trim()
  if (!en) throw new Error('英文不能为空')
  if (entries.some((e) => key(e.en) === key(en) && e.id !== entry.id)) throw new Error(`已经有「${en}」了`)
  const next: GlossaryEntry = {
    id: entry.id ?? randomUUID(),
    en,
    zh: entry.keep ? undefined : entry.zh?.trim() || undefined,
    keep: entry.keep || undefined
  }
  save([...entries.filter((e) => e.id !== next.id), next])
  return loadGlossary()
}

export function deleteEntry(id: string): GlossaryEntry[] {
  save(loadGlossary().filter((e) => e.id !== id))
  return loadGlossary()
}

/** The glossary as prompt text. */
export function glossaryPrompt(): string {
  const entries = loadGlossary()
  if (!entries.length) return '(empty)'
  return entries.map((e) => `${e.en} → ${e.keep ? '不译（保留英文）' : e.zh || '（译法未定）'}`).join('\n')
}
