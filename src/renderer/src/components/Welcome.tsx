import { useState, type ReactNode } from 'react'
import type { Settings } from '../../../shared/types'
import { PROVIDERS, PROVIDER_NAMES, type Provider, type ServiceStatus } from '../../../shared/models'
import { api } from '../api'
import brand from '../assets/brand.png'
import { ContactAvatar, ringStyle, useContacts } from './Chrome'
import { ServiceLogo } from './ServiceLogo'
import { CHATGPT_DOWNLOAD, FISH_KEYS, FISH_SIGNUP, installClaudeCode, KeyInput, LinkButton, Pill, saveDeepseekKey, Steps, useServicePolling, Waiting } from './ServiceSetup'

/*
 * The first time Shiori opens: connect one model service, then, if you like, Fish Audio for the voices. Leaving
 * it by any button marks it as seen, and it doesn't come back.
 */

const KIND: Record<Provider, string> = { claude: '订阅', openai: '订阅', deepseek: 'API' }
const ABOUT: Record<Provider, string> = { claude: '用你的 Claude 订阅', openai: '用你的 ChatGPT 账号', deepseek: '填一个 API key，按用量付费' }

function status(p: Provider, s: ServiceStatus): ReactNode {
  if (p === 'claude') return s.claude.state === 'ready' ? <Pill ok>已连接</Pill> : s.claude.state === 'signedOut' ? <Pill>未登录</Pill> : <Pill>需要安装 Claude Code</Pill>
  if (p === 'openai') {
    if (s.openai.state === 'ready') return <Pill ok>已连接{s.openai.via === 'desktop' ? ' · 桌面版' : ''}</Pill>
    return s.openai.state === 'signedOut' ? <Pill>未登录</Pill> : <Pill>需要安装 ChatGPT 桌面版</Pill>
  }
  return s.deepseek.state === 'ready' ? <Pill ok>已连接</Pill> : s.claude.state === 'missing' ? <Pill>需要安装 Claude Code</Pill> : null
}

const Lead = ({ children, last }: { children: ReactNode; last?: boolean }) => <p className={`svc-lead ${last ? 'last' : ''}`}>{children}</p>

function Setup({ p, s, onStatus }: { p: Provider; s: ServiceStatus; onStatus: (s: ServiceStatus) => void }) {
  if (p === 'claude') {
    if (s.claude.state === 'ready') return <Lead last>已经连上了。</Lead>
    if (s.claude.state === 'signedOut')
      return (
        <>
          <Lead>Claude Code 已经装好。点「登录」，在浏览器里用你的 Claude 账号登录。</Lead>
          <button className="btn primary sm" onClick={() => api.serviceLogin('claude')}>
            登录
          </button>
        </>
      )
    return (
      <>
        <Lead>Claude 通过 Claude Code 运行，先装上它。</Lead>
        <Steps steps={installClaudeCode({ title: <Waiting>装好后这里会自动检测到，再用你的 Claude 账号登录</Waiting> })} />
      </>
    )
  }
  if (p === 'openai') {
    if (s.openai.state === 'ready') return <Lead last>已经通过{s.openai.via === 'desktop' ? ' ChatGPT 桌面版' : ' Codex '}连上了。</Lead>
    if (s.openai.state === 'signedOut')
      return (
        <>
          <Lead>找到了{s.openai.via === 'desktop' ? ' ChatGPT 桌面版' : ' Codex'}。点「登录」，在浏览器里用你的 ChatGPT 账号授权。</Lead>
          <button className="btn primary sm" onClick={() => api.serviceLogin('openai')}>
            登录
          </button>
        </>
      )
    return (
      <>
        <Lead>ChatGPT 通过 Codex 运行，ChatGPT 桌面版自带它。</Lead>
        <Steps
          steps={[
            { title: '下载并安装 ChatGPT 桌面版', action: <LinkButton url={CHATGPT_DOWNLOAD}>下载</LinkButton> },
            { title: <Waiting>装好后这里会自动检测到，再用你的 ChatGPT 账号登录</Waiting> }
          ]}
        />
      </>
    )
  }
  if (s.deepseek.state === 'ready') return <Lead last>已经连上了。</Lead>
  const key = <KeyInput placeholder="sk-…" save={saveDeepseekKey(onStatus)} />
  if (s.claude.state === 'missing')
    return (
      <>
        <Lead>DeepSeek 也通过 Claude Code 运行，先装上它，不需要 Claude 账号。</Lead>
        <Steps steps={installClaudeCode({ title: '在 DeepSeek 开放平台创建一个 API key，填在这里', body: key })} />
      </>
    )
  return (
    <>
      <Lead>在 DeepSeek 开放平台创建一个 API key，填在这里。</Lead>
      {key}
    </>
  )
}

function ModelStep(props: { settings: Settings; services?: ServiceStatus; onServices: (s: ServiceStatus) => void; onLibraryChosen: (s: Settings) => void; onSkip: () => void; onNext: () => void }) {
  const s = props.services
  const ready = PROVIDERS.filter((p) => s && (p === 'deepseek' ? s.deepseek.state : s[p].state) === 'ready')
  const [picked, setPicked] = useState<Provider>()
  const current = picked ?? ready[0] ?? 'claude'
  return (
    <>
      <p className="welcome-label">先接入一个模型服务，三选一就够了</p>
      <div className="welcome-tiles">
        {PROVIDERS.map((p) => (
          <button key={p} className={`welcome-tile ${current === p ? 'on' : ''}`} onClick={() => setPicked(p)}>
            <span className="welcome-tile-name">
              <ServiceLogo provider={p} />
              {PROVIDER_NAMES[p]}
              <small>{KIND[p]}</small>
            </span>
            <span className="welcome-tile-about">{ABOUT[p]}</span>
            {s && status(p, s)}
          </button>
        ))}
      </div>
      <div className="welcome-setup">{s ? <Setup p={current} s={s} onStatus={props.onServices} /> : <Lead last>检查中…</Lead>}</div>
      <div className="welcome-foot">
        <div className="welcome-lib">
          <span>论文会放在</span>
          <code title={props.settings.libraryPath}>{props.settings.libraryPath.replace(/^\/Users\/[^/]+/, '~')}</code>
          <button className="link" onClick={async () => props.onLibraryChosen(await api.chooseLibrary())}>
            更改
          </button>
        </div>
        <button className="btn ghost" onClick={props.onSkip}>
          以后再说
        </button>
        <button className="btn primary" disabled={!ready.length} onClick={props.onNext}>
          下一步
        </button>
      </div>
    </>
  )
}

/** "诗织和八千代": the names people call them by, the given name of a full one. */
const together = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join('、')}和${names[names.length - 1]}`)

function VoiceStep(props: { settings: Settings; onSettings: (s: Settings) => void; onBack: () => void; onDone: () => void }) {
  const voiced = useContacts().filter((c) => c.voice).slice(0, 3)
  const [changing, setChanging] = useState(false)
  const has = !!props.settings.fishKey && !changing
  const save = async (key: string) => {
    const r = await api.setFishKey(key)
    if (r.settings) {
      props.onSettings(r.settings)
      setChanging(false)
    }
    return r.error
  }
  return (
    <>
      <div className="welcome-voices">
        {voiced.length > 0 && (
          <div className="welcome-faces">
            {voiced.map((c) => (
              <span key={c.id} className="welcome-face ringed" style={ringStyle(c)}>
                <ContactAvatar contact={c} />
              </span>
            ))}
          </div>
        )}
        <p>
          {voiced.length > 0 && <b>{together(voiced.map((c) => c.name.split(' ').pop()!))}都有自己的声音。</b>}
          接上 Fish Audio，通话时就能听到她们说话；不接也可以，通话只显示字幕。
        </p>
      </div>
      <div className="welcome-setup">
        <Steps
          steps={[
            { title: '注册一个 Fish Audio 账号', action: <LinkButton url={FISH_SIGNUP}>去注册</LinkButton> },
            { title: '在 API Keys 页面新建一个 key', action: <LinkButton url={FISH_KEYS}>打开 API Keys</LinkButton> },
            {
              title: '把 key 粘贴到这里',
              body: has ? (
                <div className="welcome-key-done">
                  <Pill ok>已连接</Pill>
                  <button className="btn ghost sm" onClick={() => setChanging(true)}>
                    更换 key
                  </button>
                </div>
              ) : (
                <KeyInput placeholder="粘贴你的 API key" save={save} onCancel={props.settings.fishKey ? () => setChanging(false) : undefined} />
              )
            }
          ]}
        />
      </div>
      <div className="welcome-foot">
        <button className="btn ghost" onClick={props.onBack}>
          上一步
        </button>
        <span className="spacer" />
        {!has && (
          <button className="btn ghost" onClick={props.onDone}>
            跳过
          </button>
        )}
        <button className="btn primary" onClick={props.onDone}>
          开始使用
        </button>
      </div>
    </>
  )
}

export function Welcome(props: {
  settings: Settings
  services?: ServiceStatus
  refreshServices: (fresh?: boolean) => void
  onServices: (s: ServiceStatus) => void
  onSettings: (s: Settings) => void
  onLibraryChosen: (s: Settings) => void
  onDone: () => void
}) {
  const [step, setStep] = useState<1 | 2>(1)
  useServicePolling(props.services, props.refreshServices)
  return (
    <div className="welcome">
      <div className="welcome-drag" />
      <div className="welcome-inner fade-in">
        <div className="welcome-hello">
          <img className="welcome-mark" src={brand} alt="" draggable={false} />
          <h1>{step === 1 ? '欢迎使用 Shiori' : '让她们开口说话'}</h1>
          <div className="welcome-progress">
            <i className="on" />
            <i className={step === 2 ? 'on' : ''} />
          </div>
        </div>
        {step === 1 ? (
          <ModelStep settings={props.settings} services={props.services} onServices={props.onServices} onLibraryChosen={props.onLibraryChosen} onSkip={props.onDone} onNext={() => setStep(2)} />
        ) : (
          <VoiceStep settings={props.settings} onSettings={props.onSettings} onBack={() => setStep(1)} onDone={props.onDone} />
        )}
      </div>
    </div>
  )
}
