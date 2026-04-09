import { app, shell, BrowserWindow, ipcMain, WebContents, screen } from 'electron'
import { dirname, extname, join, resolve } from 'node:path'
import { access, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { open } from 'lmdb'
import chokidar, { FSWatcher } from 'chokidar'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import type { CommitListItem, DiffFile, DiffSnapshot } from '../shared/diff'

const execFileAsync = promisify(execFile)

const DIFF_UPDATE_CHANNEL = 'diff:update'
const DIFF_SUBSCRIBE_CHANNEL = 'diff:subscribe'
const DIFF_GET_SNAPSHOT_CHANNEL = 'diff:getSnapshot'
const DIFF_COMMIT_CHANNEL = 'diff:commit'
const DIFF_GENERATE_COMMIT_MESSAGE_CHANNEL = 'diff:generateCommitMessage'
const DIFF_GET_COMMIT_HISTORY_CHANNEL = 'diff:getCommitHistory'
const DIFF_GET_COMMIT_SNAPSHOT_CHANNEL = 'diff:getCommitSnapshot'
const WINDOW_STATE_KEY = 'window:main'

const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz'])

interface StatusFile {
  path: string
  originalPath?: string
  status: DiffFile['status']
}

interface CommitStatusFile {
  path: string
  originalPath?: string
  status: Exclude<DiffFile['status'], '?'>
}

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized?: boolean
  isFullScreen?: boolean
}

let windowStateDb: ReturnType<typeof open<WindowState>> | null = null

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isValidWindowState(state: unknown): state is WindowState {
  if (!state || typeof state !== 'object') return false
  const candidate = state as Partial<WindowState>
  if (!isFiniteNumber(candidate.width) || !isFiniteNumber(candidate.height)) return false
  if (candidate.x !== undefined && !isFiniteNumber(candidate.x)) return false
  if (candidate.y !== undefined && !isFiniteNumber(candidate.y)) return false
  return true
}

function getDefaultWindowState(): WindowState {
  return { width: 1400, height: 900 }
}

function getSafeWindowState(state: WindowState): WindowState {
  const width = Math.max(640, Math.round(state.width))
  const height = Math.max(680, Math.round(state.height))
  const hasPosition = isFiniteNumber(state.x) && isFiniteNumber(state.y)

  if (!hasPosition) {
    return { ...state, width, height, x: undefined, y: undefined }
  }

  const x = Math.round(state.x!)
  const y = Math.round(state.y!)
  const target = { x, y, width, height }
  const visibleOnAnyDisplay = screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return (
      target.x < area.x + area.width &&
      target.x + target.width > area.x &&
      target.y < area.y + area.height &&
      target.y + target.height > area.y
    )
  })

  if (visibleOnAnyDisplay) {
    return { ...state, x, y, width, height }
  }

  return { ...state, width, height, x: undefined, y: undefined }
}

function loadWindowState(): WindowState {
  if (!windowStateDb) {
    return getDefaultWindowState()
  }
  const saved = windowStateDb.get(WINDOW_STATE_KEY)
  if (!isValidWindowState(saved)) {
    return getDefaultWindowState()
  }

  return getSafeWindowState(saved)
}

function saveWindowState(mainWindow: BrowserWindow, options?: { sync?: boolean }): void {
  if (!windowStateDb) return
  const bounds = mainWindow.getNormalBounds()
  const nextState: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: mainWindow.isMaximized(),
    isFullScreen: mainWindow.isFullScreen()
  }
  if (options?.sync) {
    windowStateDb.putSync(WINDOW_STATE_KEY, nextState)
    return
  }
  void windowStateDb.put(WINDOW_STATE_KEY, nextState)
}

class DiffService {
  private snapshot: DiffSnapshot = this.createEmptySnapshot('not_in_repo', 'Not inside a git repository')
  private watcher: FSWatcher | null = null
  private gitMetaWatcher: FSWatcher | null = null
  private subscribers = new Set<number>()
  private refreshTimer: NodeJS.Timeout | null = null
  private refreshing = false

  constructor(private readonly startDir: string) {}

  async init(): Promise<void> {
    await this.refreshNow()
    this.configureWatcher()
  }

  async getSnapshot(): Promise<DiffSnapshot> {
    if (!this.snapshot.generatedAt) {
      await this.refreshNow()
    }
    return this.snapshot
  }

  async commit(message: string): Promise<{ ok: boolean; error?: string }> {
    const commitMessage = message.trim()
    if (!commitMessage) {
      return { ok: false, error: 'Commit message is required.' }
    }

    const repoRoot = this.snapshot.repoRoot ?? (await this.findNearestRepoRoot(this.startDir))
    if (!repoRoot) {
      return { ok: false, error: 'Not inside a git repository.' }
    }

    try {
      await execFileAsync('git', ['-C', repoRoot, 'add', '.'])
      await execFileAsync('git', ['-C', repoRoot, 'commit', '-m', commitMessage])
      await this.refreshNow()
      return { ok: true }
    } catch (error) {
      const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr ?? '').trim() : ''
      const messageText = stderr || (error instanceof Error ? error.message : 'Commit failed.')
      return { ok: false, error: messageText }
    }
  }

  async generateCommitMessage(): Promise<{ ok: boolean; message?: string; error?: string }> {
    const repoRoot = this.snapshot.repoRoot ?? (await this.findNearestRepoRoot(this.startDir))
    if (!repoRoot) {
      return { ok: false, error: 'Not inside a git repository.' }
    }

    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) {
      return { ok: false, error: 'OPENROUTER_API_KEY is not set.' }
    }

    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', repoRoot, 'diff', 'HEAD', '--', '.'],
        { maxBuffer: 10 * 1024 * 1024 }
      )

      const diffText = stdout.trim()
      if (!diffText) {
        return { ok: false, error: 'No changes detected to generate a commit message.' }
      }

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'nvidia/nemotron-3-nano-30b-a3b:free',
          messages: [
            {
              role: 'system',
              content: `You are a commit message generator. You will be given a list of changes and you will need to generate a commit message for those changes.
You must follow conventional commits:

type(scope): short description

type is one of:
- feat
- fix
- chore
- docs
- style
- refactor
- perf
- test

scope is optional and should be abstract (not file names).
Do not explain lockfile-only changes.
Keep the message concise. You may add an optional body after an empty line.`
            },
            {
              role: 'user',
              content: `Here are the changes:\n\n${diffText}`
            }
          ],
          stream: false
        })
      })

      if (!response.ok) {
        const text = await response.text()
        return { ok: false, error: text || `Generation failed (${response.status})` }
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const message = payload.choices?.[0]?.message?.content?.trim()
      if (!message) {
        return { ok: false, error: 'No commit message returned by model.' }
      }

      return { ok: true, message }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate commit message.'
      return { ok: false, error: message }
    }
  }

  async getCommitHistory(limit = 80): Promise<{ ok: boolean; commits?: CommitListItem[]; error?: string }> {
    const repoRoot = this.snapshot.repoRoot ?? (await this.findNearestRepoRoot(this.startDir))
    if (!repoRoot) {
      return { ok: false, error: 'Not inside a git repository.' }
    }

    try {
      const { stdout } = await execFileAsync('git', [
        '-C',
        repoRoot,
        'log',
        '--max-count',
        String(limit),
        '--date=iso-strict',
        '--pretty=format:%x1e%H%x1f%h%x1f%s%x1f%an%x1f%ad',
        '--numstat'
      ])

      const commits = this.parseCommitHistory(stdout)
      return { ok: true, commits }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read commit history.'
      return { ok: false, error: message }
    }
  }

  async getCommitSnapshot(sha: string): Promise<{ ok: boolean; snapshot?: DiffSnapshot; error?: string }> {
    const targetSha = sha.trim()
    if (!targetSha) return { ok: false, error: 'Commit sha is required.' }

    const repoRoot = this.snapshot.repoRoot ?? (await this.findNearestRepoRoot(this.startDir))
    if (!repoRoot) {
      return { ok: false, error: 'Not inside a git repository.' }
    }

    try {
      const [branchName, commitInfo, parentSha, files] = await Promise.all([
        this.getBranchName(repoRoot),
        this.getCommitInfo(repoRoot, targetSha),
        this.getParentSha(repoRoot, targetSha),
        this.getCommitStatusFiles(repoRoot, targetSha)
      ])

      const diffFiles = await Promise.all(
        files.map((file) => this.buildCommitDiffFile(repoRoot, targetSha, parentSha, file))
      )

      let totalAdded = 0
      let totalRemoved = 0
      for (const file of diffFiles) {
        totalAdded += file.added
        totalRemoved += file.removed
      }

      const snapshot: DiffSnapshot = {
        repoState: 'ok',
        repoRoot,
        branchName: `${branchName} • ${commitInfo.shortSha} ${commitInfo.subject}`,
        message: `Commit ${commitInfo.shortSha} by ${commitInfo.authorName} on ${commitInfo.committedAt}`,
        totals: {
          files: diffFiles.length,
          added: totalAdded,
          removed: totalRemoved
        },
        files: diffFiles,
        generatedAt: Date.now()
      }

      return { ok: true, snapshot }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read commit diff.'
      return { ok: false, error: message }
    }
  }

  subscribe(sender: WebContents): void {
    this.subscribers.add(sender.id)
    sender.once('destroyed', () => {
      this.subscribers.delete(sender.id)
    })

    this.sendSnapshotToSender(sender)
  }

  scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.refreshNow()
    }, 180)
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }

    if (this.watcher) {
      void this.watcher.close()
      this.watcher = null
    }
    if (this.gitMetaWatcher) {
      void this.gitMetaWatcher.close()
      this.gitMetaWatcher = null
    }
  }

  private configureWatcher(): void {
    const repoRoot = this.snapshot.repoRoot
    const watchRoot = repoRoot ?? this.startDir

    if (this.watcher) {
      void this.watcher.close()
      this.watcher = null
    }
    if (this.gitMetaWatcher) {
      void this.gitMetaWatcher.close()
      this.gitMetaWatcher = null
    }

    this.watcher = chokidar.watch(watchRoot, {
      ignoreInitial: true,
      ignored: [
        /(^|[/\\])node_modules([/\\]|$)/,
        /(^|[/\\])dist([/\\]|$)/,
        /(^|[/\\])out([/\\]|$)/,
        /(^|[/\\])build([/\\]|$)/
      ]
    })

    this.watcher.on('all', () => this.scheduleRefresh())
    this.watcher.on('error', () => this.scheduleRefresh())

    if (repoRoot) {
      void this.configureGitMetaWatcher(repoRoot)
    }
  }

  private async configureGitMetaWatcher(repoRoot: string): Promise<void> {
    const gitDir = await this.getGitDir(repoRoot)
    if (!gitDir) return

    if (this.gitMetaWatcher) {
      void this.gitMetaWatcher.close()
      this.gitMetaWatcher = null
    }

    this.gitMetaWatcher = chokidar.watch(
      [
        join(gitDir, 'HEAD'),
        join(gitDir, 'index'),
        join(gitDir, 'packed-refs'),
        join(gitDir, 'refs'),
        join(gitDir, 'logs')
      ],
      {
        ignoreInitial: true
      }
    )

    this.gitMetaWatcher.on('all', () => this.scheduleRefresh())
    this.gitMetaWatcher.on('error', () => this.scheduleRefresh())
  }

  private async getGitDir(repoRoot: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'rev-parse', '--git-dir'])
      const raw = stdout.trim()
      if (!raw) return null
      return raw.startsWith('/') ? raw : join(repoRoot, raw)
    } catch {
      return null
    }
  }

  private async refreshNow(): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true

    try {
      const nextSnapshot = await this.buildSnapshot()
      const rootChanged = nextSnapshot.repoRoot !== this.snapshot.repoRoot
      this.snapshot = nextSnapshot

      if (rootChanged) {
        this.configureWatcher()
      }

      this.broadcastSnapshot()
    } finally {
      this.refreshing = false
    }
  }

  private async buildSnapshot(): Promise<DiffSnapshot> {
    const repoRoot = await this.findNearestRepoRoot(this.startDir)

    if (!repoRoot) {
      return this.createEmptySnapshot('not_in_repo', 'Not inside a git repository')
    }

    try {
      const statusFiles = await this.getStatusFiles(repoRoot)
      const branchName = await this.getBranchName(repoRoot)
      const files: DiffFile[] = []
      let totalAdded = 0
      let totalRemoved = 0

      for (const statusFile of statusFiles) {
        const file = await this.buildDiffFile(repoRoot, statusFile)
        files.push(file)
        totalAdded += file.added
        totalRemoved += file.removed
      }

      const filesByRecency = await Promise.all(
        files.map(async (file) => ({
          file,
          modifiedAtMs: await this.getFileModifiedAtMs(repoRoot, file)
        }))
      )

      filesByRecency.sort((a, b) => {
        if (b.modifiedAtMs !== a.modifiedAtMs) return b.modifiedAtMs - a.modifiedAtMs
        return a.file.path.localeCompare(b.file.path)
      })

      const orderedFiles = filesByRecency.map((entry) => entry.file)

      return {
        repoState: 'ok',
        repoRoot,
        branchName,
        totals: {
          files: orderedFiles.length,
          added: totalAdded,
          removed: totalRemoved
        },
        files: orderedFiles,
        generatedAt: Date.now()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build git diff snapshot'
      return this.createEmptySnapshot('error', message, repoRoot)
    }
  }

  private createEmptySnapshot(
    repoState: DiffSnapshot['repoState'],
    message: string,
    repoRoot?: string
  ): DiffSnapshot {
    return {
      repoState,
      repoRoot,
      message,
      totals: {
        files: 0,
        added: 0,
        removed: 0
      },
      files: [],
      generatedAt: Date.now()
    }
  }

  private async getFileModifiedAtMs(repoRoot: string, file: DiffFile): Promise<number> {
    const candidates = [file.path, file.originalPath].filter((value): value is string => Boolean(value))

    for (const candidate of candidates) {
      try {
        const info = await stat(join(repoRoot, candidate))
        return info.mtimeMs
      } catch {
        continue
      }
    }

    return 0
  }

  private async findNearestRepoRoot(fromDir: string): Promise<string | null> {
    let currentDir = resolve(fromDir)

    while (true) {
      const root = await this.tryGetRepoRoot(currentDir)
      if (root) return root

      const parentDir = dirname(currentDir)
      if (parentDir === currentDir) break
      currentDir = parentDir
    }

    return null
  }

  private async tryGetRepoRoot(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])
      return stdout.trim()
    } catch {
      return null
    }
  }

  private async getStatusFiles(repoRoot: string): Promise<StatusFile[]> {
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoRoot,
      'status',
      '--porcelain=v1',
      '--untracked-files=all'
    ])

    const lines = stdout.split('\n').filter(Boolean)
    const files = new Map<string, StatusFile>()

    for (const line of lines) {
      if (line.length < 4) continue

      const x = line[0]
      const y = line[1]
      const payload = line.slice(3)

      if (x === '?' && y === '?') {
        files.set(payload, { path: payload, status: '?' })
        continue
      }

      const renameMatch = payload.match(/^(.*) -> (.*)$/)
      const originalPath = renameMatch ? renameMatch[1] : undefined
      const path = renameMatch ? renameMatch[2] : payload

      const statusChar = y !== ' ' ? y : x
      const status = this.toDiffStatus(statusChar)

      files.set(path, {
        path,
        originalPath,
        status
      })
    }

    return [...files.values()]
  }

  private async getBranchName(repoRoot: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'branch', '--show-current'])
      const branch = stdout.trim()
      if (branch) return branch

      const detached = await execFileAsync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'])
      const sha = detached.stdout.trim()
      return sha ? `detached@${sha}` : 'detached'
    } catch {
      return 'unknown'
    }
  }

  private parseCommitHistory(logOutput: string): CommitListItem[] {
    const records = logOutput
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
    const commits: CommitListItem[] = []

    for (const record of records) {
      const lines = record.split('\n').filter(Boolean)
      if (!lines.length) continue

      const [sha, shortSha, subject, authorName, committedAt] = lines[0].split('\x1f')
      if (!sha || !shortSha) continue

      let added = 0
      let removed = 0
      let files = 0
      for (let i = 1; i < lines.length; i += 1) {
        const parts = lines[i].split('\t')
        if (parts.length < 3) continue
        const [addedRaw, removedRaw] = parts
        files += 1
        if (addedRaw !== '-') {
          added += Number.parseInt(addedRaw, 10) || 0
        }
        if (removedRaw !== '-') {
          removed += Number.parseInt(removedRaw, 10) || 0
        }
      }

      commits.push({
        sha,
        shortSha,
        subject: subject ?? '',
        authorName: authorName ?? '',
        committedAt: committedAt ?? '',
        added,
        removed,
        files
      })
    }

    return commits
  }

  private async getCommitInfo(
    repoRoot: string,
    sha: string
  ): Promise<{ shortSha: string; subject: string; authorName: string; committedAt: string }> {
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoRoot,
      'show',
      '-s',
      '--date=iso-strict',
      '--format=%h%x1f%s%x1f%an%x1f%ad',
      sha
    ])

    const [shortSha, subject, authorName, committedAt] = stdout.trim().split('\x1f')
    return {
      shortSha: shortSha ?? sha.slice(0, 7),
      subject: subject ?? '',
      authorName: authorName ?? '',
      committedAt: committedAt ?? ''
    }
  }

  private async getParentSha(repoRoot: string, sha: string): Promise<string | null> {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'rev-list', '--parents', '-n', '1', sha])
    const tokens = stdout.trim().split(/\s+/).filter(Boolean)
    return tokens.length > 1 ? tokens[1] : null
  }

  private async getCommitStatusFiles(repoRoot: string, sha: string): Promise<CommitStatusFile[]> {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'show', '--name-status', '--format=', sha])
    const lines = stdout.split('\n').filter(Boolean)
    const files: CommitStatusFile[] = []

    for (const line of lines) {
      const fields = line.split('\t')
      if (!fields.length) continue
      const statusRaw = fields[0]
      const status = statusRaw[0]
      if (status === 'A' && fields[1]) files.push({ status: 'A', path: fields[1] })
      else if (status === 'D' && fields[1]) files.push({ status: 'D', path: fields[1] })
      else if (status === 'M' && fields[1]) files.push({ status: 'M', path: fields[1] })
      else if ((status === 'R' || status === 'C') && fields[1] && fields[2]) {
        files.push({ status: status === 'R' ? 'R' : 'C', originalPath: fields[1], path: fields[2] })
      }
    }

    return files
  }

  private async buildCommitDiffFile(
    repoRoot: string,
    sha: string,
    parentSha: string | null,
    statusFile: CommitStatusFile
  ): Promise<DiffFile> {
    const originalPath = statusFile.originalPath ?? statusFile.path
    const [numStat, originalTextResult, modifiedTextResult] = await Promise.all([
      this.getCommitNumStat(repoRoot, sha, statusFile),
      this.getCommitOriginalText(repoRoot, parentSha, originalPath, statusFile.status),
      this.getCommitModifiedText(repoRoot, sha, statusFile.path, statusFile.status)
    ])

    const isBinary = numStat.binary || originalTextResult.binary || modifiedTextResult.binary

    return {
      path: statusFile.path,
      originalPath: statusFile.originalPath,
      status: statusFile.status,
      added: numStat.added,
      removed: numStat.removed,
      originalText: isBinary ? '' : originalTextResult.text,
      modifiedText: isBinary ? '' : modifiedTextResult.text,
      isBinary
    }
  }

  private async getCommitNumStat(
    repoRoot: string,
    sha: string,
    file: CommitStatusFile
  ): Promise<{ added: number; removed: number; binary: boolean }> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'show', '--numstat', '--format=', sha, '--', file.path])
      const line = stdout.trim().split('\n').find(Boolean)
      if (!line) return { added: 0, removed: 0, binary: false }
      const [addedRaw, removedRaw] = line.split('\t')
      if (addedRaw === '-' || removedRaw === '-') return { added: 0, removed: 0, binary: true }
      return {
        added: Number.parseInt(addedRaw, 10) || 0,
        removed: Number.parseInt(removedRaw, 10) || 0,
        binary: false
      }
    } catch {
      return { added: 0, removed: 0, binary: false }
    }
  }

  private async getCommitOriginalText(
    repoRoot: string,
    parentSha: string | null,
    filePath: string,
    status: CommitStatusFile['status']
  ): Promise<{ text: string; binary: boolean }> {
    if (status === 'A' || !parentSha) return { text: '', binary: false }
    try {
      const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'show', `${parentSha}:${filePath}`], {
        encoding: 'utf8',
        maxBuffer: 12 * 1024 * 1024
      })
      return { text: stdout, binary: this.hasBinaryHint(filePath, stdout) }
    } catch {
      return { text: '', binary: false }
    }
  }

  private async getCommitModifiedText(
    repoRoot: string,
    sha: string,
    filePath: string,
    status: CommitStatusFile['status']
  ): Promise<{ text: string; binary: boolean }> {
    if (status === 'D') return { text: '', binary: false }
    try {
      const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'show', `${sha}:${filePath}`], {
        encoding: 'utf8',
        maxBuffer: 12 * 1024 * 1024
      })
      return { text: stdout, binary: this.hasBinaryHint(filePath, stdout) }
    } catch {
      return { text: '', binary: false }
    }
  }

  private toDiffStatus(input: string): DiffFile['status'] {
    if (input === 'A') return 'A'
    if (input === 'D') return 'D'
    if (input === 'R') return 'R'
    if (input === 'C') return 'C'
    return 'M'
  }

  private async buildDiffFile(repoRoot: string, statusFile: StatusFile): Promise<DiffFile> {
    const fullPath = join(repoRoot, statusFile.path)
    const originalRefPath = statusFile.originalPath ?? statusFile.path

    const [numStat, originalTextResult, modifiedTextResult] = await Promise.all([
      this.getNumStat(repoRoot, statusFile.path, statusFile.status),
      this.getOriginalText(repoRoot, originalRefPath, statusFile.status),
      this.getModifiedText(fullPath, statusFile.status)
    ])

    const isBinary = numStat.binary || originalTextResult.binary || modifiedTextResult.binary
    const added = statusFile.status === '?' ? this.countLines(modifiedTextResult.text) : numStat.added
    const removed = statusFile.status === '?' ? 0 : numStat.removed

    return {
      path: statusFile.path,
      originalPath: statusFile.originalPath,
      status: statusFile.status,
      added,
      removed,
      originalText: isBinary ? '' : originalTextResult.text,
      modifiedText: isBinary ? '' : modifiedTextResult.text,
      isBinary
    }
  }

  private async getNumStat(
    repoRoot: string,
    filePath: string,
    status: DiffFile['status']
  ): Promise<{ added: number; removed: number; binary: boolean }> {
    if (status === '?') {
      return { added: 0, removed: 0, binary: false }
    }

    try {
      const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'diff', '--numstat', 'HEAD', '--', filePath])
      const line = stdout.trim().split('\n')[0]

      if (!line) return { added: 0, removed: 0, binary: false }

      const [addedRaw, removedRaw] = line.split('\t')
      if (addedRaw === '-' || removedRaw === '-') {
        return { added: 0, removed: 0, binary: true }
      }

      return {
        added: Number.parseInt(addedRaw, 10) || 0,
        removed: Number.parseInt(removedRaw, 10) || 0,
        binary: false
      }
    } catch {
      return { added: 0, removed: 0, binary: false }
    }
  }

  private async getOriginalText(
    repoRoot: string,
    filePath: string,
    status: DiffFile['status']
  ): Promise<{ text: string; binary: boolean }> {
    if (status === 'A' || status === '?') {
      return { text: '', binary: false }
    }

    try {
      const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'show', `HEAD:${filePath}`], {
        encoding: 'utf8',
        maxBuffer: 12 * 1024 * 1024
      })
      return { text: stdout, binary: this.hasBinaryHint(filePath, stdout) }
    } catch {
      return { text: '', binary: false }
    }
  }

  private async getModifiedText(
    fullPath: string,
    status: DiffFile['status']
  ): Promise<{ text: string; binary: boolean }> {
    if (status === 'D') {
      return { text: '', binary: false }
    }

    try {
      await access(fullPath, constants.F_OK)
      const buffer = await readFile(fullPath)
      const binary = this.isBinaryBuffer(fullPath, buffer)
      return { text: binary ? '' : buffer.toString('utf8'), binary }
    } catch {
      return { text: '', binary: false }
    }
  }

  private isBinaryBuffer(filePath: string, data: Buffer): boolean {
    const ext = extname(filePath).toLowerCase()
    if (BINARY_EXTENSIONS.has(ext)) {
      return true
    }

    const max = Math.min(data.length, 1024)
    for (let i = 0; i < max; i += 1) {
      if (data[i] === 0) {
        return true
      }
    }

    return false
  }

  private hasBinaryHint(filePath: string, text: string): boolean {
    const ext = extname(filePath).toLowerCase()
    if (BINARY_EXTENSIONS.has(ext)) return true
    return text.includes('\u0000')
  }

  private countLines(text: string): number {
    if (!text) return 0
    const endsWithNewline = text.endsWith('\n')
    const segments = text.split('\n').length
    return endsWithNewline ? segments - 1 : segments
  }

  private broadcastSnapshot(): void {
    for (const id of this.subscribers) {
      const contents = BrowserWindow.getAllWindows()
        .map((window) => window.webContents)
        .find((webContents) => webContents.id === id)
      if (!contents || contents.isDestroyed()) continue
      contents.send(DIFF_UPDATE_CHANNEL, this.snapshot)
    }
  }

  private sendSnapshotToSender(sender: WebContents): void {
    if (!sender.isDestroyed()) {
      sender.send(DIFF_UPDATE_CHANNEL, this.snapshot)
    }
  }
}

let diffService: DiffService | null = null

function createWindow(): void {
  const windowState = loadWindowState()
  const mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    ...(isFiniteNumber(windowState.x) ? { x: windowState.x } : {}),
    ...(isFiniteNumber(windowState.y) ? { y: windowState.y } : {}),
    minWidth: 640,
    minHeight: 680,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : { frame: false }),
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (windowState.isMaximized) {
      mainWindow.maximize()
    }
    if (windowState.isFullScreen) {
      mainWindow.setFullScreen(true)
    }
    mainWindow.show()
  })

  mainWindow.on('move', () => saveWindowState(mainWindow))
  mainWindow.on('resize', () => saveWindowState(mainWindow))
  mainWindow.on('maximize', () => saveWindowState(mainWindow))
  mainWindow.on('unmaximize', () => saveWindowState(mainWindow))
  mainWindow.on('enter-full-screen', () => saveWindowState(mainWindow))
  mainWindow.on('leave-full-screen', () => saveWindowState(mainWindow))
  mainWindow.on('close', () => saveWindowState(mainWindow, { sync: true }))

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  windowStateDb = open<WindowState>({
    path: join(app.getPath('userData'), 'state.lmdb')
  })

  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  diffService = new DiffService(process.cwd())
  await diffService.init()

  ipcMain.handle(DIFF_GET_SNAPSHOT_CHANNEL, async () => {
    if (!diffService) {
      return {
        repoState: 'error',
        message: 'Diff service unavailable',
        totals: { files: 0, added: 0, removed: 0 },
        files: [],
        generatedAt: Date.now()
      } satisfies DiffSnapshot
    }

    return diffService.getSnapshot()
  })

  ipcMain.handle(DIFF_COMMIT_CHANNEL, async (_event, message: unknown) => {
    if (!diffService) {
      return { ok: false, error: 'Diff service unavailable' }
    }

    if (typeof message !== 'string') {
      return { ok: false, error: 'Invalid commit message.' }
    }

    return diffService.commit(message)
  })

  ipcMain.handle(DIFF_GENERATE_COMMIT_MESSAGE_CHANNEL, async () => {
    if (!diffService) {
      return { ok: false, error: 'Diff service unavailable' }
    }
    return diffService.generateCommitMessage()
  })

  ipcMain.handle(DIFF_GET_COMMIT_HISTORY_CHANNEL, async () => {
    if (!diffService) {
      return { ok: false, error: 'Diff service unavailable' }
    }
    return diffService.getCommitHistory()
  })

  ipcMain.handle(DIFF_GET_COMMIT_SNAPSHOT_CHANNEL, async (_event, sha: unknown) => {
    if (!diffService) {
      return { ok: false, error: 'Diff service unavailable' }
    }
    if (typeof sha !== 'string') {
      return { ok: false, error: 'Invalid commit sha.' }
    }
    return diffService.getCommitSnapshot(sha)
  })

  ipcMain.on(DIFF_SUBSCRIBE_CHANNEL, (event) => {
    diffService?.subscribe(event.sender)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  for (const window of BrowserWindow.getAllWindows()) {
    saveWindowState(window, { sync: true })
  }
  diffService?.dispose()
  windowStateDb?.close()
  windowStateDb = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
