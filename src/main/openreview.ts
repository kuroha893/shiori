import { BrowserWindow, ipcMain, session, shell, type Session } from 'electron'
import type { OpenReviewAccount } from '../shared/types'

/*
 * OpenReview makes every visitor who isn't signed in pass a human check before it hands out a PDF; signed-in
 * visitors skip it. The owner signs in on OpenReview's own page, in a window of ours with a session of its own, so
 * Shiori never sees the password; PDFs then come through that session. The access token is short-lived and renewed
 * with the refresh token, as OpenReview's own site does; once that fails too, the owner is signed out.
 */

// Tests point both at a fake OpenReview.
const SITE = process.env.SHIORI_OPENREVIEW ?? 'https://openreview.net'
const API = process.env.SHIORI_OPENREVIEW ?? 'https://api2.openreview.net'
const ACCESS = 'openreview.accessToken'
const REFRESH = 'openreview.refreshToken'
const USER = 'openreview.user'

type Send = (channel: string, payload?: unknown) => void
let send: Send = () => {}
let owner: () => BrowserWindow | undefined = () => undefined
let signedIn = false
const listeners: (() => void)[] = []

/** Whether the owner was signed in when Shiori last looked, for callers that can't wait. */
export const isSignedIn = () => signedIn
export const onAccountChange = (fn: () => void) => listeners.push(fn)

function accountChanged(now: boolean): void {
  signedIn = now
  send('openreview:changed')
  for (const fn of listeners) fn()
}

/** OpenReview keeps the paper to its authors and reviewers for now. */
export class NotPublic extends Error {
  constructor() {
    super('这篇在 OpenReview 上暂未公开')
  }
}
const hidden = (status: number, body: { name?: string; message?: string }) =>
  status === 403 && (body.name === 'ForbiddenError' || /permission/i.test(body.message ?? ''))

const ses = (): Session => session.fromPartition('persist:openreview')
/** Cookies reach the disk only now and then; a sign-in shouldn't be lost to a crash or a forced quit. */
const keep = () => ses().cookies.flushStore().catch(() => undefined)

export const isOpenReview = (url: string): boolean => {
  try {
    const host = new URL(url).hostname
    return host === 'openreview.net' || host.endsWith('.openreview.net')
  } catch {
    return false
  }
}

async function cookie(name: string): Promise<string | undefined> {
  return (await ses().cookies.get({ name })).find((c) => c.value)?.value
}

/** A token's payload, or a cookie holding JSON. */
function decode(raw: string | undefined): any {
  if (!raw) return undefined
  const text = decodeURIComponent(raw).replace(/^j:/, '')
  try {
    return JSON.parse(text)
  } catch {
    try {
      return JSON.parse(Buffer.from(text.split('.')[1] ?? '', 'base64url').toString())
    } catch {
      return undefined
    }
  }
}

export async function account(): Promise<OpenReviewAccount | undefined> {
  const [access, refresh, user] = await Promise.all([cookie(ACCESS), cookie(REFRESH), cookie(USER)])
  signedIn = !!(access || refresh)
  if (!signedIn) return undefined
  const u = decode(user) ?? decode(access)?.user
  const p = u?.profile ?? u?.user?.profile ?? u
  return { name: String(p?.preferredEmail ?? p?.emails?.[0] ?? p?.usernames?.[0] ?? p?.id ?? u?.id ?? '') }
}

async function renew(): Promise<boolean> {
  const res = await ses()
    .fetch(`${API}/refreshToken`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=UTF-8' } })
    .catch(() => undefined)
  const data = res && ((await res.json().catch(() => ({}))) as { user?: unknown })
  if (data?.user) await keep()
  return !!data?.user
}

/** A GET to OpenReview's API through the signed-in session; undefined when it wants the owner to sign in again. */
async function get(path: string, ms: number): Promise<Response | undefined> {
  for (let round = 0; round < 2; round++) {
    if (round || !(await cookie(ACCESS))) {
      if (!(await renew())) break
    }
    const token = await cookie(ACCESS)
    const res = await ses().fetch(`${API}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(ms) })
    const body = res.status === 403 ? ((await res.clone().json().catch(() => ({}))) as { name?: string }) : {}
    if (res.status !== 401 && body.name !== 'ChallengeRequiredError') return res
  }
  await ses().clearStorageData()
  await keep()
  accountChanged(false)
  return undefined
}

const paperId = (link: string) => {
  const id = new URL(link).searchParams.get('id')
  if (!id) throw new Error('OpenReview 链接里没有论文编号')
  return encodeURIComponent(id)
}

/** The paper's PDF through the signed-in session; undefined when OpenReview wants the owner to sign in again. */
export async function fetchPdf(link: string): Promise<Buffer | undefined> {
  const res = await get(`/pdf?id=${paperId(link)}`, 120_000)
  if (!res) return undefined
  if (res.ok) {
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.subarray(0, 4).toString() !== '%PDF') throw new Error('下载到的文件不是 PDF')
    return bytes
  }
  const body = (await res.json().catch(() => ({}))) as { name?: string; message?: string }
  if (hidden(res.status, body)) throw new NotPublic()
  throw new Error(`下载 PDF 失败（${res.status}${body.message ? `：${body.message}` : ''}）`)
}

/** Whether OpenReview shows the paper to the signed-in owner; undefined when they are signed out. */
export async function visible(link: string): Promise<boolean | undefined> {
  const res = await get(`/notes?id=${paperId(link)}`, 30_000)
  if (!res) return undefined
  const body = (await res.json().catch(() => ({}))) as { name?: string; message?: string; notes?: unknown[] }
  if (res.ok) return !!body.notes?.length
  if (hidden(res.status, body)) return false
  throw new Error(`OpenReview ${res.status}${body.message ? `：${body.message}` : ''}`)
}

let signingIn: { window: BrowserWindow; done: Promise<boolean> } | undefined

/** OpenReview's sign-in page in a window; true once the owner has signed in, false when they close it. */
export function signIn(): Promise<boolean> {
  if (signingIn) {
    signingIn.window.focus()
    return signingIn.done
  }
  const parent = owner()
  const win = new BrowserWindow({
    width: 480,
    height: 640,
    useContentSize: true,
    title: 'OpenReview',
    parent,
    show: false,
    minimizable: false,
    fullscreenable: false,
    webPreferences: { session: ses(), sandbox: true, contextIsolation: true }
  })
  if (parent) {
    const p = parent.getBounds()
    const w = win.getBounds()
    win.setPosition(Math.round(p.x + (p.width - w.width) / 2), Math.round(p.y + Math.max(40, (p.height - w.height) / 2)))
  }
  win.on('page-title-updated', (e) => e.preventDefault())
  // Links to elsewhere open in the browser; the window stays on OpenReview.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (isOpenReview(url) || url.startsWith(SITE)) return
    e.preventDefault()
    if (/^https?:/.test(url)) shell.openExternal(url)
  })
  win.once('ready-to-show', () => win.show())
  const done = new Promise<boolean>((resolve) => {
    let over = false
    const finish = (ok: boolean) => {
      if (over) return
      over = true
      ses().cookies.off('changed', changed)
      signingIn = undefined
      if (!win.isDestroyed()) win.close()
      void keep().then(async () => {
        accountChanged(!!(await account()))
        resolve(ok)
      })
    }
    // The token arrives with the other cookies of the same answer; wait for those before closing.
    const changed = (_e: unknown, c: Electron.Cookie, _cause: string, removed: boolean) => {
      if (!removed && c.name === ACCESS && c.value) setTimeout(() => finish(true), 300)
    }
    ses().cookies.on('changed', changed)
    win.on('closed', () => finish(false))
  })
  signingIn = { window: win, done }
  win.loadURL(`${SITE}/login`)
  return done
}

async function signOut(): Promise<void> {
  await ses()
    .fetch(`${API}/logout`, { method: 'POST' })
    .catch(() => undefined)
  await ses().clearStorageData()
  await keep()
  accountChanged(false)
}

export function initOpenReview(o: { send: Send; window: () => BrowserWindow | undefined }): void {
  send = o.send
  owner = o.window
  void account()
  ipcMain.handle('openreview:account', () => account())
  ipcMain.handle('openreview:signIn', async () => ((await signIn()) ? account() : undefined))
  ipcMain.handle('openreview:signOut', () => signOut())
}
