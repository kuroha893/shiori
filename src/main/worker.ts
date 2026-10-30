import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'

/*
 * A hidden window running pdf.js. The main process asks it to render pages, thumbnails and
 * figure crops; it answers with PNG bytes.
 */

let win: BrowserWindow | undefined
let ready: Promise<void> | undefined
let seq = 0
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

ipcMain.on('worker:result', (_e, id: number, error: string | null, value: any) => {
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  error ? p.reject(new Error(error)) : p.resolve(value)
})

function ensure(): Promise<void> {
  if (win && !win.isDestroyed() && ready) return ready
  win = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true }
  })
  ready = new Promise<void>((resolve) => ipcMain.once('worker:ready', () => resolve()))
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/worker.html`)
  else win.loadFile(join(__dirname, '../renderer/worker.html'))
  win.on('closed', () => {
    win = undefined
    ready = undefined
  })
  return ready
}

export async function workerCall<T>(method: string, args: Record<string, unknown>): Promise<T> {
  await ensure()
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    win!.webContents.send('worker:call', id, method, args)
  })
}

export function destroyWorker(): void {
  win?.destroy()
}
