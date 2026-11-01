import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { YACHIYO } from '../shared/contacts'
import type { PetState } from '../shared/types'
import { getSettings, saveSettings } from './settings'

/* The desktop character. Her page and art ship with the app in resources/pet. */

const WIDTH = 336
const HEIGHT = 420
const DEFAULT_SCALE = 0.4
const MIN_SCALE = 0.2
const MAX_SCALE = 1.5

let win: BrowserWindow | undefined
/** The point that stays put during a resize, so she grows from where she stands. */
let anchor: { x: number; y: number } | undefined
let notify: (state: PetState) => void = () => {}
let moved: () => void = () => {}
/** Who is on the call; a character shows during it if the owner wants her to. */
let contact: string | undefined

const folder = () => join(app.getAppPath(), 'resources', 'pet')

export const petState = (): PetState => ({ contact })

/** Resolve a path inside the pack, refusing anything that escapes it. */
export function petFile(rel: string): string {
  const dir = resolve(folder())
  const full = resolve(dir, rel)
  if (!full.startsWith(dir + sep)) throw new Error('path outside pet folder')
  return full
}

const size = () => {
  const scale = getSettings().petScale ?? DEFAULT_SCALE
  return { width: Math.round(WIDTH * scale), height: Math.round(HEIGHT * scale) }
}

function position(): { x: number; y: number } {
  const { width: WIDTH, height: HEIGHT } = size()
  const saved = getSettings().petPosition
  const area = saved ? screen.getDisplayNearestPoint(saved).workArea : screen.getPrimaryDisplay().workArea
  const x = saved?.x ?? area.x + area.width - WIDTH - 40
  const y = saved?.y ?? area.y + area.height - HEIGHT - 20
  // A saved place on a screen that is gone must not leave her out of reach.
  return {
    x: Math.max(area.x - WIDTH / 2, Math.min(x, area.x + area.width - WIDTH / 2)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - HEIGHT / 2))
  }
}

function open(): void {
  win = new BrowserWindow({
    ...size(),
    ...position(),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/pet.js'),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  win.setIgnoreMouseEvents(true, { forward: true })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.once('ready-to-show', () => win?.showInactive())
  win.on('closed', () => {
    win = undefined
  })
  win.loadURL('shiori://pet/pet.html')
}

/** Puts the character on the desktop or takes her off, to match the call and the setting. */
export function syncPet(): void {
  const hasPet = contact === YACHIYO && existsSync(join(folder(), 'pet.html'))
  if (hasPet && getSettings().petShown) {
    if (!win) open()
  } else {
    win?.destroy()
    win = undefined
  }
  moved()
}

export function closePet(): void {
  if (!contact) return
  contact = undefined
  syncPet()
  notify(petState())
}

export const petBounds = () => win?.getBounds()

export function initPet(onChange: (state: PetState) => void, onMoved: () => void): void {
  notify = onChange
  moved = onMoved
  ipcMain.handle('pet:state', () => petState())
  // Calling someone else hangs up first.
  ipcMain.handle('pet:toggle', (_e, id: string) => {
    const hangUpOnly = contact === id
    closePet()
    if (!hangUpOnly) {
      contact = id
      syncPet()
      notify(petState())
    }
    return petState()
  })
  // Only her own pixels catch the mouse; the empty parts of the window let clicks through to whatever is behind.
  ipcMain.on('pet:interactive', (_e, on: boolean) => win?.setIgnoreMouseEvents(!on, { forward: true }))
  ipcMain.on('pet:move', (_e, x: number, y: number) => {
    win?.setBounds({ x: Math.round(x), y: Math.round(y), ...size() })
    moved()
  })
  // ax and ay say where in the window she stands, as fractions; that point stays where it is.
  ipcMain.on('pet:resize', (_e, scale: number, ax: number, ay: number) => {
    if (!win) return
    const b = win.getBounds()
    anchor ??= { x: b.x + b.width * ax, y: b.y + b.height * ay }
    saveSettings({ petScale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale)) })
    const { width, height } = size()
    win.setBounds({ x: Math.round(anchor.x - width * ax), y: Math.round(anchor.y - height * ay), width, height })
    moved()
  })
  ipcMain.on('pet:moved', () => {
    anchor = undefined
    if (!win) return
    const [x, y] = win.getPosition()
    saveSettings({ petPosition: { x, y } })
  })
}
