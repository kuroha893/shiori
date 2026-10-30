import { useEffect, useState } from 'react'
import type { ClaudeStatus, Settings } from '../../../shared/types'
import { api } from '../api'
import { Icon } from './Icon'
import { Modal, themeOptions } from './Chrome'

const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'

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

function TextFile({ name, rows }: { name: 'profile.md' | 'glossary.md'; rows: number }) {
  const [text, setText] = useState<string>()
  const [saved, setSaved] = useState(true)
  useEffect(() => {
    api.getText(name).then(setText)
  }, [name])
  useEffect(() => {
    if (text === undefined || saved) return
    const t = setTimeout(() => api.setText(name, text).then(() => setSaved(true)), 500)
    return () => clearTimeout(t)
  }, [text, saved, name])
  if (text === undefined) return null
  return (
    <div>
      <textarea
        className="textarea code"
        rows={rows}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          setSaved(false)
        }}
      />
      <p className="help" style={{ marginTop: 6 }}>
        {saved ? '已自动保存' : '保存中…'}
      </p>
    </div>
  )
}

export function SettingsModal(props: {
  settings: Settings
  claude?: ClaudeStatus
  onChange: (patch: Partial<Settings>) => void
  onLibraryChosen: (s: Settings) => void
  refreshClaude: () => void
  onClose: () => void
}) {
  const { settings: s, claude } = props
  const [checking, setChecking] = useState(false)

  const recheck = async () => {
    setChecking(true)
    await props.refreshClaude()
    setChecking(false)
  }

  return (
    <Modal title="设置" onClose={props.onClose}>
      <section className="set-section">
        <h3>
          Claude
          <small>转写、翻译、问答都通过你自己的 Claude Code（Claude 订阅）完成，不需要 API key。</small>
        </h3>
        <div className="set-rows">
          <div className="status-line">
            {!claude ? (
              <span className="pill">检查中…</span>
            ) : claude.loggedIn ? (
              <span className="pill ok">
                <span className="dot" />
                已连接{claude.account ? ` · ${claude.account}` : ''}
              </span>
            ) : (
              <span className="pill err">
                <span className="dot" />
                {claude.error === 'not-installed' ? '未安装' : '未登录'}
              </span>
            )}
            {claude?.version && <span className="mono faint">Claude Code {claude.version}</span>}
            <span className="spacer" />
            <button className="btn sm" onClick={recheck} disabled={checking}>
              <Icon name="refresh" size={12} />
              {checking ? '检查中' : '重新检查'}
            </button>
          </div>
          {claude && !claude.path && (
            <div className="help">
              <ol>
                <li>打开「终端」，运行官方安装命令：</li>
              </ol>
              <Copyable text={INSTALL} />
              <ol start={2}>
                <li>装好后回到这里点「重新检查」，再登录。</li>
              </ol>
            </div>
          )}
          {claude?.path && !claude.loggedIn && (
            <div className="help">
              点下面的按钮会打开「终端」运行 <code>claude auth login</code>，在弹出的浏览器里用你的 Claude 账号（Pro / Max）登录，完成后回到这里。
              <div style={{ marginTop: 10 }}>
                <button className="btn primary" onClick={() => api.claudeLogin()}>
                  <Icon name="external" />
                  在终端中登录
                </button>
              </div>
            </div>
          )}
          {claude?.path && <div className="path" title={claude.path}>{claude.path}</div>}
          <div className="set-row">
            <label>处理论文</label>
            <div className="seg">
              {['opus', 'sonnet'].map((m) => (
                <button key={m} className={s.processModel === m ? 'on' : ''} onClick={() => props.onChange({ processModel: m })}>
                  {m === 'opus' ? 'Opus' : 'Sonnet'}
                </button>
              ))}
            </div>
            <span className="faint" style={{ fontSize: 12 }}>转写 + 全文翻译，最耗额度</span>
          </div>
          <div className="set-row">
            <label>问答默认</label>
            <div className="seg">
              {['opus', 'sonnet', 'haiku'].map((m) => (
                <button key={m} className={s.chatModel === m ? 'on' : ''} onClick={() => props.onChange({ chatModel: m })}>
                  {m[0].toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
          </div>
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
                苹方 · Satoshi
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="set-section">
        <h3>
          研究者档案
          <small>告诉 Claude 你是谁、懂什么。讲解和翻译会照着它调整深浅。</small>
        </h3>
        <TextFile name="profile.md" rows={9} />
      </section>

      <section className="set-section">
        <h3>
          术语表
          <small>所有论文共用的译法。改了之后，新处理的论文会照新的来。</small>
        </h3>
        <TextFile name="glossary.md" rows={10} />
      </section>
    </Modal>
  )
}
