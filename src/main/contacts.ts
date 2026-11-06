import { dialog, ipcMain, nativeImage, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BUILTIN, YACHIYO, type AvatarCrop, type Contact, type ContactDraft } from '../shared/contacts'
import { root } from './library'
import { shippedFile } from './shippedContacts'
import { closePet, petState } from './pet'
import { getSettings } from './settings'
import { modelFor, runAgent } from './ai'

/*
 * Contacts live in <library>/contacts.json. Each has a folder <library>/<id> with who they are now: persona.md,
 * picture, notes and call records. Every contact is the owner's to change or delete, the ones that come with the
 * app included: a library receives each of those once, as a copy of resources/contacts/<id>, and from then on they
 * are its own. Only the desktop character (pet/) stays with the app, as part of it.
 */

type Stored = Pick<Contact, 'id' | 'name' | 'voice' | 'language' | 'romaji'> & { persona?: string }

const file = () => join(root(), 'contacts.json')
/** Which of the app's contacts this library has received, so one the owner deleted stays deleted. */
const receivedFile = () => join(root(), 'shipped-contacts.json')
export const contactDir = (id: string) => join(root(), id)
const avatarFile = (id: string) => join(contactDir(id), 'avatar.png')
const portraitFile = (id: string) => join(contactDir(id), 'portrait.jpg')
const cropFile = (id: string) => join(contactDir(id), 'avatar-crop.json')
const personaFile = (id: string) => join(contactDir(id), 'persona.md')

let changed: (list: Contact[]) => void = () => {}

/** A file's address, marked by when it changed so a new one shows at once. */
function assetUrl(id: string, name: string, own: string): string | undefined {
  return existsSync(own) ? `shiori://contact/${id}/${name}?v=${statSync(own).mtimeMs}` : undefined
}

function readCrop(id: string): AvatarCrop | undefined {
  try {
    return JSON.parse(readFileSync(cropFile(id), 'utf8'))
  } catch {
    return undefined
  }
}

/** persona.md is the only copy of a persona; older ones were kept in contacts.json. */
function readPersona(c: Stored): string {
  const file = personaFile(c.id)
  if (!existsSync(file)) {
    if (!c.persona) return ''
    mkdirSync(contactDir(c.id), { recursive: true })
    writeFileSync(file, c.persona)
  }
  return readFileSync(file, 'utf8')
}

function readStored(): Stored[] {
  try {
    const data = JSON.parse(readFileSync(file(), 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

const writeStored = (list: Stored[]) =>
  writeFileSync(file(), JSON.stringify(list.map(({ id, name, voice, language, romaji }) => ({ id, name, voice, language, ...(romaji ? { romaji } : {}) })), null, 2))

/** The voice and language an app's contact starts with. */
function shippedVoice(id: string): Partial<Pick<Stored, 'voice' | 'language'>> {
  try {
    return JSON.parse(readFileSync(shippedFile(id, 'contact.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** Copy an app's contact's files where the library lacks them. */
function copyShipped(id: string): void {
  for (const name of ['persona.md', 'avatar.png', 'portrait.jpg', 'avatar-crop.json']) {
    const shipped = shippedFile(id, name)
    const own = join(contactDir(id), name)
    if (!existsSync(shipped) || existsSync(own)) continue
    mkdirSync(contactDir(id), { recursive: true })
    copyFileSync(shipped, own)
  }
}

/**
 * Hand the library the app's contacts it hasn't received yet: their files, copied where the library lacks them,
 * and a place in contacts.json right after the app's contacts that come before them, ahead of the owner's own.
 * A library from before the record counts the ones it already lists as received; it used to read their pictures
 * from the app, so it gets its own copies of what it lacks, and their names and readings as they are now.
 */
function receive(stored: Stored[]): Stored[] {
  let got: string[] | undefined
  try {
    got = JSON.parse(readFileSync(receivedFile(), 'utf8'))
  } catch {
    /* none yet */
  }
  const first = !got
  got ??= BUILTIN.filter((b) => stored.some((c) => c.id === b.id)).map((b) => b.id)
  const fresh = BUILTIN.filter((b) => !got!.includes(b.id))
  if (!first && !fresh.length) return stored
  let list = stored
  if (first) {
    list = list.map((c) => {
      const b = BUILTIN.find((x) => x.id === c.id)
      if (!b) return c
      copyShipped(b.id)
      return b.formerly.includes(c.name) ? { ...c, name: b.name, romaji: c.romaji || b.romaji } : c
    })
  }
  for (const b of fresh) {
    copyShipped(b.id)
    // Yachiyo's voice and language were settings before there could be several contacts.
    const legacy = b.id === YACHIYO ? getSettings().contacts?.[YACHIYO] : undefined
    const start = shippedVoice(b.id)
    const arrival = { id: b.id, name: b.name, romaji: b.romaji, voice: legacy?.voice ?? start.voice ?? '', language: legacy?.language ?? start.language ?? 'ja' }
    const before = BUILTIN.slice(0, BUILTIN.indexOf(b)).map((x) => x.id)
    const at = list.reduce((n, c, i) => (before.includes(c.id) ? i + 1 : n), 0)
    list = [...list.slice(0, at), arrival, ...list.slice(at)]
  }
  mkdirSync(root(), { recursive: true })
  writeStored(list)
  writeFileSync(receivedFile(), JSON.stringify([...got, ...fresh.map((b) => b.id)]))
  return list
}

const callCount = (id: string) => {
  try {
    return readdirSync(join(contactDir(id), 'calls')).filter((f) => f.endsWith('.jsonl')).length
  } catch {
    return 0
  }
}

const remembers = (id: string) => {
  try {
    return readFileSync(join(contactDir(id), 'memory.md'), 'utf8').trim().length > 0
  } catch {
    return false
  }
}

export function loadContacts(): Contact[] {
  return receive(readStored()).map((c) => {
    const { persona: _old, ...rest } = c
    return {
      ...rest,
      persona: readPersona(c),
      avatar: assetUrl(c.id, 'avatar.png', avatarFile(c.id)),
      portrait: assetUrl(c.id, 'portrait.jpg', portraitFile(c.id)),
      crop: readCrop(c.id),
      hue: pictureHue(c.id) ?? nameHue(c.name),
      calls: callCount(c.id),
      remembers: remembers(c.id)
    }
  })
}

export const getContact = (id: string) => loadContacts().find((c) => c.id === id)

export function saveContact(draft: ContactDraft): Contact[] {
  const list = loadContacts()
  const before = list.find((c) => c.id === draft.id)
  if (draft.id && !before) throw new Error('这个联系人已经不在了')
  const name = draft.name.trim()
  if (!name) throw new Error('名字不能为空')
  if (list.some((c) => c.name === name && c.id !== draft.id)) throw new Error(`已经有「${name}」了`)
  // The prefix keeps a contact's folder from ever colliding with "papers" and the like.
  const id = before?.id ?? `c-${randomUUID()}`
  mkdirSync(contactDir(id), { recursive: true })
  if (draft.avatar === null) rmSync(avatarFile(id), { force: true })
  else if (draft.avatar) {
    const png = draft.avatar.match(/^data:image\/png;base64,(.+)$/)
    if (!png) throw new Error('头像格式不对')
    writeFileSync(avatarFile(id), Buffer.from(png[1], 'base64'))
  }
  if (draft.portrait === null) {
    rmSync(portraitFile(id), { force: true })
    rmSync(cropFile(id), { force: true })
  } else if (draft.portrait) {
    const jpeg = draft.portrait.match(/^data:image\/jpeg;base64,(.+)$/)
    if (!jpeg) throw new Error('图片格式不对')
    writeFileSync(portraitFile(id), Buffer.from(jpeg[1], 'base64'))
  }
  if (draft.crop && draft.portrait !== null) writeFileSync(cropFile(id), JSON.stringify(draft.crop))
  const persona = draft.persona.trim()
  writeFileSync(personaFile(id), persona)
  // A reading left as it was belongs to the old name, so a renamed contact gets a new one.
  let romaji = (draft.romaji ?? '').trim()
  if (before && before.name !== name && romaji === (before.romaji ?? '')) romaji = ''
  const next: Stored = { id, name, voice: draft.voice.trim(), language: draft.language, romaji: romaji || undefined }
  writeStored(before ? readStored().map((c) => (c.id === id ? next : c)) : [...readStored(), next])
  if (!romaji) fillRomaji(id, name)
  return loadContacts()
}

/** How a name is read, in Latin letters, asked of the model the owner chats with. */
export async function romajiFor(name: string): Promise<string> {
  const model = await modelFor(getSettings().chatModel, 'chat')
  const r = await runAgent({
    cwd: root(),
    model,
    effort: getSettings().chatEffort,
    write: false,
    prompt: `How is this name read, written in Latin letters the way it would appear on a name card? Japanese names in Hepburn, in the order written (葉山 詩織 → Hayama Shiori). Chinese names in pinyin without tone marks, family name first (李 小林 → Li Xiaolin). A name already in Latin letters stays as it is.

Name: ${name}

Reply with the reading only.`
  })
  const line = r.text.trim().split('\n')[0].replace(/^["'“「『]+|["'”」』.。]+$/g, '').trim()
  if (r.isError || !line || line.length > 60 || !/^[\p{Script=Latin}\s'’.\-]+$/u.test(line)) throw new Error('没能生成读音')
  return line
}

/** In the background; a contact renamed or given a reading by hand meanwhile keeps theirs. */
function fillRomaji(id: string, name: string): void {
  romajiFor(name)
    .then((romaji) => {
      const stored = readStored()
      const c = stored.find((s) => s.id === id)
      if (!c || c.name !== name || c.romaji) return
      c.romaji = romaji
      writeStored(stored)
      changed(loadContacts())
    })
    .catch(() => {})
}

/** Her picture, notes and call records go to the Trash, so a slip can be undone. */
async function deleteContact(id: string): Promise<Contact[]> {
  if (!readStored().some((c) => c.id === id)) return loadContacts()
  if (petState().contact === id) closePet()
  writeStored(readStored().filter((c) => c.id !== id))
  if (existsSync(contactDir(id))) await shell.trashItem(contactDir(id))
  return loadContacts()
}

const jpegUrl = (bytes: Buffer) => `data:image/jpeg;base64,${bytes.toString('base64')}`

/** The chosen file as it is; the page decodes it, since the system's image reader can't open every format, webp among them. */
async function pickPortrait(): Promise<string | undefined> {
  const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
  if (r.canceled || !r.filePaths[0]) return undefined
  const type = extname(r.filePaths[0]).slice(1).toLowerCase().replace('jpg', 'jpeg')
  return `data:image/${type};base64,${readFileSync(r.filePaths[0]).toString('base64')}`
}

const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`

const hues = new Map<string, number | undefined>()

/** The hue most of a contact's picture leans to; near-grey and near-black pixels have no say. Kept until the picture changes. */
function pictureHue(id: string): number | undefined {
  const path = avatarFile(id)
  if (!existsSync(path)) return undefined
  const key = `${path}:${statSync(path).mtimeMs}`
  if (!hues.has(key)) hues.set(key, hueOf(path))
  return hues.get(key)
}

function hueOf(path: string): number | undefined {
  const image = nativeImage.createFromPath(path).resize({ width: 48, height: 48 })
  const bins = new Array(36).fill(0)
  if (image && !image.isEmpty()) {
    const px = image.toBitmap()
    for (let i = 0; i + 3 < px.length; i += 4) {
      const [b, g, r, a] = [px[i] / 255, px[i + 1] / 255, px[i + 2] / 255, px[i + 3] / 255]
      const max = Math.max(r, g, b)
      const chroma = max - Math.min(r, g, b)
      if (a < 0.5 || chroma < 0.08 || max < 0.2) continue
      const hue = max === r ? ((g - b) / chroma + 6) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4
      bins[Math.floor(hue * 6) % 36] += chroma
    }
  }
  if (!bins.some((b) => b > 0)) return undefined
  // Three bins wide, so a color split across a bin edge still counts as one.
  const spread = (i: number) => bins[(i + 35) % 36] + bins[i] + bins[(i + 1) % 36]
  let best = 0
  for (let i = 1; i < 36; i++) if (spread(i) > spread(best)) best = i
  return best * 10 + 5
}

/** A hue for someone without a colorful picture, the same every time for the same name. */
const nameHue = (name: string) => [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7)

/** The color of a contact's call: their hue at a lightness that reads on the black capsule. */
export function contactAccent(contact: Contact): string {
  const hue = pictureHue(contact.id)
  return hue !== undefined ? hsl(hue, 0.62, 0.8) : hsl(nameHue(contact.name), 0.5, 0.8)
}

/**
 * What shiori://contact/<id>/<path> may serve: the pictures in the library, and the desktop character's pet/
 * files from the app. Notes and call records are never served.
 */
export function contactAsset(id: string, rel: string): string | undefined {
  if (!getContact(id)) return undefined
  if (rel === 'avatar.png') return existsSync(avatarFile(id)) ? avatarFile(id) : undefined
  if (rel === 'portrait.jpg') return existsSync(portraitFile(id)) ? portraitFile(id) : undefined
  if (!rel.startsWith('pet/')) return undefined
  try {
    const file = shippedFile(id, rel)
    return existsSync(file) ? file : undefined
  } catch {
    return undefined
  }
}

export function initContacts(onChange: (list: Contact[]) => void): void {
  changed = onChange
  ipcMain.handle('contacts:list', () => loadContacts())
  ipcMain.handle('contacts:romaji', (_e, name: string) => romajiFor(name))
  ipcMain.handle('contacts:save', (_e, draft: ContactDraft) => {
    const list = saveContact(draft)
    onChange(list)
    return list
  })
  ipcMain.handle('contacts:delete', async (_e, id: string) => {
    const list = await deleteContact(id)
    onChange(list)
    return list
  })
  ipcMain.handle('contacts:pickPortrait', () => pickPortrait())
  // Settings cuts the avatar on a canvas, which only reads pictures it is handed directly.
  ipcMain.handle('contacts:portrait', (_e, id: string) => {
    const path = contactAsset(id, 'portrait.jpg')
    return path ? jpegUrl(readFileSync(path)) : undefined
  })
}
