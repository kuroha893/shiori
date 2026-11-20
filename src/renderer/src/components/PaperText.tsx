import { memo, useMemo } from 'react'
import { inlineHtml } from '../lib/markdown'
import { useTitles } from '../lib/titles'

/** A paper's title or abstract with its marks and formulas drawn; plain text when it has none. */
export const PaperText = memo(function PaperText(props: { text: string; as?: 'span' | 'p' | 'div' | 'h3' | 'h4' | 'b'; className?: string; zh?: boolean }) {
  const { text, as: Tag = 'span', className, zh } = props
  const html = useMemo(() => inlineHtml(text, zh), [text, zh])
  return html === undefined ? <Tag className={className}>{text}</Tag> : <Tag className={className} dangerouslySetInnerHTML={{ __html: html }} />
})

/**
 * A paper's title, the one the owner chose to see papers by (lib/titles.ts); with `other`, the remaining title, for
 * the small line beneath (nothing when the paper has only one).
 */
export function PaperTitle(props: { paper: { title: string; titleZh?: string }; other?: boolean; as?: 'span' | 'p' | 'div' | 'h3' | 'h4' | 'b'; className?: string }) {
  const t = useTitles(props.paper)
  if (props.other) return t.other ? <PaperText as={props.as} className={props.className} text={t.other} zh={t.otherZh} /> : null
  return <PaperText as={props.as} className={props.className} text={t.main} zh={t.zh} />
}
