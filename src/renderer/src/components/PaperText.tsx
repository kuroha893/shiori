import { memo, useMemo } from 'react'
import { inlineHtml } from '../lib/markdown'

/** A paper's title or abstract with its marks and formulas drawn; plain text when it has none. */
export const PaperText = memo(function PaperText(props: { text: string; as?: 'span' | 'p' | 'div' | 'h3'; className?: string; zh?: boolean }) {
  const { text, as: Tag = 'span', className, zh } = props
  const html = useMemo(() => inlineHtml(text, zh), [text, zh])
  return html === undefined ? <Tag className={className}>{text}</Tag> : <Tag className={className} dangerouslySetInnerHTML={{ __html: html }} />
})
