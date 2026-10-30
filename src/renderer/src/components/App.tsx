import { useCallback, useEffect, useState } from 'react'
import type { ClaudeStatus, PaperMeta, Settings } from '../../../shared/types'
import { api } from '../api'
import { Library } from './Library'
import { Reader } from './Reader'
import { SettingsModal } from './SettingsModal'

export type Toast = (text: string) => void

function applyTheme(theme: Settings['theme']): void {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.dataset.theme = theme === 'system' ? (dark ? 'dark' : 'light') : theme
}

export function App() {
  const [settings, setSettings] = useState<Settings>()
  const [papers, setPapers] = useState<PaperMeta[]>([])
  const [open, setOpen] = useState<string>()
  const [showSettings, setShowSettings] = useState(false)
  const [claude, setClaude] = useState<ClaudeStatus>()
  const [toast, setToast] = useState<string>()

  const refreshClaude = useCallback(() => api.claudeStatus().then(setClaude), [])

  useEffect(() => {
    api.getSettings().then(setSettings)
    api.listPapers().then(setPapers)
    refreshClaude()
    const offChanged = api.onPaperChanged((m) =>
      setPapers((list) => (list.some((p) => p.id === m.id) ? list.map((p) => (p.id === m.id ? m : p)) : [m, ...list]))
    )
    const offRemoved = api.onPaperRemoved((id) => setPapers((list) => list.filter((p) => p.id !== id)))
    // Coming back to the app after signing in in Terminal.
    window.addEventListener('focus', refreshClaude)
    return () => {
      offChanged()
      offRemoved()
      window.removeEventListener('focus', refreshClaude)
    }
  }, [refreshClaude])

  useEffect(() => {
    if (!settings) return
    applyTheme(settings.theme)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const h = () => applyTheme(settings.theme)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [settings?.theme])

  const showToast: Toast = useCallback((text) => {
    setToast(text)
    window.clearTimeout((showToast as any).t)
    ;(showToast as any).t = window.setTimeout(() => setToast(undefined), 2600)
  }, [])

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s))
    setSettings(await api.setSettings(patch))
  }, [])

  if (!settings) return null
  const paper = papers.find((p) => p.id === open)

  return (
    <>
      {paper ? (
        <Reader
          key={paper.id}
          paper={paper}
          settings={settings}
          claude={claude}
          onSettings={updateSettings}
          onClose={() => setOpen(undefined)}
          onOpenSettings={() => setShowSettings(true)}
          toast={showToast}
        />
      ) : (
        <Library
          papers={papers}
          settings={settings}
          claude={claude}
          onOpen={setOpen}
          onSettings={updateSettings}
          onOpenSettings={() => setShowSettings(true)}
          toast={showToast}
        />
      )}
      {showSettings && (
        <SettingsModal
          settings={settings}
          claude={claude}
          onChange={updateSettings}
          onLibraryChosen={(s) => {
            setSettings(s)
            api.listPapers().then(setPapers)
          }}
          refreshClaude={refreshClaude}
          onClose={() => setShowSettings(false)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
