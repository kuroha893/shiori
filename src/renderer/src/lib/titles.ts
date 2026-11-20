import { useSyncExternalStore } from 'react'

/**
 * Which title a paper shows by, as the owner chose in Settings (论文标题): the translation or the paper's own. Every
 * place that shows a paper's title asks here, so the choice reaches them all; where two titles show, the other one
 * goes small beneath.
 */

export type TitleLang = 'zh' | 'en'

let lang: TitleLang = 'zh'
const listeners = new Set<() => void>()

export function setTitleLang(next: TitleLang | undefined): void {
  const l = next ?? 'zh'
  if (l === lang) return
  lang = l
  listeners.forEach((f) => f())
}

export function useTitleLang(): TitleLang {
  return useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => lang
  )
}

export interface Titles {
  /** the title to show */
  main: string
  /** whether that one is the Chinese translation */
  zh: boolean
  /** the other title, when there is one, for places that show it small beneath */
  other?: string
  otherZh: boolean
}

export function titlesOf(p: { title: string; titleZh?: string }, l: TitleLang = lang): Titles {
  if (!p.titleZh) return { main: p.title, zh: false, otherZh: false }
  return l === 'en' ? { main: p.title, zh: false, other: p.titleZh, otherZh: true } : { main: p.titleZh, zh: true, other: p.title, otherZh: false }
}

/** A paper's titles, kept up with the owner's choice. */
export function useTitles(p: { title: string; titleZh?: string }): Titles {
  return titlesOf(p, useTitleLang())
}
