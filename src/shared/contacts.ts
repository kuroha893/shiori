// The people you can call. Shiori, Yachiyo and Aemeath come with the app; from then on every contact is the owner's own.

export const SHIORI = 'shiori'
export const YACHIYO = 'yachiyo'
export const AEMEATH = 'aemeath'

/** The contacts that come with the app, in the order a library receives them; `formerly` are the names they once shipped under. */
export const BUILTIN = [
  { id: SHIORI, name: '叶山 诗织', romaji: 'Hayama Shiori', formerly: ['詩織'] },
  { id: YACHIYO, name: '月见 八千代', romaji: 'Runami Yachiyo', formerly: ['八千代'] },
  { id: AEMEATH, name: '爱弥斯', romaji: 'Aemeath', formerly: [] as string[] }
]

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
  /** How the name is read, in Latin letters; filled in by the model when left empty */
  romaji?: string
  /** The hue of the ring around their picture: the picture's own, or one from the name */
  hue?: number
  /** How many calls they have had, and whether they keep notes about the owner */
  calls?: number
  remembers?: boolean
}

export interface ContactDraft {
  id?: string
  name: string
  romaji?: string
  persona: string
  voice: string
  language: CallLanguage
  /** A new picture as a data URL, or null to remove the one there is; left out to keep it */
  avatar?: string | null
  portrait?: string | null
  crop?: AvatarCrop
}
