import { useRef, useState } from 'react'
import { YACHIYO, type AvatarCrop, type Contact, type ContactDraft } from '../../../shared/contacts'
import { api } from '../api'
import { ContactAvatar, ringStyle, useContacts } from './Chrome'
import { errorText } from './Folders'
import { Icon } from './Icon'
import { fitPortrait, PortraitCrop } from './PortraitCrop'

// Eight clicks, for eight thousand years.
const EGG_CLICKS = 8
const EGG_WINDOW = 4000

type Form = ContactDraft & { avatarShown?: string; portraitShown?: string }

const NEW: Form = { name: '', persona: '', voice: '', language: 'zh' }

const toForm = (c: Contact): Form => ({ id: c.id, name: c.name, romaji: c.romaji ?? '', persona: c.persona, voice: c.voice, language: c.language, avatarShown: c.avatar, crop: c.crop })

/**
 * Deleting someone asks twice; once you have talked, a third time, by typing their name, since their memory of
 * you goes with them. Everything goes to the Trash, so a slip can still be undone there.
 */
function DeleteContact({ contact, onCancel, onDeleted }: { contact: Contact; onCancel: () => void; onDeleted: () => void }) {
  const [stage, setStage] = useState<'ask' | 'type'>('ask')
  const [typed, setTyped] = useState('')
  const history = (contact.calls ?? 0) > 0 || !!contact.remembers
  const remove = async () => {
    await api.deleteContact(contact.id)
    onDeleted()
  }
  if (stage === 'ask')
    return (
      <div className="danger-box">
        <h5>删除「{contact.name}」？</h5>
        <p>
          TA 的人设、图片
          {contact.calls ? (
            <>
              ，还有 <b>{contact.calls} 次通话记录</b>
            </>
          ) : null}
          {contact.remembers ? '和 TA 对你的记忆' : ''}，都会移到废纸篓。从废纸篓里还能找回。
        </p>
        <div className="danger-row">
          <span className="spacer" />
          <button className="btn sm" onClick={onCancel}>
            取消
          </button>
          <button className="btn sm destroy" onClick={() => (history ? setStage('type') : remove())}>
            {history ? '继续' : '删除'}
          </button>
        </div>
      </div>
    )
  return (
    <div className="danger-box">
      <h5>最后确认一次</h5>
      <p>
        你们已经有过通话，TA 记得你。输入 TA 的名字 <b>{contact.name}</b> 来删除。
      </p>
      <div className="danger-row">
        <input className="input" autoFocus placeholder={contact.name} value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && typed.trim() === contact.name && remove()} />
        <button className="btn sm" onClick={onCancel}>
          取消
        </button>
        <button className="btn sm destroy" disabled={typed.trim() !== contact.name} onClick={remove}>
          删除
        </button>
      </div>
    </div>
  )
}

/** The contacts in Settings: click one to edit it, a row at the bottom to add someone. */
export function ContactsList({ petShown, onPetShown, toast }: { petShown: boolean; onPetShown: (on: boolean) => void; toast: (text: string) => void }) {
  const contacts = useContacts()
  const [form, setForm] = useState<Form>()
  const [error, setError] = useState<string>()
  const [deleting, setDeleting] = useState(false)
  const [reading, setReading] = useState(false)
  const egg = useRef({ count: 0, at: 0 })

  const edit = (next?: Form) => {
    setForm(next)
    setError(undefined)
    setDeleting(false)
    if (next?.id && contacts.find((c) => c.id === next.id)?.portrait) {
      api.contactPortrait(next.id).then((portraitShown) => setForm((f) => (f && f.id === next.id ? { ...f, portraitShown } : f)))
    }
  }
  const patch = (p: Partial<Form>) => setForm((f) => f && { ...f, ...p })

  const pick = async () => {
    try {
      const file = await api.pickPortrait()
      if (!file) return
      const portrait = await fitPortrait(file)
      setError(undefined)
      // No crop yet: the picture opens with a default one, which also makes the avatar.
      patch({ portrait, portraitShown: portrait, crop: undefined })
    } catch (e) {
      setError(errorText(e))
    }
  }

  const save = async () => {
    if (!form) return
    const { avatarShown: _shown, portraitShown: _portrait, ...draft } = form
    try {
      await api.saveContact(draft)
      edit(undefined)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const cropped = (crop: AvatarCrop, avatar: string) => patch({ crop, avatar, avatarShown: avatar })

  const regenerate = async () => {
    if (!form?.name.trim()) return
    setReading(true)
    setError(undefined)
    try {
      patch({ romaji: await api.contactRomaji(form.name.trim()) })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setReading(false)
    }
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
        <div className="set-row">
          <label>名字</label>
          <input className="input" autoFocus={!form.id} value={form.name} onChange={(e) => patch({ name: e.target.value })} />
        </div>
        <div className="set-row">
          <label>罗马音</label>
          <div className="set-contact-romaji-edit">
            <input className="input" spellCheck={false} placeholder="保存后自动生成" value={form.romaji ?? ''} onChange={(e) => patch({ romaji: e.target.value })} />
            <button className="btn sm" disabled={reading || !form.name.trim()} onClick={regenerate}>
              {reading ? '生成中…' : '重新生成'}
            </button>
          </div>
        </div>
        {form.portraitShown && (
          <div className="set-row">
            <label>立绘</label>
            <PortraitCrop src={form.portraitShown} crop={form.crop} onChange={cropped} />
          </div>
        )}
        <div className="set-row">
          <label>头像</label>
          <div className="set-contact-picture">
            <span className="set-contact-pic">
              <ContactAvatar contact={{ name: form.name }} src={form.avatar === null ? null : form.avatarShown} />
            </span>
            <button className="btn sm" onClick={pick}>
              选择图片
            </button>
            {form.avatar !== null && (form.avatar || form.portrait || form.avatarShown) && (
              <button className="btn ghost sm" onClick={() => patch({ avatar: null, portrait: null, avatarShown: undefined, portraitShown: undefined, crop: undefined })}>
                移除
              </button>
            )}
          </div>
        </div>
        <div className="set-row">
          <label>人设</label>
          <div className="set-contact-persona">
            <textarea
              className="textarea"
              rows={form.persona.length > 600 ? 16 : 7}
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
        {original && deleting ? (
          <DeleteContact contact={original} onCancel={() => setDeleting(false)} onDeleted={() => edit(undefined)} />
        ) : (
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
            {original && (
              <button className="btn ghost sm danger" onClick={() => setDeleting(true)}>
                删除联系人
              </button>
            )}
          </div>
        )}
      </div>
    )

  return (
    <div className="set-contacts">
      {contacts.map((c) => (
        <div className="set-contact" key={c.id}>
          <button className="set-contact-row" onClick={() => edit(form?.id === c.id ? undefined : toForm(c))}>
            <span className={`set-contact-pic ${ringStyle(c) ? 'ringed' : ''}`} style={ringStyle(c)} onClick={(e) => eggClick(e, c)}>
              <ContactAvatar contact={c} />
            </span>
            <span className="set-contact-who">
              <b>{c.name}</b>
              {c.romaji && c.romaji !== c.name && <span className="set-contact-romaji">{c.romaji}</span>}
            </span>
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
