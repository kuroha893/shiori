import { useRef, useState } from 'react'
import { YACHIYO, type Contact, type ContactDraft } from '../../../shared/contacts'
import { api } from '../api'
import { ContactAvatar, useContacts } from './Chrome'
import { errorText } from './Folders'
import { Icon } from './Icon'

// Eight clicks, for eight thousand years.
const EGG_CLICKS = 8
const EGG_WINDOW = 4000

type Form = ContactDraft & { avatarShown?: string; builtin?: boolean }

const NEW: Form = { name: '', persona: '', voice: '', language: 'zh' }

const toForm = (c: Contact): Form => ({ id: c.id, name: c.name, persona: c.persona, voice: c.voice, language: c.language, avatarShown: c.avatar, builtin: c.builtin })

/** The contacts in Settings: click one to edit it, a row at the bottom to add someone. */
export function ContactsList({ petShown, onPetShown, toast }: { petShown: boolean; onPetShown: (on: boolean) => void; toast: (text: string) => void }) {
  const contacts = useContacts()
  const [form, setForm] = useState<Form>()
  const [error, setError] = useState<string>()
  const egg = useRef({ count: 0, at: 0 })

  const edit = (next?: Form) => {
    setForm(next)
    setError(undefined)
  }
  const patch = (p: Partial<Form>) => setForm((f) => f && { ...f, ...p })

  const pick = async () => {
    try {
      const avatar = await api.pickAvatar()
      if (avatar) patch({ avatar, avatarShown: avatar })
    } catch (e) {
      setError(errorText(e))
    }
  }

  const save = async () => {
    if (!form) return
    const { avatarShown: _shown, builtin: _builtin, ...draft } = form
    try {
      await api.saveContact(draft)
      edit(undefined)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const remove = async (c: Contact) => {
    if (!confirm(`删除「${c.name}」？TA 的记忆和通话记录会移到废纸篓。`)) return
    await api.deleteContact(c.id)
    edit(undefined)
  }

  const eggClick = (e: React.MouseEvent, c: Contact) => {
    if (c.id !== YACHIYO) return
    e.stopPropagation()
    const now = Date.now()
    egg.current = { count: now - egg.current.at < EGG_WINDOW ? egg.current.count + 1 : 1, at: now }
    if (egg.current.count < EGG_CLICKS) return
    egg.current = { count: 0, at: 0 }
    onPetShown(!petShown)
    toast(petShown ? '八千代回去了' : '八千代要到桌面上来了')
  }

  const body = (original?: Contact) =>
    form && (
      <div className="set-contact-form">
        {!form.builtin && (
          <div className="set-row">
            <label>名字</label>
            <input className="input" autoFocus={!form.id} value={form.name} onChange={(e) => patch({ name: e.target.value })} />
          </div>
        )}
        <div className="set-row">
          <label>头像</label>
          <div className="set-contact-picture">
            <span className="set-contact-pic">
              <ContactAvatar contact={{ name: form.name, avatar: form.builtin ? `shiori://contact/${form.id}/avatar.png` : undefined }} src={form.avatar === null ? null : form.avatarShown} />
            </span>
            <button className="btn sm" onClick={pick}>
              选择图片
            </button>
            {form.avatar !== null && (form.avatar || (form.avatarShown && (!form.builtin || form.avatarShown.includes('?v=')))) && (
              <button className="btn ghost sm" onClick={() => patch({ avatar: null, avatarShown: undefined })}>
                {form.builtin ? '恢复默认' : '移除'}
              </button>
            )}
          </div>
        </div>
        <div className="set-row">
          <label>人设</label>
          <div className="set-contact-persona">
            <textarea
              className="textarea"
              rows={form.builtin ? 16 : 7}
              spellCheck={false}
              placeholder="TA 是谁、性格怎样、和你是什么关系、怎么说话。写得越具体越像，也可以直接贴一段说话的例子。"
              value={form.persona}
              onChange={(e) => patch({ persona: e.target.value })}
            />
            <p className="faint">存在 persona.md，下次通话生效。</p>
          </div>
        </div>
        <div className="set-row">
          <label>音色 ID</label>
          <input className="input" spellCheck={false} placeholder="不填就只有字幕" value={form.voice} onChange={(e) => patch({ voice: e.target.value })} />
        </div>
        <div className="set-row">
          <label>说的语言</label>
          <div className="seg">
            {(['ja', 'zh'] as const).map((l) => (
              <button key={l} className={form.language === l ? 'on' : ''} onClick={() => patch({ language: l })}>
                {l === 'ja' ? '日语' : '中文'}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="set-contact-error">{error}</p>}
        <div className="set-contact-actions">
          <button className="btn primary sm" disabled={!form.name.trim()} onClick={save}>
            {form.id ? '保存' : '添加'}
          </button>
          <button className="btn sm" onClick={() => edit(undefined)}>
            取消
          </button>
          <span className="spacer" />
          {original && (
            <button className="btn ghost sm" onClick={() => api.revealMemory(original.id)}>
              打开文件夹
            </button>
          )}
          {original && !original.builtin && (
            <button className="btn ghost sm" onClick={() => remove(original)}>
              删除
            </button>
          )}
        </div>
      </div>
    )

  return (
    <div className="set-contacts">
      {contacts.map((c) => (
        <div className="set-contact" key={c.id}>
          <button className="set-contact-row" onClick={() => edit(form?.id === c.id ? undefined : toForm(c))}>
            <span className="set-contact-pic" onClick={(e) => eggClick(e, c)}>
              <ContactAvatar contact={c} />
            </span>
            <b>{c.name}</b>
            <span className="set-contact-sub">
              {c.language === 'ja' ? '日语' : '中文'} · {c.voice ? '已设音色' : '只有字幕'}
            </span>
          </button>
          {form?.id === c.id && body(c)}
        </div>
      ))}
      <button className="set-contact-add" onClick={() => edit(form && !form.id ? undefined : { ...NEW })}>
        <Icon name="plus" size={14} />
        添加联系人
      </button>
      {form && !form.id && body()}
    </div>
  )
}
