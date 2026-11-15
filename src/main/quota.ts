import { execFile } from 'node:child_process'
import { net } from 'electron'
import { promisify } from 'node:util'
import type { QuotaView, QuotaWindow, ServiceQuota } from '../shared/types'
import { parseModel, type Provider } from '../shared/models'
import { DEEPSEEK_URL, serviceStatus } from './ai'
import { claudeEnv, findClaude } from './claude'
import { codexRateLimits, onCodexRateLimits } from './codex'
import { getSettings } from './settings'

const run = promisify(execFile)

/*
 * How much the owner has left on each connected service, for the status block in the top bar. Nothing here spends
 * any of it: Claude Code answers /usage without calling a model, Codex has a read for its rate limits, and DeepSeek
 * a balance endpoint. Both subscriptions are the owner's whole account, so the numbers include use outside Shiori.
 *
 * Read on start, every five minutes for the services Shiori runs on, a little after each of the owner's tasks, and
 * when the owner opens the panel or asks.
 */

let view: QuotaView = { services: [], inUse: [] }
let notify: (v: QuotaView) => void = () => {}
let reading: Promise<QuotaView> | undefined

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** "Nov 15 at 8:50pm", "Nov 21 at 3pm" or "8:50pm", in the local time zone, the next such moment. */
export function parseReset(text: string, now = new Date()): number | undefined {
  const m = text.match(/(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)
  if (!m) return undefined
  const [, mon, day, year, h, min, ap] = m
  let hour = +h % 12
  if (ap.toLowerCase() === 'pm') hour += 12
  const d = new Date(now)
  d.setSeconds(0, 0)
  d.setHours(hour, min ? +min : 0)
  if (mon) {
    const mi = MONTHS.indexOf(mon.toLowerCase())
    if (mi < 0) return undefined
    d.setMonth(mi, +day)
    if (year) d.setFullYear(+year)
    else if (d.getTime() < now.getTime() - 24 * 3600_000) d.setFullYear(d.getFullYear() + 1)
  } else if (d.getTime() < now.getTime()) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/**
 * Claude Code's /usage, run headless, prints lines such as
 * "Current session: 82% used · resets Nov 15 at 8:50pm (Australia/Sydney)" and
 * "Current week (all models): 37% used · resets Nov 21 at 3pm (Australia/Sydney)". A per-model weekly line is left out.
 */
export function parseClaudeUsage(text: string, now = new Date()): QuotaWindow[] {
  const out: QuotaWindow[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*Current (session|week \(all models\))\s*:\s*(\d+(?:\.\d+)?)%\s*used(.*)$/i)
    if (!m) continue
    out.push({
      minutes: /session/i.test(m[1]) ? 300 : 10080,
      left: Math.max(0, Math.min(1, 1 - +m[2] / 100)),
      resetsAt: parseReset(m[3], now)
    })
  }
  return out
}

async function readClaude(): Promise<ServiceQuota> {
  const path = await findClaude()
  if (!path) return { provider: 'claude', failed: true }
  try {
    const { stdout } = await run(path, ['-p', '/usage', '--output-format', 'json'], { env: claudeEnv(), timeout: 30_000, maxBuffer: 4 << 20 })
    const result = JSON.parse(stdout).result ?? ''
    const windows = parseClaudeUsage(String(result))
    return windows.length ? { provider: 'claude', windows } : { provider: 'claude', failed: true }
  } catch {
    return { provider: 'claude', failed: true }
  }
}

async function readCodex(): Promise<ServiceQuota> {
  try {
    const limits = await codexRateLimits()
    const windows = [limits?.primary, limits?.secondary]
      .filter((w): w is NonNullable<typeof w> => !!w)
      .map((w) => ({
        minutes: w.windowDurationMins ?? 300,
        left: Math.max(0, Math.min(1, 1 - w.usedPercent / 100)),
        // Codex gives seconds
        resetsAt: w.resetsAt ? (w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt) : undefined
      }))
    return windows.length ? { provider: 'openai', windows } : { provider: 'openai', failed: true }
  } catch {
    return { provider: 'openai', failed: true }
  }
}

async function readDeepseek(): Promise<ServiceQuota> {
  try {
    const res = await net.fetch(`${DEEPSEEK_URL}/user/balance`, {
      headers: { Authorization: `Bearer ${getSettings().deepseekKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) return { provider: 'deepseek', failed: true }
    const b = await res.json()
    const infos: { currency: string; total_balance: string }[] = b.balance_infos ?? []
    const info = infos.find((i) => i.currency === 'CNY') ?? infos[0]
    if (!info) return { provider: 'deepseek', failed: true }
    return { provider: 'deepseek', balance: { amount: parseFloat(info.total_balance) || 0, currency: info.currency, usable: b.is_available !== false } }
  } catch {
    return { provider: 'deepseek', failed: true }
  }
}

const READERS: Record<Provider, () => Promise<ServiceQuota>> = { claude: readClaude, openai: readCodex, deepseek: readDeepseek }

/** The services picked for processing, chat or calls. */
function inUse(): Provider[] {
  const s = getSettings()
  return [...new Set([s.processModel, s.chatModel, s.callModel].map((m) => parseModel(m).provider))]
}

/** Read the connected services; `all` also reads those Shiori doesn't run on now, for the open panel. */
export function readQuota(all: boolean): Promise<QuotaView> {
  reading ??= (async () => {
    const status = await serviceStatus()
    const connected = (['claude', 'openai', 'deepseek'] as const).filter((p) => status[p].state === 'ready')
    const using = inUse().filter((p) => connected.includes(p))
    const want = all ? connected : using
    const fresh = await Promise.all(want.map((p) => READERS[p]()))
    // Keep what was read before for services not read this time; drop services no longer connected.
    const services = connected
      .map((p) => fresh.find((q) => q.provider === p) ?? view.services.find((q) => q.provider === p))
      .filter((q): q is ServiceQuota => !!q)
      // a failed read keeps the last good numbers
      .map((q) => (q.failed ? (view.services.find((o) => o.provider === q.provider && !o.failed) ?? q) : q))
    view = { services, inUse: using, checkedAt: Date.now() }
    notify(view)
    return view
  })().finally(() => (reading = undefined))
  return reading
}

export const quotaView = () => ({ ...view, inUse: inUse().filter((p) => view.services.some((q) => q.provider === p)) })

let soon: NodeJS.Timeout | undefined
/** After the owner's task is done, read again once things settle. */
export function quotaSoon(): void {
  if (soon) clearTimeout(soon)
  soon = setTimeout(() => void readQuota(false), 10_000)
}

export function initQuota(onChange: (v: QuotaView) => void): void {
  notify = onChange
  setTimeout(() => void readQuota(false), 5_000)
  setInterval(() => void readQuota(false), 5 * 60_000)
  // Codex says when its numbers change while it runs.
  onCodexRateLimits(() => quotaSoon())
}
