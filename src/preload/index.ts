import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Annotation, ChatEvent, Folder, GlossaryEntry, PaperMeta, PetState, Settings } from '../shared/types'

const on = <T>(channel: string, fn: (v: T) => void) => {
  const h = (_e: unknown, v: T) => fn(v)
  ipcRenderer.on(channel, h)
  return () => {
    ipcRenderer.off(channel, h)
  }
}

const api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:set', patch),
  chooseLibrary: () => ipcRenderer.invoke('settings:chooseLibrary'),
  getText: (name: 'profile.md') => ipcRenderer.invoke('text:get', name),
  setText: (name: 'profile.md', text: string) => ipcRenderer.invoke('text:set', name, text),
  listTerms: (): Promise<GlossaryEntry[]> => ipcRenderer.invoke('glossary:list'),
  saveTerm: (entry: Omit<GlossaryEntry, 'id'> & { id?: string }): Promise<GlossaryEntry[]> => ipcRenderer.invoke('glossary:save', entry),
  deleteTerm: (id: string): Promise<GlossaryEntry[]> => ipcRenderer.invoke('glossary:delete', id),
  listFolders: (): Promise<Folder[]> => ipcRenderer.invoke('folders:list'),
  createFolder: (name: string): Promise<Folder> => ipcRenderer.invoke('folders:create', name),
  renameFolder: (id: string, name: string) => ipcRenderer.invoke('folders:rename', id, name),
  deleteFolder: (id: string) => ipcRenderer.invoke('folders:delete', id),
  acceptSuggestion: (id: string) => ipcRenderer.invoke('papers:acceptSuggestion', id),
  claudeStatus: () => ipcRenderer.invoke('claude:status'),
  claudeLogin: () => ipcRenderer.invoke('claude:login'),

  listPapers: () => ipcRenderer.invoke('papers:list'),
  importDialog: () => ipcRenderer.invoke('papers:importDialog'),
  importFiles: (files: File[]) => ipcRenderer.invoke('papers:importPaths', files.map((f) => webUtils.getPathForFile(f))),
  importArxiv: (input: string) => ipcRenderer.invoke('papers:importArxiv', input),
  updatePaper: (id: string, patch: Partial<PaperMeta>) => ipcRenderer.invoke('papers:update', id, patch),
  processPaper: (id: string) => ipcRenderer.invoke('papers:process', id),
  writeGuide: (id: string) => ipcRenderer.invoke('papers:guide', id),
  cancelPaper: (id: string) => ipcRenderer.invoke('papers:cancel', id),
  trashPaper: (id: string) => ipcRenderer.invoke('papers:trash', id),
  revealPaper: (id: string) => ipcRenderer.invoke('papers:reveal', id),
  loadDoc: (id: string) => ipcRenderer.invoke('papers:doc', id),
  loadAnnotations: (id: string) => ipcRenderer.invoke('papers:annotations', id),
  saveAnnotations: (id: string, list: Annotation[]) => ipcRenderer.invoke('papers:saveAnnotations', id, list),
  loadChat: (id: string) => ipcRenderer.invoke('papers:chat', id),
  loadNote: (id: string): Promise<object | null> => ipcRenderer.invoke('papers:note', id),
  saveNote: (id: string, doc: object) => ipcRenderer.invoke('papers:saveNote', id, doc),
  saveNoteImage: (id: string, ext: string, bytes: ArrayBuffer): Promise<string> => ipcRenderer.invoke('papers:saveNoteImage', id, ext, bytes),

  ask: (id: string, input: { text: string; quote?: { block: string; text: string }; model?: string }) =>
    ipcRenderer.invoke('chat:ask', id, input),
  stopAsking: (id: string) => ipcRenderer.invoke('chat:stop', id),
  resetChat: (id: string) => ipcRenderer.invoke('chat:reset', id),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),

  petState: (): Promise<PetState> => ipcRenderer.invoke('pet:state'),
  togglePet: (): Promise<PetState> => ipcRenderer.invoke('pet:toggle'),
  onPetChanged: (fn: (s: PetState) => void) => on('pet:changed', fn),

  onPaperChanged: (fn: (m: PaperMeta) => void) => on('paper:changed', fn),
  onFoldersChanged: (fn: (f: Folder[]) => void) => on('folders:changed', fn),
  onPaperRemoved: (fn: (id: string) => void) => on('paper:removed', fn),
  onChatEvent: (fn: (e: ChatEvent) => void) => on('chat:event', fn)
}

// Used only by the hidden pdf.js worker window.
const workerBridge = {
  ready: () => ipcRenderer.send('worker:ready'),
  onCall: (fn: (id: number, method: string, args: any) => void) =>
    ipcRenderer.on('worker:call', (_e, id: number, method: string, args: any) => fn(id, method, args)),
  reply: (id: number, error: string | null, value: unknown) => ipcRenderer.send('worker:result', id, error, value)
}

contextBridge.exposeInMainWorld('api', api)
contextBridge.exposeInMainWorld('workerBridge', workerBridge)

export type Api = typeof api
export type WorkerBridge = typeof workerBridge
