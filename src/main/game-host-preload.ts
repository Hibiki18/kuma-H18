import { contextBridge, ipcRenderer } from 'electron'

import type { GameOverlayEvent } from '../shared/game-window'

contextBridge.exposeInMainWorld('kansoGameHost', {
  bootstrap: () => ipcRenderer.invoke('game-host:get-bootstrap'),
  ready: () => ipcRenderer.send('game-host:ready'),
  command: (type: 'reload') => ipcRenderer.invoke('game-window:command', { type }),
  onOverlay: (listener: (event: GameOverlayEvent) => void) => {
    ipcRenderer.on('game-host:overlay', (_event, value: GameOverlayEvent) => listener(value))
  },
  action: (token: string) => ipcRenderer.send('game-host:action', token),
  onRemount: (listener: () => void) => {
    ipcRenderer.on('game-host:remount', () => listener())
  },
})

