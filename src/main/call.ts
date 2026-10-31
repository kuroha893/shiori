import { BrowserWindow, ipcMain, net, screen, shell } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CallLine, CallState, PaperMeta } from '../shared/types'
import { openConversation, runClaude, type Conversation } from './claude'
import { readMeta, root } from './library'
import { petBounds } from './pet'
import { getSettings, saveSettings } from './settings'
import { callPrompt, memoryPrompt } from './yachiyo'

/* The call with Yachiyo: you type, she answers aloud with subtitles. It stays open for hours, mostly in silence. */

const WIDTH = 340
const HEIGHT = 340
const GAP = 8
// A nudge from her needs a long stretch without one, and without you talking.
const NUDGE_EVERY = 45 * 60_000
const QUIET_BEFORE_NUDGE = 10 * 60_000

type Record = { at: string; who: 'you' | 'her' | 'event'; text: string; zh?: string }

let win: BrowserWindow | undefined
let conversation: Conversation | undefined
let state: CallState = { active: false, thinking: false }
let log: Record[] = []
let logFile = ''
/** Changes when you speak, so that lines still on their way are dropped. */
let generation = 0
let turns: Promise<void> = Promise.resolve()
let pending = 0
let timer: NodeJS.Timeout | undefined
let lastSpoke = 0
let lastNudge = 0
let lateNoted = false
let reading: { id: string; since: number } | undefined
const statuses = new Map<string, PaperMeta['status']>()

const dir = () => join(root(), 'yachiyo')
const memoryFile = () => join(dir(), 'memory.md')
const readMemory = () => (existsSync(memoryFile()) ? readFileSync(memoryFile(), 'utf8') : '')

const push = (channel: string, payload?: unknown) => win?.webContents.send(channel, payload)

function update(patch: Partial<CallState>): void {
  state = { ...state, ...patch }
  push('call:state', state)
}

function record(entry: Omit<Record, 'at'>): void {
  const line = { at: new Date().toISOString(), ...entry }
  log.push(line)
  appendFileSync(logFile, JSON.stringify(line) + '\n')
}

const span = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}min`
}

function statusLine(): string {
  const now = new Date()
  const clock = now.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const parts = [clock, `call ${span(now.getTime() - (state.startedAt ?? now.getTime()))}`]
  const paper = reading && readMeta(reading.id)
  if (reading && paper) {
    const at = Math.round((paper.readPos?.ratio ?? 0) * 100)
    parts.push(`reading 《${paper.titleZh || paper.title}》 ${span(now.getTime() - reading.since)}, at ${at}%`)
  }
  return `[status: ${parts.join(', ')}]`
}

/** The last few lines of the previous call, so a new one doesn't start from nothing. */
function lastCallTail(): string {
  try {
    const files = readdirSync(join(dir(), 'calls')).filter((f) => f.endsWith('.jsonl')).sort()
    const previous = files.filter((f) => join(dir(), 'calls', f) !== logFile).pop()
    if (!previous) return ''
    const lines = readFileSync(join(dir(), 'calls', previous), 'utf8').trim().split('\n').slice(-6)
    return lines.map((l) => transcriptLine(JSON.parse(l))).join('\n')
  } catch {
    return ''
  }
}

const transcriptLine = (r: Record) => `${new Date(r.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} ${r.who === 'you' ? 'They' : r.who === 'her' ? 'You' : 'App'}: ${r.zh ?? r.text}`

async function talk(): Promise<Conversation> {
  if (conversation?.alive()) return conversation
  const s = getSettings()
  conversation = await openConversation({
    cwd: dir(),
    model: s.callModel,
    systemPrompt: callPrompt({ language: s.callLanguage, memory: readMemory(), lastCall: lastCallTail() })
  })
  return conversation
}

async function synthesize(text: string): Promise<{ audio: Uint8Array; type: string } | undefined> {
  const s = getSettings()
  if (!s.fishKey || !s.fishVoice) return undefined
  try {
    const res = await net.fetch(`${process.env.FISH_AUDIO_URL ?? 'https://api.fish.audio'}/v1/tts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.fishKey}`, 'Content-Type': 'application/json', model: s.fishModel },
      body: JSON.stringify({ text, reference_id: s.fishVoice, format: 'mp3', latency: 'balanced', language: s.callLanguage })
    })
    if (!res.ok) {
      const reason = { 401: 'API 密钥不对', 402: '额度不够了', 404: '找不到这个音色' }[res.status] ?? `服务返回 ${res.status}`
      update({ notice: `Fish Audio：${reason}，先只显示字幕` })
      return undefined
    }
    if (state.notice) update({ notice: undefined })
    return { audio: new Uint8Array(await res.arrayBuffer()), type: res.headers.get('content-type') ?? 'audio/mpeg' }
  } catch (e) {
    update({ notice: `Fish Audio 连不上（${(e as Error).message}），先只显示字幕` })
    return undefined
  }
}

/** One output line: "[tone] words ||| subtitle". Anything else, such as (silent) or a stray fragment, says nothing. */
export function parseLine(raw: string): { tone?: string; say: string; zh: string } | undefined {
  const line = raw.trim()
  if (!line || /^\(?silent\)?$/i.test(line)) return undefined
  const tag = line.match(/^\[([^\]]*)\]\s*/)
  const body = tag ? line.slice(tag[0].length) : line
  if (!tag && !body.includes('|||')) return undefined
  const [say, zh] = body.split('|||').map((part) => part.trim())
  if (!say || !/[\p{L}\p{N}]/u.test(say) || /^\(?silent\)?$/i.test(say)) return undefined
  return { tone: tag?.[1], say, zh: zh || say }
}

async function runTurn(content: string, turnGeneration: number): Promise<void> {
  let delivered = Promise.resolve()
  let buffer = ''
  const emit = (raw: string) => {
    const line = parseLine(raw)
    if (!line || turnGeneration !== generation) return
    record({ who: 'her', text: line.say, zh: line.zh })
    const voice = synthesize(line.tone ? `[${line.tone}] ${line.say}` : line.say)
    const entry: CallLine = { id: randomUUID(), say: line.say, zh: line.zh }
    delivered = delivered.then(async () => {
      const sound = await voice
      if (turnGeneration === generation) push('call:line', { ...entry, ...sound })
    })
  }
  try {
    const conv = await talk()
    await conv.send(content, (text) => {
      buffer += text
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        emit(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
      }
    })
    emit(buffer)
    await delivered
  } catch (e) {
    update({ notice: `连不上 Claude：${(e as Error).message}` })
  }
}

function speak(content: string): void {
  const turnGeneration = generation
  pending++
  update({ thinking: true })
  turns = turns.then(() => runTurn(`${statusLine()} ${content}`, turnGeneration)).finally(() => {
    if (--pending === 0) update({ thinking: false })
  })
}

/** Something happened in the app; she says so if a call is open. */
export function callEvent(text: string): void {
  if (!state.active) return
  record({ who: 'event', text })
  speak(`[event] ${text}`)
}

export function watchPaper(meta: PaperMeta): void {
  const before = statuses.get(meta.id)
  statuses.set(meta.id, meta.status)
  if (before !== 'processing' || meta.status === before) return
  const title = meta.titleZh || meta.title
  if (meta.status === 'ready') callEvent(`《${title}》翻译好了`)
  if (meta.status === 'error') callEvent(`《${title}》处理失败了`)
}

/** Her rare, unprompted remarks; she may still decide to stay silent. */
function checkNudges(): void {
  const now = Date.now()
  if (now - lastSpoke < QUIET_BEFORE_NUDGE || now - lastNudge < NUDGE_EVERY) return
  const hour = new Date().getHours()
  let note: string | undefined
  if (hour < 5 && !lateNoted) {
    lateNoted = true
    note = 'it is very late and they are still at it'
  } else if (reading && now - reading.since >= NUDGE_EVERY) {
    note = `they have been reading this one for ${span(now - reading.since)}`
  }
  if (!note) return
  lastNudge = now
  speak(`[note] ${note}`)
}

function place(): void {
  if (!win) return
  const pet = petBounds()
  if (!pet) {
    // On her own the call sits at the bottom right, clear of the avatar button, unless it was dragged elsewhere.
    const saved = getSettings().callPosition
    const area = (saved ? screen.getDisplayNearestPoint(saved) : screen.getPrimaryDisplay()).workArea
    const x = Math.min(saved?.x ?? area.x + area.width - WIDTH - 96, area.x + area.width - WIDTH)
    const y = Math.min(saved?.y ?? area.y + area.height - HEIGHT - 16, area.y + area.height - HEIGHT)
    win.setBounds({ x: Math.max(area.x, x), y: Math.max(area.y, y), width: WIDTH, height: HEIGHT })
    return
  }
  const area = screen.getDisplayMatching(pet).workArea
  const left = pet.x - WIDTH - GAP
  const x = left >= area.x ? left : pet.x + pet.width + GAP
  const y = Math.max(area.y, Math.min(pet.y + pet.height - HEIGHT, area.y + area.height - HEIGHT))
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: WIDTH, height: HEIGHT })
}

export const placeCall = place

export function startCall(): void {
  if (state.active) return
  mkdirSync(join(dir(), 'calls'), { recursive: true })
  const now = new Date()
  logFile = join(dir(), 'calls', `${now.toISOString().replace(/[:.]/g, '-')}.jsonl`)
  log = []
  generation++
  lastSpoke = lastNudge = now.getTime()
  lateNoted = false
  state = { active: true, thinking: false, startedAt: now.getTime() }

  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/call.js'),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  win.setIgnoreMouseEvents(true, { forward: true })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.once('ready-to-show', () => win?.showInactive())
  win.on('closed', () => (win = undefined))
  win.on('moved', () => {
    if (win && !petBounds()) {
      const [x, y] = win.getPosition()
      saveSettings({ callPosition: { x, y } })
    }
  })
  place()
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/call.html`)
  else win.loadFile(join(__dirname, '../renderer/call.html'))

  timer = setInterval(checkNudges, 60_000)
  speak('(they just picked up)')
}

export function endCall(): void {
  if (!state.active) return
  clearInterval(timer)
  generation++
  state = { active: false, thinking: false }
  conversation?.close()
  conversation = undefined
  const closing = win
  closing?.webContents.send('call:ended')
  // Long enough for the hang-up tone.
  setTimeout(() => closing?.destroy(), 400)
  rememberCall(log)
}

/** After the call she updates her notes, in the background; a failure only costs this one memory. */
function rememberCall(call: Record[]): void {
  if (!call.some((r) => r.who === 'you')) return
  const s = getSettings()
  runClaude({
    cwd: dir(),
    prompt: memoryPrompt(readMemory(), call.map(transcriptLine).join('\n')),
    model: s.callModel,
    tools: ['Write'],
    sessionId: randomUUID(),
    writable: true
  }).catch(() => {})
}

export function initCall(hangUp: () => void): void {
  ipcMain.handle('call:init', () => ({ state, uiFont: getSettings().uiFont }))
  ipcMain.on('call:send', (_e, text: string) => {
    const clean = text.trim()
    if (!clean || !state.active) return
    generation++
    lastSpoke = Date.now()
    push('call:clear')
    record({ who: 'you', text: clean })
    speak(clean)
  })
  ipcMain.on('call:hangUp', () => hangUp())
  ipcMain.on('call:interactive', (_e, on: boolean) => win?.setIgnoreMouseEvents(!on, { forward: true }))
  ipcMain.on('call:reading', (_e, id: string | null) => {
    if (reading?.id === id) return
    reading = id ? { id, since: Date.now() } : undefined
  })
  ipcMain.handle('call:revealMemory', () => {
    mkdirSync(dir(), { recursive: true })
    if (!existsSync(memoryFile())) writeFileSync(memoryFile(), '')
    shell.showItemInFolder(memoryFile())
  })
}
