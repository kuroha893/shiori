import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { JournalDay, JournalPaper, PaperMeta, RoomFact, RoomLink, RoomNote, RoomView, StudyPlan, StudyState } from '../shared/types'
import { getSettings } from './settings'
import { listPapers, loadAnnotations, loadChat, readMeta, root } from './library'
import { contactDir, getContact, loadContacts } from './contacts'
import { modelFor, runAgent } from './ai'
import { notesPrompt } from './callPrompt'
import { callActive, callEvent, onMissedEvent, setCallMood } from './call'
import { callWith } from './pet'

/*
 * 大厅, the lobby Shiori opens on. Everything in it grows out of what already happens: notes the contact last called
 * leaves about what the app did while no call was open, the papers being read, the owner's own highlights and
 * questions day by day, and a study timer she can keep with them. Its files live in <library>/room; her notes in her
 * own folder.
 */

const dir = () => join(root(), 'room')
const file = (name: string) => join(dir(), name)

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

/** A local calendar day, YYYY-MM-DD */
const dayOf = (d: Date | string | number = new Date()) => {
  const t = new Date(d)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
// Facts wait for company before she writes: a few quiet minutes, but never much longer than half an hour.
const WRITE_AFTER_QUIET = 5 * MINUTE
const WRITE_AT_MOST = 30 * MINUTE
// A note about her own day: after a long time away, at most one a day.
const DAY_NOTE_AFTER = 6 * HOUR
const KEEP_NOTES = 30 * 24 * HOUR
// Shorter stretches with the timer don't count as studying.
const STUDY_COUNTS = 5

let send: (channel: string, payload?: unknown) => void = () => {}
let mainWindow: () => BrowserWindow | undefined = () => undefined

/* ---------- wallpaper ---------- */

const IMAGE = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']

export function wallpaperFile(): string | undefined {
  if (!existsSync(dir())) return undefined
  const name = readdirSync(dir()).find((f) => f.startsWith('wallpaper.') && IMAGE.includes(extname(f).toLowerCase()))
  return name && file(name)
}

function wallpaperUrl(): string | undefined {
  const f = wallpaperFile()
  return f && `shiori://room/wallpaper?v=${Math.round(statSync(f).mtimeMs)}`
}

function clearWallpaper(): void {
  for (;;) {
    const f = wallpaperFile()
    if (!f) return
    rmSync(f)
  }
}

async function chooseWallpaper(): Promise<void> {
  const win = mainWindow()
  const options = { properties: ['openFile' as const], filters: [{ name: '图片', extensions: IMAGE.map((e) => e.slice(1)) }] }
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const path = r.filePaths[0]
  if (r.canceled || !path) return
  clearWallpaper()
  mkdirSync(dir(), { recursive: true })
  copyFileSync(path, file(`wallpaper${extname(path).toLowerCase()}`))
  changed()
}

/* ---------- papers opened ---------- */

interface Opens {
  /** The papers opened each day */
  days: Record<string, string[]>
  /** When each paper was last opened */
  last: Record<string, string>
}

const loadOpens = () => readJson<Opens>(file('opens.json'), { days: {}, last: {} })

function recordOpen(id: string): void {
  const opens = loadOpens()
  const day = dayOf()
  const list = (opens.days[day] ??= [])
  if (!list.includes(id)) list.push(id)
  opens.last[id] = new Date().toISOString()
  writeJson(file('opens.json'), opens)
}

/** The paper being read: the one opened last that is still unfinished, or else the furthest along. */
function readingNow(): string | undefined {
  const usable = (m?: PaperMeta) => !!m && m.status === 'ready' && !m.finished
  const { last } = loadOpens()
  const opened = Object.entries(last).sort((a, b) => b[1].localeCompare(a[1]))
  for (const [id] of opened) if (usable(readMeta(id))) return id
  return listPapers()
    .filter((p) => usable(p) && (p.readPos?.ratio ?? 0) > 0.01)
    .sort((a, b) => (b.readPos?.ratio ?? 0) - (a.readPos?.ratio ?? 0))[0]?.id
}

/** One of the owner's highlights, the same all day and another the next. */
async function quoteOfTheDay(): Promise<RoomView['quote']> {
  const all: { text: string; paper: string }[] = []
  for (const p of listPapers()) for (const a of await loadAnnotations(p.id)) if (a.text.trim().length >= 12) all.push({ text: a.text.trim(), paper: p.id })
  if (!all.length) return undefined
  let h = 0
  for (const c of dayOf()) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return all[h % all.length]
}

/* ---------- her notes ---------- */

/** Who leaves notes: the contact last called, or the first one there is. */
function noteWriter(): string | undefined {
  const id = getSettings().roomContact
  if (id && getContact(id)) return id
  return loadContacts()[0]?.id
}

const notesFile = (contact: string) => join(contactDir(contact), 'notes.json')
const loadNotes = (contact: string) => readJson<RoomNote[]>(notesFile(contact), [])
const loadInbox = () => readJson<RoomFact[]>(file('inbox.json'), [])

let writing = false
/** Asked to write again while writing, and whether a note about her day was wanted then */
let again: boolean | undefined
let writeTimer: NodeJS.Timeout | undefined

/** Something happened with no call open: keep it for her next note. */
function addFact(text: string, links: RoomLink[]): void {
  const inbox = loadInbox()
  inbox.push({ at: new Date().toISOString(), text, links })
  writeJson(file('inbox.json'), inbox)
  schedule()
}

function schedule(): void {
  clearTimeout(writeTimer)
  const inbox = loadInbox()
  if (!inbox.length) return
  const first = Date.parse(inbox[0].at)
  const last = Date.parse(inbox[inbox.length - 1].at)
  const due = Math.min(last + WRITE_AFTER_QUIET, first + WRITE_AT_MOST)
  writeTimer = setTimeout(() => void write(false), Math.max(0, due - Date.now()))
}

/** A fact the owner has already seen to, such as a paper opened since it was translated, needs no note. */
function stillNews(f: RoomFact): boolean {
  const { last } = loadOpens()
  return !f.links.some((l) => l.kind === 'paper' && (!readMeta(l.paper) || (last[l.paper] ?? '') > f.at))
}

/** When the owner last left and came back, to tell whether a note about her day is due. */
let away = { since: 0, lasted: 0 }

function dayNoteDue(contact: string): boolean {
  if (away.lasted < DAY_NOTE_AFTER) return false
  const today = dayOf()
  return !loadNotes(contact).some((n) => n.kind === 'day' && dayOf(n.at) === today)
}

/** She writes whatever is waiting, and a note about her day when one is due. */
async function write(withDay: boolean): Promise<void> {
  if (writing) {
    again = again || withDay
    return
  }
  const contact = noteWriter()
  const person = contact && getContact(contact)
  if (!contact || !person) return
  const taken = loadInbox()
  const items = taken.filter(stillNews)
  const day = withDay && dayNoteDue(contact)
  if (!items.length && !day) {
    if (taken.length) writeJson(file('inbox.json'), loadInbox().slice(taken.length))
    return
  }
  writing = true
  changed()
  try {
    const memoryFile = join(contactDir(contact), 'memory.md')
    const memory = existsSync(memoryFile) ? readFileSync(memoryFile, 'utf8') : ''
    const prompt = notesPrompt({ contact: person, memory, items, day })
    const model = await modelFor(getSettings().callModel, 'call')
    const res = await runAgent({ cwd: contactDir(contact), prompt, model, effort: getSettings().callEffort, write: false })
    if (res.isError) throw new Error(res.text)
    const json = JSON.parse(res.text.slice(res.text.indexOf('{'), res.text.lastIndexOf('}') + 1))
    const fresh: RoomNote[] = []
    const used = new Set<number>()
    for (const n of Array.isArray(json.notes) ? json.notes : []) {
      const nums: number[] = (Array.isArray(n.items) ? n.items : []).map(Number).filter((i: number) => items[i - 1] && !used.has(i))
      if (!nums.length || typeof n.zh !== 'string' || !n.zh.trim()) continue
      nums.forEach((i) => used.add(i))
      const facts = nums.map((i) => items[i - 1])
      fresh.push({
        id: randomUUID(),
        at: facts.map((f) => f.at).sort().pop()!,
        kind: 'news',
        ...(person.language !== 'zh' && typeof n.say === 'string' && n.say.trim() ? { say: n.say.trim() } : {}),
        zh: n.zh.trim(),
        links: dedupeLinks(facts.flatMap((f) => f.links))
      })
    }
    // Whatever she left out still gets said, in the app's own words.
    for (const [i, f] of items.entries()) if (!used.has(i + 1)) fresh.push({ id: randomUUID(), at: f.at, kind: 'news', zh: f.text, links: f.links })
    if (day && typeof json.day?.zh === 'string' && json.day.zh.trim()) {
      fresh.push({
        id: randomUUID(),
        at: new Date().toISOString(),
        kind: 'day',
        ...(person.language !== 'zh' && typeof json.day.say === 'string' && json.day.say.trim() ? { say: json.day.say.trim() } : {}),
        zh: json.day.zh.trim(),
        links: []
      })
      away.lasted = 0
    }
    const cutoff = Date.now() - KEEP_NOTES
    const notes = [...loadNotes(contact), ...fresh].filter((n) => Date.parse(n.at) >= cutoff).sort((a, b) => a.at.localeCompare(b.at))
    writeJson(notesFile(contact), notes)
    // Facts that came in while she was writing wait for the next note.
    writeJson(file('inbox.json'), loadInbox().slice(taken.length))
  } catch {
    // The facts stay in the inbox and go into the next note.
  } finally {
    writing = false
    changed()
    schedule()
    if (again !== undefined) {
      const day = again
      again = undefined
      void write(day)
    }
  }
}

function dedupeLinks(links: RoomLink[]): RoomLink[] {
  const seen = new Set<string>()
  return links.filter((l) => {
    const k = JSON.stringify(l)
    return !seen.has(k) && !!seen.add(k)
  })
}

/** Papers that just finished or failed while no call was open become facts; during a call she says them herself. */
const known = new Map<string, PaperMeta['status']>()
export function roomPaper(meta: PaperMeta): void {
  const before = known.get(meta.id)
  known.set(meta.id, meta.status)
  if (before !== 'processing' || callActive()) return
  const title = meta.titleZh || meta.title
  if (meta.status === 'ready') addFact(`《${title}》翻译好了`, [{ kind: 'paper', paper: meta.id }])
  if (meta.status === 'error') addFact(`《${title}》处理失败了`, [{ kind: 'paper', paper: meta.id }])
}

/* ---------- the study timer ---------- */

let study: StudyState | undefined
let studyTimer: NodeJS.Timeout | undefined
/** Focused time so far (breaks don't count), and since when the current focus has been running */
let focused = 0
let runningSince = 0
let startedAt = 0
let moodBefore: ReturnType<typeof getSettings>['callMood'] | undefined

const DEFAULT_PLAN: StudyPlan = { focus: 25, rest: 5, rounds: 4 }

const pushStudy = () => send('room:study', study ?? null)

/** The plan last used, offered again next time */
const loadPlan = (): StudyPlan => ({ ...DEFAULT_PLAN, ...readJson<Partial<StudyPlan>>(file('plan.json'), {}) })

function validPlan(p: StudyPlan): StudyPlan | undefined {
  const focus = Number(p?.focus)
  const rest = Number(p?.rest)
  const rounds = Math.round(Number(p?.rounds))
  if (!(focus > 0 && focus <= 600) || !(rest >= 0 && rest <= 120) || !(rounds >= 1 && rounds <= 20)) return undefined
  return { focus, rest, rounds }
}

/** Fold the running focus into the total */
function accrue(): void {
  if (study?.endsAt && study.phase === 'focus') focused += Date.now() - runningSince
  runningSince = Date.now()
}

function runPhase(): void {
  clearTimeout(studyTimer)
  if (!study?.endsAt) return
  studyTimer = setTimeout(phaseDone, Math.max(0, study.endsAt - Date.now()))
}

/** Tell her on the call, or the owner by a notification when no call is open */
function studyNews(text: string): void {
  if (callActive()) callEvent(text)
  else if (Notification.isSupported()) new Notification({ title: 'Shiori', body: text }).show()
}

function startStudy(given: StudyPlan, withContact?: string): void {
  const plan = validPlan(given)
  if (study || !plan) return
  writeJson(file('plan.json'), plan)
  const now = Date.now()
  study = { plan, round: 1, phase: 'focus', minutes: plan.focus, endsAt: now + plan.focus * MINUTE, ...(withContact ? { with: withContact } : {}) }
  focused = 0
  runningSince = startedAt = now
  if (withContact && getContact(withContact)) callWith(withContact)
  // While focusing she doesn't start conversations; news she still tells. In the breaks she may chat.
  if (callActive()) {
    moodBefore = getSettings().callMood
    setCallMood('quiet')
    const rounds = plan.rounds > 1 ? `，${plan.rest ? `休息 ${plan.rest} 分钟，` : ''}一共 ${plan.rounds} 轮` : ''
    callEvent(`一起自习开始了：专注 ${plan.focus} 分钟${rounds}`)
  }
  runPhase()
  pushStudy()
}

function phaseDone(): void {
  if (!study) return
  accrue()
  const { plan, round, phase } = study
  const now = Date.now()
  if (phase === 'focus' && round >= plan.rounds) return finishStudy()
  if (phase === 'focus' && plan.rest > 0) {
    study = { ...study, phase: 'rest', minutes: plan.rest, endsAt: now + plan.rest * MINUTE, left: undefined }
    if (moodBefore !== undefined) setCallMood('chat')
    studyNews(`第 ${round} 轮专注结束了，休息 ${plan.rest} 分钟`)
  } else {
    study = { ...study, round: round + 1, phase: 'focus', minutes: plan.focus, endsAt: now + plan.focus * MINUTE, left: undefined }
    if (moodBefore !== undefined) setCallMood('quiet')
    studyNews(phase === 'rest' ? `休息结束，第 ${round + 1} 轮专注开始` : `第 ${round} 轮专注结束了，接着第 ${round + 1} 轮`)
  }
  runPhase()
  pushStudy()
}

function pauseStudy(): void {
  if (!study?.endsAt) return
  accrue()
  clearTimeout(studyTimer)
  study = { ...study, endsAt: undefined, left: study.endsAt - Date.now() }
  pushStudy()
}

function resumeStudy(): void {
  if (!study || study.endsAt || study.left === undefined) return
  runningSince = Date.now()
  study = { ...study, endsAt: Date.now() + study.left, left: undefined }
  runPhase()
  pushStudy()
}

function endStudy(): void {
  clearTimeout(studyTimer)
  accrue()
  const minutes = Math.round(focused / MINUTE)
  if (minutes >= STUDY_COUNTS) {
    const sessions = readJson<{ at: string; minutes: number }[]>(file('study.json'), [])
    sessions.push({ at: new Date(startedAt).toISOString(), minutes })
    writeJson(file('study.json'), sessions)
  }
  study = undefined
  if (moodBefore !== undefined) setCallMood(moodBefore)
  moodBefore = undefined
  pushStudy()
  changed()
}

function finishStudy(): void {
  if (!study) return
  const { plan } = study
  const minutes = Math.round(focused / MINUTE)
  endStudy()
  studyNews(plan.rounds > 1 ? `一起自习结束了，${plan.rounds} 轮，一共专注了 ${minutes} 分钟` : `一起自习的 ${minutes} 分钟到了`)
}

/* ---------- journal ---------- */

async function journal(year: number, month: number): Promise<JournalDay[]> {
  const prefix = `${year}-${String(month).padStart(2, '0')}-`
  const days = new Map<string, { minutes: number; papers: Map<string, JournalPaper> }>()
  const dayEntry = (d: string) => {
    let e = days.get(d)
    if (!e) days.set(d, (e = { minutes: 0, papers: new Map() }))
    return e
  }
  const paperEntry = (d: string, meta: PaperMeta) => {
    const papers = dayEntry(d).papers
    let p = papers.get(meta.id)
    if (!p) papers.set(meta.id, (p = { id: meta.id, title: meta.titleZh || meta.title, questions: [], highlights: [] }))
    return p
  }
  for (const s of readJson<{ at: string; minutes: number }[]>(file('study.json'), [])) {
    const d = dayOf(s.at)
    if (d.startsWith(prefix)) dayEntry(d).minutes += s.minutes
  }
  const metas = new Map(listPapers().map((p) => [p.id, p]))
  for (const [d, ids] of Object.entries(loadOpens().days)) {
    if (!d.startsWith(prefix)) continue
    for (const id of ids) {
      const meta = metas.get(id)
      if (meta) paperEntry(d, meta)
    }
  }
  for (const meta of metas.values()) {
    for (const m of (await loadChat(meta.id)).messages) {
      const d = dayOf(m.createdAt)
      if (m.role === 'user' && d.startsWith(prefix) && m.text.trim()) paperEntry(d, meta).questions.push(m.text.trim())
    }
    for (const a of await loadAnnotations(meta.id)) {
      const d = dayOf(a.createdAt)
      if (d.startsWith(prefix) && a.text.trim()) paperEntry(d, meta).highlights.push(a.text.trim())
    }
  }
  return [...days.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, e]) => ({ date, minutes: e.minutes, papers: [...e.papers.values()] }))
}

/* ---------- the room as the page sees it ---------- */

export async function roomView(): Promise<RoomView> {
  const contact = noteWriter()
  return {
    contact,
    notes: contact ? loadNotes(contact).slice().reverse() : [],
    writing,
    wallpaper: wallpaperUrl(),
    reading: readingNow(),
    quote: await quoteOfTheDay()
  }
}

/** Views take a moment to gather; only the latest one is sent, so an older one never lands last. */
let latest = 0
function changed(): void {
  const n = ++latest
  void roomView().then((v) => n === latest && send('room:changed', v))
}

export function initRoom(o: { send: (channel: string, payload?: unknown) => void; window: () => BrowserWindow | undefined }): void {
  send = o.send
  mainWindow = o.window
  for (const p of listPapers()) known.set(p.id, p.status)
  onMissedEvent(addFact)
  schedule()

  // Time away from the app, also across a quit, decides whether a note about her day is due.
  const seen = file('seen.json')
  const lastSeen = readJson<{ at?: number }>(seen, {}).at
  if (lastSeen) away = { since: lastSeen, lasted: Date.now() - lastSeen }
  const markSeen = () => writeJson(seen, { at: Date.now() })
  setInterval(markSeen, 10 * MINUTE)
  app.on('before-quit', markSeen)
  app.on('did-resign-active', () => {
    away = { since: Date.now(), lasted: away.lasted }
    markSeen()
  })
  app.on('did-become-active', () => {
    if (away.since) away = { since: 0, lasted: Math.max(away.lasted, Date.now() - away.since) }
  })

  ipcMain.on('call:reading', (_e, id: string | null) => {
    if (id) recordOpen(id)
  })
  ipcMain.handle('room:view', () => roomView())
  // Coming into the room: what is waiting gets written now rather than in a few minutes.
  ipcMain.handle('room:visit', () => {
    const contact = noteWriter()
    if (loadInbox().length || (contact && dayNoteDue(contact))) void write(true)
  })
  ipcMain.handle('room:read', () => {
    const contact = noteWriter()
    if (!contact) return
    const notes = loadNotes(contact)
    if (!notes.some((n) => !n.read)) return
    writeJson(notesFile(contact), notes.map((n) => ({ ...n, read: true })))
    changed()
  })
  ipcMain.handle('room:chooseWallpaper', () => chooseWallpaper())
  ipcMain.handle('room:clearWallpaper', () => {
    clearWallpaper()
    changed()
  })
  ipcMain.handle('room:journal', (_e, year: number, month: number) => journal(year, month))
  ipcMain.handle('room:study', () => study ?? null)
  ipcMain.handle('room:studyPlan', () => loadPlan())
  ipcMain.handle('room:studyStart', (_e, plan: StudyPlan, withContact?: string) => startStudy(plan, withContact))
  ipcMain.handle('room:studyPause', () => pauseStudy())
  ipcMain.handle('room:studyResume', () => resumeStudy())
  ipcMain.handle('room:studyStop', () => endStudy())
}
