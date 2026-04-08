import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { createHighlighter } from 'shiki'
import { shikiToMonaco } from '@shikijs/monaco'
import type { DiffFile, DiffSnapshot, LayoutMode } from '../../shared/diff'

type WorkerFactory = { new (): Worker }

interface MonacoEnvironmentWithWorker {
  getWorker: (_: string, label: string) => Worker
}

interface FileView {
  path: string
  section: HTMLElement
  sidebarItem: HTMLButtonElement
  editorHost: HTMLElement
  editor: monaco.editor.IStandaloneDiffEditor | null
  originalModel: monaco.editor.ITextModel | null
  modifiedModel: monaco.editor.ITextModel | null
}

const fileViews = new Map<string, FileView>()
let layoutMode: LayoutMode = 'side-by-side'
let snapshot: DiffSnapshot | null = null
let activePath: string | null = null
let shikiReady = false

const appRoot = document.getElementById('app') as HTMLElement
const sidebarList = document.getElementById('file-list') as HTMLElement
const repoText = document.getElementById('repo-root') as HTMLElement
const stateText = document.getElementById('repo-state') as HTMLElement
const totalFiles = document.getElementById('total-files') as HTMLElement
const totalAdded = document.getElementById('total-added') as HTMLElement
const totalRemoved = document.getElementById('total-removed') as HTMLElement
const sectionsRoot = document.getElementById('diff-sections') as HTMLElement
const emptyState = document.getElementById('empty-state') as HTMLElement
const modeButton = document.getElementById('layout-toggle') as HTMLButtonElement
const sectionsScroller = document.getElementById('diff-scroller') as HTMLElement

function installMonacoWorkers(): void {
  const globalScope = globalThis as typeof globalThis & { MonacoEnvironment?: MonacoEnvironmentWithWorker }

  globalScope.MonacoEnvironment = {
    getWorker(_: string, label: string): Worker {
      if (label === 'json') return new (jsonWorker as WorkerFactory)()
      if (label === 'css' || label === 'scss' || label === 'less') return new (cssWorker as WorkerFactory)()
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new (htmlWorker as WorkerFactory)()
      if (label === 'typescript' || label === 'javascript') return new (tsWorker as WorkerFactory)()
      return new (editorWorker as WorkerFactory)()
    }
  }
}

async function installShikiTheme(): Promise<void> {
  if (shikiReady) return

  const highlighter = await createHighlighter({
    themes: ['github-dark-default'],
    langs: [
      'plaintext',
      'typescript',
      'tsx',
      'javascript',
      'jsx',
      'json',
      'css',
      'scss',
      'html',
      'markdown',
      'yaml',
      'bash',
      'diff'
    ]
  })

  shikiToMonaco(highlighter, monaco)
  monaco.editor.setTheme('github-dark-default')
  shikiReady = true
}

function init(): void {
  installMonacoWorkers()

  modeButton.addEventListener('click', () => {
    layoutMode = layoutMode === 'side-by-side' ? 'inline' : 'side-by-side'
    modeButton.textContent = layoutMode === 'side-by-side' ? 'Inline View' : 'Side by Side'

    for (const view of fileViews.values()) {
      view.editor?.updateOptions({ renderSideBySide: layoutMode === 'side-by-side' })
    }
  })

  sectionsScroller.addEventListener('scroll', onScrollActiveSection)

  void boot()
}

async function boot(): Promise<void> {
  await installShikiTheme()

  const firstSnapshot = await window.api.getSnapshot()
  applySnapshot(firstSnapshot)

  window.api.onSnapshot((nextSnapshot) => {
    applySnapshot(nextSnapshot)
  })
}

function applySnapshot(nextSnapshot: DiffSnapshot): void {
  snapshot = nextSnapshot
  updateSummary(nextSnapshot)

  if (nextSnapshot.repoState !== 'ok') {
    renderNotReady(nextSnapshot)
    return
  }

  emptyState.hidden = true
  appRoot.classList.remove('has-empty-state')

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
    emptyState.hidden = false
    emptyState.textContent = 'No local changes found in this repository.'
    appRoot.classList.add('has-empty-state')
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
  totalFiles.textContent = String(nextSnapshot.totals.files)
  totalAdded.textContent = `+${nextSnapshot.totals.added}`
  totalRemoved.textContent = `-${nextSnapshot.totals.removed}`

  if (nextSnapshot.repoRoot) {
    repoText.textContent = nextSnapshot.repoRoot
  } else {
    repoText.textContent = 'No repository found'
  }

  if (nextSnapshot.repoState === 'ok') {
    stateText.textContent = 'Tracking git changes'
  } else if (nextSnapshot.repoState === 'not_in_repo') {
    stateText.textContent = nextSnapshot.message ?? 'Not inside a git repository'
  } else {
    stateText.textContent = nextSnapshot.message ?? 'Unable to read git changes'
  }
}

function renderNotReady(nextSnapshot: DiffSnapshot): void {
  for (const view of fileViews.values()) {
    disposeView(view)
  }
  fileViews.clear()
  sidebarList.replaceChildren()
  sectionsRoot.replaceChildren()

  emptyState.hidden = false
  appRoot.classList.add('has-empty-state')
  emptyState.textContent =
    nextSnapshot.repoState === 'not_in_repo'
      ? 'Not inside a git repository. Move into a git project or initialize one.'
      : nextSnapshot.message ?? 'Failed to read git state.'
}

function upsertView(file: DiffFile): FileView {
  const existing = fileViews.get(file.path)
  if (existing) {
    return existing
  }

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

  const editorHost = document.createElement('div')
  editorHost.className = 'diff-editor'

  section.append(header, editorHost)
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
    editorHost,
    editor: null,
    originalModel: null,
    modifiedModel: null
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
    disposeEditorOnly(view)
    view.editorHost.innerHTML = '<div class="binary-placeholder">Binary file changes cannot be rendered as text diff.</div>'
    return
  }

  if (view.editorHost.firstElementChild?.classList.contains('binary-placeholder')) {
    view.editorHost.innerHTML = ''
  }

  if (!view.editor) {
    view.editor = monaco.editor.createDiffEditor(view.editorHost, {
      readOnly: true,
      renderSideBySide: layoutMode === 'side-by-side',
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      diffCodeLens: false,
      originalEditable: false,
      wordWrap: 'on'
    })
  }

  if (!view.originalModel) {
    view.originalModel = monaco.editor.createModel('', detectLanguage(file.path), monaco.Uri.parse(`rtdiff://original/${file.path}`))
  }
  if (!view.modifiedModel) {
    view.modifiedModel = monaco.editor.createModel('', detectLanguage(file.path), monaco.Uri.parse(`rtdiff://modified/${file.path}`))
  }

  const language = detectLanguage(file.path)
  monaco.editor.setModelLanguage(view.originalModel, language)
  monaco.editor.setModelLanguage(view.modifiedModel, language)

  if (view.originalModel.getValue() !== file.originalText) {
    view.originalModel.setValue(file.originalText)
  }

  if (view.modifiedModel.getValue() !== file.modifiedText) {
    view.modifiedModel.setValue(file.modifiedText)
  }

  view.editor.updateOptions({ renderSideBySide: layoutMode === 'side-by-side' })
  view.editor.setModel({ original: view.originalModel, modified: view.modifiedModel })
}

function disposeEditorOnly(view: FileView): void {
  if (view.editor) {
    view.editor.dispose()
    view.editor = null
  }

  if (view.originalModel) {
    view.originalModel.dispose()
    view.originalModel = null
  }

  if (view.modifiedModel) {
    view.modifiedModel.dispose()
    view.modifiedModel = null
  }
}

function disposeView(view: FileView): void {
  disposeEditorOnly(view)
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
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'typescript'
  if (lower.endsWith('.tsx')) return 'typescript'
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript'
  if (lower.endsWith('.jsx')) return 'javascript'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.css')) return 'css'
  if (lower.endsWith('.scss')) return 'scss'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (lower.endsWith('.md')) return 'markdown'
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml'
  if (lower.endsWith('.sh')) return 'shell'
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

init()
