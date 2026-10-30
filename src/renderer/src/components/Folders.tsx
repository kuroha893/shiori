import { useEffect, useState } from 'react'
import type { Folder, PaperMeta } from '../../../shared/types'
import { api } from '../api'
import { Icon } from './Icon'

export function useFolders(): Folder[] {
  const [folders, setFolders] = useState<Folder[]>([])
  useEffect(() => {
    api.listFolders().then(setFolders)
    return api.onFoldersChanged(setFolders)
  }, [])
  return folders
}

export const setPaperFolders = (id: string, folders: string[]) => api.updatePaper(id, { folders, suggestion: undefined })

export const errorText = (e: unknown) => String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function NameInput({ initial = '', placeholder, onDone }: { initial?: string; placeholder?: string; onDone: (name?: string) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <input
      className="input lib-side-input"
      autoFocus
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => onDone()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone()
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) onDone(value)
      }}
    />
  )
}

/** Claude's suggestion for a paper not yet filed: one click to accept, or leave it alone. */
export function Suggestion({ paper, folders, toast }: { paper: PaperMeta; folders: Folder[]; toast: (t: string) => void }) {
  const s = paper.suggestion
  if (!s || paper.folders?.length) return null
  const existing = folders.find((f) => f.id === s.folderId) ?? folders.find((f) => f.name.toLowerCase() === s.name.toLowerCase())
  return (
    <div className="paper-suggest" onClick={(e) => e.stopPropagation()}>
      <Icon name="sparkles" size={12} />
      <span className="paper-suggest-text">
        建议归入「{existing?.name ?? s.name}」{!existing && <em>新建</em>}
      </span>
      <button className="btn sm" onClick={() => api.acceptSuggestion(paper.id).catch((e) => toast(errorText(e)))}>
        接受
      </button>
      <button className="icon-btn paper-suggest-x" title="忽略这个建议" onClick={() => api.updatePaper(paper.id, { suggestion: undefined })}>
        <Icon name="x" size={12} />
      </button>
    </div>
  )
}
