// The people you can call. Yachiyo ships with the app; the rest are added by the owner.

export const YACHIYO = 'yachiyo'

export type CallLanguage = 'ja' | 'zh'

/** A square on the portrait: x and size as fractions of its width, y of its height. */
export interface AvatarCrop {
  x: number
  y: number
  size: number
}

export interface Contact {
  id: string
  name: string
  /** Image URL; without one the first letter of the name stands in */
  avatar?: string
  /** Image URL of the full picture behind the call screen */
  portrait?: string
  /** Where on the portrait the avatar was cut from */
  crop?: AvatarCrop
  /** Who they are and how they talk: the text of <library>/<id>/persona.md */
  persona: string
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
  portrait?: string | null
  crop?: AvatarCrop
}
