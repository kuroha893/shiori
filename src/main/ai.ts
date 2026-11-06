import { randomUUID } from 'node:crypto'
import { net } from 'electron'
import { CLAUDE_EFFORTS, CLAUDE_MODELS, DEEPSEEK_EFFORTS, DEEPSEEK_MODELS, parseModel, pickEffort, pickModel, type ModelOption, type ModelUse, type Provider, type ServiceStatus } from '../shared/models'
import { claudeStatus, openConversation, runClaude, type Conversation } from './claude'
import { codexAccount, findCodex, isDesktopCodex, openCodexConversation, runCodex, type Activity, type CodexModel } from './codex'
import { getSettings } from './settings'

/*
 * One way in for every AI run, whichever service the chosen model belongs to. Claude and DeepSeek go through
 * Claude Code, ChatGPT through Codex.
 */

export type { Activity }

export const DEEPSEEK_URL = process.env.DEEPSEEK_API_URL ?? 'https://api.deepseek.com'

/** Claude Code pointed at DeepSeek: every model name it might use maps to the one DeepSeek model that sees images. */
function deepseekEnv(model: string): NodeJS.ProcessEnv {
  const api = DEEPSEEK_MODELS.find((m) => m.id === model)?.api ?? DEEPSEEK_MODELS[0].api
  return {
    ANTHROPIC_BASE_URL: `${DEEPSEEK_URL}/anthropic`,
    ANTHROPIC_AUTH_TOKEN: getSettings().deepseekKey,
    ANTHROPIC_MODEL: api,
    ANTHROPIC_DEFAULT_OPUS_MODEL: api,
    ANTHROPIC_DEFAULT_SONNET_MODEL: api,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: api,
    CLAUDE_CODE_SUBAGENT_MODEL: api,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
  }
}

/** The model name and environment for Claude Code. */
function viaClaude(provider: Provider, model: string): { model: string; env?: NodeJS.ProcessEnv } {
  if (provider === 'deepseek') return { model: DEEPSEEK_MODELS.find((m) => m.id === model)?.api ?? DEEPSEEK_MODELS[0].api, env: deepseekEnv(model) }
  return { model }
}

/* ---------- which services are connected ---------- */

let status: ServiceStatus | undefined
let checkedAt = 0
let checking: Promise<ServiceStatus> | undefined

/** Codex lists older generations too; offer the newest one, as the ChatGPT app does. */
function codexOptions(models: CodexModel[]): ModelOption[] {
  const shown = models.filter((m) => !m.hidden)
  const gen = (id: string) => parseFloat(id.match(/^gpt-(\d+(?:\.\d+)?)/)?.[1] ?? '0')
  const newest = Math.max(0, ...shown.map((m) => gen(m.id)))
  return shown
    .filter((m) => !newest || gen(m.id) === newest)
    .map((m) => ({
      value: `openai:${m.id}`,
      provider: 'openai',
      name: m.displayName,
      process: m.inputModalities.includes('image'),
      efforts: m.supportedReasoningEfforts?.map((e) => e.reasoningEffort)
    }))
}

async function check(): Promise<ServiceStatus> {
  const [c, codexPath] = await Promise.all([claudeStatus(), findCodex()])
  const claude: ServiceStatus['claude'] = {
    state: !c.path ? 'missing' : c.loggedIn ? 'ready' : 'signedOut',
    version: c.version,
    account: c.account,
    path: c.path
  }
  let openai: ServiceStatus['openai'] = { state: 'missing' }
  let gpt: ModelOption[] = []
  if (codexPath) {
    openai = { state: 'signedOut', via: isDesktopCodex(codexPath) ? 'desktop' : 'cli', path: codexPath }
    try {
      const { account, models } = await codexAccount()
      if (account) {
        openai = { ...openai, state: 'ready', account }
        gpt = codexOptions(models)
      }
    } catch {
      /* Codex that won't start counts as not signed in */
    }
  }
  const deepseek: ServiceStatus['deepseek'] = { state: !getSettings().deepseekKey ? 'noKey' : !c.path ? 'needsClaudeCode' : 'ready' }
  const models: ModelOption[] = [
    ...(claude.state === 'ready'
      ? CLAUDE_MODELS.map((m) => ({ value: `claude:${m.id}`, provider: 'claude' as const, name: m.name, process: m.process, efforts: CLAUDE_EFFORTS }))
      : []),
    ...gpt,
    ...(deepseek.state === 'ready'
      ? DEEPSEEK_MODELS.map((m) => ({ value: `deepseek:${m.id}`, provider: 'deepseek' as const, name: m.name, process: m.process, efforts: DEEPSEEK_EFFORTS }))
      : [])
  ]
  return { claude, openai, deepseek, models }
}

/** Checking starts CLIs, so a recent answer is reused unless `fresh` is asked for. */
export async function serviceStatus(fresh = false): Promise<ServiceStatus> {
  if (!fresh && status && Date.now() - checkedAt < 30_000) return status
  checking ??= check()
    .then((s) => {
      status = s
      checkedAt = Date.now()
      return s
    })
    .finally(() => (checking = undefined))
  return checking
}

/** The model to run for a place, falling back to another connected one; throws when nothing is connected. */
export async function modelFor(value: string, use: ModelUse): Promise<string> {
  let picked = pickModel(value, (await serviceStatus()).models, use)
  picked ??= pickModel(value, (await serviceStatus(true)).models, use)
  if (!picked) throw new Error('还没有接入模型服务，请先在设置里接入 Claude、ChatGPT 或 DeepSeek')
  return picked
}

/** The level a settled model runs at, from the level wanted for its place. */
async function effortFor(model: string, wanted: string | undefined): Promise<string | undefined> {
  return pickEffort(wanted, (await serviceStatus()).models.find((m) => m.value === model)?.efforts)
}

/** Ask DeepSeek whether a key is good, before keeping it. */
export async function checkDeepseekKey(key: string): Promise<string | undefined> {
  try {
    const res = await net.fetch(`${DEEPSEEK_URL}/models`, { headers: { Authorization: `Bearer ${key}` } })
    if (res.ok) return undefined
    return res.status === 401 ? '这个 key 不对' : `DeepSeek 返回 ${res.status}`
  } catch (e) {
    return `连不上 DeepSeek（${(e as Error).message}）`
  }
}

/* ---------- running ---------- */

export interface AgentRun {
  cwd: string
  prompt: string
  /** A "<provider>:<model>" already settled by modelFor */
  model: string
  /** The thinking level wanted, from the place's setting */
  effort?: string
  /** Whether it may write files in cwd */
  write: boolean
  search?: boolean
  /** May also read web pages (with search) */
  fetch?: boolean
  /** Added to the system prompt */
  instructions?: string
  /** Continue this session of the same service */
  session?: string
  /** Keep the session for a later run */
  keep?: boolean
  /** The reply as it is written, with a blank line between messages */
  onText?: (delta: string) => void
  onActivity?: (a: Activity) => void
  signal?: AbortSignal
}

export interface AgentResult {
  text: string
  session: string
  isError: boolean
}

/** Claude Code's tool calls in the same terms as Codex's. */
function claudeActivity(name: string, input: any): Activity | undefined {
  if (name === 'Read') return { kind: 'read', path: String(input?.file_path ?? '') }
  if (name === 'Write' || name === 'Edit') return { kind: 'write', path: String(input?.file_path ?? '') }
  if (name === 'Grep' || name === 'Glob') return { kind: 'find' }
  if (name === 'WebSearch' || name === 'WebFetch') return { kind: 'search' }
  return { kind: 'think' }
}

export async function runAgent(r: AgentRun): Promise<AgentResult> {
  const { provider, model } = parseModel(r.model)
  const effort = await effortFor(r.model, r.effort)
  let streamed = ''
  const text = (d: string) => {
    streamed += d
    r.onText?.(d)
  }
  // A new message after tool use reads as a new paragraph.
  const message = () => {
    if (streamed && !streamed.endsWith('\n\n')) text(streamed.endsWith('\n') ? '\n' : '\n\n')
  }

  if (provider === 'openai') {
    const res = await runCodex({
      cwd: r.cwd,
      prompt: r.prompt,
      model,
      effort,
      write: r.write,
      search: r.search,
      instructions: r.instructions,
      thread: r.session,
      keep: r.keep,
      onText: text,
      onMessage: message,
      onActivity: r.onActivity,
      signal: r.signal
    })
    return { text: res.text, session: res.thread, isError: res.isError }
  }

  const cli = viaClaude(provider, model)
  const tools = r.write ? ['Read', 'Write', 'Edit', 'Glob', 'Grep'] : ['Read', 'Grep', 'Glob']
  if (r.search) tools.push('WebSearch')
  if (r.fetch) tools.push('WebFetch')
  const web = tools.filter((t) => t.startsWith('Web'))
  const sessionId = r.session ?? randomUUID()
  const res = await runClaude({
    cwd: r.cwd,
    prompt: r.prompt,
    model: cli.model,
    effort,
    env: cli.env,
    tools,
    allowedTools: web.length ? web : undefined,
    systemPrompt: r.instructions,
    sessionId,
    resume: !!r.session,
    writable: r.write,
    partial: !!r.onText,
    signal: r.signal,
    onEvent: (event) => {
      if (event.type === 'stream_event') {
        const d = event.event
        if (d?.type === 'content_block_delta' && d.delta?.type === 'text_delta') text(d.delta.text)
      } else if (event.type === 'assistant') {
        message()
        for (const c of event.message?.content ?? []) {
          if (c.type !== 'tool_use') continue
          const a = claudeActivity(c.name, c.input)
          if (a) r.onActivity?.(a.kind === 'read' && c.input?.pages ? { ...a, path: `${a.path}#${c.input.pages}` } : a)
        }
      }
    }
  })
  return { text: res.text, session: res.sessionId, isError: res.isError }
}

/** A conversation kept open across turns, for calls. */
export async function talkTo(o: { cwd: string; model: string; systemPrompt: string; effort?: string }): Promise<Conversation> {
  const { provider, model } = parseModel(o.model)
  const effort = await effortFor(o.model, o.effort)
  if (provider === 'openai') return openCodexConversation({ ...o, model, effort })
  const cli = viaClaude(provider, model)
  return openConversation({ ...o, model: cli.model, effort, env: cli.env })
}
