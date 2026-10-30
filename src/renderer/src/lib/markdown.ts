import MarkdownIt from 'markdown-it'
import mdKatex from '@vscode/markdown-it-katex'
import cjkFriendly from 'markdown-it-cjk-friendly'
import DOMPurify from 'dompurify'

// Paper text and AI answers are untrusted: rendered Markdown always goes through DOMPurify.
const md = new MarkdownIt({ html: true, linkify: true, breaks: false })
// **强调：**紧跟汉字 — CommonMark alone leaves these asterisks as text.
md.use(cjkFriendly)
md.use((mdKatex as any).default ?? mdKatex, {
  throwOnError: false,
  enableMathBlockInHtml: true,
  enableMathInlineInHtml: true,
  enableFencedBlocks: true
})

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') || ''
    if (href.startsWith('#')) {
      const ref = decodeURIComponent(href.slice(1))
      node.setAttribute('data-ref', ref)
      // Numeric citations read as [12], like in the paper.
      if (ref.startsWith('ref-') && /^\d+$/.test(node.textContent ?? '')) node.textContent = `[${node.textContent}]`
    } else node.setAttribute('target', '_blank')
  }
})

const cache = new Map<string, string>()

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    // semantics/annotation hold each formula's LaTeX source (plain text), used when copying selections
    ADD_TAGS: ['semantics', 'annotation'],
    ADD_ATTR: ['target', 'data-ref', 'encoding'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe']
  })
}

const CLOSING = /^[，。、；：！？）」』”’,.;:!?)\]]+/

/**
 * Typographic touches applied the same way on every render, so highlight offsets stay valid:
 * - inline math keeps the punctuation that follows it on the same line (no "。" starting a line);
 * - in Chinese text, Latin words are marked English so the browser may hyphenate them; otherwise
 *   a long word that doesn't fit stretches the previous justified line apart.
 */
function polish(html: string, zh: boolean): string {
  if (!html.includes('katex') && !(zh && /[A-Za-z]{6}/.test(html))) return html
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  for (const k of tpl.content.querySelectorAll('.katex')) {
    if (k.parentElement?.closest('.katex')) continue
    const next = k.nextSibling
    const m = next?.nodeType === Node.TEXT_NODE ? next.nodeValue!.match(CLOSING) : null
    // Move the punctuation into the formula's last unbreakable piece, so it can't start a line
    // while the formula itself may still wrap at = or +. Text order stays the same.
    const last = [...k.querySelectorAll('.katex-html > .base')].pop()
    if (!m || !last) continue
    next!.nodeValue = next!.nodeValue!.slice(m[0].length)
    const punct = document.createElement('span')
    punct.className = 'katex-punct'
    punct.textContent = m[0]
    last.append(punct)
  }
  if (!zh) return tpl.innerHTML
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = (n as Text).parentElement
    if (!parent?.closest('.katex, code, pre, a, [lang]') && /[A-Za-z]{6}/.test(n.nodeValue!)) nodes.push(n as Text)
  }
  for (const t of nodes) {
    const frag = document.createDocumentFragment()
    for (const part of t.nodeValue!.split(/([A-Za-z][A-Za-z'’-]{5,})/)) {
      if (!part) continue
      if (/^[A-Za-z][A-Za-z'’-]{5,}$/.test(part)) {
        const span = document.createElement('span')
        span.lang = 'en'
        span.textContent = part
        frag.append(span)
      } else frag.append(part)
    }
    t.replaceWith(frag)
  }
  return tpl.innerHTML
}

export function renderMarkdown(src: string, inline = false, zh = false): string {
  const key = (inline ? 'i' : 'b') + (zh ? 'z:' : ':') + src
  let html = cache.get(key)
  if (html === undefined) {
    // Footnote markers written as [^4](#fn-4) become superscripts.
    const pre = src.replace(/\[\^(\w+)\]\((#[^)\s]+)\)/g, '<sup>[$1]($2)</sup>')
    html = polish(sanitize(inline ? md.renderInline(pre) : md.render(pre)), zh)
    if (cache.size > 4000) cache.clear()
    cache.set(key, html)
  }
  return html
}
