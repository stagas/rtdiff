import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { CommitListItem, DiffSnapshot } from '../shared/diff'

const api = {
  getSnapshot: (): Promise<DiffSnapshot> => ipcRenderer.invoke('diff:getSnapshot'),
  commit: (message: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('diff:commit', message),
  generateCommitMessage: (): Promise<{ ok: boolean; message?: string; error?: string }> =>
    ipcRenderer.invoke('diff:generateCommitMessage'),
  getCommitHistory: (): Promise<{ ok: boolean; commits?: CommitListItem[]; error?: string }> =>
    ipcRenderer.invoke('diff:getCommitHistory'),
  getCommitSnapshot: (sha: string): Promise<{ ok: boolean; snapshot?: DiffSnapshot; error?: string }> =>
    ipcRenderer.invoke('diff:getCommitSnapshot', sha),
  onSnapshot: (listener: (snapshot: DiffSnapshot) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: DiffSnapshot): void => {
      listener(snapshot)
    }

    ipcRenderer.on('diff:update', wrapped)
    ipcRenderer.send('diff:subscribe')

    return () => {
      ipcRenderer.off('diff:update', wrapped)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
