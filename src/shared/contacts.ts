// The people you can call. Yachiyo ships with the app; the rest are added by the owner.

export const YACHIYO = 'yachiyo'

export type CallLanguage = 'ja' | 'zh'

export interface Contact {
  id: string
  name: string
  /** Image URL; without one the first letter of the name stands in */
  avatar?: string
  /** Who they are and how they talk: the text of <library>/<id>/persona.md */
  persona: string
  /** What the persona goes back to on restoring it; only Yachiyo's ships with the app */
  defaultPersona?: string
  /** Fish Audio voice id */
  voice: string
  language: CallLanguage
  builtin?: boolean
}

export interface ContactDraft {
  id?: string
  name: string
  persona: string
  voice: string
  language: CallLanguage
  /** A new picture as a data URL, or null to remove the one there is; left out to keep it */
  avatar?: string | null
}
