import { net } from 'electron'
import vm from 'node:vm'
import { parse } from 'node-html-parser'

/*
 * Runs one fetch script that Claude wrote, in its own utility process so a script that hangs or crashes takes
 * nothing else down. The script gets the web (through Electron's network stack, which follows the system proxy),
 * an HTML parser and a log, and nothing else: no files, no require, no process.
 */

interface Job {
  code: string
  file: string
}

const MAX_LOG = 12_000

process.parentPort.once('message', async (e: { data: Job }) => {
  const { code, file } = e.data
  let logged = ''
  const log = (...args: unknown[]) => {
    if (logged.length > MAX_LOG) return
    logged += args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 1))).join(' ').slice(0, 4000) + '\n'
  }
  let requests = 0
  const fetchRaw = async (url: string, init?: RequestInit): Promise<Response> => {
    if (++requests > 3000) throw new Error('too many requests in one run (3000)')
    const res = await net.fetch(url, { ...init, signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Shiori', ...(init?.headers as any) } })
    return res
  }
  const get = async (url: string, init?: RequestInit) => {
    const res = await fetchRaw(url, init)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
    return res
  }
  const tools = {
    fetch: fetchRaw,
    fetchText: async (url: string, init?: RequestInit) => (await get(url, init)).text(),
    fetchJSON: async (url: string, init?: RequestInit) => (await get(url, init)).json(),
    parseHTML: (html: string) => parse(html),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 10_000))),
    log
  }
  try {
    const context = vm.createContext({
      ...tools,
      tools,
      console: { log, warn: log, error: log, info: log },
      URL,
      URLSearchParams,
      TextDecoder,
      TextEncoder,
      AbortSignal,
      setTimeout,
      clearTimeout,
      atob,
      btoa
    })
    const run = vm.runInContext(`${code}\n;typeof fetchPapers === 'function' ? fetchPapers : undefined`, context, { filename: file, timeout: 10_000 })
    if (typeof run !== 'function') throw new Error('the script defines no function fetchPapers')
    const result = await run(tools)
    process.parentPort.postMessage({ ok: true, result: JSON.parse(JSON.stringify(result ?? null)), log: logged, requests })
  } catch (err) {
    const error = err instanceof Error ? `${err.message}\n${(err.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(err)
    process.parentPort.postMessage({ ok: false, error, log: logged, requests })
  }
})
