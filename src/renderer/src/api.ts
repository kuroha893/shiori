import type { Api } from '../../preload'

declare global {
  interface Window {
    api: Api
  }
}

export const api = window.api

export const fileUrl = (id: string, rel: string) =>
  `shiori://paper/${encodeURIComponent(id)}/${rel.split('/').map(encodeURIComponent).join('/')}`
