import { Extension, InputRule, Node, mergeAttributes, type Editor, type Range } from '@tiptap/core'
import { InlineMath } from '@tiptap/extension-mathematics'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion'

export const NOTE_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const
export type NoteColor = (typeof NOTE_COLORS)[number]

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      toggleCallout: () => ReturnType
    }
  }
}

/** 高亮块: a tinted box that can hold any blocks. */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      color: {
        default: 'blue',
        parseHTML: (el) => el.getAttribute('data-color') ?? 'blue',
        renderHTML: (attrs) => ({ 'data-color': attrs.color })
      }
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout' }), 0]
  },
  renderMarkdown: (node, h) =>
    h
      .renderChildren(node.content ?? [], '\n\n')
      .split('\n')
      .map((line: string) => `> ${line}`.trimEnd())
      .join('\n'),
  addCommands() {
    return {
      toggleCallout:
        () =>
        ({ commands }) =>
          commands.toggleWrap(this.name)
    }
  }
})

/** Typing $x$ makes a formula, as in LaTeX. Not "$5 and $", and not a closing $ after a space. */
export const NoteInlineMath = InlineMath.extend({
  addInputRules() {
    return [
      ...(this.parent?.() ?? []),
      new InputRule({
        find: /(?:^|[^$\\])(\$([^\s$](?:[^$\n]*[^\s$])?)\$)$/,
        handler: ({ state, range, match }) => {
          // The match may begin with the character before the opening $; that one stays.
          const start = range.from + (match[0].length - match[1].length)
          state.tr.replaceWith(start, range.to, this.type.create({ latex: match[2] }))
        }
      })
    ]
  }
})

export interface SlashHandlers {
  open: (props: SuggestionProps<SlashItem>) => void
  key: (props: SuggestionKeyDownProps) => boolean
  close: () => void
  items: (query: string) => SlashItem[]
  /** A line that is just "$$ ": ask for a display formula. */
  blockMath: (editor: Editor) => void
}

export interface SlashItem {
  id: string
  label: string
  badge: string
  keys: string
  run: (editor: Editor, range: Range) => void
}

/** The "/" menu, and the "$$ " shortcut that shares its place at the start of a line. */
export const slashCommands = (ui: SlashHandlers) =>
  Extension.create({
    name: 'slash',
    addInputRules() {
      const editor = this.editor
      return [
        new InputRule({
          find: /^\$\$\s$/,
          handler: ({ state, range }) => {
            state.tr.delete(range.from, range.to)
            setTimeout(() => ui.blockMath(editor))
          }
        })
      ]
    },
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem, SlashItem>({
          editor: this.editor,
          pluginKey: new PluginKey('slash'),
          char: '/',
          // Chinese has no spaces: the menu opens right after any character.
          allowedPrefixes: null,
          allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
          items: ({ query }) => ui.items(query),
          command: ({ editor, range, props }) => props.run(editor, range),
          render: () => ({ onStart: ui.open, onUpdate: ui.open, onKeyDown: ui.key, onExit: ui.close })
        })
      ]
    }
  })

/**
 * Pasted HTML keeps its structure but not its looks: a web page's black text would vanish in dark mode.
 * Rendered formulas (a copied answer) come back as formula nodes instead of KaTeX's duplicated text.
 */
export function cleanPastedHtml(html: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const latexOf = (el: Element) => el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim()
  for (const el of tpl.content.querySelectorAll('.katex-display')) {
    const latex = latexOf(el)
    if (!latex) continue
    const block = document.createElement('div')
    block.dataset.type = 'block-math'
    block.dataset.latex = latex
    el.replaceWith(block)
  }
  for (const el of tpl.content.querySelectorAll('.katex')) {
    const latex = latexOf(el)
    if (!latex) continue
    const inline = document.createElement('span')
    inline.dataset.type = 'inline-math'
    inline.dataset.latex = latex
    el.replaceWith(inline)
  }
  // Web images can't load here (see the CSP); a pasted screenshot arrives as a file instead.
  for (const img of tpl.content.querySelectorAll('img')) {
    if (!/^(shiori|data):/.test(img.getAttribute('src') ?? '')) img.remove()
  }
  for (const el of tpl.content.querySelectorAll('[style]')) {
    // Our own colours are variables, so copying inside the note keeps them.
    const own = (el.getAttribute('style') ?? '').split(';').filter((rule) => rule.includes('--note-'))
    if (own.length) el.setAttribute('style', own.join(';'))
    else el.removeAttribute('style')
  }
  return tpl.innerHTML
}

/** Plain text that was probably written as Markdown (Claude's answers, for one). */
export const looksLikeMarkdown = (text: string): boolean =>
  /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\$\$)|\*\*\S|`[^`\n]+`|\$[^$\s][^$\n]*\$|^\|.+\|\s*$/m.test(text)
