// The people you can call. Each has a folder of her own in the library, named by id, for her notes and call records.

export interface Contact {
  id: string
  name: string
  avatar: string
  /** Has a character that can stand on the desktop during a call */
  pet?: boolean
}

export interface ContactSettings {
  /** Fish Audio voice id */
  voice: string
  language: 'ja' | 'zh'
}

export const CONTACTS: Contact[] = [{ id: 'yachiyo', name: '八千代', avatar: 'shiori://pet/avatar.png', pet: true }]

export const contactSettings = (s: { contacts: Record<string, ContactSettings | undefined> }, id: string): ContactSettings => ({
  voice: '',
  language: 'ja',
  ...s.contacts[id]
})
