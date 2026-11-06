import { net } from 'electron'
import { plainText } from '../../shared/tex'

/*
 * A conference paper's copy on arXiv, for a paper whose data names none: arXiv's search by the whole title, then by
 * the first author and the title's key words (titles change for the camera-ready), then OpenAlex. A hit counts only
 * when its title is nearly the same and an author matches, or close with two authors matching.
 */

interface Candidate {
  id: string
  title: string
  authors: string[]
}

const STOP = new Set(
  'a an the of for and in on with to via from by is are at as its into towards toward beyond under over using without through what when how why do does can'.split(' ')
)

/** Lower-case words of a title, formulas read as their letters ("$R^2E$" → "r2e"). */
const words = (s: string) =>
  plainText(s)
    .replace(/\$([^$]*)\$/g, (_, m: string) => m.replace(/[\\{}^_]/g, ''))
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

function similarity(a: string, b: string): number {
  if (!a.length || !b.length) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length)
}

/** First and last names, so "Wei Zhang" and "Zhang Wei" meet. */
function names(list: string[]): Set<string> {
  const out = new Set<string>()
  for (const n of list) {
    const parts = n
      .normalize('NFKD')
      .replace(/[^\x00-\x7f]/g, '')
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 1)
    if (parts.length) out.add(parts[0]).add(parts[parts.length - 1])
  }
  return out
}

function same(p: { title: string; authors: string[] }, c: Candidate): boolean {
  const sim = similarity(words(p.title), words(c.title))
  const theirs = names(c.authors)
  const shared = [...names(p.authors)].filter((n) => theirs.has(n)).length
  return (sim >= 0.9 && shared >= 1) || (sim >= 0.8 && shared >= 2)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const entity = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

let next = 0

/** One arXiv search; arXiv asks for no more than a request every three seconds. */
async function search(query: string): Promise<Candidate[]> {
  const at = Math.max(Date.now(), next)
  next = at + 3100
  await sleep(at - Date.now())
  const res = await net.fetch(`https://export.arxiv.org/api/query?${new URLSearchParams({ search_query: query, max_results: '10' })}`, {
    signal: AbortSignal.timeout(30_000)
  })
  if (!res.ok) throw new Error(`arXiv ${res.status}`)
  return (await res.text())
    .split('<entry>')
    .slice(1)
    .map((e) => ({
      id: e.match(/<id>[^<]*\/abs\/([^<]+?)(?:v\d+)?<\/id>/)?.[1] ?? '',
      title: entity(e.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').replace(/\s+/g, ' ').trim(),
      authors: [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => entity(m[1]).trim())
    }))
    .filter((c) => c.id && c.title)
}

async function openAlex(title: string): Promise<Candidate[]> {
  const res = await net.fetch(`https://api.openalex.org/works?${new URLSearchParams({ search: plainText(title).slice(0, 200), per_page: '5' })}`, {
    signal: AbortSignal.timeout(30_000)
  })
  if (!res.ok) throw new Error(`OpenAlex ${res.status}`)
  const data = (await res.json()) as { results?: any[] }
  return (data.results ?? []).flatMap((w) => {
    const id = (w.locations ?? [])
      .map((l: any) => String(l.landing_page_url ?? '').match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5})/)?.[1])
      .find(Boolean)
    return id ? [{ id, title: String(w.display_name ?? w.title ?? ''), authors: (w.authorships ?? []).map((a: any) => String(a.author?.display_name ?? '')) }] : []
  })
}

/** The arXiv id of the paper, when a copy is there; throws when a search failed, as "none" would then be a guess. */
export async function findArxiv(p: { title: string; authors: string[] }): Promise<string | undefined> {
  const title = words(p.title).split(' ')
  const surname = [...names(p.authors.slice(0, 1))].pop()
  const head = p.title.includes(':') ? words(p.title.split(':')[0]).split(' ') : []
  const key = (head.length && head.length <= 4 ? head : title).filter((w) => w && !STOP.has(w)).slice(0, 4)
  const queries = [`ti:"${title.join(' ')}"`, surname && key.length ? [`au:${surname}`, ...key.map((w) => `ti:${w}`)].join(' AND ') : '']
  let failed: unknown
  const tried = (list: Promise<Candidate[]>) =>
    list.catch((err) => {
      failed = err
      return [] as Candidate[]
    })
  for (const q of queries.filter(Boolean)) {
    const hit = (await tried(search(q))).find((c) => same(p, c))
    if (hit) return hit.id
  }
  const hit = (await tried(openAlex(p.title))).find((c) => same(p, c))
  if (hit) return hit.id
  if (failed) throw failed
  return undefined
}
