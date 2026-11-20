import { useCallback, useEffect, useState } from 'react'
import type { PaperMeta, Settings } from '../../../shared/types'
import type { ServiceStatus } from '../../../shared/models'
import { api } from '../api'
import { Library, type Space } from './Library'
import { useWallpaper } from './Room'
import { Reader } from './Reader'
import { SettingsModal } from './SettingsModal'
import { Welcome } from './Welcome'
import { applyFonts } from '../lib/fonts'
import { startGlass } from '../lib/glass'
import { setTitleLang } from '../lib/titles'

/** A short note at the bottom; with `until`, it stays until that settles instead of fading. */
export type Toast = (text: string, until?: Promise<unknown>) => void

function applyTheme(theme: Settings['theme']): void {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.dataset.theme = theme === 'system' ? (dark ? 'dark' : 'light') : theme
}

/** 大厅's wallpaper behind the other pages, when the owner wants it there: blurred, under a veil of the theme's colour. */
function Backdrop({ settings, reading, inRoom }: { settings: Settings; reading: boolean; inRoom: boolean }) {
  const url = useWallpaper()
  const shown = settings.wallpaperIn
  const on = !!url && (reading ? shown.includes('reading') : !inRoom && shown.includes('pages'))
  const blur = reading ? settings.readingBlur : settings.wallpaperBlur
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('walled', on)
    root.classList.toggle('walled-reading', on && reading)
    root.classList.toggle('walled-sheet', on && reading && settings.readingWall === 'sheet')
    return () => root.classList.remove('walled', 'walled-reading', 'walled-sheet')
  }, [on, reading, settings.readingWall])
  useEffect(() => (on ? startGlass() : undefined), [on])
  if (!on) return null
  return (
    <>
      <div className="app-wall" data-ink-layer="" style={{ backgroundImage: `url("${url}")`, filter: blur ? `blur(${blur}px)` : undefined }} />
      <div className="app-veil" data-ink-layer="" />
    </>
  )
}

export function App() {
  const [settings, setSettings] = useState<Settings>()
  useEffect(() => setTitleLang(settings?.paperTitle), [settings?.paperTitle])
  const [papers, setPapers] = useState<PaperMeta[]>([])
  const [open, setOpen] = useState<string>()
  const [showSettings, setShowSettings] = useState(false)
  const [services, setServices] = useState<ServiceStatus>()
  const [toast, setToast] = useState<string>()
  // Shiori opens on 大厅; closing a paper goes back to the space it was opened from.
  const [space, setSpace] = useState<Space>('room')

  const refreshServices = useCallback((fresh?: boolean) => api.serviceStatus(fresh).then(setServices), [])

  useEffect(() => {
    api.getSettings().then(setSettings)
    api.listPapers().then(setPapers)
    refreshServices()
    const offChanged = api.onPaperChanged((m) =>
      setPapers((list) => (list.some((p) => p.id === m.id) ? list.map((p) => (p.id === m.id ? m : p)) : [m, ...list]))
    )
    const offRemoved = api.onPaperRemoved((id) => setPapers((list) => list.filter((p) => p.id !== id)))
    // Coming back to the app after installing or signing in elsewhere.
    const refocus = () => refreshServices(true)
    window.addEventListener('focus', refocus)
    return () => {
      offChanged()
      offRemoved()
      window.removeEventListener('focus', refocus)
    }
  }, [refreshServices])

  useEffect(() => {
    if (!settings) return
    applyTheme(settings.theme)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const h = () => applyTheme(settings.theme)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [settings?.theme])

  useEffect(() => {
    if (settings) applyFonts(settings.uiFont, settings.monoFont)
  }, [settings?.uiFont, settings?.monoFont])

  const showToast: Toast = useCallback((text, until) => {
    setToast(text)
    window.clearTimeout((showToast as any).t)
    if (!until) (showToast as any).t = window.setTimeout(() => setToast(undefined), 2600)
    else {
      const hide = () => setToast((t) => (t === text ? undefined : t))
      until.then(hide, hide)
    }
  }, [])

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s))
    setSettings(await api.setSettings(patch))
  }, [])

  if (!settings) return null
  const paper = papers.find((p) => p.id === open)

  if (!settings.welcomed)
    return (
      <Welcome
        settings={settings}
        services={services}
        refreshServices={refreshServices}
        onServices={setServices}
        onSettings={setSettings}
        onLibraryChosen={(s) => {
          setSettings(s)
          api.listPapers().then(setPapers)
        }}
        onDone={() => updateSettings({ welcomed: true })}
      />
    )

  return (
    <>
      <Backdrop settings={settings} reading={!!paper} inRoom={space === 'room'} />
      {paper ? (
        <Reader
          key={paper.id}
          paper={paper}
          papers={papers}
          settings={settings}
          services={services}
          onSettings={updateSettings}
          onClose={() => setOpen(undefined)}
          onOpenSettings={() => setShowSettings(true)}
          toast={showToast}
        />
      ) : (
        <Library
          papers={papers}
          settings={settings}
          services={services}
          onOpen={setOpen}
          onSettings={updateSettings}
          onOpenSettings={() => setShowSettings(true)}
          toast={showToast}
          space={space}
          onSpace={setSpace}
        />
      )}
      {showSettings && (
        <SettingsModal
          settings={settings}
          services={services}
          onChange={updateSettings}
          onLibraryChosen={(s) => {
            setSettings(s)
            api.listPapers().then(setPapers)
          }}
          refreshServices={refreshServices}
          onServices={setServices}
          onClose={() => setShowSettings(false)}
          toast={showToast}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
