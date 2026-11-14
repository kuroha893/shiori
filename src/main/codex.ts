import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, shell } from 'electron'
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

/** Sign in with ChatGPT in the browser, started from here; from Terminal only when this Codex can't do that. */
export async function openCodexLogin(): Promise<void> {
  try {
    const c = await connect()
    const r = await c.request('account/login/start', { type: 'chatgpt' })
    if (!r?.authUrl) throw new Error('no sign-in link')
    await shell.openExternal(r.authUrl)
  } catch {
    await inTerminal(`${quote((await findCodex()) || 'codex')} login`)
  }
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

/** Threads kept loaded after their turn, by id, with their model; they last as long as the app-server does. */
const live = new Map<string, string>()

/** Whether a kept thread can take another turn with this model. */
export const codexThreadLive = (id: string, model: string) => live.get(id) === model

/** One app-server for everything; started on first use and again after it exits. */
async function connect(): Promise<Client> {
  const current = client && (await client.catch(() => undefined))
  if (current && !current.closed) return current
  client = (async () => {
    const path = await findCodex()
    if (!path) throw new Error('没有找到 Codex，请先在设置里接入 ChatGPT')
    const c = new Client(path)
    c.listen((method) => method === 'shiori/closed' && live.clear())
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
  live.clear()
  kept.length = 0
}

export interface CodexModel {
  id: string
  displayName: string
  hidden: boolean
  inputModalities: string[]
  supportedReasoningEfforts?: { reasoningEffort: string }[]
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
  effort?: string
  /** Keep the thread loaded after the turn, to continue it with `thread` */
  keep?: boolean
  /** Continue this thread when it is still loaded; otherwise a new one starts */
  thread?: string
  /** A JSON Schema the final answer must follow */
  outputSchema?: object
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

/** In place of Codex's own instructions, which are written for programming work. */
const SHIORI_BASE = `You work inside Shiori, a paper reader on its owner's Mac, on one task Shiori hands you. Nobody watches you
work, so don't say what you are about to do or report progress along the way: do the task, then give the final answer
it asks for.

Your tools: the shell, for reading and searching files in the current folder (rg, sed, head, ls and the like);
view_image, for looking at an image file; apply_patch, for creating and editing files when the task lets you write;
web search when it is on, which can also open a page and find text in it. The shell has no network, and it is not for
writing files: never create or change a file with a shell command, a heredoc or a script. Use apply_patch.`

/** Threads kept for later turns, oldest first; beyond this many the oldest are let go. */
const KEEP = 8
const kept: string[] = []

function release(c: Client, id: string): void {
  live.delete(id)
  c.request('thread/unsubscribe', { threadId: id }).catch(() => {})
}

function keepThread(c: Client, id: string): void {
  const i = kept.indexOf(id)
  if (i >= 0) kept.splice(i, 1)
  kept.push(id)
  while (kept.length > KEEP) release(c, kept.shift()!)
}

async function startThread(c: Client, o: { cwd: string; model: string; write: boolean; search?: boolean; instructions?: string; base?: string }): Promise<string> {
  const { thread } = await c.request('thread/start', {
    model: o.model,
    cwd: o.cwd,
    approvalPolicy: 'never',
    sandbox: o.write ? 'workspace-write' : 'read-only',
    config: { web_search: o.search ? 'live' : 'disabled' },
    baseInstructions: o.base ?? SHIORI_BASE,
    developerInstructions: o.instructions ?? null,
    // Not kept in the user's own Codex history.
    ephemeral: true,
    serviceName: 'Shiori'
  })
  live.set(thread.id, o.model)
  return thread.id
}

/** One turn on a thread; resolves with the turn's answer once it completes. */
function turn(
  c: Client,
  thread: string,
  text: string,
  o: { effort?: string; outputSchema?: object; onText?: (d: string) => void; onMessage?: () => void; onActivity?: (a: Activity) => void; signal?: AbortSignal }
): Promise<{ text: string; isError: boolean }> {
  return new Promise((resolve, reject) => {
    let turnId: string | undefined
    let answer = ''
    let failure = ''
    const seen = new Set<string>()
    // A message saying what it is about to do shows as activity, not as part of the answer.
    const asides = new Set<string>()
    const off = c.listen((method, p) => {
      if (method === 'shiori/closed') {
        off()
        return reject(new Error(p.message))
      }
      if (p?.threadId !== thread) return
      if (method === 'item/agentMessage/delta') {
        if (!asides.has(p.itemId)) o.onText?.(p.delta)
      } else if (method === 'item/started' || method === 'item/completed') {
        const item = p.item
        if (item?.type === 'agentMessage') {
          const aside = item.phase === 'commentary'
          if (aside) asides.add(item.id)
          if (method === 'item/started') {
            if (aside) o.onActivity?.({ kind: 'think' })
            else o.onMessage?.()
          } else if (!aside) answer = item.text ?? answer
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
        resolve({ text: answer, isError: false })
      }
    })
    const abort = () => turnId && c.request('turn/interrupt', { threadId: thread, turnId }).catch(() => {})
    o.signal?.addEventListener('abort', abort)
    c.request('turn/start', {
      threadId: thread,
      input: [{ type: 'text', text, text_elements: [] }],
      ...(o.effort ? { effort: o.effort } : {}),
      ...(o.outputSchema ? { outputSchema: o.outputSchema } : {})
    })
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

/** Run one headless turn, on the thread given while it is still loaded, else on a new one. */
export async function runCodex(o: CodexRun): Promise<{ text: string; thread: string; isError: boolean }> {
  if (o.signal?.aborted) throw new Error('已取消')
  const c = await connect()
  const thread = o.thread && codexThreadLive(o.thread, o.model) ? o.thread : await startThread(c, o)
  try {
    const r = await turn(c, thread, o.prompt, o)
    return { ...r, thread }
  } finally {
    if (o.keep) keepThread(c, thread)
    else {
      const i = kept.indexOf(thread)
      if (i >= 0) kept.splice(i, 1)
      release(c, thread)
    }
  }
}

/** A thread kept open across turns, with the system prompt in place of Codex's own instructions. */
export async function openCodexConversation(o: { cwd: string; model: string; systemPrompt: string; effort?: string }) {
  const c = await connect()
  const thread = await startThread(c, { cwd: o.cwd, model: o.model, write: false, base: o.systemPrompt })
  let open = true
  const off = c.listen((method) => {
    if (method === 'shiori/closed') open = false
  })
  return {
    async send(text: string, onText: (text: string) => void): Promise<void> {
      const r = await turn(c, thread, text, { effort: o.effort, onText })
      if (r.isError) throw new Error(r.text)
    },
    alive: () => open && !c.closed,
    close: () => {
      open = false
      off()
      release(c, thread)
    }
  }
}
