// Types shared by the main process, the preload bridge and the renderer.

import type { ContactSettings } from './contacts'

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
  /** When the owner hearted this paper */
  likedAt?: string
  /** Reading state */
  readPos?: { block: string; ratio: number }
  readAt?: string
  finished?: boolean
}

export interface Folder {
  id: string
  name: string
}

/** How readily she speaks up on a call: wants to chat, normal, or do not disturb */
export type CallMood = 'chat' | 'normal' | 'quiet'

export interface CallState {
  active: boolean
  startedAt?: number
  /** Claude is working on a reply */
  thinking: boolean
  /** Why she can't speak or be heard right now */
  notice?: string
}

export interface CallLine {
  id: string
  /** What she says, and its Chinese subtitle */
  say: string
  zh: string
  audio?: Uint8Array
  type?: string
  /** She brought this up herself, rather than answering or announcing something */
  unprompted?: boolean
}

export interface CallInit {
  state: CallState
  mood: CallMood
  uiFont: string
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
  /** Side panel: width and text size in px */
  panelWidth: number
  panelFontSize: number
  /** Calls: the Claude model behind them, and each contact's voice and language */
  callModel: string
  contacts: Record<string, ContactSettings>
  callMood: CallMood
  /** Whether the chibi character stands on the desktop during a call */
  petShown: boolean
  /** Where the call was dragged to when she isn't there to stand beside */
  callPosition?: { x: number; y: number }
  /** The owner's own Fish Audio key and model */
  fishKey: string
  fishModel: string
  /** Where the desktop character was last left */
  petPosition?: { x: number; y: number }
  petScale?: number
  view: 'zh' | 'en' | 'both'
}

export interface PetState {
  /** Who is on the call, if anyone */
  contact?: string
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
