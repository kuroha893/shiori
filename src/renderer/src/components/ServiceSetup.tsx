import { useEffect, useState, type ReactNode } from 'react'
import type { ServiceStatus } from '../../../shared/models'
import { api } from '../api'
import { Icon } from './Icon'

// The pieces for connecting a service, shared by Settings and the welcome page.

export const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'
export const CHATGPT_DOWNLOAD = 'https://chatgpt.com/download'
export const FISH_SIGNUP = 'https://fish.audio/auth/signup'
export const FISH_KEYS = 'https://fish.audio/app/api-keys'

export function Copyable({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="cmd">
      <code>{text}</code>
      <button
        className="icon-btn"
        title="复制"
        onClick={() => {
          navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        }}
      >
        <Icon name={done ? 'check' : 'copy'} size={14} />
      </button>
    </div>
  )
}

export const Pill = ({ ok, children }: { ok?: boolean; children: ReactNode }) => (
  <span className={`pill ${ok ? 'ok' : 'need'}`}>
    <span className="dot" />
    {children}
  </span>
)

export const Waiting = ({ children }: { children: ReactNode }) => (
  <span className="waiting">
    <span className="dot" />
    {children}
  </span>
)

/** Numbered steps on a thin line; each is a title, maybe with a button at its end, and maybe something under it. */
export function Steps({ steps }: { steps: { title: ReactNode; action?: ReactNode; body?: ReactNode }[] }) {
  return (
    <ol className="steps">
      {steps.map((s, i) => (
        <li className="step" key={i}>
          <span className="step-num">{i + 1}</span>
          <div className="step-body">
            <div className="step-title">
              {s.title}
              {s.action && (
                <>
                  <span className="spacer" />
                  {s.action}
                </>
              )}
            </div>
            {s.body}
          </div>
        </li>
      ))}
    </ol>
  )
}

/** Installing Claude Code from Terminal, ending with whatever comes after it. */
export const installClaudeCode = (last: { title: ReactNode; body?: ReactNode }) => [
  {
    title: '打开「终端」',
    action: (
      <button className="btn sm" onClick={() => api.openTerminal()}>
        <Icon name="terminal" size={13} />
        打开终端
      </button>
    )
  },
  { title: '粘贴这行命令，回车', body: <Copyable text={CLAUDE_INSTALL} /> },
  last
]

export const LinkButton = ({ url, children }: { url: string; children: ReactNode }) => (
  <button className="btn sm" onClick={() => api.openExternal(url)}>
    <Icon name="external" size={13} />
    {children}
  </button>
)

/** A key typed in and checked by its service before it is kept; save answers with an error, or nothing when it took. */
export function KeyInput({ placeholder, save, onCancel }: { placeholder: string; save: (key: string) => Promise<string | undefined>; onCancel?: () => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async () => {
    if (!key.trim() || busy) return
    setBusy(true)
    setError(undefined)
    const problem = await save(key.trim())
    setBusy(false)
    if (problem) setError(problem)
  }
  return (
    <>
      <div className="svc-key">
        <input
          className="input"
          type="password"
          spellCheck={false}
          autoFocus={!!onCancel}
          placeholder={placeholder}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button className="btn primary" disabled={busy || !key.trim()} onClick={submit}>
          {busy ? '检查中' : '保存'}
        </button>
        {onCancel && (
          <button className="btn ghost" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
      {error && <p className="svc-error">{error}</p>}
    </>
  )
}

/** A DeepSeek key, handing back the services as they are once it is kept. */
export const saveDeepseekKey = (onStatus: (s: ServiceStatus) => void) => async (key: string) => {
  const r = await api.setDeepseekKey(key)
  if (!r.error) onStatus(r.status)
  return r.error
}

/** While something is being installed or signed into elsewhere, keep looking, so the page updates by itself. */
export function useServicePolling(services: ServiceStatus | undefined, refresh: (fresh?: boolean) => void): void {
  const waiting = !!services && (services.claude.state !== 'ready' || services.openai.state === 'signedOut')
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => refresh(true), 3000)
    return () => clearInterval(t)
  }, [waiting, refresh])
}
