import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ort from 'onnxruntime-node'
import { Tokenizer } from '@huggingface/tokenizers'
import MiniSearch from 'minisearch'
import { plainText } from '../../shared/tex'
import { SEARCH_MODEL } from '../../shared/conferences'

/*
 * Finding papers, in a utility process of its own: the usual hybrid search. A keyword index (BM25) catches the exact
 * terms, a small multilingual embedding model (multilingual-e5-small) catches the same idea in other words or in
 * Chinese, and the two rankings are fused by reciprocal rank. Every paper's Chinese title goes into both, so Chinese
 * queries meet Chinese text. The model's vectors are kept per edition next to its papers (vectors.bin + vectors.json)
 * and only papers whose text changed are embedded again.
 */

type Paper = { key: string; title: string; titleZh?: string; abstract?: string }
type In =
  | { type: 'init'; root: string }
  | { type: 'model'; dir: string }
  | { type: 'load'; ref: string }
  | { id: number; type: 'index'; ref: string }
  | { id: number; type: 'search'; query: string; edition?: string }

const DIM = 384
const BATCH = 8
/** RRF's constant, as everyone uses it */
const K = 60
/** The model's share of a search: its best papers, as long as they are close to its very best */
const SEMANTIC_TOP = 50
const SEMANTIC_SPREAD = 0.03

let root = ''
const post = (m: unknown) => process.parentPort.postMessage(m)

/* ---------- keyword index ---------- */

const cjk = /[㐀-鿿]/
/** Latin words as they are; Chinese, which has no spaces, as overlapping pairs of characters. */
function tokenize(s: string): string[] {
  const out: string[] = []
  for (const run of s.toLowerCase().match(/[㐀-鿿]+|[a-z0-9][a-z0-9\-+.]*/g) ?? []) {
    if (cjk.test(run)) {
      if (run.length === 1) out.push(run)
      for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
    } else out.push(run.replace(/[.\-+]+$/, ''))
  }
  return out
}

const index = new MiniSearch<{ id: string; title: string; zh: string; abstract: string }>({
  fields: ['title', 'zh', 'abstract'],
  storeFields: [],
  tokenize,
  searchOptions: { boost: { title: 3, zh: 2 }, prefix: (t) => t.length > 3, fuzzy: (t) => (t.length > 5 ? 0.15 : 0), combineWith: 'AND' }
})
/** The ids each edition has in the index */
const indexed = new Map<string, string[]>()

const papersOf = (ref: string): Paper[] => {
  try {
    return JSON.parse(readFileSync(join(root, ref, 'papers.json'), 'utf8'))
  } catch {
    return []
  }
}

function load(ref: string): void {
  const old = indexed.get(ref)
  if (old?.length) index.discardAll(old)
  const papers = papersOf(ref)
  index.addAll(papers.map((p) => ({ id: `${ref}/${p.key}`, title: plainText(p.title), zh: p.titleZh ?? '', abstract: plainText(p.abstract ?? '') })))
  indexed.set(ref, papers.map((p) => `${ref}/${p.key}`))
  vectors.set(ref, readVectors(ref))
}

/* ---------- vectors ---------- */

type Vectors = { keys: string[]; hashes: string[]; data: Float32Array }
const vectors = new Map<string, Vectors>()

const passage = (p: Paper) => `passage: ${p.titleZh ? `${p.titleZh}。` : ''}${plainText(p.title)}. ${plainText(p.abstract ?? '').slice(0, 1500)}`
const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12)

function readVectors(ref: string): Vectors {
  try {
    const meta = JSON.parse(readFileSync(join(root, ref, 'vectors.json'), 'utf8'))
    if (meta.model !== SEARCH_MODEL) throw new Error('other model')
    const buf = readFileSync(join(root, ref, 'vectors.bin'))
    const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice()
    if (data.length !== meta.keys.length * DIM) throw new Error('size')
    return { keys: meta.keys, hashes: meta.hashes, data }
  } catch {
    return { keys: [], hashes: [], data: new Float32Array(0) }
  }
}

function writeVectors(ref: string, v: Vectors): void {
  const dir = join(root, ref)
  if (!existsSync(dir)) return
  writeFileSync(join(dir, 'vectors.bin.tmp'), Buffer.from(v.data.buffer, v.data.byteOffset, v.data.byteLength))
  writeFileSync(join(dir, 'vectors.json.tmp'), JSON.stringify({ model: SEARCH_MODEL, keys: v.keys, hashes: v.hashes }))
  renameSync(join(dir, 'vectors.bin.tmp'), join(dir, 'vectors.bin'))
  renameSync(join(dir, 'vectors.json.tmp'), join(dir, 'vectors.json'))
}

/* ---------- the model ---------- */

let model: { session: ort.InferenceSession; tok: Tokenizer } | undefined

async function loadModel(dir: string): Promise<void> {
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'))
  const tok = new Tokenizer(read('tokenizer.json'), read('tokenizer_config.json'))
  const session = await ort.InferenceSession.create(join(dir, 'onnx', 'model_quantized.onnx'))
  model = { session, tok }
}

/** Mean of the last hidden states over the real tokens, normalised: what e5 is trained for. */
async function embed(texts: string[]): Promise<Float32Array[]> {
  const { session, tok } = model!
  const encs = texts.map((t) => tok.encode(t).ids.slice(0, 512))
  const L = Math.max(...encs.map((e) => e.length))
  const ids = new BigInt64Array(texts.length * L)
  const mask = new BigInt64Array(texts.length * L)
  encs.forEach((e, b) => e.forEach((id, i) => ((ids[b * L + i] = BigInt(id)), (mask[b * L + i] = 1n))))
  const shape = [texts.length, L]
  const feeds: Record<string, ort.Tensor> = { input_ids: new ort.Tensor('int64', ids, shape), attention_mask: new ort.Tensor('int64', mask, shape) }
  if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(texts.length * L), shape)
  const out = (await session.run(feeds))[session.outputNames[0]]
  const h = out.data as Float32Array
  return encs.map((e, b) => {
    const v = new Float32Array(DIM)
    for (let i = 0; i < e.length; i++) for (let d = 0; d < DIM; d++) v[d] += h[(b * L + i) * DIM + d]
    let norm = 0
    for (let d = 0; d < DIM; d++) norm += v[d] * v[d]
    norm = Math.sqrt(norm) || 1
    for (let d = 0; d < DIM; d++) v[d] /= norm
    return v
  })
}

/** Embeds the papers of an edition whose text is new or changed, saving as it goes. */
async function indexEdition(ref: string): Promise<number> {
  if (!model) throw new Error('no model')
  const papers = papersOf(ref)
  const old = vectors.get(ref) ?? readVectors(ref)
  const at = new Map(old.keys.map((k, i) => [k, i]))
  const keys: string[] = []
  const hashes: string[] = []
  const data = new Float32Array(papers.length * DIM)
  const todo: { i: number; text: string }[] = []
  papers.forEach((p, i) => {
    const text = passage(p)
    const h = hash(text)
    keys.push(p.key)
    hashes.push(h)
    const j = at.get(p.key)
    if (j !== undefined && old.hashes[j] === h) data.set(old.data.subarray(j * DIM, (j + 1) * DIM), i * DIM)
    else todo.push({ i, text })
  })
  const v = { keys, hashes, data }
  if (!todo.length) {
    if (old.keys.length !== keys.length) writeVectors(ref, v)
    vectors.set(ref, v)
    return 0
  }
  let since = 0
  for (let n = 0; n < todo.length; n += BATCH) {
    const batch = todo.slice(n, n + BATCH)
    const out = await embed(batch.map((b) => b.text))
    batch.forEach((b, k) => data.set(out[k], b.i * DIM))
    post({ type: 'progress', ref, done: Math.min(n + BATCH, todo.length), total: todo.length })
    // Saved every few hundred papers, so closing Shiori halfway loses little. Unembedded papers are saved with an
    // empty hash and done next time.
    if ((since += batch.length) >= 400) {
      since = 0
      const done = new Set(todo.slice(n + BATCH).map((t) => t.i))
      writeVectors(ref, { keys, hashes: hashes.map((h, i) => (done.has(i) ? '' : h)), data })
    }
  }
  writeVectors(ref, v)
  vectors.set(ref, v)
  return todo.length
}

/* ---------- search ---------- */

async function search(query: string, edition?: string): Promise<string[]> {
  const inScope = (id: string) => !edition || id.startsWith(`${edition}/`)
  const scope = edition ? { filter: (r: { id: string }) => inScope(r.id) } : {}
  // Every word, or failing that the best of any: Chinese pairs that straddle two words ("型幻" in 大模型幻觉) appear nowhere.
  let found = index.search(query, scope)
  if (!found.length) found = index.search(query, { ...scope, combineWith: 'OR' })
  const keyword = found.slice(0, 300).map((r) => r.id as string)

  const semantic: string[] = []
  if (model) {
    const [q] = await embed([`query: ${query}`])
    const scored: { id: string; s: number }[] = []
    for (const [ref, v] of vectors) {
      if (edition && ref !== edition) continue
      // An edition still being embedded sits this out: the model would pick its best from a fraction of the papers.
      if (v.keys.length !== indexed.get(ref)?.length || v.hashes.some((h) => !h)) continue
      for (let i = 0; i < v.keys.length; i++) {
        let s = 0
        const o = i * DIM
        for (let d = 0; d < DIM; d++) s += v.data[o + d] * q[d]
        scored.push({ id: `${ref}/${v.keys[i]}`, s })
      }
    }
    scored.sort((a, b) => b.s - a.s)
    const best = scored[0]?.s ?? 0
    for (const x of scored.slice(0, SEMANTIC_TOP)) if (x.s >= best - SEMANTIC_SPREAD) semantic.push(x.id)
  }

  const fused = new Map<string, number>()
  for (const list of [keyword, semantic]) list.forEach((id, r) => fused.set(id, (fused.get(id) ?? 0) + 1 / (K + r + 1)))
  return [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

/* ---------- messages ---------- */

const editionsOnDisk = (): string[] =>
  existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((c) =>
          readdirSync(join(root, c.name), { withFileTypes: true })
            .filter((y) => y.isDirectory() && /^\d{4}$/.test(y.name) && existsSync(join(root, c.name, y.name, 'papers.json')))
            .map((y) => `${c.name}/${y.name}`)
        )
    : []

// Searches wait for the start-up load; everything else runs in order as it comes.
let ready: Promise<void> = Promise.resolve()

process.parentPort.on('message', (e: { data: In }) => {
  const m = e.data
  const reply = (p: Promise<unknown>) =>
    p.then(
      (result) => post({ id: (m as { id: number }).id, result }),
      (err) => post({ id: (m as { id: number }).id, error: String((err as Error)?.message || err) })
    )
  switch (m.type) {
    case 'init':
      root = m.root
      ready = new Promise((ok) => {
        // Let the reply loop run first: loading every edition takes a few seconds.
        setTimeout(() => {
          for (const ref of editionsOnDisk())
            try {
              load(ref)
            } catch (err) {
              post({ type: 'log', text: `load ${ref}: ${err}` })
            }
          ok()
        }, 0)
      })
      break
    case 'model':
      ready = ready.then(() => loadModel(m.dir)).catch((err) => post({ type: 'log', text: `model: ${err}` }))
      break
    case 'load':
      ready = ready.then(() => load(m.ref)).catch((err) => post({ type: 'log', text: `load ${m.ref}: ${err}` }))
      break
    case 'index':
      reply(ready.then(() => indexEdition(m.ref)))
      break
    case 'search':
      reply(ready.then(() => search(m.query, m.edition)))
      break
  }
})
