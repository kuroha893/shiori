import { useEffect, useState } from 'react'
import type { Settings } from '../../../shared/types'
import { pickModel, type ModelOption, type ModelUse, type ServiceStatus } from '../../../shared/models'
import { api } from '../api'
import { Icon } from './Icon'
import { Modal, themeOptions } from './Chrome'
import { ContactsList } from './ContactsList'
import { GlossaryList } from './GlossaryList'
import { FontPicker } from './FontPicker'
import { ModelPicker } from './ModelPicker'

const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'
const CHATGPT_DOWNLOAD = 'https://chatgpt.com/download'

function Copyable({ text }: { text: string }) {
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

const Pill = ({ ok, children }: { ok?: boolean; children: React.ReactNode }) => (
  <span className={`pill ${ok ? 'ok' : 'need'}`}>
    <span className="dot" />
    {children}
  </span>
)

/** Claude and DeepSeek both run in Claude Code, so it unfolds under the Claude row until it is installed. */
function InstallClaudeCode() {
  return (
    <div className="svc-more">
      <p className="svc-lead">Claude 和 DeepSeek 都通过 Claude Code 运行，装一次就好。</p>
      <ol className="steps">
        <li className="step">
          <span className="step-num">1</span>
          <div className="step-body">
            <div className="step-title">
              打开「终端」
              <span className="spacer" />
              <button className="btn sm" onClick={() => api.openTerminal()}>
                <Icon name="terminal" size={13} />
                打开终端
              </button>
            </div>
          </div>
        </li>
        <li className="step">
          <span className="step-num">2</span>
          <div className="step-body">
            <div className="step-title">粘贴这行命令，回车</div>
            <Copyable text={INSTALL} />
          </div>
        </li>
        <li className="step">
          <span className="step-num">3</span>
          <div className="step-body">
            <div className="step-title">
              <span className="waiting">
                <span className="dot" />
                装好后这里会自动检测到
              </span>
            </div>
          </div>
        </li>
      </ol>
    </div>
  )
}

function DeepseekKey({ onDone }: { onDone: (status?: ServiceStatus) => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const save = async () => {
    setBusy(true)
    setError(undefined)
    const r = await api.setDeepseekKey(key)
    setBusy(false)
    if (r.error) setError(r.error)
    else onDone(r.status)
  }
  return (
    <div className="svc-more">
      <div className="svc-key">
        <input
          className="input"
          type="password"
          spellCheck={false}
          autoFocus
          placeholder="sk-…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && save()}
        />
        <button className="btn primary" disabled={busy} onClick={save}>
          {busy ? '检查中' : '保存'}
        </button>
        <button className="btn ghost" onClick={() => onDone()}>
          取消
        </button>
      </div>
      {error && <p className="svc-error">{error}</p>}
    </div>
  )
}

function Services({ services, onStatus }: { services?: ServiceStatus; onStatus: (s: ServiceStatus) => void }) {
  const [editingKey, setEditingKey] = useState(false)
  if (!services) return <div className="svc"><div className="svc-row faint">检查中…</div></div>
  const { claude, openai, deepseek } = services
  return (
    <div className="svc">
      <div className="svc-row">
        <span className="svc-name">Claude</span>
        <span className="svc-kind faint">订阅</span>
        <span className="spacer" />
        {claude.state === 'ready' ? (
          <Pill ok>已连接</Pill>
        ) : claude.state === 'signedOut' ? (
          <>
            <Pill>未登录</Pill>
            <button className="btn sm" onClick={() => api.serviceLogin('claude')}>
              登录
            </button>
          </>
        ) : (
          <Pill>未安装 Claude Code</Pill>
        )}
      </div>
      {claude.state === 'missing' && <InstallClaudeCode />}
      <div className="svc-row">
        <span className="svc-name">ChatGPT</span>
        <span className="svc-kind faint">订阅</span>
        <span className="spacer" />
        {openai.state === 'ready' ? (
          <Pill ok>已连接{openai.via === 'desktop' ? ' · ChatGPT 桌面版' : ''}</Pill>
        ) : openai.state === 'signedOut' ? (
          <>
            <Pill>未登录</Pill>
            <button className="btn sm" onClick={() => api.serviceLogin('openai')}>
              登录
            </button>
          </>
        ) : (
          <>
            <Pill>未安装</Pill>
            <button className="btn sm" onClick={() => api.openExternal(CHATGPT_DOWNLOAD)}>
              下载 ChatGPT 桌面版
            </button>
          </>
        )}
      </div>
      <div className="svc-row">
        <span className="svc-name">DeepSeek</span>
        <span className="svc-kind faint">API</span>
        <span className="spacer" />
        {deepseek.state === 'ready' ? <Pill ok>已连接</Pill> : deepseek.state === 'needsClaudeCode' ? <Pill>需要 Claude Code</Pill> : null}
        {!editingKey && (
          <button className="btn sm" onClick={() => setEditingKey(true)}>
            {deepseek.state === 'noKey' ? '填写 key' : '更换 key'}
          </button>
        )}
      </div>
      {editingKey && (
        <DeepseekKey
          onDone={(status) => {
            setEditingKey(false)
            if (status) onStatus(status)
          }}
        />
      )}
    </div>
  )
}

export function SettingsModal(props: {
  settings: Settings
  services?: ServiceStatus
  onChange: (patch: Partial<Settings>) => void
  onLibraryChosen: (s: Settings) => void
  refreshServices: (fresh?: boolean) => void
  onServices: (s: ServiceStatus) => void
  onClose: () => void
  toast: (text: string) => void
}) {
  const { settings: s, services, refreshServices } = props
  const models: ModelOption[] = services?.models ?? []

  // While something is being installed or signed into elsewhere, keep looking so the row updates by itself.
  const waiting = !!services && (services.claude.state !== 'ready' || services.openai.state === 'signedOut')
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => refreshServices(true), 3000)
    return () => clearInterval(t)
  }, [waiting, refreshServices])

  const picker = (label: string, key: 'processModel' | 'chatModel' | 'callModel', use: ModelUse, hint?: string) => (
    <div className="set-row">
      <label>{label}</label>
      <ModelPicker value={pickModel(s[key], models, use)} options={models.filter((m) => use !== 'process' || m.process)} onChange={(v) => props.onChange({ [key]: v })} />
      {hint && (
        <span className="faint" style={{ fontSize: 12 }}>
          {hint}
        </span>
      )}
    </div>
  )

  return (
    <Modal title="设置" onClose={props.onClose}>
      <section className="set-section">
        <h3>模型选择</h3>
        <div className="set-rows">
          <Services services={services} onStatus={props.onServices} />
          {picker('处理论文', 'processModel', 'process', '转写、翻译和导读，最耗额度')}
          {picker('问答默认', 'chatModel', 'chat')}
          {picker('通话模型', 'callModel', 'call')}
        </div>
      </section>

      <section className="set-section">
        <h3>
          书库
          <small>每篇论文一个文件夹：原 PDF、转写稿、图表、批注、对话，全是普通文件。</small>
        </h3>
        <div className="set-rows">
          <div className="set-row">
            <div className="path" title={s.libraryPath}>
              {s.libraryPath}
            </div>
            <button className="btn sm" onClick={async () => props.onLibraryChosen(await api.chooseLibrary())}>
              更改
            </button>
          </div>
        </div>
      </section>

      <section className="set-section">
        <h3>
          阅读
          <small>阅读页右上角的 Aa 也能随时调。</small>
        </h3>
        <div className="set-rows">
          <div className="set-row">
            <label>主题</label>
            <div className="seg">
              {themeOptions.map((t) => (
                <button key={t.id} className={s.theme === t.id ? 'on' : ''} onClick={() => props.onChange({ theme: t.id })}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="set-row">
            <label>正文字体</label>
            <div className="seg">
              <button className={s.readingFont === 'serif' ? 'on' : ''} onClick={() => props.onChange({ readingFont: 'serif' })}>
                宋体 · Charter
              </button>
              <button className={s.readingFont === 'sans' ? 'on' : ''} onClick={() => props.onChange({ readingFont: 'sans' })}>
                苹方 · 界面字体
              </button>
            </div>
          </div>
          <div className="set-row">
            <label>界面字体</label>
            <FontPicker kind="ui" value={s.uiFont} onChange={(uiFont) => props.onChange({ uiFont })} />
            <span className="faint" style={{ fontSize: 12 }}>标题、按钮和英文界面</span>
          </div>
          <div className="set-row">
            <label>等宽字体</label>
            <FontPicker kind="mono" value={s.monoFont} onChange={(monoFont) => props.onChange({ monoFont })} />
            <span className="faint" style={{ fontSize: 12 }}>日期、编号</span>
          </div>
        </div>
      </section>

      <section className="set-section">
        <h3>
          联系人
          <small>点右下角的绿圈，选一个人通话。你打字，对方说话并配字幕。没填音色时只有字幕。</small>
        </h3>
        <ContactsList petShown={s.petShown} onPetShown={(petShown) => props.onChange({ petShown })} toast={props.toast} />
      </section>

      <section className="set-section">
        <h3>声音</h3>
        <div className="set-rows">
          <div className="set-row">
            <label>Fish Audio 密钥</label>
            <input className="input" type="password" spellCheck={false} value={s.fishKey} onChange={(e) => props.onChange({ fishKey: e.target.value.trim() })} />
          </div>
          <div className="set-row">
            <label>声音模型</label>
            <div className="seg">
              {['s2.1-pro', 's2.1-pro-free', 'drama-3'].map((m) => (
                <button key={m} className={s.fishModel === m ? 'on' : ''} onClick={() => props.onChange({ fishModel: m })}>
                  {m}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="set-section">
        <h3>
          术语表
          <small>所有论文共用的译法。改了之后，新处理的论文和问答都会照新的来。</small>
        </h3>
        <GlossaryList />
      </section>
    </Modal>
  )
}
