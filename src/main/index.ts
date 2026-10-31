import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Annotation, ChatEvent, GlossaryEntry, PaperMeta, Settings } from '../shared/types'
import * as lib from './library'
import { getSettings, saveSettings } from './settings'
import { claudeStatus, openLogin } from './claude'
import { acceptSuggestion, createFolder, deleteFolder, loadFolders, renameFolder } from './folders'
import { cancel, enqueue, initJobs, prepare, startGuide } from './jobs'
import { deleteEntry, loadGlossary, saveEntry } from './glossary'
import { ask, resetChat, stopAsking } from './chat'
import { destroyWorker } from './worker'
import { closePet, initPet, libraryChanged, petFile } from './pet'

// Development: a separate profile (settings + default library) so tests don't touch the real one.
if (process.env.SHIORI_USER_DATA) app.setPath('userData', process.env.SHIORI_USER_DATA)

protocol.registerSchemesAsPrivileged([
  { scheme: 'shiori', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
])

let main: BrowserWindow | undefined

const bg = () => {
  const t = getSettings().theme
  const dark = t === 'dark' || (t === 'system' && nativeTheme.shouldUseDarkColors)
  return t === 'sepia' ? '#f6f1e7' : dark ? '#131315' : '#fcfdfe'
}

function createWindow(): void {
  main = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 860,
    minHeight: 560,
    title: 'Shiori',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: bg(),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  main.once('ready-to-show', () => main?.show())
  // Links in answers and papers open in the browser, never inside the app.
  main.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  main.webContents.on('will-navigate', (e, url) => {
    if (url !== main?.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:/.test(url)) shell.openExternal(url)
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) main.loadURL(process.env.ELECTRON_RENDERER_URL)
  else main.loadFile(join(__dirname, '../renderer/index.html'))
  main.on('closed', () => {
    main = undefined
    closePet()
  })
}

const send = (channel: string, payload: unknown) => main?.webContents.send(channel, payload)
const paperChanged = (meta: PaperMeta) => send('paper:changed', meta)
const foldersChanged = () => send('folders:changed', loadFolders())

async function addPdf(path: string): Promise<PaperMeta> {
  const meta = lib.importPdf(path)
  paperChanged(meta)
  await prepare(meta.id).catch(() => {})
  return lib.readMeta(meta.id) ?? meta
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const s = saveSettings(patch)
    if (patch.libraryPath) {
      lib.ensureLibrary()
      loadGlossary()
      libraryChanged()
    }
    return s
  })
  ipcMain.handle('settings:chooseLibrary', async () => {
    const r = await dialog.showOpenDialog(main!, { properties: ['openDirectory', 'createDirectory'], message: '选择书库文件夹' })
    if (r.canceled || !r.filePaths[0]) return getSettings()
    const s = saveSettings({ libraryPath: r.filePaths[0] })
    lib.ensureLibrary()
    loadGlossary()
    libraryChanged()
    return s
  })
  ipcMain.handle('text:get', (_e, name: 'profile.md') => lib.readRootText(name))
  ipcMain.handle('text:set', (_e, name: 'profile.md', text: string) => lib.writeRootText(name, text))

  ipcMain.handle('glossary:list', () => loadGlossary())
  ipcMain.handle('glossary:save', (_e, entry: Omit<GlossaryEntry, 'id'> & { id?: string }) => saveEntry(entry))
  ipcMain.handle('glossary:delete', (_e, id: string) => deleteEntry(id))

  ipcMain.handle('folders:list', () => loadFolders())
  ipcMain.handle('folders:create', (_e, name: string) => {
    const folder = createFolder(name)
    foldersChanged()
    return folder
  })
  ipcMain.handle('folders:rename', (_e, id: string, name: string) => {
    renameFolder(id, name)
    foldersChanged()
  })
  ipcMain.handle('folders:delete', (_e, id: string) => {
    deleteFolder(id).forEach(paperChanged)
    foldersChanged()
  })
  ipcMain.handle('papers:acceptSuggestion', (_e, id: string) => {
    const meta = acceptSuggestion(id)
    if (meta) paperChanged(meta)
    foldersChanged()
  })

  ipcMain.handle('claude:status', () => claudeStatus())
  ipcMain.handle('claude:login', () => openLogin())

  ipcMain.handle('papers:list', () => lib.listPapers())
  ipcMain.handle('papers:importDialog', async () => {
    const r = await dialog.showOpenDialog(main!, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    const out: PaperMeta[] = []
    for (const p of r.filePaths) out.push(await addPdf(p))
    return out
  })
  ipcMain.handle('papers:importPaths', async (_e, paths: string[]) => {
    const out: PaperMeta[] = []
    for (const p of paths.filter((p) => p.toLowerCase().endsWith('.pdf'))) out.push(await addPdf(p))
    return out
  })
  ipcMain.handle('papers:importArxiv', async (_e, input: string) => {
    const meta = await lib.importArxiv(input)
    paperChanged(meta)
    await prepare(meta.id).catch(() => {})
    return lib.readMeta(meta.id) ?? meta
  })
  ipcMain.handle('papers:update', (_e, id: string, patch: Partial<PaperMeta>) => {
    const meta = lib.updateMeta(id, patch)
    if (meta) paperChanged(meta)
    return meta
  })
  ipcMain.handle('papers:process', (_e, id: string) => enqueue(id))
  ipcMain.handle('papers:guide', (_e, id: string) => startGuide(id))
  ipcMain.handle('papers:cancel', (_e, id: string) => cancel(id))
  ipcMain.handle('papers:trash', async (_e, id: string) => {
    cancel(id)
    await lib.trashPaper(id)
    send('paper:removed', id)
  })
  ipcMain.handle('papers:reveal', (_e, id: string) => lib.revealPaper(id))
  ipcMain.handle('papers:doc', (_e, id: string) => lib.loadDoc(id))
  ipcMain.handle('papers:annotations', (_e, id: string) => lib.loadAnnotations(id))
  ipcMain.handle('papers:saveAnnotations', (_e, id: string, list: Annotation[]) => lib.saveAnnotations(id, list))
  ipcMain.handle('papers:chat', (_e, id: string) => lib.loadChat(id))
  ipcMain.handle('papers:note', (_e, id: string) => lib.loadNote(id))
  ipcMain.handle('papers:saveNote', (_e, id: string, doc: object) => lib.saveNote(id, doc))
  ipcMain.handle('papers:saveNoteImage', (_e, id: string, ext: string, bytes: ArrayBuffer) => lib.saveNoteImage(id, ext, bytes))

  ipcMain.handle('chat:ask', (_e, id: string, input) => ask(id, input, (ev: ChatEvent) => send('chat:event', ev)))
  ipcMain.handle('chat:stop', (_e, id: string) => stopAsking(id))
  ipcMain.handle('chat:reset', (_e, id: string) => resetChat(id))

  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
  })
}

app.whenReady().then(() => {
  app.setName('Shiori')
  // shiori://paper/<id>/<path> serves files of a paper folder (PDF, figures, thumbnails); shiori://pet/<path> the character pack.
  protocol.handle('shiori', (req) => {
    const u = new URL(req.url)
    if (u.host === 'pet') {
      try {
        return net.fetch(pathToFileURL(petFile(decodeURIComponent(u.pathname.slice(1)))).toString())
      } catch {
        return new Response('forbidden', { status: 403 })
      }
    }
    if (u.host !== 'paper') return new Response('not found', { status: 404 })
    const [id, ...rest] = u.pathname.slice(1).split('/').map(decodeURIComponent)
    try {
      return net.fetch(pathToFileURL(lib.paperFile(id, rest.join('/'))).toString())
    } catch {
      return new Response('forbidden', { status: 403 })
    }
  })
  lib.ensureLibrary()
  loadGlossary()
  registerIpc()
  initPet((state) => send('pet:changed', state))
  createWindow()
  initJobs(paperChanged)
  nativeTheme.on('updated', () => main?.setBackgroundColor(bg()))
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().some((w) => w.isVisible())) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => destroyWorker())
