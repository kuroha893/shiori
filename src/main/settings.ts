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
  panelWidth: 400,
  panelFontSize: 13.5,
  callModel: 'opus',
  callMood: 'normal',
  petShown: false,
  fishKey: '',
  fishModel: 's2.1-pro',
  view: 'zh'
}

const file = () => join(app.getPath('userData'), 'settings.json')

let cache: Settings | undefined

export function getSettings(): Settings {
  if (!cache) {
    try {
      const { fishVoice, callLanguage, ...saved } = JSON.parse(readFileSync(file(), 'utf8'))
      cache = { ...defaults, ...saved }
      // Voice and language used to be one setting, from before there could be several contacts.
      if (fishVoice !== undefined && !cache!.contacts?.yachiyo) {
        cache!.contacts = { ...cache!.contacts, yachiyo: { voice: fishVoice, language: callLanguage ?? 'ja' } }
      }
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
