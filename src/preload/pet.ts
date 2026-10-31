import { contextBridge, ipcRenderer } from 'electron'

// All the character's page may do: say whether the mouse is on her, and move or resize her window.
contextBridge.exposeInMainWorld('petBridge', {
  setInteractive: (on: boolean) => ipcRenderer.send('pet:interactive', on),
  moveTo: (x: number, y: number) => ipcRenderer.send('pet:move', x, y),
  resizeTo: (scale: number, anchorX: number, anchorY: number) => ipcRenderer.send('pet:resize', scale, anchorX, anchorY),
  dragEnd: () => ipcRenderer.send('pet:moved')
})
