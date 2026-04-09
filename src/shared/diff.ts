export type RepoState = 'ok' | 'not_in_repo' | 'error'

export type LayoutMode = 'side-by-side' | 'inline'

export interface DiffStats {
  files: number
  added: number
  removed: number
}

export interface DiffFile {
  path: string
  originalPath?: string
  status: 'A' | 'M' | 'D' | 'R' | 'C' | '?'
  added: number
  removed: number
  originalText: string
  modifiedText: string
  isBinary?: boolean
}

export interface DiffSnapshot {
  repoState: RepoState
  repoRoot?: string
  branchName?: string
  message?: string
  totals: DiffStats
  files: DiffFile[]
  generatedAt: number
}

export interface CommitListItem {
  sha: string
  shortSha: string
  subject: string
  authorName: string
  committedAt: string
  added: number
  removed: number
  files: number
}
