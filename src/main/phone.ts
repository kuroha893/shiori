import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, statfsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SYSTEM_THREAD, type PaperMeta, type PhoneConversation, type PhoneItem, type PhoneThread, type PhoneView, type RoomNote, type SystemNotice } from '../shared/types'
import { PROVIDER_NAMES, modelLabel, type ModelUse, type Provider } from '../shared/models'
import { getSettings, saveSettings } from './settings'
import { root } from './library'
import { contactDir, getContact, loadContacts } from './contacts'
import { modelFor, onModelSwap, runAgent } from './ai'
import { notesPrompt } from './callPrompt'
import { callActive, callContact, callEvent, onVoiceTrouble } from './call'
import { isSignedIn, onAccountChange, onExpired } from './openreview'
import { onStudyDone } from './room'
import { taskAction, taskList } from './tasks'

/*
 * The phone: Shiori Talk, where the app and the contacts reach the owner. Facts come from the app as notices, each with
 * the one thing to do about it; the contacts only write about their own days and react to what the owner did. How
 * often each of them writes follows how close they are: whoever was called last writes most, someone not called for a
 * month goes quiet.
 *
 * Notices live in <library>/notices.json, a contact's messages in her folder's notes.json.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
// A message about her own day comes after a long time away.
const DAY_NOTE_AFTER = 6 * HOUR
// Days between such messages, by how recently each was called: the latest, the one before, everyone else.
const EVERY = [1, 2, 4]
// Not called for this long, she stops writing until the next call.
const FADE = 30 * DAY
// All of them together write no more than this a day, reactions included.
const DAILY_CAP = 3
const REACTIONS_A_DAY = 2
// What the owner did waits a few quiet minutes before the reaction is written.
const MOMENT_QUIET = 5 * MINUTE
const KEEP = 60 * DAY
const KEEP_NOTICES = 200
// Below this much free disk the library is about to fail to save; above the second it is fine again.
const DISK_LOW = 2 * 1024 ** 3
const DISK_OK = 3 * 1024 ** 3

let send: (channel: string, payload?: unknown) => void = () => {}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

const dayOf = (d: Date | string | number = new Date()) => {
  const t = new Date(d)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

/** Calendar days from one moment to another */
const daysBetween = (a: string | number, b: string | number) => {
  const start = (x: string | number) => {
    const d = new Date(x)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  return Math.round((start(b) - start(a)) / DAY)
}

/* ---------- notices ---------- */

const noticesFile = () => join(root(), 'notices.json')
let notices: SystemNotice[] | undefined
const allNotices = (): SystemNotice[] => (notices ??= readJson<SystemNotice[]>(noticesFile(), []))

function saveNotices(): void {
  const list = allNotices()
  if (list.length > KEEP_NOTICES) notices = list.slice(-KEEP_NOTICES)
  writeJson(noticesFile(), notices)
  changed()
}

/** Tell the owner something. A lasting condition (`key`) is told once until it ends. On a call she hears it too. */
export function notice(n: Omit<SystemNotice, 'id' | 'at'>, event?: string): void {
  try {
    if (n.key && allNotices().some((x) => x.key === n.key && !x.done)) return
    allNotices().push({ id: randomUUID(), at: new Date().toISOString(), ...n })
    saveNotices()
  } catch {
    // no library yet
  }
  if (event) callEvent(event)
}

/** A lasting condition is over; true when one had been told. */
export function resolveNotice(key: string): boolean {
  try {
    const open = allNotices().filter((x) => x.key === key && !x.done)
    if (!open.length) return false
    // over and done: nothing left to read or to do
    for (const x of open) Object.assign(x, { done: true, read: true })
    saveNotices()
    return true
  } catch {
    return false
  }
}

/** Papers that just finished or failed */
const known = new Map<string, PaperMeta>()
export function phonePaper(meta: PaperMeta): void {
  const before = known.get(meta.id)
  known.set(meta.id, meta)
  if (!before) return
  // the desktop notification names it the way the owner reads paper titles (the phone looks the paper up itself)
  const title = getSettings().paperTitle === 'en' ? meta.title : meta.titleZh || meta.title
  const action = { kind: 'paper' as const, paper: meta.id }
  if (before.status === 'processing' && meta.status === 'ready') notice({ kind: 'paper-ready', title, paper: meta.id, action }, `《${title}》翻译好了`)
  if (before.status === 'processing' && meta.status === 'error') notice({ kind: 'paper-failed', title, paper: meta.id, action }, `《${title}》处理失败了`)
  if (!before.finished && meta.finished) addMoment(`they just finished reading 《${title}》`)
}

const USE_NAMES: Record<ModelUse, string> = { process: '处理论文', chat: '问答', call: '通话' }

/** A service in use was signed out, or (out false) is signed in again. */
export function serviceSignedOut(p: Provider, out: boolean): void {
  const key = `signed-out:${p}`
  if (out) notice({ kind: 'signed-out', key, provider: p, title: `${PROVIDER_NAMES[p]} 未登录`, action: { kind: 'login', provider: p } })
  else if (resolveNotice(key)) recovered(p)
}

/** The allowance of a service in use ran out, or (out false) is back. */
export function serviceExhausted(p: Provider, out: boolean, resetsAt?: number): void {
  const key = `quota-out:${p}`
  if (out) {
    const at = resetsAt ? new Date(resetsAt) : undefined
    const when = at && (dayOf(at) === dayOf() ? `${pad(at.getHours())}:${pad(at.getMinutes())}` : `${at.getMonth() + 1} 月 ${at.getDate()} 日 ${pad(at.getHours())}:${pad(at.getMinutes())}`)
    notice({ kind: 'quota-out', key, provider: p, title: `${PROVIDER_NAMES[p]} 额度用完了`, ...(when ? { sub: `${when} 恢复` } : {}) })
  } else if (resolveNotice(key)) recovered(p)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A service is usable again; tasks that failed meanwhile can go again. */
function recovered(p: Provider): void {
  const failed = taskList().failed.length
  if (failed) notice({ kind: 'recovered', provider: p, title: `${PROVIDER_NAMES[p]} 恢复了`, count: failed, action: { kind: 'retry' } })
}

function checkDisk(): void {
  try {
    const s = statfsSync(root())
    const free = s.bavail * s.bsize
    if (free < DISK_LOW) notice({ kind: 'disk', key: 'disk', title: '磁盘空间快满了', sub: `剩余 ${(free / 1024 ** 3).toFixed(1)} GB` })
    else if (free > DISK_OK) resolveNotice('disk')
  } catch {
    // no library yet
  }
}

/* ---------- her messages ---------- */

const notesFile = (id: string) => join(contactDir(id), 'notes.json')
const notesOf = (id: string) => readJson<RoomNote[]>(notesFile(id), [])

/** When each contact was last called */
function lastCall(id: string): number | undefined {
  try {
    const name = readdirSync(join(contactDir(id), 'calls'))
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .pop()
    return name ? Date.parse(name.replace(/T(\d+)-(\d+)-(\d+)-(\d+)Z.*/, 'T$1:$2:$3.$4Z')) : undefined
  } catch {
    return undefined
  }
}

/** The contacts who still write, the one called most recently first */
function ranked(): string[] {
  const now = Date.now()
  return loadContacts()
    .map((c) => ({ id: c.id, at: lastCall(c.id) }))
    .filter((c): c is { id: string; at: number } => !!c.at && now - c.at < FADE)
    .sort((a, b) => b.at - a.at)
    .map((c) => c.id)
}

const writtenToday = (kind?: RoomNote['kind']) => {
  const today = dayOf()
  return loadContacts().reduce((n, c) => n + notesOf(c.id).filter((x) => x.kind !== 'news' && (!kind || x.kind === kind) && dayOf(x.at) === today).length, 0)
}

const writing = new Set<string>()

/** She writes one message: about her day, or a reaction to what the owner just did. */
async function writeNote(id: string, moments: { at: string; text: string }[]): Promise<void> {
  const person = getContact(id)
  if (!person || writing.has(id)) return
  writing.add(id)
  try {
    const memoryFile = join(contactDir(id), 'memory.md')
    const memory = existsSync(memoryFile) ? readFileSync(memoryFile, 'utf8') : ''
    const recent = notesOf(id)
      .slice(-5)
      .map((n) => n.zh)
    const prompt = notesPrompt({ contact: person, memory, recent, moments })
    const model = await modelFor(getSettings().callModel, 'call')
    const res = await runAgent({ cwd: contactDir(id), prompt, model, effort: getSettings().callEffort, write: false })
    if (res.isError) return
    const json = JSON.parse(res.text.slice(res.text.indexOf('{'), res.text.lastIndexOf('}') + 1))
    if (typeof json.zh !== 'string' || !json.zh.trim()) return
    const note: RoomNote = {
      id: randomUUID(),
      at: new Date().toISOString(),
      kind: moments.length ? 'reaction' : 'day',
      ...(person.language !== 'zh' && typeof json.say === 'string' && json.say.trim() ? { say: json.say.trim() } : {}),
      zh: json.zh.trim(),
      links: []
    }
    const cutoff = Date.now() - KEEP
    writeJson(notesFile(id), [...notesOf(id), note].filter((n) => Date.parse(n.at) >= cutoff))
  } catch {
    // a message that didn't get written is simply not sent
  } finally {
    writing.delete(id)
    changed()
  }
}

/** Time away from the app, also across a quit, decides whether messages about their days are due. */
let away = { since: 0, lasted: 0 }

async function dayNotes(): Promise<void> {
  if (away.lasted < DAY_NOTE_AFTER) return
  away.lasted = 0
  for (const [rank, id] of ranked().entries()) {
    if (writtenToday() >= DAILY_CAP) return
    if (callContact() === id) continue
    const last = notesOf(id)
      .filter((n) => n.kind === 'day')
      .pop()
    if (last && daysBetween(last.at, Date.now()) < EVERY[Math.min(rank, EVERY.length - 1)]) continue
    await writeNote(id, [])
  }
}

let moments: { at: string; text: string }[] = []
let momentTimer: NodeJS.Timeout | undefined

/** Something the owner did while no call was open; the closest contact may react to it in a message. */
function addMoment(text: string): void {
  if (callActive()) return
  moments.push({ at: new Date().toISOString(), text })
  clearTimeout(momentTimer)
  momentTimer = setTimeout(() => void react(), MOMENT_QUIET)
}

async function react(): Promise<void> {
  const taken = moments
  moments = []
  const id = ranked()[0]
  if (!id || !taken.length || callActive() || writtenToday('reaction') >= REACTIONS_A_DAY || writtenToday() >= DAILY_CAP) return
  await writeNote(id, taken)
}

/* ---------- what the phone shows ---------- */

/** A contact's past calls: when each began and how long it lasted */
function callsOf(id: string): { at: string; seconds: number }[] {
  const folder = join(contactDir(id), 'calls')
  if (!existsSync(folder)) return []
  const out: { at: string; seconds: number }[] = []
  for (const name of readdirSync(folder).filter((f) => f.endsWith('.jsonl'))) {
    const start = Date.parse(name.replace(/T(\d+)-(\d+)-(\d+)-(\d+)Z.*/, 'T$1:$2:$3.$4Z'))
    const lines = readFileSync(join(folder, name), 'utf8').trim().split('\n')
    let end = start
    try {
      end = Date.parse(JSON.parse(lines[lines.length - 1]).at)
    } catch {
      /* a call cut short by a crash */
    }
    // the call going on now isn't a record yet
    if (callContact() === id && name === readdirSync(folder).filter((f) => f.endsWith('.jsonl')).sort().pop()) continue
    if (Number.isFinite(start) && end - start >= 5000) out.push({ at: new Date(start).toISOString(), seconds: Math.round((end - start) / 1000) })
  }
  return out
}

const muted = () => new Set(getSettings().mutedContacts ?? [])

export function phoneView(): PhoneView {
  const mute = muted()
  const conversations: PhoneConversation[] = []
  let latest: PhoneView['latest']
  let list: SystemNotice[] = []
  try {
    list = allNotices()
  } catch {
    /* no library yet */
  }
  const lastNotice = list[list.length - 1]
  if (lastNotice) conversations.push({ id: SYSTEM_THREAD, at: lastNotice.at, last: lastNotice.title, unread: list.filter((n) => !n.read).length })
  // On the home screen only what still matters: a condition that is over doesn't take the spot.
  const liveNotice = [...list].reverse().find((n) => !n.done)
  if (liveNotice) latest = { thread: SYSTEM_THREAD, at: liveNotice.at, notice: liveNotice }
  for (const c of loadContacts()) {
    const notes = notesOf(c.id)
    const note = notes[notes.length - 1]
    const call = callsOf(c.id).sort((a, b) => a.at.localeCompare(b.at)).pop()
    const conv: PhoneConversation = { id: c.id, unread: notes.filter((n) => !n.read).length, ...(mute.has(c.id) ? { muted: true } : {}) }
    if (note && (!call || note.at >= call.at)) Object.assign(conv, { at: note.at, last: note.zh })
    else if (call) Object.assign(conv, { at: call.at, call: call.seconds })
    conversations.push(conv)
    if (note && (!latest || note.at > latest.at)) latest = { thread: c.id, at: note.at, note }
  }
  conversations.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
  const unread = conversations.filter((c) => !c.muted).reduce((n, c) => n + c.unread, 0)
  return { conversations, unread, latest }
}

export function phoneThread(id: string): PhoneThread {
  let items: PhoneItem[]
  if (id === SYSTEM_THREAD) {
    let list: SystemNotice[] = []
    try {
      list = allNotices()
    } catch {
      /* no library yet */
    }
    items = list.map((n) => ({ type: 'notice', at: n.at, notice: n }))
  } else {
    items = [...notesOf(id).map((n): PhoneItem => ({ type: 'note', at: n.at, note: n })), ...callsOf(id).map((c): PhoneItem => ({ type: 'call', ...c }))]
  }
  items.sort((a, b) => a.at.localeCompare(b.at))
  const firstUnread = items.findIndex((i) => (i.type === 'note' && !i.note.read) || (i.type === 'notice' && !i.notice.read))
  return { id, items, ...(firstUnread >= 0 ? { firstUnread } : {}) }
}

function markRead(id: string): void {
  if (id === SYSTEM_THREAD) {
    if (!allNotices().some((n) => !n.read)) return
    for (const n of allNotices()) n.read = true
    return saveNotices()
  }
  const notes = notesOf(id)
  if (!notes.some((n) => !n.read)) return
  writeJson(notesFile(id), notes.map((n) => ({ ...n, read: true })))
  changed()
}

/** A notice's button that the main process carries out itself */
function act(noticeId: string): void {
  const n = allNotices().find((x) => x.id === noticeId)
  if (!n || n.action?.kind !== 'retry') return
  for (const t of taskList().failed) taskAction({ type: 'retry', key: t.key })
  n.done = true
  saveNotices()
}

/** Views are quick to gather but asked for often; a burst of changes sends one. */
let pushTimer: NodeJS.Timeout | undefined
function changed(): void {
  clearTimeout(pushTimer)
  pushTimer = setTimeout(() => send('phone:changed', phoneView()), 50)
}

/** Another library: its notices are read afresh. */
export function phoneLibraryChanged(): void {
  notices = undefined
  changed()
}

export function initPhone(o: { send: (channel: string, payload?: unknown) => void; papers: PaperMeta[] }): void {
  send = o.send
  for (const p of o.papers) known.set(p.id, p)

  onModelSwap((use, wanted, picked) => {
    const key = `model:${use}`
    if (picked === wanted) return void resolveNotice(key)
    notice({ kind: 'model', key, title: `${USE_NAMES[use]}改用了 ${modelLabel(picked)}`, action: { kind: 'settings' } })
  })
  onVoiceTrouble((t) => {
    if (!t) return void resolveNotice('voice')
    notice({ kind: 'voice', key: 'voice', title: { key: 'Fish Audio 的 key 不对', balance: 'Fish Audio 余额不足', voice: '找不到她的音色' }[t], action: { kind: 'settings' } })
  })
  onExpired(() => notice({ kind: 'openreview-expired', key: 'openreview', title: 'OpenReview 登录已过期', action: { kind: 'openreview' } }))
  onAccountChange(() => {
    if (isSignedIn()) resolveNotice('openreview')
  })
  onStudyDone((minutes) => {
    if (minutes >= 20 && !callActive()) addMoment(`they just finished a pomodoro: ${minutes} minutes of focus`)
  })

  // Reading far into the night, once a night
  let lateNoted = ''
  ipcMain.on('call:reading', (_e, id: string | null) => {
    const now = new Date()
    if (!id || now.getHours() >= 5 || now.getHours() < 1 || lateNoted === dayOf(now)) return
    lateNoted = dayOf(now)
    addMoment(`it is ${pad(now.getHours())}:${pad(now.getMinutes())} at night and they are still reading`)
  })

  const seen = () => join(app.getPath('userData'), 'phone-seen.json')
  const lastSeen = readJson<{ at?: number }>(seen(), {}).at
  if (lastSeen) away = { since: lastSeen, lasted: Date.now() - lastSeen }
  const markSeen = () => writeJson(seen(), { at: Date.now() })
  setInterval(markSeen, 10 * MINUTE)
  app.on('before-quit', markSeen)
  app.on('did-resign-active', () => {
    away = { since: Date.now(), lasted: away.lasted }
    markSeen()
  })
  app.on('did-become-active', () => {
    if (away.since) away = { since: 0, lasted: Math.max(away.lasted, Date.now() - away.since) }
    void dayNotes()
  })
  setTimeout(() => void dayNotes(), 20_000)
  checkDisk()
  setInterval(checkDisk, HOUR)

  ipcMain.handle('phone:view', () => phoneView())
  ipcMain.handle('phone:thread', (_e, id: string) => phoneThread(id))
  ipcMain.handle('phone:read', (_e, id: string) => markRead(id))
  ipcMain.handle('phone:mute', (_e, id: string, on: boolean) => {
    const list = getSettings().mutedContacts ?? []
    saveSettings({ mutedContacts: on ? [...new Set([...list, id])] : list.filter((x) => x !== id) })
    changed()
  })
  ipcMain.handle('phone:act', (_e, noticeId: string) => act(noticeId))
}
