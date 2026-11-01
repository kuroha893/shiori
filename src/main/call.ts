import { app, BrowserWindow, ipcMain, net, screen, shell } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CallLine, CallMood, CallState, PaperMeta } from '../shared/types'
import { openConversation, runClaude, type Conversation } from './claude'
import { listPapers, readMeta } from './library'
import { keepOnTop, petBounds } from './pet'
import { getSettings, saveSettings } from './settings'
import { callPrompt, memoryPrompt } from './yachiyo'
import { YACHIYO } from '../shared/contacts'
import { contactDir, getContact } from './contacts'

/* A call with a contact: you type, they answer aloud with subtitles. It stays open for hours, mostly in silence. */

const WIDTH = 340
const HEIGHT = 340
const GAP = 8
// A nudge from her needs a long stretch without one, and without you talking.
const NUDGE_EVERY = 45 * 60_000
const QUIET_BEFORE_NUDGE = 10 * 60_000
// When you feel like chatting she starts something herself, every so often, once you have gone quiet.
const CHAT_EVERY = [8 * 60_000, 15 * 60_000]
const QUIET_BEFORE_CHAT = 3 * 60_000
// Remarks on something you just did stay spaced out, so a burst of clicks gets at most one.
const REACT_GAP = { chat: 2 * 60_000, normal: 8 * 60_000 }
const REACT_GAP_BIG = 60_000
const QUIET_AFTER_TALK = 30_000
const STUCK_AFTER = 20 * 60_000
const AWAY_AFTER = 20 * 60_000
// The mood button cycles, so a click only counts once it has been left alone for a moment.
const MOOD_SETTLE = 5000
const CHAT_NOW_GAP = 5 * 60_000

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
let nextChat = 0
let lastChatNow = 0
/** Where the mood button has just been clicked to, until it settles */
let settling: { mood: CallMood; timer: NodeJS.Timeout } | undefined
/** Turns she started herself; "do not disturb" drops them. */
const unprompted = new Set<{ dropped: boolean }>()
let lateNoted = false
let reading: { id: string; since: number; moved: number } | undefined
let awaySince: number | undefined
let lastReaction = 0
const reacted = new Set<string>()
const known = new Map<string, PaperMeta>()

let contact = YACHIYO
const dir = (id = contact) => contactDir(id)
const person = () => getContact(contact) ?? getContact(YACHIYO)!
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
    systemPrompt: callPrompt({ contact: person(), memory: readMemory(), lastCall: lastCallTail() })
  })
  return conversation
}

async function synthesize(text: string): Promise<{ audio: Uint8Array; type: string } | undefined> {
  const s = getSettings()
  const { voice, language } = person()
  if (!s.fishKey || !voice) return undefined
  try {
    const res = await net.fetch(`${process.env.FISH_AUDIO_URL ?? 'https://api.fish.audio'}/v1/tts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.fishKey}`, 'Content-Type': 'application/json', model: s.fishModel },
      body: JSON.stringify({ text, reference_id: voice, format: 'mp3', latency: 'balanced', language })
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

async function runTurn(content: string, turnGeneration: number, turn: { dropped: boolean }, isUnprompted: boolean, isReply: boolean): Promise<void> {
  let delivered = Promise.resolve()
  let buffer = ''
  const said = new Set<string>()
  const emit = (raw: string) => {
    const line = parseLine(raw)
    if (!line || said.has(line.say) || turn.dropped || turnGeneration !== generation) return
    said.add(line.say)
    record({ who: 'her', text: line.say, zh: line.zh })
    const voice = synthesize(line.tone ? `[${line.tone}] ${line.say}` : line.say)
    const entry: CallLine = { id: randomUUID(), say: line.say, zh: line.zh, unprompted: isUnprompted, reply: isReply }
    delivered = delivered.then(async () => {
      const sound = await voice
      if (!turn.dropped && turnGeneration === generation) push('call:line', { ...entry, ...sound })
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

function speak(content: string, isUnprompted = false, isReply = false): void {
  const turnGeneration = generation
  const turn = { dropped: false }
  if (isUnprompted) unprompted.add(turn)
  pending++
  update({ thinking: true })
  turns = turns
    .then(() => (turn.dropped ? undefined : runTurn(`${statusLine()} ${content}`, turnGeneration, turn, isUnprompted, isReply)))
    .finally(() => {
      unprompted.delete(turn)
      if (--pending === 0) update({ thinking: false })
    })
}

function dropUnprompted(): void {
  for (const turn of unprompted) turn.dropped = true
  push('call:dropUnprompted')
}

/** While the button is being clicked through she doesn't speak up at all, whatever color it passes over. */
const currentMood = (): CallMood => (settling ? 'quiet' : getSettings().callMood)

function settleMood(): void {
  if (!settling) return
  const { mood, timer } = settling
  clearTimeout(timer)
  settling = undefined
  if (mood === getSettings().callMood) return
  saveSettings({ callMood: mood })
  if (!state.active) return
  // A new mood starts from now; whatever she held back while in another mood isn't due all at once.
  const now = Date.now()
  lastReaction = lastNudge = now
  if (mood !== 'chat') return
  scheduleChat()
  // You just said you want to talk, so she doesn't wait for her next turn, unless she is already talking.
  if (pending === 0 && now - lastChatNow >= CHAT_NOW_GAP) {
    lastChatNow = now
    speak('[chat] they just let you know they feel like chatting', true)
  }
}

/** Something happened in the app; she says so if a call is open. */
export function callEvent(text: string): void {
  if (!state.active) return
  record({ who: 'event', text })
  speak(`[event] ${text}`)
}

/**
 * She reacts to something you just did, unless you asked not to be disturbed. Wanting to chat she always
 * speaks; otherwise she may stay silent. Each thing gets one remark per call.
 */
function react(key: string, what: string, big = false): void {
  const mood = currentMood()
  if (!state.active || mood === 'quiet' || reacted.has(key)) return
  const now = Date.now()
  if (now - lastSpoke < QUIET_AFTER_TALK || now - lastReaction < (big ? REACT_GAP_BIG : REACT_GAP[mood])) return
  reacted.add(key)
  lastReaction = lastNudge = now
  scheduleChat()
  speak(`[${mood === 'chat' ? 'chat' : 'note'}] ${what}`, true)
}

export function watchPaper(meta: PaperMeta): void {
  const before = known.get(meta.id)
  known.set(meta.id, meta)
  if (!state.active) return
  const title = meta.titleZh || meta.title
  if (!before) return react(`added:${meta.id}`, 'they just added a new paper to the shelf')
  if (before.status === 'processing' && meta.status === 'ready') callEvent(`《${title}》翻译好了`)
  if (before.status === 'processing' && meta.status === 'error') callEvent(`《${title}》处理失败了`)
  if (!before.finished && meta.finished) react(`finished:${meta.id}`, `they just finished reading 《${title}》`, true)
  if (!before.likedAt && meta.likedAt) react(`liked:${meta.id}`, `they just gave 《${title}》 a heart`)
  if (reading?.id === meta.id && Math.abs((before.readPos?.ratio ?? 0) - (meta.readPos?.ratio ?? 0)) > 0.002) {
    reading.moved = Date.now()
    reacted.delete(`stuck:${meta.id}`)
  }
}

const scheduleChat = () => {
  nextChat = Date.now() + CHAT_EVERY[0] + Math.random() * (CHAT_EVERY[1] - CHAT_EVERY[0])
}

/** Her unprompted remarks: how often depends on the mood, and outside "chat" she may still decide to stay silent. */
function checkNudges(): void {
  const now = Date.now()
  const mood = currentMood()
  if (mood === 'quiet') return
  if (reading && !awaySince && now - reading.moved >= STUCK_AFTER && !known.get(reading.id)?.finished) {
    react(`stuck:${reading.id}`, `they have been on the same spot of this paper for ${span(now - reading.moved)}`)
  }
  if (mood === 'chat') {
    if (now >= nextChat && now - lastSpoke >= QUIET_BEFORE_CHAT) {
      scheduleChat()
      speak('[chat]', true)
    }
    return
  }
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
  speak(`[note] ${note}`, true)
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

export function startCall(id: string): void {
  if (state.active) return
  contact = id
  mkdirSync(join(dir(), 'calls'), { recursive: true })
  const now = new Date()
  logFile = join(dir(), 'calls', `${now.toISOString().replace(/[:.]/g, '-')}.jsonl`)
  log = []
  generation++
  lastSpoke = lastNudge = now.getTime()
  lateNoted = false
  scheduleChat()
  reacted.clear()
  lastReaction = lastChatNow = 0
  awaySince = undefined
  known.clear()
  for (const p of listPapers()) known.set(p.id, p)
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
  keepOnTop(win)
  win.setIgnoreMouseEvents(true, { forward: true })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.once('ready-to-show', () => win?.showInactive())
  // The window of the call before this one closes late, and must not take this one with it.
  const opened = win
  win.on('closed', () => {
    if (win === opened) win = undefined
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
  settleMood()
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
    prompt: memoryPrompt(person().name, readMemory(), call.map(transcriptLine).join('\n')),
    model: s.callModel,
    tools: ['Write'],
    sessionId: randomUUID(),
    writable: true
  }).catch(() => {})
}

export function initCall(hangUp: () => void): void {
  ipcMain.handle('call:init', () => {
    const { name, avatar } = person()
    return { state, contact: { name, avatar }, mood: getSettings().callMood, uiFont: getSettings().uiFont }
  })
  ipcMain.on('call:focus', () => win?.focus())
  // With the character on the desktop the call stands beside her, so it is only moved on its own.
  ipcMain.on('call:move', (_e, x: number, y: number) => {
    if (!petBounds()) win?.setPosition(Math.round(x), Math.round(y))
  })
  ipcMain.on('call:moved', () => {
    if (!win || petBounds()) return
    const [x, y] = win.getPosition()
    saveSettings({ callPosition: { x, y } })
  })
  ipcMain.on('call:mood', (_e, mood: CallMood) => {
    if (settling) clearTimeout(settling.timer)
    settling = { mood, timer: setTimeout(settleMood, MOOD_SETTLE) }
    // Do not disturb means now, even if the button is only passing over it.
    if (mood === 'quiet') dropUnprompted()
  })
  ipcMain.on('call:send', (_e, text: string) => {
    const clean = text.trim()
    if (!clean || !state.active) return
    generation++
    lastSpoke = Date.now()
    push('call:clear')
    record({ who: 'you', text: clean })
    speak(clean, false, true)
  })
  ipcMain.on('call:hangUp', () => hangUp())
  // Leaving Shiori and coming back; time away doesn't count as being stuck on a page.
  app.on('did-resign-active', () => (awaySince = Date.now()))
  app.on('did-become-active', () => {
    const away = awaySince ? Date.now() - awaySince : 0
    awaySince = undefined
    if (reading) reading.moved = Date.now()
    if (away >= AWAY_AFTER) {
      reacted.delete('back')
      react('back', `they just came back to Shiori after ${span(away)} away`)
    }
  })
  ipcMain.on('call:interactive', (_e, on: boolean) => win?.setIgnoreMouseEvents(!on, { forward: true }))
  ipcMain.on('call:reading', (_e, id: string | null) => {
    if (reading?.id === id) return
    reading = id ? { id, since: Date.now(), moved: Date.now() } : undefined
    const paper = id && readMeta(id)
    if (paper) react(`opened:${paper.id}`, `they just opened 《${paper.titleZh || paper.title}》`)
  })
  ipcMain.handle('call:revealMemory', (_e, id: string) => {
    const file = join(dir(id), 'memory.md')
    mkdirSync(dir(id), { recursive: true })
    if (!existsSync(file)) writeFileSync(file, '')
    shell.showItemInFolder(file)
  })
}
