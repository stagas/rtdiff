import { ElectronAPI } from '@electron-toolkit/preload'
import type { CommitListItem, DiffSnapshot } from '../shared/diff'

interface RTDiffAPI {
  getSnapshot: () => Promise<DiffSnapshot>
  onSnapshot: (listener: (snapshot: DiffSnapshot) => void) => () => void
  commit: (message: string) => Promise<{ ok: boolean; error?: string }>
  generateCommitMessage: () => Promise<{ ok: boolean; message?: string; error?: string }>
  getCommitHistory: () => Promise<{ ok: boolean; commits?: CommitListItem[]; error?: string }>
  getCommitSnapshot: (sha: string) => Promise<{ ok: boolean; snapshot?: DiffSnapshot; error?: string }>
  setOpenRouterApiKey: (value: string) => Promise<{ ok: boolean; error?: string }>
  onPromptOpenRouterApiKey: (listener: () => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: RTDiffAPI
  }
}
