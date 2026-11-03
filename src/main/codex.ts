import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { getSettings } from './settings'
import { inTerminal, quote, withProxy } from './claude'

const run = promisify(execFile)

/*
 * ChatGPT goes through the user's own Codex CLI, signed in with their ChatGPT account; the ChatGPT desktop app
 * ships one. Shiori talks to its app-server over stdio (JSON-RPC, one message per line) and never sees a token.
 */

const DESKTOP = ['/Applications/ChatGPT.app', join(homedir(), 'Applications/ChatGPT.app')].map((a) => join(a, 'Contents/Resources/codex-cli/bin/codex'))
const CANDIDATES = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', join(homedir(), '.local/bin/codex'), join(homedir(), '.npm-global/bin/codex')]

let found: string | undefined

export async function findCodex(): Promise<string | undefined> {
  const configured = getSettings().codexPath
  if (configured && existsSync(configured)) return configured
  if (found && existsSync(found)) return found
  found = CANDIDATES.find((p) => existsSync(p))
  if (!found) {
    try {
      const { stdout } = await run('/bin/zsh', ['-lc', 'command -v codex'], { timeout: 8000 })
      const p = stdout.trim().split('\n').pop()
      if (p && p.startsWith('/') && existsSync(p)) found = p
    } catch {
      /* not on PATH */
    }
  }
  found ??= DESKTOP.find((p) => existsSync(p))
  return found
}

export const isDesktopCodex = (path: string) => path.includes('ChatGPT.app/')

/** Sign in from Terminal; Codex opens the browser itself. */
export async function openCodexLogin(): Promise<void> {
  await inTerminal(`${quote((await findCodex()) || 'codex')} login`)
}

type Listener = (method: string, params: any) => void

class Client {
  private child: ChildProcessWithoutNullStreams
  private seq = 0
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private listeners = new Set<Listener>()
  private err = ''
  closed = false

  constructor(path: string) {
    // The user's own Codex setup stays theirs: no apps, plugins or memories in Shiori's threads.
    const args = ['app-server', '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.memories=false']
    this.child = spawn(path, args, { env: withProxy({ ...process.env }), stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      out += chunk
      let nl: number
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim()
        out = out.slice(nl + 1)
        if (line) this.receive(line)
      }
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (c: string) => (this.err = (this.err + c).slice(-2000)))
    const closed = () => {
      if (this.closed) return
      this.closed = true
      const reason = new Error(this.err.trim().split('\n').slice(-2).join(' ') || 'Codex 退出了')
      for (const w of this.waiting.values()) w.reject(reason)
      this.waiting.clear()
      for (const l of this.listeners) l('shiori/closed', { message: reason.message })
    }
    this.child.on('error', closed)
    this.child.on('close', closed)
    this.child.stdin.on('error', () => {})
  }

  private receive(line: string): void {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id != null && msg.method) {
      // A request from the server, such as an approval; runs here never ask, so anything that arrives is declined.
      this.write({ id: msg.id, error: { code: -32601, message: 'Shiori does not handle this request' } })
    } else if (msg.id != null) {
      const w = this.waiting.get(msg.id)
      if (!w) return
      this.waiting.delete(msg.id)
      msg.error ? w.reject(new Error(msg.error.message || 'Codex 出错了')) : w.resolve(msg.result)
    } else if (msg.method) {
      for (const l of this.listeners) l(msg.method, msg.params)
    }
  }

  private write(msg: unknown): void {
    if (!this.closed) this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex 退出了'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
  }

  notify(method: string): void {
    this.write({ method })
  }

  listen(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  close(): void {
    this.child.kill('SIGTERM')
  }
}

let client: Promise<Client> | undefined

/** One app-server for everything; started on first use and again after it exits. */
async function connect(): Promise<Client> {
  const current = client && (await client.catch(() => undefined))
  if (current && !current.closed) return current
  client = (async () => {
    const path = await findCodex()
    if (!path) throw new Error('没有找到 Codex，请先在设置里接入 ChatGPT')
    const c = new Client(path)
    await c.request('initialize', { clientInfo: { name: 'shiori', title: 'Shiori', version: app.getVersion() }, capabilities: null })
    c.notify('initialized')
    return c
  })()
  client.catch(() => (client = undefined))
  return client
}

export function closeCodex(): void {
  client?.then((c) => c.close()).catch(() => {})
  client = undefined
}

export interface CodexModel {
  id: string
  displayName: string
  hidden: boolean
  inputModalities: string[]
}

/** The signed-in account and the models it may use. */
export async function codexAccount(): Promise<{ account?: string; models: CodexModel[] }> {
  const c = await connect()
  const { account } = await c.request('account/read', {})
  if (!account) return { models: [] }
  const models: CodexModel[] = []
  let cursor: string | null = null
  do {
    const page: { data: CodexModel[]; nextCursor: string | null } = await c.request('model/list', cursor ? { cursor } : {})
    models.push(...page.data)
    cursor = page.nextCursor
  } while (cursor)
  return { account: account.type === 'chatgpt' ? account.email || 'ChatGPT' : 'API key', models }
}

/** Things the agent does along the way, for progress and status lines. */
export type Activity = { kind: 'read' | 'write'; path: string } | { kind: 'find' | 'search' | 'think' }

export interface CodexRun {
  cwd: string
  prompt: string
  model: string
  write: boolean
  search?: boolean
  instructions?: string
  /** Keep the thread loaded after the turn, to continue it with `thread` */
  keep?: boolean
  thread?: string
  onText?: (delta: string) => void
  onMessage?: () => void
  onActivity?: (a: Activity) => void
  signal?: AbortSignal
}

function activities(item: any): Activity[] {
  switch (item?.type) {
    case 'commandExecution': {
      const acts = (item.commandActions ?? []) as any[]
      if (!acts.length) return [{ kind: 'think' }]
      return acts.map((a) => (a.type === 'read' ? { kind: 'read', path: String(a.path) } : a.type === 'unknown' ? { kind: 'think' } : { kind: 'find' }))
    }
    case 'imageView':
      return [{ kind: 'read', path: String(item.path) }]
    case 'fileChange':
      return (item.changes ?? []).map((c: any) => ({ kind: 'write', path: String(c.path) }))
    case 'webSearch':
      return [{ kind: 'search' }]
    default:
      return []
  }
}

async function startThread(c: Client, o: { cwd: string; model: string; write: boolean; search?: boolean; instructions?: string; base?: string }): Promise<string> {
  const { thread } = await c.request('thread/start', {
    model: o.model,
    cwd: o.cwd,
    approvalPolicy: 'never',
    sandbox: o.write ? 'workspace-write' : 'read-only',
    config: { web_search: o.search ? 'live' : 'disabled' },
    baseInstructions: o.base ?? null,
    developerInstructions: o.instructions ?? null,
    // Not kept in the user's own Codex history.
    ephemeral: true,
    serviceName: 'Shiori'
  })
  return thread.id
}

/** One turn on a thread; resolves with the turn's last message once it completes. */
function turn(
  c: Client,
  thread: string,
  text: string,
  o: { effort?: string; onText?: (d: string) => void; onMessage?: () => void; onActivity?: (a: Activity) => void; signal?: AbortSignal }
): Promise<{ text: string; isError: boolean }> {
  return new Promise((resolve, reject) => {
    let turnId: string | undefined
    let last = ''
    let failure = ''
    const seen = new Set<string>()
    const off = c.listen((method, p) => {
      if (method === 'shiori/closed') {
        off()
        return reject(new Error(p.message))
      }
      if (p?.threadId !== thread) return
      if (method === 'item/agentMessage/delta') o.onText?.(p.delta)
      else if (method === 'item/started' || method === 'item/completed') {
        const item = p.item
        if (item?.type === 'agentMessage') {
          if (method === 'item/started') o.onMessage?.()
          else last = item.text ?? last
        }
        // Commands and images show up when they start, file changes once they are written.
        if ((method === 'item/started') !== (item?.type === 'fileChange') && !seen.has(item?.id)) {
          seen.add(item?.id)
          for (const a of activities(item)) o.onActivity?.(a)
        }
      } else if (method === 'error' && !p.willRetry) failure = p.error?.message ?? failure
      else if (method === 'turn/completed' && (!turnId || p.turn?.id === turnId)) {
        off()
        o.signal?.removeEventListener('abort', abort)
        const status = p.turn?.status
        if (status === 'interrupted') return reject(new Error('已取消'))
        if (status === 'failed') return resolve({ text: p.turn?.error?.message || failure || 'Codex 出错了', isError: true })
        resolve({ text: last, isError: false })
      }
    })
    const abort = () => turnId && c.request('turn/interrupt', { threadId: thread, turnId }).catch(() => {})
    o.signal?.addEventListener('abort', abort)
    c.request('turn/start', { threadId: thread, input: [{ type: 'text', text, text_elements: [] }], ...(o.effort ? { effort: o.effort } : {}) })
      .then((r) => {
        turnId = r?.turn?.id
        if (o.signal?.aborted) abort()
      })
      .catch((e) => {
        off()
        reject(e)
      })
  })
}

/** Run one headless turn, in a new thread or one kept from before. */
export async function runCodex(o: CodexRun): Promise<{ text: string; thread: string; isError: boolean }> {
  if (o.signal?.aborted) throw new Error('已取消')
  const c = await connect()
  const thread = o.thread ?? (await startThread(c, o))
  try {
    const r = await turn(c, thread, o.prompt, o)
    return { ...r, thread }
  } finally {
    if (!o.keep) c.request('thread/unsubscribe', { threadId: thread }).catch(() => {})
  }
}

/** A thread kept open across turns, with the system prompt in place of Codex's own instructions. */
export async function openCodexConversation(o: { cwd: string; model: string; systemPrompt: string }) {
  const c = await connect()
  const thread = await startThread(c, { cwd: o.cwd, model: o.model, write: false, base: o.systemPrompt })
  let open = true
  const off = c.listen((method) => {
    if (method === 'shiori/closed') open = false
  })
  return {
    async send(text: string, onText: (text: string) => void): Promise<void> {
      // Spoken replies want speed over deliberation.
      const r = await turn(c, thread, text, { effort: 'low', onText })
      if (r.isError) throw new Error(r.text)
    },
    alive: () => open && !c.closed,
    close: () => {
      open = false
      off()
      c.request('thread/unsubscribe', { threadId: thread }).catch(() => {})
    }
  }
}
