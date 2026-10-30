import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Folder, PaperMeta } from '../shared/types'
import { listPapers, readMeta, root, updateMeta } from './library'

/* Research directions live in <library>/folders.json; each paper lists the ids of the ones it belongs to. */

const file = () => join(root(), 'folders.json')
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export function loadFolders(): Folder[] {
  if (!existsSync(file())) return []
  try {
    const data = JSON.parse(readFileSync(file(), 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

const save = (list: Folder[]) => writeFileSync(file(), JSON.stringify(list, null, 2))

function checkName(name: string, list: Folder[], id?: string): string {
  const clean = name.trim()
  if (!clean) throw new Error('名称不能为空')
  if (list.some((f) => same(f.name, clean) && f.id !== id)) throw new Error(`已经有「${clean}」了`)
  return clean
}

export function createFolder(name: string): Folder {
  const list = loadFolders()
  const folder = { id: randomUUID(), name: checkName(name, list) }
  save([...list, folder])
  return folder
}

export function renameFolder(id: string, name: string): void {
  const list = loadFolders()
  const clean = checkName(name, list, id)
  save(list.map((f) => (f.id === id ? { ...f, name: clean } : f)))
}

/** The papers stay in the library, without this direction. Returns the papers that changed. */
export function deleteFolder(id: string): PaperMeta[] {
  save(loadFolders().filter((f) => f.id !== id))
  const changed: PaperMeta[] = []
  for (const p of listPapers()) {
    if (!p.folders?.includes(id)) continue
    const next = updateMeta(p.id, { folders: p.folders.filter((f) => f !== id) })
    if (next) changed.push(next)
  }
  return changed
}

export function findFolder(name: string): Folder | undefined {
  return loadFolders().find((f) => same(f.name, name))
}

/** File the paper where the suggestion says, creating the direction if it is a new one. */
export function acceptSuggestion(id: string): PaperMeta | undefined {
  const meta = readMeta(id)
  const s = meta?.suggestion
  if (!meta || !s) return meta
  const folder = loadFolders().find((f) => f.id === s.folderId) ?? findFolder(s.name) ?? createFolder(s.name)
  return updateMeta(id, { folders: [...new Set([...(meta.folders ?? []), folder.id])], suggestion: undefined })
}
