// Types shared by the main process, the preload bridge and the renderer.

import type { BackdropFrame, CallLanguage } from './contacts'

export type PaperStatus = 'new' | 'queued' | 'processing' | 'ready' | 'error'

export interface PaperMeta {
  id: string
  title: string
  titleZh?: string
  authors: string[]
  /** Where it was published, as found from the PDF, Semantic Scholar or the web; see shared/venue.ts */
  venue?: string
  year?: string
  /** The owner's own venue and year, shown instead of the found ones and never overwritten */
  venueEdit?: { venue: string; year?: string }
  /** When a paper still only a preprint was last looked up, on Semantic Scholar and the web */
  venueCheckedAt?: string
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
  /** Marked 稍后再看 */
  laterAt?: string
  /** The conference listing it was imported from: "<conf>/<year>" and the paper's key there */
  source?: { edition: string; key: string }
  /** Reading state */
  readPos?: { block: string; ratio: number }
  readAt?: string
  finished?: boolean
}

/**
 * The owner's own AI tasks, done one at a time in their order (see main/tasks.ts). A paper's guide is the last stage
 * of processing it; a guide task alone is a rewrite, a venue task the owner asking where a paper was published.
 */
export type TaskKind = 'process' | 'guide' | 'venue'

export interface Task {
  key: string
  paper: string
  kind: TaskKind
  /** Why it failed, on a failed task */
  error?: string
}

export interface TaskList {
  running?: Task & { stage?: string; progress?: number }
  queue: Task[]
  failed: Task[]
  /** Nothing new starts until the owner resumes */
  paused: boolean
  /** Pause once the running task is done */
  stopAfter: boolean
}

export type TaskAction =
  | { type: 'stopNow' }
  | { type: 'stopAfter'; on: boolean }
  | { type: 'resume' }
  | { type: 'clear' }
  | { type: 'remove'; key: string }
  | { type: 'top'; key: string }
  | { type: 'retry'; key: string }
  | { type: 'order'; keys: string[] }

/** How much of a service's allowance is left (see main/quota.ts). */
export interface QuotaWindow {
  /** The window's length in minutes: 300 for five hours, 10080 for a week */
  minutes: number
  /** 0..1 */
  left: number
  /** When it resets, ms since the epoch */
  resetsAt?: number
}

export interface ServiceQuota {
  provider: 'claude' | 'openai' | 'deepseek'
  /** Claude and ChatGPT: usage windows */
  windows?: QuotaWindow[]
  /** DeepSeek: money left on the account */
  balance?: { amount: number; currency: string; usable: boolean }
  /** Couldn't be read this time */
  failed?: boolean
}

export interface QuotaView {
  services: ServiceQuota[]
  /** Services Shiori runs on now: those picked for processing, chat or calls */
  inUse: ServiceQuota['provider'][]
  checkedAt?: number
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
  /** The answer to what you just said */
  reply?: boolean
}

/** A finished call, for the record on the call screen. */
export interface PastCall {
  startedAt: number
  endedAt: number
  lines: { who: 'you' | 'her'; text: string; zh?: string; at: number }[]
  /** Its opening lines fell outside the limit of what is shown */
  cut?: boolean
}

export interface CallInit {
  state: CallState
  contact: { name: string; avatar?: string; portrait?: string; frame?: BackdropFrame; accent: string }
  past: PastCall[]
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
  /** Images the owner attached, as paths inside the paper folder (chat-media/...) */
  images?: string[]
  createdAt: string
  model?: string
  error?: boolean
}

export interface ChatState {
  sessionId?: string
  /** The service the session belongs to; another service starts afresh from the messages */
  sessionProvider?: string
  messages: ChatMessage[]
}

export interface Settings {
  libraryPath: string
  claudePath?: string
  codexPath?: string
  /** The owner's own DeepSeek API key */
  deepseekKey: string
  /** "<provider>:<model>", see shared/models.ts */
  processModel: string
  chatModel: string
  /** Thinking level wanted for each place; a model that lacks it runs at the nearest below, see pickEffort */
  processEffort: string
  chatEffort: string
  callEffort: string
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
  /** The model behind calls */
  callModel: string
  /** Yachiyo's voice from before contacts moved into the library */
  contacts?: Record<string, { voice: string; language: CallLanguage }>
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
  /** Whether the welcome page has been through, or skipped */
  welcomed?: boolean
}

export interface PetState {
  /** Who is on the call, if anyone */
  contact?: string
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

/** The OpenReview account Shiori downloads through */
export interface OpenReviewAccount {
  /** Its email or profile id, as OpenReview gives it */
  name: string
}
