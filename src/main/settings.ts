import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Settings } from '../shared/types'

const defaults: Settings = {
  libraryPath: join(homedir(), 'Documents', 'Shiori'),
  processModel: 'opus',
  chatModel: 'opus',
  theme: 'system',
  readingFont: 'serif',
  uiFont: 'Geist Variable',
  monoFont: 'Geist Mono Variable',
  fontSize: 18,
  lineHeight: 1.85,
  view: 'zh'
}

const file = () => join(app.getPath('userData'), 'settings.json')

let cache: Settings | undefined

export function getSettings(): Settings {
  if (!cache) {
    try {
      cache = { ...defaults, ...JSON.parse(readFileSync(file(), 'utf8')) }
    } catch {
      cache = { ...defaults }
    }
  }
  return cache!
}

export function saveSettings(patch: Partial<Settings>): Settings {
  cache = { ...getSettings(), ...patch }
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(cache, null, 2))
  return cache
}
