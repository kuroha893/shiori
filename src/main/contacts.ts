import { dialog, ipcMain, nativeImage, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { YACHIYO, type AvatarCrop, type Contact, type ContactDraft } from '../shared/contacts'
import { root } from './library'
import { shippedFile } from './shippedContacts'
import { closePet, petState } from './pet'
import { getSettings } from './settings'

/*
 * Contacts live in <library>/contacts.json. Each has a folder <library>/<id> with who they are now: persona.md,
 * picture, notes and call records. A contact that ships with the app also has resources/contacts/<id>, how they
 * started; anything the library doesn't have yet is looked up there.
 */

type Stored = Pick<Contact, 'id' | 'name' | 'voice' | 'language'> & { persona?: string }

const file = () => join(root(), 'contacts.json')
export const contactDir = (id: string) => join(root(), id)
const avatarFile = (id: string) => join(contactDir(id), 'avatar.png')
const portraitFile = (id: string) => join(contactDir(id), 'portrait.jpg')
const cropFile = (id: string) => join(contactDir(id), 'avatar-crop.json')
const personaFile = (id: string) => join(contactDir(id), 'persona.md')

/** A file's address: the library's copy, marked by when it changed so a new one shows at once, or the shipped one. */
function assetUrl(id: string, name: string, own: string): string | undefined {
  const url = `shiori://contact/${id}/${name}`
  if (existsSync(own)) return `${url}?v=${statSync(own).mtimeMs}`
  return existsSync(shippedFile(id, name)) ? url : undefined
}

function readCrop(id: string): AvatarCrop | undefined {
  try {
    return JSON.parse(readFileSync(existsSync(cropFile(id)) ? cropFile(id) : shippedFile(id, 'avatar-crop.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** persona.md is the only copy of a persona. Yachiyo's first one comes with the app; older ones were kept in contacts.json. */
function readPersona(c: Stored): string {
  const file = personaFile(c.id)
  if (!existsSync(file)) {
    const first = shippedFile(c.id, 'persona.md')
    const shipped = existsSync(first)
    if (!c.persona && !shipped) return ''
    mkdirSync(contactDir(c.id), { recursive: true })
    if (shipped) copyFileSync(first, file)
    else writeFileSync(file, c.persona!)
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

/** Yachiyo is always there and always first, whatever the file says. */
export function loadContacts(): Contact[] {
  const stored = readStored()
  const legacy = getSettings().contacts?.[YACHIYO]
  const yachiyo: Stored = {
    voice: legacy?.voice ?? '',
    language: legacy?.language ?? 'ja',
    ...stored.find((c) => c.id === YACHIYO),
    id: YACHIYO,
    name: '八千代'
  }
  return [yachiyo, ...stored.filter((c) => c.id !== YACHIYO)].map((c) => {
    const builtin = c.id === YACHIYO
    const avatar = assetUrl(c.id, 'avatar.png', avatarFile(c.id))
    const portrait = assetUrl(c.id, 'portrait.jpg', portraitFile(c.id))
    const { persona: _old, ...rest } = c
    return { ...rest, persona: readPersona(c), avatar, portrait, crop: readCrop(c.id), ...(builtin ? { builtin } : {}) }
  })
}

export const getContact = (id: string) => loadContacts().find((c) => c.id === id)

const save = (list: Contact[]) =>
  writeFileSync(file(), JSON.stringify(list.map(({ id, name, voice, language }) => ({ id, name, voice, language })), null, 2))

export function saveContact(draft: ContactDraft): Contact[] {
  const list = loadContacts()
  const before = list.find((c) => c.id === draft.id)
  if (draft.id && !before) throw new Error('这个联系人已经不在了')
  const name = before?.builtin ? before.name : draft.name.trim()
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
  if (before?.builtin && !persona) throw new Error('八千代的人设不能为空')
  writeFileSync(personaFile(id), persona)
  const next: Contact = { id, name, persona, voice: draft.voice.trim(), language: draft.language }
  save(before ? list.map((c) => (c.id === id ? next : c)) : [...list, next])
  return loadContacts()
}

/** Her picture, notes and call records go to the Trash, so a slip can be undone. */
async function deleteContact(id: string): Promise<Contact[]> {
  const list = loadContacts()
  const target = list.find((c) => c.id === id)
  if (!target || target.builtin) return list
  if (petState().contact === id) closePet()
  save(list.filter((c) => c.id !== id))
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

/**
 * The color of a contact's call: the hue most of their picture leans to, at a lightness that reads on the
 * black capsule. Near-grey and near-black pixels have no say, and a picture with no color falls back on the name.
 */
export function contactAccent(contact: Contact): string {
  const path = contactAsset(contact.id, 'avatar.png')
  const image = path ? nativeImage.createFromPath(path).resize({ width: 48, height: 48 }) : undefined
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
  const total = bins.reduce((a, b) => a + b, 0)
  if (total > 0) {
    // Three bins wide, so a color split across a bin edge still counts as one.
    const spread = (i: number) => bins[(i + 35) % 36] + bins[i] + bins[(i + 1) % 36]
    let best = 0
    for (let i = 1; i < 36; i++) if (spread(i) > spread(best)) best = i
    return hsl(best * 10 + 5, 0.62, 0.8)
  }
  const hash = [...contact.name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7)
  return hsl(hash, 0.5, 0.8)
}

/**
 * What shiori://contact/<id>/<path> may serve: the picture, library first, and the shipped pet/ files.
 * Notes and call records are never served.
 */
export function contactAsset(id: string, rel: string): string | undefined {
  if (!getContact(id)) return undefined
  if (rel !== 'avatar.png' && rel !== 'portrait.jpg' && !rel.startsWith('pet/')) return undefined
  if (rel === 'avatar.png' && existsSync(avatarFile(id))) return avatarFile(id)
  if (rel === 'portrait.jpg' && existsSync(portraitFile(id))) return portraitFile(id)
  try {
    const file = shippedFile(id, rel)
    return existsSync(file) ? file : undefined
  } catch {
    return undefined
  }
}

export function initContacts(onChange: (list: Contact[]) => void): void {
  ipcMain.handle('contacts:list', () => loadContacts())
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
