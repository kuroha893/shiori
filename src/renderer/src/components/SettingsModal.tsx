import { useEffect, useState } from 'react'
import type { OpenReviewAccount, Settings } from '../../../shared/types'
import { pickModel, type ModelOption, type ModelUse, type ServiceStatus } from '../../../shared/models'
import { api } from '../api'
import { Modal, themeOptions } from './Chrome'
import { ContactsList } from './ContactsList'
import { GlossaryList } from './GlossaryList'
import { FontPicker } from './FontPicker'
import { ModelPicker } from './ModelPicker'
import { CHATGPT_DOWNLOAD, installClaudeCode, KeyInput, Pill, saveDeepseekKey, Steps, useServicePolling, Waiting } from './ServiceSetup'

/** The OpenReview account conference papers download through: signing in happens on OpenReview's own page. */
function OpenReviewRow() {
  const [account, setAccount] = useState<OpenReviewAccount | null>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const load = () => api.openReviewAccount().then((a) => setAccount(a ?? null))
    load()
    return api.onOpenReviewChanged(load)
  }, [])
  const signIn = async () => {
    setBusy(true)
    try {
      await api.openReviewSignIn()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="set-row">
      <label>OpenReview</label>
      {account ? (
        <>
          <div className="path" title={account.name}>
            {account.name}
          </div>
          <button className="btn sm" onClick={() => api.openReviewSignOut()}>
            退出
          </button>
        </>
      ) : (
        <>
          <span className="spacer" />
          <button className="btn sm" disabled={busy || account === undefined} onClick={signIn}>
            登录
          </button>
        </>
      )}
    </div>
  )
}

/** Claude and DeepSeek both run in Claude Code, so it unfolds under the Claude row until it is installed. */
const InstallClaudeCode = () => (
  <div className="svc-more">
    <Steps steps={installClaudeCode({ title: <Waiting>装好后这里会自动检测到</Waiting> })} />
  </div>
)

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
        <div className="svc-more">
          <KeyInput
            placeholder="sk-…"
            save={saveDeepseekKey((status) => {
              setEditingKey(false)
              onStatus(status)
            })}
            onCancel={() => setEditingKey(false)}
          />
        </div>
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

  useServicePolling(services, refreshServices)

  const picker = (label: string, use: ModelUse) => (
    <div className="set-row">
      <label>{label}</label>
      <ModelPicker
        value={pickModel(s[`${use}Model`], models, use)}
        options={models.filter((m) => use !== 'process' || m.process)}
        onChange={(v) => props.onChange({ [`${use}Model`]: v })}
        effort={s[`${use}Effort`]}
        onEffort={(v) => props.onChange({ [`${use}Effort`]: v })}
      />
    </div>
  )

  return (
    <Modal title="设置" onClose={props.onClose}>
      <section className="set-section">
        <h3>模型选择</h3>
        <div className="set-rows">
          <Services services={services} onStatus={props.onServices} />
          {picker('处理论文', 'process')}
          {picker('问答默认', 'chat')}
          {picker('通话模型', 'call')}
        </div>
      </section>

      <section className="set-section">
        <h3>书库</h3>
        <div className="set-rows">
          <div className="set-row">
            <div className="path" title={s.libraryPath}>
              {s.libraryPath}
            </div>
            <button className="btn sm" onClick={async () => props.onLibraryChosen(await api.chooseLibrary())}>
              更改
            </button>
          </div>
          <OpenReviewRow />
        </div>
      </section>

      <section className="set-section">
        <h3>阅读</h3>
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
          </div>
          <div className="set-row">
            <label>等宽字体</label>
            <FontPicker kind="mono" value={s.monoFont} onChange={(monoFont) => props.onChange({ monoFont })} />
          </div>
        </div>
      </section>

      <section className="set-section">
        <h3>联系人</h3>
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
        <h3>术语表</h3>
        <GlossaryList />
      </section>
    </Modal>
  )
}
