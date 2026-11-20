import { useEffect, useState } from 'react'
import type { Folder } from '../../../shared/types'
import { api } from '../api'

export function useFolders(): Folder[] {
  const [folders, setFolders] = useState<Folder[]>([])
  useEffect(() => {
    api.listFolders().then(setFolders)
    return api.onFoldersChanged(setFolders)
  }, [])
  return folders
}

export const setPaperFolders = (id: string, folders: string[]) => api.updatePaper(id, { folders })

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
