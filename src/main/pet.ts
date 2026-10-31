import { BrowserWindow, ipcMain, screen, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { PetState } from '../shared/types'
import { root } from './library'
import { getSettings, saveSettings } from './settings'

/* The desktop character. Her page and art are a pack in <library>/pet, kept out of this repository; no pack, no button. */

const WIDTH = 336
const HEIGHT = 420
const DEFAULT_SCALE = 0.4
const MIN_SCALE = 0.2
const MAX_SCALE = 1.5

let win: BrowserWindow | undefined
/** The point that stays put during a resize, so she grows from where she stands. */
let anchor: { x: number; y: number } | undefined
let notify: (state: PetState) => void = () => {}

const folder = () => join(root(), 'pet')

export const petState = (): PetState => ({ available: existsSync(join(folder(), 'pet.html')), visible: !!win })

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
    notify(petState())
  })
  win.loadURL('shiori://pet/pet.html')
  notify(petState())
}

export const closePet = () => win?.destroy()

export function initPet(onChange: (state: PetState) => void): void {
  notify = onChange
  ipcMain.handle('pet:state', () => petState())
  ipcMain.handle('pet:toggle', () => {
    if (win) closePet()
    else if (petState().available) open()
    return petState()
  })
  // Only her own pixels catch the mouse; the empty parts of the window let clicks through to whatever is behind.
  ipcMain.on('pet:interactive', (_e, on: boolean) => win?.setIgnoreMouseEvents(!on, { forward: true }))
  ipcMain.on('pet:move', (_e, x: number, y: number) => win?.setBounds({ x: Math.round(x), y: Math.round(y), ...size() }))
  // ax and ay say where in the window she stands, as fractions; that point stays where it is.
  ipcMain.on('pet:resize', (_e, scale: number, ax: number, ay: number) => {
    if (!win) return
    const b = win.getBounds()
    anchor ??= { x: b.x + b.width * ax, y: b.y + b.height * ay }
    saveSettings({ petScale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale)) })
    const { width, height } = size()
    win.setBounds({ x: Math.round(anchor.x - width * ax), y: Math.round(anchor.y - height * ay), width, height })
  })
  ipcMain.on('pet:moved', () => {
    anchor = undefined
    if (!win) return
    const [x, y] = win.getPosition()
    saveSettings({ petPosition: { x, y } })
  })
}

/** After the library changes, the pack may be a different one or none at all. */
export function libraryChanged(): void {
  closePet()
  notify(petState())
}
