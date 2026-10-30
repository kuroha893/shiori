import type { Block } from './types'

/*
 * The paper document format Claude writes (doc/01.md, doc/02.md, ...):
 *
 *   @@ p id=p-12 page=3
 *   English paragraph with $x$ inline math and a [Figure 3](#fig-3) link.
 *   @@zh
 *   中文译文，含 $x$ 和 [图 3](#fig-3)。
 *
 * A line "@@ <type> key=value key="quoted value"" starts a block; a line "@@<name>"
 * switches to another section of the same block. Text before the first section
 * marker is the "en" section.
 */

const TYPES = new Set(['h', 'p', 'eq', 'fig', 'tab', 'list', 'quote', 'code', 'ref', 'note'])

function parseAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const m of text.matchAll(/([\w-]+)=(?:"([^"]*)"|(\S+))/g)) attrs[m[1]] = m[2] ?? m[3]
  return attrs
}

export function parseDoc(source: string): Block[] {
  const blocks: Block[] = []
  const seen = new Set<string>()
  let cur: Block | undefined
  let section = 'en'
  let buf: string[] = []

  const flush = () => {
    if (!cur) return
    const text = buf.join('\n').trim()
    if (text) cur.parts[section] = cur.parts[section] ? cur.parts[section] + '\n\n' + text : text
    buf = []
  }

  for (const line of source.split(/\r?\n/)) {
    const start = line.match(/^@@\s+([a-z]+)\b(.*)$/)
    if (start && TYPES.has(start[1])) {
      flush()
      const attrs = parseAttrs(start[2])
      let id = attrs.id || `b${blocks.length + 1}`
      while (seen.has(id)) id += '_'
      seen.add(id)
      const page = attrs.page ? parseInt(attrs.page, 10) : undefined
      const box = attrs.bbox?.split(',').map(Number)
      cur = {
        id,
        type: start[1] as Block['type'],
        attrs,
        parts: {},
        page: Number.isFinite(page) ? page : undefined,
        bbox: box && box.length === 4 && box.every(Number.isFinite) ? (box as Block['bbox']) : undefined
      }
      blocks.push(cur)
      section = 'en'
      continue
    }
    const sw = line.match(/^@@([a-z]+)\s*$/)
    if (sw && cur) {
      flush()
      section = sw[1]
      continue
    }
    buf.push(line)
  }
  flush()
  return blocks
}
