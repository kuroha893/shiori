// Types shared by the main process, the preload bridge and the renderer.

export type PaperStatus = 'new' | 'queued' | 'processing' | 'ready' | 'error'

export interface PaperMeta {
  id: string
  title: string
  titleZh?: string
  authors: string[]
  venue?: string
  year?: string
  arxiv?: string
  abstract?: string
  tags: string[]
  addedAt: string
  pages?: number
  status: PaperStatus
  /** Human-readable description of what the background job is doing */
  stage?: string
  /** 0..1 while processing */
  progress?: number
  error?: string
  /** Claude session used for transcription and translation */
  processSession?: string
  processedAt?: string
  processModel?: string
  /** A guide is being written in the background */
  guideWriting?: boolean
  guideError?: string
  /** Ids of the research directions the owner filed this paper under */
  folders?: string[]
  /** Claude's suggestion for an unfiled paper; nothing is filed until the owner accepts it */
  suggestion?: { name: string; folderId?: string }
  /** Reading state */
  readPos?: { block: string; ratio: number }
  readAt?: string
  finished?: boolean
}

export interface Folder {
  id: string
  name: string
}

export interface Block {
  id: string
  type: 'h' | 'p' | 'eq' | 'fig' | 'tab' | 'list' | 'quote' | 'code' | 'ref' | 'note'
  attrs: Record<string, string>
  /** Section name -> markdown. 'en' is the original text, 'zh' the translation, 'table' a transcribed table. */
  parts: Record<string, string>
  page?: number
  bbox?: [number, number, number, number]
}

export interface PaperDoc {
  blocks: Block[]
  summary?: string
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink'

export interface Annotation {
  id: string
  block: string
  lang: 'zh' | 'en'
  start: number
  end: number
  text: string
  color: HighlightColor
  note?: string
  createdAt: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  quote?: { block: string; text: string }
  createdAt: string
  model?: string
  error?: boolean
}

export interface ChatState {
  sessionId?: string
  messages: ChatMessage[]
}

export interface Settings {
  libraryPath: string
  claudePath?: string
  processModel: string
  chatModel: string
  theme: 'system' | 'light' | 'dark' | 'sepia'
  readingFont: 'serif' | 'sans'
  /** CSS family names of the interface and monospace fonts */
  uiFont: string
  monoFont: string
  fontSize: number
  lineHeight: number
  view: 'zh' | 'en' | 'both'
}

export interface ClaudeStatus {
  path?: string
  version?: string
  loggedIn: boolean
  account?: string
  error?: string
}

export interface GlossaryEntry {
  id: string
  en: string
  /** Chinese rendering; ignored when keep is set */
  zh?: string
  /** Keep the English term untranslated */
  keep?: boolean
}

export type ChatEvent =
  | { paper: string; kind: 'delta'; text: string }
  | { paper: string; kind: 'status'; text: string }
  | { paper: string; kind: 'done'; message: ChatMessage }
