/*
 * Where the AI comes from. A model is chosen as "<provider>:<model>", e.g. "claude:opus", "openai:gpt-6-sol",
 * "deepseek:flash". Any connected service can serve any of the places a model is chosen.
 */

export type Provider = 'claude' | 'openai' | 'deepseek'

/** Where a model is used; transcription needs one that can see page images. */
export type ModelUse = 'process' | 'chat' | 'call'

export interface ModelOption {
  value: string
  provider: Provider
  /** Name within its service, as listed under the service's heading */
  name: string
  process: boolean
  /** Thinking levels it takes, least first; none when it has no choice */
  efforts?: string[]
}

export const PROVIDER_NAMES: Record<Provider, string> = { claude: 'Claude', openai: 'ChatGPT', deepseek: 'DeepSeek' }
export const PROVIDERS = Object.keys(PROVIDER_NAMES) as Provider[]

/** Thinking levels from least to most, named as the services name them. */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
/** DeepSeek reads medium and xhigh as high; its none can't be sent through Claude Code, which drops it. */
export const DEEPSEEK_EFFORTS = ['low', 'high', 'max']

export const CLAUDE_MODELS = [
  { id: 'opus', name: 'Opus', process: true },
  { id: 'sonnet', name: 'Sonnet', process: true },
  { id: 'haiku', name: 'Haiku', process: false }
]

/** DeepSeek Flash is the one DeepSeek model that reads images. */
export const DEEPSEEK_MODELS = [{ id: 'flash', name: 'Flash', api: 'deepseek-flash', process: true }]

export interface ServiceStatus {
  claude: { state: 'missing' | 'signedOut' | 'ready'; version?: string; account?: string; path?: string }
  openai: { state: 'missing' | 'signedOut' | 'ready'; via?: 'desktop' | 'cli'; account?: string; path?: string }
  deepseek: { state: 'noKey' | 'needsClaudeCode' | 'ready' }
  /** Models of the connected services, in the order they are offered */
  models: ModelOption[]
}

/** Settings from before there was more than one service hold a bare Claude alias. */
export function normalizeModel(value: string | undefined): string {
  if (!value) return 'claude:opus'
  return value.includes(':') ? value : `claude:${value}`
}

export function parseModel(value: string): { provider: Provider; model: string } {
  const v = normalizeModel(value)
  const i = v.indexOf(':')
  return { provider: v.slice(0, i) as Provider, model: v.slice(i + 1) }
}

/** "gpt-6-sol" → "GPT-6-Sol", the way Codex names its models. */
const gptName = (id: string) => id.split('-').map((s) => (s === 'gpt' ? 'GPT' : s.charAt(0).toUpperCase() + s.slice(1))).join('-')

export function modelName(value: string): string {
  const { provider, model } = parseModel(value)
  if (provider === 'openai') return gptName(model)
  return (provider === 'claude' ? CLAUDE_MODELS : DEEPSEEK_MODELS).find((m) => m.id === model)?.name ?? model
}

/** The full name: "Claude Opus", "GPT-6-Sol", "DeepSeek Flash". */
export function modelLabel(value: string): string {
  const { provider } = parseModel(value)
  return provider === 'openai' ? modelName(value) : `${PROVIDER_NAMES[provider]} ${modelName(value)}`
}

/**
 * The level a model runs at: the chosen one when it takes it, otherwise the highest it takes below that (as
 * Claude Code does), or its lowest.
 */
export function pickEffort(level: string | undefined, efforts: string[] | undefined): string | undefined {
  if (!efforts?.length) return undefined
  if (level && efforts.includes(level)) return level
  const rank = (l: string) => EFFORT_ORDER.indexOf(l)
  const below = efforts.filter((e) => rank(e) <= rank(level ?? ''))
  return below.length ? below.reduce((a, b) => (rank(b) > rank(a) ? b : a)) : efforts.reduce((a, b) => (rank(b) < rank(a) ? b : a))
}

/**
 * The model to use for a place: the chosen one while its service is connected, otherwise the first connected
 * model that fits, so a disconnected service never stops anything.
 */
export function pickModel(value: string, models: ModelOption[], use: ModelUse): string | undefined {
  const fits = models.filter((m) => use !== 'process' || m.process)
  const v = normalizeModel(value)
  if (fits.some((m) => m.value === v)) return v
  const { provider } = parseModel(v)
  return (fits.find((m) => m.provider === provider) ?? fits[0])?.value
}
