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
  /** An interrupted run left this share of the work (doc parts) to carry on from; 重新处理 drops it */
  kept?: number
  processedAt?: string
  processModel?: string
  /**
   * The appendix, left out when the paper was processed, until the owner has it translated: the page it starts on,
   * how many doc parts the main text took (the appendix's parts come after), and the task's state
   */
  appendix?: AppendixState
  /** A guide is being written in the background */
  guideWriting?: boolean
  guideError?: string
  /** Ids of the research directions the owner filed this paper under */
  folders?: string[]
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

export interface AppendixState {
  from: number
  parts?: number
  state?: 'queued' | 'writing' | 'error'
  progress?: number
  error?: string
  /** The Claude Code session writing it, to carry on after an interruption */
  session?: string
}

/**
 * The owner's own AI tasks, done one at a time in their order (see main/tasks.ts). A paper's guide is the last stage
 * of processing it; a guide task alone is a rewrite, a venue task the owner asking where a paper was published, an
 * appendix task the appendix left out when processing.
 */
export type TaskKind = 'process' | 'guide' | 'venue' | 'appendix'

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
  /** Services in use that are signed out */
  signedOut?: ('claude' | 'openai')[]
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

export type WallpaperPlace = 'room' | 'pages' | 'reading'

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
  /** Whether processing a paper transcribes and translates its appendix too, or leaves it for later */
  appendix: 'translate' | 'skip'
  /** Which title a paper shows by: the translation, or the paper's own (where both show, the other goes small) */
  paperTitle: 'zh' | 'en'
  /** How 书库 shows papers: covers, cards or a list, and what it groups them by */
  libraryView: LibraryView
  libraryGroup: LibraryGroup
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
  /** Where the wallpaper shows, each switched on its own: 大厅, 书库 and 会议, the reader */
  wallpaperIn: WallpaperPlace[]
  /** How blurred the wallpaper is on 书库 and 会议, in px */
  wallpaperBlur: number
  /** How blurred it is behind the reader, in px */
  readingBlur: number
  /** With the wallpaper in the reader: the article on a sheet of its own, or across the page over the wallpaper */
  readingWall: 'sheet' | 'full'
  /** Whether the welcome page has been through, or skipped */
  welcomed?: boolean
  /** The contact last called */
  roomContact?: string
  /** Conversations in Shiori Talk that write without lighting a badge */
  mutedContacts: string[]
}

export type LibraryView = 'cover' | 'card' | 'list'
export type LibraryGroup = 'none' | 'added' | 'venue' | 'year' | 'state'

/** What arXiv says about a paper before it is imported, or the paper already in the library */
export interface ArxivPeek {
  arxiv: string
  title: string
  authors: string[]
  /** The library's paper, when it is already there */
  paper?: string
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

/* ---------- 手机 ---------- */

/** The conversation of the app itself in Shiori Talk */
export const SYSTEM_THREAD = '@shiori'

export type NoticeKind =
  | 'paper-ready'
  | 'paper-failed'
  | 'edition'
  | 'later'
  | 'openreview-public'
  | 'signed-out'
  | 'quota-out'
  | 'model'
  | 'openreview-expired'
  | 'voice'
  | 'disk'
  | 'recovered'

/** What a notice's button does */
export type NoticeAction =
  | RoomLink
  | { kind: 'login'; provider: 'claude' | 'openai' | 'deepseek' }
  | { kind: 'openreview' }
  | { kind: 'settings' }
  | { kind: 'retry' }

/** A message from the app itself: a fact, with the one thing to do about it */
export interface SystemNotice {
  id: string
  at: string
  kind: NoticeKind
  /** The fact, in a few words */
  title: string
  /** A second line when the title can't carry it: when the allowance comes back, how much disk is left */
  sub?: string
  paper?: string
  provider?: 'claude' | 'openai' | 'deepseek'
  /** New papers, failed tasks */
  count?: number
  action?: NoticeAction
  read?: boolean
  /** The condition it reported is over (signed in again, allowance back) */
  done?: boolean
  /** Conditions that last are reported once until they end */
  key?: string
}

export interface PhoneConversation {
  /** A contact's id, or SYSTEM_THREAD */
  id: string
  /** The latest thing in it */
  at?: string
  last?: string
  /** That latest thing was a call of so many seconds */
  call?: number
  unread: number
  muted?: boolean
}

export interface PhoneView {
  /** Most recent first */
  conversations: PhoneConversation[]
  /** Unread, leaving out muted conversations */
  unread: number
  /** The newest message of all, for the home screen */
  latest?: { thread: string; at: string; note?: RoomNote; notice?: SystemNotice }
}

export type PhoneItem = { type: 'note'; at: string; note: RoomNote } | { type: 'call'; at: string; seconds: number } | { type: 'notice'; at: string; notice: SystemNotice }

export interface PhoneThread {
  id: string
  /** Oldest first */
  items: PhoneItem[]
  /** Where 到此已读 goes: the first unread item */
  firstUnread?: number
}

/* ---------- 大厅 ---------- */

/** Where a note of hers leads */
export type RoomLink = { kind: 'paper'; paper: string } | { kind: 'edition'; conf: string; year: number } | { kind: 'later' }

/** A message a contact left in Shiori Talk */
export interface RoomNote {
  id: string
  /** When she wrote it; for older notes that told the app's news, when that happened */
  at: string
  /** About her own day, a reaction to what the owner did, or (written before notices) the app's news in her words */
  kind: 'news' | 'day' | 'reaction'
  /** Her words in her own language, when that isn't Chinese */
  say?: string
  zh: string
  links: RoomLink[]
  read?: boolean
}

export interface RoomView {
  /** shiori:// address of the owner's wallpaper, versioned */
  wallpaper?: string
  /** The paper being read: the one opened last that isn't finished */
  reading?: string
  /** A passage the owner highlighted some day, a different one each day */
  quote?: { text: string; paper: string }
}

/** A study timer, kept by the main process so it runs on whatever page is open */
/** Focus, then a break, so many times over; minutes */
export interface StudyPlan {
  focus: number
  rest: number
  rounds: number
}

export interface StudyState {
  plan: StudyPlan
  /** Which round, from 1 */
  round: number
  phase: 'focus' | 'rest'
  /** Length of the phase now running, in minutes */
  minutes: number
  /** When this phase ends, while running */
  endsAt?: number
  /** Milliseconds left in this phase, while paused */
  left?: number
  /** Who is on the call for it */
  with?: string
}

export interface JournalPaper {
  id: string
  title: string
  questions: string[]
  highlights: string[]
}

export interface JournalDay {
  /** YYYY-MM-DD, local */
  date: string
  /** Minutes studied with the timer */
  minutes: number
  papers: JournalPaper[]
}

/** What macOS says is playing */
export interface NowPlaying {
  /** The player's bundle id */
  app: string
  appName?: string
  playing: boolean
  title: string
  artist?: string
  album?: string
  /** Seconds */
  duration?: number
  /** Seconds, as of `at` */
  elapsed?: number
  at: number
  /** A data: URL; sent with a new song only, null when the song has none */
  cover?: string | null
}
