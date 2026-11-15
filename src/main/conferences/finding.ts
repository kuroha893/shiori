import { app, net, utilityProcess, type UtilityProcess } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SEARCH_MODEL } from '../../shared/conferences'
import { confRoot } from './store'

/*
 * The main side of paper search: the search itself runs in finder.ts, in a utility process, so building the index and
 * embedding papers never hold up the window. This file starts it, fetches the model once, and passes requests on.
 * When the process can't run, search falls back on plain word matching (searchScore).
 */

/** multilingual-e5-small as converted for ONNX, pinned to one revision and checked by hash */
const REPO = 'Xenova/multilingual-e5-small'
const REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
const FILES = [
  { path: 'tokenizer.json', sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' },
  { path: 'tokenizer_config.json', sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b' },
  { path: 'onnx/model_quantized.onnx', sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193' }
]
/** Hugging Face, then its mirror for networks that can't reach it */
const HOSTS = ['https://huggingface.co', 'https://hf-mirror.com']

const modelDir = () => join(app.getPath('userData'), 'models', SEARCH_MODEL)
const verifiedFile = () => join(modelDir(), 'verified')

export const modelReady = () => existsSync(verifiedFile())

/** Downloads the model's three files through Electron's network stack (which follows the system proxy). */
export async function ensureModel(): Promise<void> {
  if (modelReady()) return
  for (const f of FILES) {
    const file = join(modelDir(), f.path)
    if (existsSync(file) && sha256(readFileSync(file)) === f.sha256) continue
    let last = ''
    let done = false
    for (const host of HOSTS) {
      try {
        const res = await net.fetch(`${host}/${REPO}/resolve/${REVISION}/${f.path}`, { signal: AbortSignal.timeout(20 * 60_000) })
        if (!res.ok) throw new Error(`${res.status}`)
        const bytes = Buffer.from(await res.arrayBuffer())
        if (sha256(bytes) !== f.sha256) throw new Error('hash mismatch')
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(`${file}.part`, bytes)
        renameSync(`${file}.part`, file)
        done = true
        break
      } catch (e) {
        last = `${host}: ${(e as Error).message}`
      }
    }
    if (!done) throw new Error(`search model ${f.path}: ${last}`)
  }
  writeFileSync(verifiedFile(), REVISION)
  child?.postMessage({ type: 'model', dir: modelDir() })
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/* ---------- the process ---------- */

let child: UtilityProcess | undefined
let childRoot = ''
let seq = 0
const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>()
const progress = new Map<string, (done: number, total: number) => void>()
/** After a crash, the process is left alone for a minute rather than restarted in a loop */
let restAfterCrash = 0

function worker(): UtilityProcess | undefined {
  if (child && childRoot !== confRoot()) stop()
  if (child) return child
  if (Date.now() < restAfterCrash) return undefined
  const c = utilityProcess.fork(join(__dirname, 'finder.js'), [], { serviceName: 'Shiori search', stdio: 'ignore' })
  c.on('message', (m: any) => {
    if (m.type === 'progress') return progress.get(m.ref)?.(m.done, m.total)
    if (m.type === 'log') return console.error('[search]', m.text)
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.error) p.fail(new Error(m.error))
    else p.ok(m.result)
  })
  c.on('exit', () => {
    if (child !== c) return
    child = undefined
    restAfterCrash = Date.now() + 60_000
    for (const p of pending.values()) p.fail(new Error('search process ended'))
    pending.clear()
  })
  childRoot = confRoot()
  c.postMessage({ type: 'init', root: childRoot })
  if (modelReady()) c.postMessage({ type: 'model', dir: modelDir() })
  child = c
  return c
}

function call<T>(m: Record<string, unknown>): Promise<T> {
  const c = worker()
  if (!c) return Promise.reject(new Error('search process resting after a crash'))
  const id = ++seq
  return new Promise<T>((ok, fail) => {
    pending.set(id, { ok, fail })
    c.postMessage({ ...m, id })
  })
}

/** Started ahead of the first search, which would otherwise wait for every edition to be read in. */
export function warm(): void {
  worker()
}

export function stop(): void {
  const c = child
  child = undefined
  c?.kill()
}

/** Paper ids ("<conf>/<year>/<key>"), best first; undefined when the search process isn't there to ask. */
export async function search(query: string, edition?: string): Promise<string[] | undefined> {
  try {
    return await call<string[]>({ type: 'search', query, edition })
  } catch (e) {
    console.error('[search]', e)
    return undefined
  }
}

/** An edition's papers changed or went away: the process reads them again (if it's running; otherwise it will). */
export function reload(ref: string): void {
  child?.postMessage({ type: 'load', ref })
}

/** Embeds the edition's new and changed papers; resolves with how many. */
export async function indexEdition(ref: string, onProgress: (done: number, total: number) => void): Promise<number> {
  progress.set(ref, onProgress)
  try {
    return await call<number>({ type: 'index', ref })
  } finally {
    progress.delete(ref)
  }
}
