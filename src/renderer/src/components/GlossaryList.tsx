import { useEffect, useState } from 'react'
import type { GlossaryEntry } from '../../../shared/types'
import { api } from '../api'
import { Icon } from './Icon'

type Draft = { id?: string; en: string; zh: string; keep: boolean }

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** The glossary in Settings: English → Chinese rows, click to edit, a row at the bottom to add. */
export function GlossaryList() {
  const [entries, setEntries] = useState<GlossaryEntry[]>()
  const [draft, setDraft] = useState<Draft>()
  const [error, setError] = useState<string>()
  const cancel = () => {
    setDraft(undefined)
    setError(undefined)
  }

  useEffect(() => {
    api.listTerms().then(setEntries)
  }, [])

  const commit = async () => {
    if (!draft) return
    if (!draft.en.trim()) {
      // An emptied existing row means delete; an empty new row just closes.
      if (draft.id) setEntries(await api.deleteTerm(draft.id))
      return setDraft(undefined)
    }
    try {
      setEntries(await api.saveTerm({ id: draft.id, en: draft.en, zh: draft.zh, keep: draft.keep }))
      setDraft(undefined)
      setError(undefined)
    } catch (e) {
      setError(errText(e))
    }
  }

  if (!entries) return null
  return (
    <div className="gloss">
      <div className="gloss-list">
        {entries.map((e) =>
          draft?.id === e.id ? (
            <Editor key={e.id} draft={draft} setDraft={setDraft} onCommit={commit} onCancel={cancel} />
          ) : (
            <div key={e.id} className="gloss-row" onClick={() => setDraft({ id: e.id, en: e.en, zh: e.zh ?? '', keep: !!e.keep })}>
              <span className="gloss-en">{e.en}</span>
              <Icon name="next" size={14} className="gloss-arrow" />
              <span className="gloss-zh">{e.keep ? <span className="pill keep">保留英文</span> : e.zh || <span className="faint">未填写</span>}</span>
              <button
                className="icon-btn gloss-del"
                title="删除"
                onClick={async (ev) => {
                  ev.stopPropagation()
                  setEntries(await api.deleteTerm(e.id))
                }}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          )
        )}
        {draft && !draft.id ? (
          <Editor draft={draft} setDraft={setDraft} onCommit={commit} onCancel={cancel} />
        ) : (
          <button className="gloss-add" onClick={() => setDraft({ en: '', zh: '', keep: false })}>
            <Icon name="plus" size={14} />
            添加术语
          </button>
        )}
      </div>
      {error && <p className="gloss-error">{error}</p>}
    </div>
  )
}

function Editor({ draft, setDraft, onCommit, onCancel }: { draft: Draft; setDraft: (d: Draft) => void; onCommit: () => void; onCancel: () => void }) {
  const keys = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) onCommit()
    if (e.key === 'Escape') onCancel()
  }
  return (
    <div className="gloss-row editing">
      <input className="input gloss-en" placeholder="English" value={draft.en} autoFocus onChange={(e) => setDraft({ ...draft, en: e.target.value })} onKeyDown={keys} />
      <Icon name="next" size={14} className="gloss-arrow" />
      <div className="gloss-zh">
        <input
          className="input"
          placeholder={draft.keep ? '保留英文' : '中文'}
          value={draft.keep ? '' : draft.zh}
          disabled={draft.keep}
          onChange={(e) => setDraft({ ...draft, zh: e.target.value })}
          onKeyDown={keys}
        />
        <button type="button" className={`keep-toggle ${draft.keep ? 'on' : ''}`} onClick={() => setDraft({ ...draft, keep: !draft.keep })} title="翻译时保留英文原词">
          <span className="kt-box">{draft.keep && <Icon name="check" size={11} />}</span>
          保留英文
        </button>
      </div>
      <button className="icon-btn gloss-ok" title="保存（↩）" onClick={onCommit}>
        <Icon name="check" size={15} />
      </button>
    </div>
  )
}
