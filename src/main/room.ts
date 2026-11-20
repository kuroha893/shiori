import { BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { JournalDay, JournalPaper, PaperMeta, RoomView, StudyPlan, StudyState } from '../shared/types'
import { getSettings } from './settings'
import { listPapers, loadAnnotations, loadChat, readMeta, root } from './library'
import { getContact } from './contacts'
import { callActive, callEvent, setCallMood } from './call'
import { callWith } from './pet'

/*
 * 大厅, the lobby Shiori opens on: the owner's desk. Everything in it grows out of what already happens: the papers
 * being read, the owner's own highlights and questions day by day, and the study timer (番茄钟 in the phone). Its
 * files live in <library>/room. Her messages are the phone's (phone.ts).
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

const studyListeners: ((minutes: number, withContact?: string) => void)[] = []
/** A pomodoro ran to its end: how many minutes of focus, and with whom on the call. */
export const onStudyDone = (fn: (minutes: number, withContact?: string) => void) => studyListeners.push(fn)

function finishStudy(): void {
  if (!study) return
  const { plan } = study
  const minutes = Math.round(focused / MINUTE)
  const withContact = study.with
  endStudy()
  for (const fn of studyListeners) fn(minutes, withContact)
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
  return {
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

  ipcMain.on('call:reading', (_e, id: string | null) => {
    if (id) recordOpen(id)
  })
  ipcMain.handle('room:view', () => roomView())
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
