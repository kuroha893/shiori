import { useState } from 'react'
import type { ClaudeStatus, Settings } from '../../../shared/types'
import { api } from '../api'
import { Icon } from './Icon'
import { Modal, themeOptions } from './Chrome'
import { ContactsList } from './ContactsList'
import { GlossaryList } from './GlossaryList'
import { FontPicker } from './FontPicker'

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

export function SettingsModal(props: {
  settings: Settings
  claude?: ClaudeStatus
  onChange: (patch: Partial<Settings>) => void
  onLibraryChosen: (s: Settings) => void
  refreshClaude: () => void
  onClose: () => void
  toast: (text: string) => void
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
        <h3>
          通话服务
          <small>所有联系人共用。声音用你自己的 Fish Audio 账号。</small>
        </h3>
        <div className="set-rows">
          <div className="set-row">
            <label>对话模型</label>
            <div className="seg">
              {['opus', 'sonnet', 'haiku'].map((m) => (
                <button key={m} className={s.callModel === m ? 'on' : ''} onClick={() => props.onChange({ callModel: m })}>
                  {m[0].toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
            <span className="faint" style={{ fontSize: 12 }}>下次通话生效</span>
          </div>
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
