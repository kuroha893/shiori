import { dialog, ipcMain, nativeImage, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { YACHIYO, type Contact, type ContactDraft } from '../shared/contacts'
import { root } from './library'
import { YACHIYO_PERSONA } from './yachiyo'
import { closePet, petState } from './pet'
import { getSettings } from './settings'

/* Contacts live in <library>/contacts.json; each has a folder <library>/<id> for her persona.md, picture, notes and call records. */

type Stored = Pick<Contact, 'id' | 'name' | 'voice' | 'language'> & { persona?: string }

const AVATAR_SIZE = 256
const file = () => join(root(), 'contacts.json')
export const contactDir = (id: string) => join(root(), id)
const avatarFile = (id: string) => join(contactDir(id), 'avatar.png')
const personaFile = (id: string) => join(contactDir(id), 'persona.md')

function readPersona(c: Stored): string {
  const builtin = c.id === YACHIYO
  if (existsSync(personaFile(c.id))) return readFileSync(personaFile(c.id), 'utf8')
  // Personas used to be kept in contacts.json.
  if (c.persona && !builtin) {
    mkdirSync(contactDir(c.id), { recursive: true })
    writeFileSync(personaFile(c.id), c.persona)
    return c.persona
  }
  return builtin ? YACHIYO_PERSONA : ''
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
    const picture = existsSync(avatarFile(c.id))
    const builtin = c.id === YACHIYO
    const avatar = picture ? `shiori://contact/${c.id}/avatar.png?v=${statSync(avatarFile(c.id)).mtimeMs}` : builtin ? 'shiori://pet/avatar.png' : undefined
    const { persona: _old, ...rest } = c
    return { ...rest, persona: readPersona(c), avatar, ...(builtin ? { builtin, defaultPersona: YACHIYO_PERSONA } : {}) }
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
  // Yachiyo's unchanged persona isn't written out, so she keeps following what ships with the app.
  const persona = draft.persona.trim()
  if (before?.builtin && (!persona || persona === YACHIYO_PERSONA.trim())) rmSync(personaFile(id), { force: true })
  else writeFileSync(personaFile(id), persona)
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

/** A square from the middle of the chosen picture, small enough to sit in the settings as a preview. */
async function pickAvatar(): Promise<string | undefined> {
  const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
  if (r.canceled || !r.filePaths[0]) return undefined
  const image = nativeImage.createFromPath(r.filePaths[0])
  if (image.isEmpty()) throw new Error('这张图片读不出来')
  const { width, height } = image.getSize()
  const side = Math.min(width, height)
  const square = image.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side })
  return square.resize({ width: AVATAR_SIZE, height: AVATAR_SIZE, quality: 'best' }).toDataURL()
}

/** The one file of a contact's folder the app serves. */
export const contactAvatar = (id: string) => (getContact(id) ? avatarFile(id) : undefined)

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
  ipcMain.handle('contacts:pickAvatar', () => pickAvatar())
}
