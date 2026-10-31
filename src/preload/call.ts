import { contextBridge, ipcRenderer } from 'electron'
import type { CallInit, CallLine, CallState } from '../shared/types'

const on = <T>(channel: string, fn: (v: T) => void) => {
  const h = (_e: unknown, v: T) => fn(v)
  ipcRenderer.on(channel, h)
  return () => {
    ipcRenderer.off(channel, h)
  }
}

// All the call window may do: say something, hang up, and say whether the mouse is on it.
const callBridge = {
  init: (): Promise<CallInit> => ipcRenderer.invoke('call:init'),
  send: (text: string) => ipcRenderer.send('call:send', text),
  hangUp: () => ipcRenderer.send('call:hangUp'),
  setInteractive: (on: boolean) => ipcRenderer.send('call:interactive', on),
  onState: (fn: (s: CallState) => void) => on('call:state', fn),
  onLine: (fn: (l: CallLine) => void) => on('call:line', fn),
  onClear: (fn: () => void) => on('call:clear', fn),
  onEnded: (fn: () => void) => on('call:ended', fn)
}

contextBridge.exposeInMainWorld('callBridge', callBridge)

export type CallBridge = typeof callBridge
