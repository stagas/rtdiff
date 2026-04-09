import { createHighlighter, createJavaScriptRegexEngine, type Highlighter } from 'shiki'
import type { CommitListItem, DiffFile, DiffSnapshot, LayoutMode } from '../../shared/diff'

type RowKind = 'context' | 'added' | 'removed' | 'modified'

interface DiffOp {
  type: 'context' | 'add' | 'remove'
  leftLine?: number
  rightLine?: number
}

interface DiffRow {
  kind: RowKind
  leftLine?: number
  rightLine?: number
}

interface DiffHunk {
  rows: DiffRow[]
}

interface FileView {
  path: string
  section: HTMLElement
  sidebarItem: HTMLButtonElement
  contentHost: HTMLElement
}

const fileViews = new Map<string, FileView>()
let layoutMode: LayoutMode = 'side-by-side'
let snapshot: DiffSnapshot | null = null
let activePath: string | null = null
let highlighter: Highlighter | null = null
let viewMode: 'working' | 'commit-list' | 'commit-diff' = 'working'
let latestWorkingSnapshot: DiffSnapshot | null = null

const appRoot = document.getElementById('app') as HTMLElement
const sidebarRoot = document.querySelector('.sidebar') as HTMLElement
const sidebarList = document.getElementById('file-list') as HTMLElement
const branchName = document.getElementById('branch-name') as HTMLElement
const totalAdded = document.getElementById('total-added') as HTMLElement
const totalRemoved = document.getElementById('total-removed') as HTMLElement
const sectionsRoot = document.getElementById('diff-sections') as HTMLElement
const emptyState = document.getElementById('empty-state') as HTMLElement
const modeButton = document.getElementById('layout-toggle') as HTMLButtonElement
const commitButton = document.getElementById('commit-button') as HTMLButtonElement
const backButton = document.getElementById('back-button') as HTMLButtonElement
const topbarHeading = document.getElementById('topbar-heading') as HTMLElement
const sectionsScroller = document.getElementById('diff-scroller') as HTMLElement
const commitModal = document.getElementById('commit-modal') as HTMLElement
const commitBackdrop = document.getElementById('commit-backdrop') as HTMLElement
const commitMessage = document.getElementById('commit-message') as HTMLTextAreaElement
const commitGenerate = document.getElementById('commit-generate') as HTMLButtonElement
const commitGenerateLabel = commitGenerate.querySelector('.label') as HTMLSpanElement
const commitConfirm = document.getElementById('commit-confirm') as HTMLButtonElement
const commitCancel = document.getElementById('commit-cancel') as HTMLButtonElement
const commitError = document.getElementById('commit-error') as HTMLElement

function init(): void {
  updateLayoutToggle()

  modeButton.addEventListener('click', () => {
    layoutMode = layoutMode === 'side-by-side' ? 'inline' : 'side-by-side'
    updateLayoutToggle()

    if (snapshot) {
      applySnapshot(snapshot)
    }
  })

  commitButton.addEventListener('click', openCommitModal)
  backButton.addEventListener('click', () => {
    viewMode = 'commit-list'
    if (latestWorkingSnapshot) {
      if (latestWorkingSnapshot.files.length > 0) {
        viewMode = 'working'
      }
      applySnapshot(latestWorkingSnapshot)
    }
  })
  commitBackdrop.addEventListener('click', closeCommitModal)
  commitCancel.addEventListener('click', closeCommitModal)
  commitGenerate.addEventListener('click', () => {
    void generateCommitMessage()
  })
  commitConfirm.addEventListener('click', () => {
    void submitCommit()
  })
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || commitModal.hidden) return
    closeCommitModal()
  })

  sectionsScroller.addEventListener('scroll', onScrollActiveSection)
  void boot()
}

function updateLayoutToggle(): void {
  modeButton.classList.toggle('is-inline', layoutMode === 'inline')
  modeButton.classList.toggle('is-side-by-side', layoutMode === 'side-by-side')
}

function openCommitModal(): void {
  commitModal.hidden = false
  commitError.hidden = true
  commitError.textContent = ''
  commitMessage.value = ''
  commitConfirm.disabled = false
  commitCancel.disabled = false
  commitGenerate.disabled = false
  requestAnimationFrame(() => {
    commitMessage.focus()
  })
  void generateCommitMessage()
}

function closeCommitModal(): void {
  commitModal.hidden = true
}

async function submitCommit(): Promise<void> {
  const message = commitMessage.value.trim()
  if (!message) {
    commitError.hidden = false
    commitError.textContent = 'Commit message is required.'
    return
  }

  commitConfirm.disabled = true
  commitCancel.disabled = true
  commitGenerate.disabled = true
  commitError.hidden = true
  commitError.textContent = ''

  const result = await window.api.commit(message)
  if (!result.ok) {
    commitConfirm.disabled = false
    commitCancel.disabled = false
    commitGenerate.disabled = false
    commitError.hidden = false
    commitError.textContent = result.error ?? 'Commit failed.'
    return
  }

  closeCommitModal()
}

async function generateCommitMessage(): Promise<void> {
  commitGenerate.classList.add('is-loading')
  commitGenerateLabel.textContent = 'Generating...'
  commitGenerate.disabled = true
  commitConfirm.disabled = true
  commitError.hidden = true
  commitError.textContent = ''

  const result = await window.api.generateCommitMessage()
  if (!result.ok || !result.message) {
    commitGenerate.classList.remove('is-loading')
    commitGenerateLabel.textContent = 'Generate'
    commitGenerate.disabled = false
    commitConfirm.disabled = false
    commitError.hidden = false
    commitError.textContent = result.error ?? 'Failed to generate commit message.'
    return
  }

  commitMessage.value = result.message
  commitGenerate.classList.remove('is-loading')
  commitGenerateLabel.textContent = 'Generate'
  commitGenerate.disabled = false
  commitConfirm.disabled = false
}

async function boot(): Promise<void> {
  highlighter = await createHighlighter({
    themes: ['github-dark-default'],
    langs: ['plaintext', 'typescript', 'tsx', 'javascript', 'jsx', 'json', 'css', 'scss', 'html', 'markdown', 'yaml', 'bash', 'diff'],
    engine: createJavaScriptRegexEngine()
  })

  const firstSnapshot = await window.api.getSnapshot()
  latestWorkingSnapshot = firstSnapshot
  applySnapshot(firstSnapshot)

  window.api.onSnapshot((nextSnapshot) => {
    latestWorkingSnapshot = nextSnapshot
    if (viewMode === 'commit-diff') return
    applySnapshot(nextSnapshot)
  })
}

function applySnapshot(nextSnapshot: DiffSnapshot): void {
  snapshot = nextSnapshot
  updateSummary(nextSnapshot)
  syncCommitAvailability(nextSnapshot)
  updateTopbarHeading(nextSnapshot)

  if (nextSnapshot.repoState !== 'ok') {
    renderNotReady(nextSnapshot)
    return
  }

  emptyState.hidden = true
  appRoot.classList.remove('has-empty-state')
  backButton.hidden = viewMode !== 'commit-diff'
  sidebarRoot.classList.toggle('has-back', !backButton.hidden)
  if (viewMode !== 'commit-diff' && nextSnapshot.files.length > 0) {
    viewMode = 'working'
  }

  const incomingPaths = new Set(nextSnapshot.files.map((file) => file.path))
  for (const [path, view] of fileViews) {
    if (!incomingPaths.has(path)) {
      disposeView(view)
      fileViews.delete(path)
    }
  }

  sidebarList.replaceChildren()

  for (const file of nextSnapshot.files) {
    const view = upsertView(file)
    renderSidebarItem(view, file)
    updateSection(view, file)
  }

  if (!nextSnapshot.files.length) {
    if (viewMode === 'commit-diff') {
      emptyState.hidden = false
      emptyState.textContent = 'No file changes in this commit.'
      appRoot.classList.add('has-empty-state')
    } else {
      viewMode = 'commit-list'
      void renderCommitList()
    }
  }

  if (activePath && !incomingPaths.has(activePath)) {
    activePath = null
  }

  if (!activePath && nextSnapshot.files.length > 0) {
    setActivePath(nextSnapshot.files[0].path)
  } else {
    syncActiveStyles()
  }
}

function updateSummary(nextSnapshot: DiffSnapshot): void {
  branchName.textContent = nextSnapshot.branchName ?? 'unknown'
  totalAdded.textContent = `+${nextSnapshot.totals.added}`
  totalRemoved.textContent = `-${nextSnapshot.totals.removed}`
}

function syncCommitAvailability(nextSnapshot: DiffSnapshot): void {
  const canCommit = viewMode === 'working' && nextSnapshot.repoState === 'ok' && nextSnapshot.files.length > 0
  commitButton.disabled = !canCommit
}

function renderNotReady(nextSnapshot: DiffSnapshot): void {
  for (const view of fileViews.values()) {
    disposeView(view)
  }
  fileViews.clear()
  sidebarList.replaceChildren()
  sectionsRoot.replaceChildren()

  emptyState.hidden = false
  backButton.hidden = true
  sidebarRoot.classList.remove('has-back')
  topbarHeading.hidden = true
  topbarHeading.textContent = ''
  viewMode = 'working'
  appRoot.classList.add('has-empty-state')
  emptyState.textContent =
    nextSnapshot.repoState === 'not_in_repo'
      ? 'Not inside a git repository. Move into a git project or initialize one.'
      : nextSnapshot.message ?? 'Failed to read git state.'
}

async function renderCommitList(): Promise<void> {
  backButton.hidden = true
  sidebarRoot.classList.remove('has-back')
  topbarHeading.hidden = true
  topbarHeading.textContent = ''
  syncCommitAvailability(snapshot ?? { repoState: 'error', totals: { files: 0, added: 0, removed: 0 }, files: [], generatedAt: Date.now() })
  const result = await window.api.getCommitHistory()
  if (!result.ok || !result.commits) {
    emptyState.hidden = false
    emptyState.textContent = result.error ?? 'Failed to load commit history.'
    appRoot.classList.add('has-empty-state')
    return
  }

  const commits = result.commits
  if (!commits.length) {
    emptyState.hidden = false
    emptyState.textContent = 'No commits yet.'
    appRoot.classList.add('has-empty-state')
    return
  }

  emptyState.hidden = false
  appRoot.classList.add('has-empty-state')
  emptyState.innerHTML = `
    <div class="commit-list">
      ${commits.map((commit) => renderCommitListItem(commit)).join('')}
    </div>
  `

  for (const button of emptyState.querySelectorAll<HTMLButtonElement>('[data-commit-sha]')) {
    button.addEventListener('click', () => {
      const sha = button.dataset.commitSha
      if (!sha) return
      void openCommitDiff(sha)
    })
  }
}

function renderCommitListItem(commit: CommitListItem): string {
  const dateLabel = commit.committedAt ? new Date(commit.committedAt).toLocaleString() : ''
  return `
    <button class="commit-list-item" data-commit-sha="${escapeHtml(commit.sha)}" type="button">
      <span class="commit-main">
        <span class="commit-subject">${escapeHtml(commit.subject || '(no subject)')}</span>
        <span class="commit-meta">${escapeHtml(commit.shortSha)} • ${escapeHtml(commit.authorName)}${dateLabel ? ` • ${escapeHtml(dateLabel)}` : ''}</span>
      </span>
      <span class="commit-delta">
        <span class="added">+${commit.added}</span>
        <span class="removed">-${commit.removed}</span>
        <span>${commit.files} file${commit.files === 1 ? '' : 's'}</span>
      </span>
    </button>
  `
}

async function openCommitDiff(sha: string): Promise<void> {
  emptyState.hidden = false
  appRoot.classList.add('has-empty-state')
  emptyState.textContent = 'Loading commit diff...'

  const result = await window.api.getCommitSnapshot(sha)
  if (!result.ok || !result.snapshot) {
    emptyState.textContent = result.error ?? 'Failed to load commit diff.'
    return
  }

  viewMode = 'commit-diff'
  applySnapshot(result.snapshot)
}

function updateTopbarHeading(nextSnapshot: DiffSnapshot): void {
  const message = nextSnapshot.message?.trim() ?? ''
  if (viewMode === 'commit-diff' && message) {
    topbarHeading.hidden = false
    topbarHeading.textContent = message
    sidebarRoot.classList.add('has-heading')
    return
  }

  topbarHeading.hidden = true
  topbarHeading.textContent = ''
  sidebarRoot.classList.remove('has-heading')
}

function upsertView(file: DiffFile): FileView {
  const existing = fileViews.get(file.path)
  if (existing) return existing

  const section = document.createElement('section')
  section.className = 'diff-section'
  section.dataset.path = file.path

  const header = document.createElement('div')
  header.className = 'diff-header'

  const title = document.createElement('h3')
  title.className = 'diff-title'
  title.textContent = file.path

  const stats = document.createElement('div')
  stats.className = 'diff-line-count'

  header.append(title, stats)

  const contentHost = document.createElement('div')
  contentHost.className = 'diff-content'

  section.append(header, contentHost)
  sectionsRoot.append(section)

  const sidebarItem = document.createElement('button')
  sidebarItem.type = 'button'
  sidebarItem.className = 'file-item'
  sidebarItem.addEventListener('click', () => {
    setActivePath(file.path)
    section.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })

  const view: FileView = {
    path: file.path,
    section,
    sidebarItem,
    contentHost
  }

  fileViews.set(file.path, view)
  return view
}

function renderSidebarItem(view: FileView, file: DiffFile): void {
  const markerClass = statusClass(file.status)
  view.sidebarItem.innerHTML = `
    <span class="file-marker ${markerClass}">${file.status}</span>
    <span class="file-path">${escapeHtml(file.path)}</span>
    <span class="file-delta">
      <span class="added">+${file.added}</span>
      <span class="removed">-${file.removed}</span>
    </span>
  `
  sidebarList.append(view.sidebarItem)
}

function updateSection(view: FileView, file: DiffFile): void {
  const header = view.section.querySelector('.diff-header') as HTMLElement
  const lineCount = header.querySelector('.diff-line-count') as HTMLElement
  lineCount.innerHTML = `
    <span class="status-pill ${statusClass(file.status)}">${file.status}</span>
    <span class="added">+${file.added}</span>
    <span class="removed">-${file.removed}</span>
  `

  if (file.isBinary) {
    view.contentHost.innerHTML = '<div class="binary-placeholder">Binary file changes cannot be rendered as text diff.</div>'
    return
  }

  const language = detectLanguage(file.path)
  const originalLines = splitLines(file.originalText)
  const modifiedLines = splitLines(file.modifiedText)
  const rows = buildRows(originalLines, modifiedLines)
  const hunks = buildHunks(rows, 3)

  const originalTokens = tokenizeLines(file.originalText, language)
  const modifiedTokens = tokenizeLines(file.modifiedText, language)
  const orderedHunks = [...hunks].sort((a, b) => getHunkSortLine(a) - getHunkSortLine(b))
  const hunkNodes = orderedHunks.map((hunk) => renderHunk(hunk, originalTokens, modifiedTokens, layoutMode))
  view.contentHost.replaceChildren(...hunkNodes)
}

function getHunkSortLine(hunk: DiffHunk): number {
  let maxLine = 0

  for (const row of hunk.rows) {
    if (row.kind === 'context') continue
    const candidate = row.rightLine ?? row.leftLine ?? 0
    if (candidate > maxLine) maxLine = candidate
  }

  if (maxLine > 0) return maxLine

  for (const row of hunk.rows) {
    const candidate = row.rightLine ?? row.leftLine ?? 0
    if (candidate > maxLine) maxLine = candidate
  }

  return maxLine
}

function renderHunk(
  hunk: DiffHunk,
  originalTokens: ShikiTokenLine[],
  modifiedTokens: ShikiTokenLine[],
  mode: LayoutMode
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'diff-hunk'

  const scroller = document.createElement('div')
  scroller.className = 'diff-hunk-scroll'

  if (mode === 'inline') {
    const table = document.createElement('div')
    table.className = 'diff-table inline'
    for (const row of hunk.rows) {
      const rowEl = renderInlineRow(row, originalTokens, modifiedTokens)
      rowEl.dataset.changed = row.kind === 'context' ? '0' : '1'
      table.append(rowEl)
    }
    scroller.append(table)
    wrapper.append(scroller)

    requestAnimationFrame(() => {
      centerChangedRows(scroller)
    })

    return wrapper
  }

  const split = renderSideBySideHunk(hunk, originalTokens, modifiedTokens)
  scroller.append(split.container)
  wrapper.append(scroller)

  requestAnimationFrame(() => {
    centerChangedRows(split.leftPane)
    centerChangedRows(split.rightPane)
  })

  return wrapper
}

function renderSideBySideHunk(
  hunk: DiffHunk,
  originalTokens: ShikiTokenLine[],
  modifiedTokens: ShikiTokenLine[]
): { container: HTMLElement; leftPane: HTMLElement; rightPane: HTMLElement } {
  const container = document.createElement('div')
  container.className = 'diff-sbs'

  const leftPane = document.createElement('div')
  leftPane.className = 'diff-sbs-pane'
  const rightPane = document.createElement('div')
  rightPane.className = 'diff-sbs-pane'

  const leftTable = document.createElement('div')
  leftTable.className = 'diff-sbs-table'
  const rightTable = document.createElement('div')
  rightTable.className = 'diff-sbs-table'

  for (const row of hunk.rows) {
    const leftRow = renderPaneRow('left', row, originalTokens, modifiedTokens)
    leftTable.append(leftRow)
    const rightRow = renderPaneRow('right', row, originalTokens, modifiedTokens)
    rightTable.append(rightRow)
  }

  leftPane.append(leftTable)
  rightPane.append(rightTable)
  container.append(leftPane, rightPane)
  syncPaneScroll(leftPane, rightPane)

  return { container, leftPane, rightPane }
}

function renderPaneRow(
  side: 'left' | 'right',
  row: DiffRow,
  originalTokens: ShikiTokenLine[],
  modifiedTokens: ShikiTokenLine[]
): HTMLElement {
  const el = document.createElement('div')
  el.className = `diff-row ${row.kind}`
  el.dataset.changed = row.kind === 'context' ? '0' : '1'

  const lineNo = document.createElement('span')
  lineNo.className = 'line-no pane'
  lineNo.textContent = side === 'left' ? String(row.leftLine ?? '') : String(row.rightLine ?? '')

  const code = document.createElement('code')
  code.className = 'line-code pane'
  if (side === 'left') {
    code.innerHTML = row.leftLine ? renderTokenLine(originalTokens[row.leftLine - 1]) : '&nbsp;'
  } else {
    code.innerHTML = row.rightLine ? renderTokenLine(modifiedTokens[row.rightLine - 1]) : '&nbsp;'
  }

  el.append(lineNo, code)
  return el
}

function syncPaneScroll(a: HTMLElement, b: HTMLElement): void {
  let syncing = false
  a.addEventListener('scroll', () => {
    if (syncing) return
    syncing = true
    b.scrollTop = a.scrollTop
    b.scrollLeft = a.scrollLeft
    syncing = false
  })
  b.addEventListener('scroll', () => {
    if (syncing) return
    syncing = true
    a.scrollTop = b.scrollTop
    a.scrollLeft = b.scrollLeft
    syncing = false
  })
}

function centerChangedRows(scroller: HTMLElement): void {
  const changedRows = [...scroller.querySelectorAll<HTMLElement>('.diff-row[data-changed="1"]')]
  if (!changedRows.length) return

  const first = changedRows[0]
  const last = changedRows[changedRows.length - 1]
  const changedMid = (first.offsetTop + last.offsetTop + last.offsetHeight) / 2
  const target = Math.max(0, changedMid - scroller.clientHeight / 2)
  scroller.scrollTop = target
}

function renderInlineRow(
  row: DiffRow,
  originalTokens: ShikiTokenLine[],
  modifiedTokens: ShikiTokenLine[]
): HTMLElement {
  const el = document.createElement('div')
  el.className = `diff-row inline ${row.kind}`

  const marker = document.createElement('span')
  marker.className = 'line-marker'
  marker.textContent = row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : row.kind === 'modified' ? '~' : ' '

  const lineNo = document.createElement('span')
  lineNo.className = 'line-no inline'
  lineNo.textContent = String(row.rightLine ?? row.leftLine ?? '')

  const code = document.createElement('code')
  code.className = 'line-code inline'

  const tokenLine =
    row.kind === 'removed'
      ? originalTokens[(row.leftLine ?? 1) - 1]
      : modifiedTokens[(row.rightLine ?? row.leftLine ?? 1) - 1]

  code.innerHTML = renderTokenLine(tokenLine)

  el.append(marker, lineNo, code)
  return el
}

function buildRows(originalLines: string[], modifiedLines: string[]): DiffRow[] {
  const ops = diffLines(originalLines, modifiedLines)
  const rows: DiffRow[] = []

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]
    if (op.type === 'context') {
      rows.push({ kind: 'context', leftLine: op.leftLine, rightLine: op.rightLine })
    } else if (op.type === 'remove') {
      rows.push({ kind: 'removed', leftLine: op.leftLine })
    } else {
      rows.push({ kind: 'added', rightLine: op.rightLine })
    }
  }

  return rows
}

function buildHunks(rows: DiffRow[], contextLines: number): DiffHunk[] {
  if (!rows.length) return [{ rows: [] }]

  const changedIndices: number[] = []
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].kind !== 'context') changedIndices.push(i)
  }

  if (!changedIndices.length) {
    return [{ rows }]
  }

  const ranges: Array<{ start: number; end: number }> = []
  for (const index of changedIndices) {
    const start = Math.max(0, index - contextLines)
    const end = Math.min(rows.length - 1, index + contextLines)
    const last = ranges[ranges.length - 1]
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end)
    } else {
      ranges.push({ start, end })
    }
  }

  return ranges.map((range) => ({
    rows: rows.slice(range.start, range.end + 1)
  }))
}

function diffLines(left: string[], right: string[]): DiffOp[] {
  if (left.length > 1400 || right.length > 1400) {
    return fastDiffLines(left, right)
  }

  const n = left.length
  const m = right.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0))

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (left[i] === right[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1])
      }
    }
  }

  const ops: DiffOp[] = []
  let i = 0
  let j = 0

  while (i < n && j < m) {
    if (left[i] === right[j]) {
      ops.push({ type: 'context', leftLine: i + 1, rightLine: j + 1 })
      i += 1
      j += 1
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'remove', leftLine: i + 1 })
      i += 1
    } else {
      ops.push({ type: 'add', rightLine: j + 1 })
      j += 1
    }
  }

  while (i < n) {
    ops.push({ type: 'remove', leftLine: i + 1 })
    i += 1
  }

  while (j < m) {
    ops.push({ type: 'add', rightLine: j + 1 })
    j += 1
  }

  return ops
}

function fastDiffLines(left: string[], right: string[]): DiffOp[] {
  const ops: DiffOp[] = []
  const maxLen = Math.max(left.length, right.length)

  for (let i = 0; i < maxLen; i += 1) {
    const l = left[i]
    const r = right[i]

    if (l !== undefined && r !== undefined) {
      if (l === r) {
        ops.push({ type: 'context', leftLine: i + 1, rightLine: i + 1 })
      } else {
        ops.push({ type: 'remove', leftLine: i + 1 })
        ops.push({ type: 'add', rightLine: i + 1 })
      }
    } else if (l !== undefined) {
      ops.push({ type: 'remove', leftLine: i + 1 })
    } else {
      ops.push({ type: 'add', rightLine: i + 1 })
    }
  }

  return ops
}

function tokenizeLines(text: string, language: string): ShikiTokenLine[] {
  if (!highlighter) return []

  const tokens = highlighter.codeToTokensBase(text, {
    lang: language as never,
    theme: 'github-dark-default'
  }) as ShikiTokenLine[]

  return tokens
}

function renderTokenLine(tokens: ShikiTokenLine | undefined): string {
  if (!tokens || tokens.length === 0) {
    return '&nbsp;'
  }

  return tokens
    .map((token) => {
      const content = escapeHtml(token.content).replaceAll(' ', '&nbsp;').replaceAll('\t', '&nbsp;&nbsp;')
      const color = token.color ? ` style=\"color:${token.color}\"` : ''
      return `<span${color}>${content || '&nbsp;'}</span>`
    })
    .join('')
}

function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

function disposeView(view: FileView): void {
  view.sidebarItem.remove()
  view.section.remove()
}

function statusClass(status: DiffFile['status']): string {
  if (status === 'A' || status === '?') return 'status-added'
  if (status === 'D') return 'status-removed'
  if (status === 'R' || status === 'C') return 'status-renamed'
  return 'status-modified'
}

function setActivePath(path: string): void {
  activePath = path
  syncActiveStyles()
}

function syncActiveStyles(): void {
  for (const [path, view] of fileViews) {
    const isActive = path === activePath
    view.sidebarItem.classList.toggle('active', isActive)
    view.section.classList.toggle('active', isActive)
  }
}

function onScrollActiveSection(): void {
  if (!snapshot || snapshot.repoState !== 'ok' || snapshot.files.length === 0) return

  let nearestPath: string | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  const scrollerRect = sectionsScroller.getBoundingClientRect()

  for (const file of snapshot.files) {
    const view = fileViews.get(file.path)
    if (!view) continue

    const distance = Math.abs(view.section.getBoundingClientRect().top - scrollerRect.top - 16)
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearestPath = file.path
    }
  }

  if (nearestPath && nearestPath !== activePath) {
    setActivePath(nearestPath)
  }
}

function detectLanguage(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts') || lower.endsWith('.tsx')) return 'typescript'
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.jsx')) return 'javascript'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.css')) return 'css'
  if (lower.endsWith('.scss')) return 'scss'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (lower.endsWith('.md')) return 'markdown'
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml'
  if (lower.endsWith('.sh')) return 'bash'
  return 'plaintext'
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

type ShikiToken = { content: string; color?: string }
type ShikiTokenLine = ShikiToken[]

init()
