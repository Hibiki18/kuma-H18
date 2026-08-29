import { contextBridge, ipcRenderer } from 'electron'

import type { GameCommand, GameWindowSnapshot } from '../shared/game-window'

contextBridge.exposeInMainWorld('kansoGameWindow', {
  state: () => ipcRenderer.invoke('game-window:get-state'),
  attach: () => ipcRenderer.invoke('game-window:set-mode', 'embedded'),
  command: (command: GameCommand) => ipcRenderer.invoke('game-window:command', command),
  bounds: (rect: unknown, seq: number) =>
    ipcRenderer.send('game-window:bounds', 'detached', rect, seq),
  onState: (listener: (state: GameWindowSnapshot) => void) => {
    ipcRenderer.on('game-window:state', (_event, state: GameWindowSnapshot) => listener(state))
  },
})

