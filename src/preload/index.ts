import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Annotation, ChatEvent, PaperMeta, Settings } from '../shared/types'

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
  getText: (name: 'profile.md' | 'glossary.md') => ipcRenderer.invoke('text:get', name),
  setText: (name: 'profile.md' | 'glossary.md', text: string) => ipcRenderer.invoke('text:set', name, text),
  claudeStatus: () => ipcRenderer.invoke('claude:status'),
  claudeLogin: () => ipcRenderer.invoke('claude:login'),

  listPapers: () => ipcRenderer.invoke('papers:list'),
  importDialog: () => ipcRenderer.invoke('papers:importDialog'),
  importFiles: (files: File[]) => ipcRenderer.invoke('papers:importPaths', files.map((f) => webUtils.getPathForFile(f))),
  importArxiv: (input: string) => ipcRenderer.invoke('papers:importArxiv', input),
  updatePaper: (id: string, patch: Partial<PaperMeta>) => ipcRenderer.invoke('papers:update', id, patch),
  processPaper: (id: string) => ipcRenderer.invoke('papers:process', id),
  cancelPaper: (id: string) => ipcRenderer.invoke('papers:cancel', id),
  trashPaper: (id: string) => ipcRenderer.invoke('papers:trash', id),
  revealPaper: (id: string) => ipcRenderer.invoke('papers:reveal', id),
  loadDoc: (id: string) => ipcRenderer.invoke('papers:doc', id),
  loadAnnotations: (id: string) => ipcRenderer.invoke('papers:annotations', id),
  saveAnnotations: (id: string, list: Annotation[]) => ipcRenderer.invoke('papers:saveAnnotations', id, list),
  loadChat: (id: string) => ipcRenderer.invoke('papers:chat', id),

  ask: (id: string, input: { text: string; quote?: { block: string; text: string }; model?: string }) =>
    ipcRenderer.invoke('chat:ask', id, input),
  stopAsking: (id: string) => ipcRenderer.invoke('chat:stop', id),
  resetChat: (id: string) => ipcRenderer.invoke('chat:reset', id),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),

  onPaperChanged: (fn: (m: PaperMeta) => void) => on('paper:changed', fn),
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
