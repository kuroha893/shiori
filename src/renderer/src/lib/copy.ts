import { formulasAsSource } from './anchors'

// Copying text with formulas: each formula once, as its $LaTeX$ source, with paragraphs kept. Editors (notes) copy
// their own way and are left alone, as is anything without a formula.
document.addEventListener('copy', (e) => {
  const sel = getSelection()
  if (e.defaultPrevented || !e.clipboardData || !sel || sel.isCollapsed || !sel.rangeCount) return
  const range = sel.getRangeAt(0)
  const at = range.commonAncestorContainer
  if ((at instanceof Element ? at : at.parentElement)?.closest('[contenteditable="true"], input, textarea')) return
  const frag = range.cloneContents()
  if (!frag.querySelector('.katex, .katex-mathml, .katex-html')) return
  formulasAsSource(frag)
  // innerText needs a layout to know where paragraphs end: the copy is laid out off screen for a moment
  const box = document.createElement('div')
  box.style.cssText = 'position: fixed; left: -100000px; top: 0; width: 800px'
  box.append(frag)
  document.body.append(box)
  const text = box.innerText.replace(/\n{3,}/g, '\n\n').trim()
  const html = box.innerHTML
  box.remove()
  e.clipboardData.setData('text/plain', text)
  e.clipboardData.setData('text/html', html)
  e.preventDefault()
})
