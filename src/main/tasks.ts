import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Task, TaskAction, TaskKind, TaskList } from '../shared/types'
import { root } from './library'

/*
 * The owner's own AI tasks, in one queue, one at a time, in the owner's order: processing papers (with the guide as
 * the last stage), rewriting a guide, looking up where a paper was published. Work Shiori starts by itself
 * (conferences, the weekly venue checks) and the owner's chat and calls don't come through here.
 *
 * Processing goes to the end of the queue; a guide or venue task, a single click on one paper, goes next. The queue
 * stops when the owner says so, at once (the task goes back to the head, and starts over later) or once the running
 * task is done. Failed tasks wait until the owner retries or removes them. Kept in <library>/tasks.json, so a quit
 * picks up where it was; a task cut off by quitting starts over.
 */

export interface TaskContext {
  signal: AbortSignal
  /** What the running task is doing now, for the list */
  report: (stage: string, progress?: number) => void
  /** If it is stopped from now on, it goes back to the queue as this kind instead (a paper's guide stage). */
  requeueAs: (kind: TaskKind) => void
}

export interface Runner {
  run: (paper: string, ctx: TaskContext) => Promise<unknown>
  /** Put in the queue (again): mark the paper as waiting */
  queued?: (paper: string) => void
  /** Taken out of the queue without running */
  dropped?: (paper: string) => void
  /** Stopped at once and put back in the queue */
  stopped?: (paper: string) => void
}

/** A failure to show as another kind of task, so that retrying redoes only that part. */
export class TaskError extends Error {
  constructor(
    message: string,
    readonly kind: TaskKind
  ) {
    super(message)
  }
}

const runners = new Map<TaskKind, Runner>()
let queue: Task[] = []
let failed: Task[] = []
let paused = false
let stopAfter = false
interface Running {
  task: Task
  abort: AbortController
  stage?: string
  progress?: number
  requeue: TaskKind
  stoppedNow?: boolean
}
let running: Running | undefined
/** Callers waiting on one task's result (the venue lookup the owner asked for) */
const waiting = new Map<string, (v: unknown) => void>()
let notify: (list: TaskList) => void = () => {}
let exists: (paper: string) => boolean = () => false

const file = () => join(root(), 'tasks.json')
const strip = ({ key, paper, kind, error }: Task): Task => ({ key, paper, kind, ...(error ? { error } : {}) })

function save(): void {
  // A running task is saved at the head of the queue: after a quit it starts over.
  const q = running && !running.stoppedNow ? [{ ...running.task, kind: running.requeue }, ...queue] : queue
  try {
    writeFileSync(file(), JSON.stringify({ queue: q.map(strip), failed: failed.map(strip), paused }, null, 2))
  } catch {
    /* the library may be gone; the queue still works for this session */
  }
}

export function taskList(): TaskList {
  return {
    running: running && { ...strip(running.task), stage: running.stage, progress: running.progress },
    queue: queue.map(strip),
    failed: failed.map(strip),
    paused,
    stopAfter
  }
}

let changedTimer: NodeJS.Timeout | undefined
function changed(now = false): void {
  save()
  if (changedTimer) clearTimeout(changedTimer)
  changedTimer = setTimeout(() => notify(taskList()), now ? 0 : 50)
}

export function registerRunner(kind: TaskKind, runner: Runner): void {
  runners.set(kind, runner)
}

export function initTasks(onChange: (list: TaskList) => void): void {
  notify = onChange
}

/**
 * Load the library's saved queue, on start and when the owner picks another library; `extra` are tasks found in paper
 * state that the file doesn't have (libraries from before the queue).
 */
export function loadTasks(extra: { paper: string; kind: TaskKind }[], paperExists: (paper: string) => boolean): void {
  exists = paperExists
  if (running) {
    running.stoppedNow = true
    running.abort.abort()
    running = undefined
  }
  for (const [key] of waiting) settle(key, undefined)
  queue = []
  failed = []
  paused = stopAfter = false
  try {
    if (existsSync(file())) {
      const saved = JSON.parse(readFileSync(file(), 'utf8'))
      queue = (saved.queue ?? []).filter((t: Task) => runners.has(t.kind) && exists(t.paper))
      failed = (saved.failed ?? []).filter((t: Task) => runners.has(t.kind) && exists(t.paper))
      paused = !!saved.paused
    }
  } catch {
    /* start empty */
  }
  for (const t of extra) if (!has(t.paper, t.kind)) queue.push({ key: randomUUID(), ...t })
  for (const t of queue) runners.get(t.kind)?.queued?.(t.paper)
  if (!queue.length) paused = false
  changed(true)
  pump()
}

const has = (paper: string, kind: TaskKind) =>
  (running?.task.paper === paper && running.task.kind === kind) || queue.some((t) => t.paper === paper && t.kind === kind)

/**
 * Add the owner's task. Resolves with the task's result once it has run, or undefined if it never does. Processing a
 * paper writes its guide too, so a guide task for a paper waiting to be processed is left out, and processing
 * replaces a waiting guide task.
 */
export function addTask(paper: string, kind: TaskKind): Promise<unknown> {
  if (!exists(paper)) return Promise.resolve(undefined)
  failed = failed.filter((t) => t.paper !== paper || (kind !== 'process' && t.kind !== kind))
  let task = queue.find((t) => t.paper === paper && t.kind === kind)
  if (running?.task.paper === paper && running.task.kind === kind) task = running.task
  else if (kind === 'guide' && (queue.some((t) => t.paper === paper && t.kind === 'process') || (running?.task.paper === paper && running.task.kind === 'process')))
    task = queue.find((t) => t.paper === paper && t.kind === 'process') ?? running!.task
  else if (!task) {
    if (kind === 'process') queue = queue.filter((t) => !(t.paper === paper && t.kind === 'guide'))
    task = { key: randomUUID(), paper, kind }
    if (kind === 'process') queue.push(task)
    else queue.unshift(task)
    runners.get(kind)?.queued?.(paper)
  }
  const key = task.key
  const result = new Promise<unknown>((resolve) => {
    const before = waiting.get(key)
    waiting.set(key, (v) => {
      before?.(v)
      resolve(v)
    })
  })
  changed(true)
  pump()
  return result
}

function settle(key: string, value: unknown): void {
  waiting.get(key)?.(value)
  waiting.delete(key)
}

function drop(t: Task): void {
  runners.get(t.kind)?.dropped?.(t.paper)
  settle(t.key, undefined)
}

function pump(): void {
  if (running || paused || !queue.length) return
  const task = queue.shift()!
  const runner = runners.get(task.kind)
  if (!runner) return pump()
  const abort = new AbortController()
  const r: Running = { task, abort, requeue: task.kind }
  running = r
  const ctx: TaskContext = {
    signal: abort.signal,
    report: (stage, progress) => {
      if (running !== r) return
      r.stage = stage
      if (progress !== undefined) r.progress = progress
      changed()
    },
    requeueAs: (kind) => {
      r.requeue = kind
    }
  }
  changed(true)
  runner
    .run(task.paper, ctx)
    .then((v) => settle(task.key, v))
    .catch((e) => {
      if (r.stoppedNow) return
      if (abort.signal.aborted) return settle(task.key, undefined)
      const kind = e instanceof TaskError ? e.kind : task.kind
      failed.push({ key: task.key, paper: task.paper, kind, error: String(e?.message || e).slice(0, 300) })
      settle(task.key, undefined)
    })
    .finally(() => {
      // a library switch has already let it go
      if (running !== r) return
      running = undefined
      if (stopAfter) {
        stopAfter = false
        paused = true
      }
      if (!queue.length) paused = false
      changed(true)
      pump()
    })
}

export function taskAction(a: TaskAction): void {
  const at = (key: string) => queue.findIndex((t) => t.key === key)
  switch (a.type) {
    case 'stopNow': {
      if (!running) break
      const r = running
      r.stoppedNow = true
      const back = { ...r.task, kind: r.requeue }
      queue.unshift(back)
      // a caller waiting on it keeps waiting for the task that comes back
      if (back.kind !== r.task.kind) settle(r.task.key, undefined)
      paused = true
      stopAfter = false
      r.abort.abort()
      runners.get(back.kind)?.stopped?.(back.paper)
      break
    }
    case 'stopAfter':
      stopAfter = a.on && !!running
      break
    case 'resume':
      paused = false
      break
    case 'clear':
      queue.splice(0).forEach(drop)
      paused = false
      break
    case 'remove': {
      const i = at(a.key)
      if (i >= 0) drop(queue.splice(i, 1)[0])
      failed = failed.filter((t) => t.key !== a.key)
      break
    }
    case 'top': {
      const i = at(a.key)
      if (i > 0) queue.unshift(...queue.splice(i, 1))
      break
    }
    case 'retry': {
      const t = failed.find((x) => x.key === a.key)
      if (!t) break
      failed = failed.filter((x) => x !== t)
      if (!has(t.paper, t.kind)) {
        queue.unshift({ key: t.key, paper: t.paper, kind: t.kind })
        runners.get(t.kind)?.queued?.(t.paper)
      }
      break
    }
    case 'order': {
      // Tasks the list didn't know about (just added, or started meanwhile) keep their place at the end.
      const byKey = new Map(queue.map((t) => [t.key, t]))
      const ordered = a.keys.map((k) => byKey.get(k)).filter((t): t is Task => !!t)
      queue = [...ordered, ...queue.filter((t) => !a.keys.includes(t.key))]
      break
    }
  }
  if (!queue.length && !running) paused = false
  changed(true)
  pump()
}

/** The owner cancelled a paper's processing from the paper itself. */
export function cancelTasks(paper: string, kinds: TaskKind[] = ['process', 'guide']): void {
  for (const t of queue.filter((t) => t.paper === paper && kinds.includes(t.kind))) {
    queue = queue.filter((x) => x !== t)
    drop(t)
  }
  if (running?.task.paper === paper && kinds.includes(running.task.kind)) running.abort.abort()
  changed(true)
}

/** A paper going to the Trash takes all its tasks along. */
export function forgetPaper(paper: string): void {
  cancelTasks(paper, ['process', 'guide', 'venue'])
  failed = failed.filter((t) => t.paper !== paper)
  if (!queue.length && !running) paused = false
  changed(true)
}

export const runningTask = () => running?.task
