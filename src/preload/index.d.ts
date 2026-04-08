import { ElectronAPI } from '@electron-toolkit/preload'
import type { DiffSnapshot } from '../shared/diff'

interface RTDiffAPI {
  getSnapshot: () => Promise<DiffSnapshot>
  onSnapshot: (listener: (snapshot: DiffSnapshot) => void) => () => void
  commit: (message: string) => Promise<{ ok: boolean; error?: string }>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: RTDiffAPI
  }
}
