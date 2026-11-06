import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ConfPaper, Conference, Edition, Follow, LaterItem, Theme } from '../../shared/conferences'
import { normTitle } from '../../shared/conferences'
import { TIDY_VERSION } from '../../shared/tex'
import { root } from '../library'

/*
 * <library>/conferences/
 *   conferences.json, follows.json, later.json
 *   <conf>/<year>/edition.json, papers.json, themes.json
 *   <conf>/<year>/channels/<id>.js (a script) or <id>.json (papers written down once), out/<id>.json (last run)
 */

export const confRoot = () => join(root(), 'conferences')
export const confDir = (conf: string) => join(confRoot(), conf)
export const editionDir = (conf: string, year: number) => join(confDir(conf), String(year))

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Through a temporary file, so quitting halfway never leaves half a list. */
function writeJson(file: string, data: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file + '.tmp', JSON.stringify(data, null, 1))
  renameSync(file + '.tmp', file)
}

/* ---------- conferences ---------- */

export const DEFAULT_CONFERENCES: [string, string][] = [
  ['icml', 'ICML'],
  ['neurips', 'NeurIPS'],
  ['iclr', 'ICLR'],
  ['acl', 'ACL'],
  ['emnlp', 'EMNLP']
]

const confFile = () => join(confRoot(), 'conferences.json')

/** Undefined until the owner first opens 会议; then the defaults are written once. */
export function loadConferences(): Conference[] | undefined {
  return existsSync(confFile()) ? readJson<Conference[]>(confFile(), []) : undefined
}

export const saveConferences = (list: Conference[]) => writeJson(confFile(), list)

export function updateConference(id: string, patch: Partial<Conference>): Conference | undefined {
  const list = loadConferences() ?? []
  const i = list.findIndex((c) => c.id === id)
  if (i < 0) return undefined
  list[i] = { ...list[i], ...patch }
  saveConferences(list)
  return list[i]
}

export const confId = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'conf'

/* ---------- editions ---------- */

export function listEditions(conf: string): Edition[] {
  const dir = confDir(conf)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((y) => /^\d{4}$/.test(y))
    .map((y) => readEdition(conf, +y))
    .filter((e): e is Edition => !!e)
    .sort((a, b) => b.year - a.year)
}

export function readEdition(conf: string, year: number): Edition | undefined {
  const e = readJson<Edition | undefined>(join(editionDir(conf, year), 'edition.json'), undefined)
  return e && { ...e, channels: e.channels ?? [] }
}

export const writeEdition = (e: Edition) => writeJson(join(editionDir(e.conf, e.year), 'edition.json'), e)

export function updateEdition(conf: string, year: number, patch: Partial<Edition> | ((e: Edition) => Partial<Edition>)): Edition | undefined {
  const e = readEdition(conf, year)
  if (!e) return undefined
  const next = { ...e, ...(typeof patch === 'function' ? patch(e) : patch) }
  writeEdition(next)
  return next
}

/** Keeps the last 40 things that happened to an edition, for its page. */
export function logEdition(conf: string, year: number, text: string): void {
  updateEdition(conf, year, (e) => ({ log: [...(e.log ?? []), { at: new Date().toISOString(), text }].slice(-40) }))
}

export function createEdition(conf: string, name: string, year: number, patch: Partial<Edition> = {}): Edition {
  const existing = readEdition(conf, year)
  if (existing) return existing
  const e: Edition = { conf, year, name: `${name} ${year}`, channels: [], createdAt: new Date().toISOString(), tidied: TIDY_VERSION, ...patch }
  mkdirSync(join(editionDir(conf, year), 'channels'), { recursive: true })
  writeEdition(e)
  return e
}

/* ---------- papers ---------- */

/** Kept in memory by file, so another library never sees this one's papers. */
const papersCache = new Map<string, ConfPaper[]>()
const papersFile = (conf: string, year: number) => join(editionDir(conf, year), 'papers.json')

export function loadPapers(conf: string, year: number): ConfPaper[] {
  const file = papersFile(conf, year)
  let list = papersCache.get(file)
  if (!list) {
    list = readJson<ConfPaper[]>(file, [])
    papersCache.set(file, list)
  }
  return list
}

export function savePapers(conf: string, year: number, list: ConfPaper[]): void {
  papersCache.set(papersFile(conf, year), list)
  writeJson(papersFile(conf, year), list)
}

export const forgetEdition = (conf: string, year: number) => papersCache.delete(papersFile(conf, year))

/** From the title without its tags, so a script that starts keeping <i> or <b> doesn't make its papers new. */
export const paperKey = (title: string) => createHash('sha1').update(normTitle(title.replace(/<[^<>]*>/g, ''))).digest('hex').slice(0, 12)

export function loadThemes(conf: string, year: number): Theme[] {
  return readJson<Theme[]>(join(editionDir(conf, year), 'themes.json'), [])
}

export const saveThemes = (conf: string, year: number, themes: Theme[]) => writeJson(join(editionDir(conf, year), 'themes.json'), themes)

/* ---------- the owner's directions and 稍后再看 ---------- */

const followsFile = () => join(confRoot(), 'follows.json')
export const loadFollows = () => readJson<Follow[]>(followsFile(), [])
export const saveFollows = (list: Follow[]) => writeJson(followsFile(), list)

const laterFile = () => join(confRoot(), 'later.json')
export const loadLater = () => readJson<LaterItem[]>(laterFile(), [])
export const saveLater = (list: LaterItem[]) => writeJson(laterFile(), list)
