import { spawn, execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ClaudeStatus } from '../shared/types'
import { getSettings } from './settings'

const run = promisify(execFile)

/*
 * Everything AI goes through the user's own, unmodified Claude Code CLI, signed in with
 * their Claude subscription. Nothing here talks to the Anthropic API directly.
 */

const CANDIDATES = [
  join(homedir(), '.local/bin/claude'),
  join(homedir(), '.claude/local/claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  join(homedir(), '.npm-global/bin/claude')
]

let found: string | undefined

export async function findClaude(): Promise<string | undefined> {
  const configured = getSettings().claudePath
  if (configured && existsSync(configured)) return configured
  if (found && existsSync(found)) return found
  found = CANDIDATES.find((p) => existsSync(p))
  if (!found) {
    // Apps started from Finder get a minimal PATH; ask a login shell where claude is.
    try {
      const { stdout } = await run('/bin/zsh', ['-lc', 'command -v claude'], { timeout: 8000 })
      const p = stdout.trim().split('\n').pop()
      if (p && p.startsWith('/') && existsSync(p)) found = p
    } catch {
      /* not installed */
    }
  }
  return found
}

/**
 * A clean environment for the CLI: an ANTHROPIC_API_KEY would take precedence over the
 * subscription login (and bill the API), and variables of a parent Claude Code session
 * must not leak into ours.
 */
export function claudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('ANTHROPIC_') || (k.startsWith('CLAUDE') && k !== 'CLAUDE_CONFIG_DIR')) continue
    env[k] = v
  }
  env.PATH = [env.PATH, '/usr/local/bin', '/opt/homebrew/bin', join(homedir(), '.local/bin')].filter(Boolean).join(':')
  // Apps opened from Finder don't inherit the shell's proxy variables, and the CLI ignores the macOS
  // system proxy; hand it over explicitly when one is set.
  if (!env.HTTPS_PROXY && !env.https_proxy) {
    const proxy = systemProxy()
    if (proxy) {
      env.HTTPS_PROXY = env.HTTP_PROXY = proxy.url
      if (proxy.exceptions) env.NO_PROXY = proxy.exceptions
    }
  }
  return env
}

let proxyCache: { url: string; exceptions?: string } | null | undefined

function systemProxy(): { url: string; exceptions?: string } | null {
  if (proxyCache !== undefined) return proxyCache
  proxyCache = null
  try {
    const out = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 })
    const get = (k: string) => out.match(new RegExp(`\\b${k} : (\\S+)`))?.[1]
    for (const kind of ['HTTPS', 'HTTP']) {
      if (get(`${kind}Enable`) === '1' && get(`${kind}Proxy`)) {
        const list = out.match(/ExceptionsList : <array> \{([^}]*)\}/)?.[1]
        const exceptions = list
          ?.split('\n')
          .map((l) => l.split(' : ')[1]?.trim())
          .filter(Boolean)
          .join(',')
        proxyCache = { url: `http://${get(`${kind}Proxy`)}:${get(`${kind}Port`) ?? 80}`, exceptions }
        break
      }
    }
  } catch {
    /* no proxy */
  }
  return proxyCache
}

export async function claudeStatus(): Promise<ClaudeStatus> {
  const path = await findClaude()
  if (!path) return { loggedIn: false, error: 'not-installed' }
  try {
    const [{ stdout: version }, { stdout: auth }] = await Promise.all([
      run(path, ['--version'], { env: claudeEnv(), timeout: 15000 }),
      run(path, ['auth', 'status', '--json'], { env: claudeEnv(), timeout: 15000 })
    ])
    const info = JSON.parse(auth)
    return {
      path,
      version: version.trim().split(' ')[0],
      loggedIn: !!info.loggedIn,
      account: info.email || info.account?.email || info.authMethod
    }
  } catch (e) {
    return { path, loggedIn: false, error: String((e as Error).message || e) }
  }
}

/** Open Terminal with `claude auth login`; the sign-in itself happens in the browser. */
export async function openLogin(): Promise<void> {
  const path = (await findClaude()) || 'claude'
  const cmd = `'${path.replace(/'/g, "'\\''")}' auth login`
  await run('osascript', [
    '-e',
    `tell application "Terminal" to do script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    '-e',
    'tell application "Terminal" to activate'
  ])
}

export interface RunOptions {
  cwd: string
  prompt: string
  model: string
  tools: string[]
  /** Tools that may run without asking; headless runs cannot ask */
  allowedTools?: string[]
  systemPrompt?: string
  /** Start a new session with this id, or resume it when `resume` is set */
  sessionId: string
  resume?: boolean
  /** Allow file writes inside cwd without asking */
  writable?: boolean
  partial?: boolean
  onEvent?: (event: any) => void
  signal?: AbortSignal
}

export interface RunResult {
  text: string
  sessionId: string
  isError: boolean
  usage?: any
}

/** Run one headless Claude Code turn and stream its JSON events. */
export async function runClaude(opts: RunOptions): Promise<RunResult> {
  const path = await findClaude()
  if (!path) throw new Error('没有找到 Claude Code，请先在设置里安装并登录')

  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    opts.model,
    // No code execution, no user/project settings, file tools confined to cwd.
    '--restricted',
    '--strict-mcp-config',
    '--tools',
    opts.tools.join(','),
    opts.resume ? '--resume' : '--session-id',
    opts.sessionId
  ]
  if (opts.writable) args.push('--permission-mode', 'acceptEdits')
  if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','))
  if (opts.partial) args.push('--include-partial-messages')
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt)

  return new Promise<RunResult>((resolveRun, rejectRun) => {
    const child = spawn(path, args, { cwd: opts.cwd, env: claudeEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let result: RunResult | undefined

    const onAbort = () => child.kill('SIGTERM')
    opts.signal?.addEventListener('abort', onAbort)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
      let nl: number
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim()
        out = out.slice(nl + 1)
        if (!line) continue
        let event: any
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type === 'result') {
          result = {
            text: event.result ?? '',
            sessionId: event.session_id ?? opts.sessionId,
            isError: !!event.is_error || event.subtype !== 'success',
            usage: event.usage
          }
        }
        opts.onEvent?.(event)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => (err += c))
    child.on('error', (e) => rejectRun(e))
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) return rejectRun(new Error('已取消'))
      if (result) return resolveRun(result)
      rejectRun(new Error(err.trim().split('\n').slice(-3).join('\n') || `Claude Code 退出（代码 ${code}）`))
    })
    child.stdin.end(opts.prompt)
  })
}
