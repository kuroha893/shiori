// Text offsets inside a rendered block, used to anchor highlights. Offsets count every text node
// of the container in document order, so they stay valid as long as the block renders the same.

function textNodes(root: Node): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text)
  return out
}

export function rangeToOffsets(root: Element, range: Range): { start: number; end: number } {
  const pre = document.createRange()
  pre.selectNodeContents(root)
  pre.setEnd(range.startContainer, range.startOffset)
  const start = pre.toString().length
  return { start, end: start + range.toString().length }
}

export function offsetsToRange(root: Element, start: number, end: number): Range | undefined {
  const range = document.createRange()
  let pos = 0
  let startSet = false
  for (const t of textNodes(root)) {
    const next = pos + t.length
    if (!startSet && start <= next) {
      range.setStart(t, start - pos)
      startSet = true
    }
    if (startSet && end <= next) {
      range.setEnd(t, end - pos)
      return range
    }
    pos = next
  }
  return undefined
}

export function caretOffset(root: Element, x: number, y: number): number | undefined {
  const pos = (document as any).caretPositionFromPoint?.(x, y)
  if (!pos || !root.contains(pos.offsetNode)) return undefined
  const pre = document.createRange()
  pre.selectNodeContents(root)
  pre.setEnd(pos.offsetNode, pos.offset)
  return pre.toString().length
}


/**
 * The selected text with formulas written back as $LaTeX$. Range.toString() would repeat each formula
 * (KaTeX keeps a hidden MathML copy next to the visible one) and garble quotes sent to Claude.
 */
export function selectionText(range: Range): string {
  const frag = range.cloneContents()
  for (const ann of [...frag.querySelectorAll('annotation[encoding="application/x-tex"]')]) {
    const holder = ann.closest('.katex') ?? ann.closest('.katex-mathml') ?? ann
    holder.replaceWith(`$${ann.textContent?.trim()}$`)
  }
  frag.querySelectorAll('.katex-html, .katex-mathml').forEach((n) => n.remove())
  return (frag.textContent ?? '').replace(/\s+/g, ' ').trim()
}
