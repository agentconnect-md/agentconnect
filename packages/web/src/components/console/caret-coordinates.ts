// The CSS that affects text layout inside a textarea — mirrored onto a hidden
// clone so measuring where it wraps gives the real caret position. A textarea
// has no native API for this (the mention picker needs it to anchor under the
// line being typed, not the textarea's edge — see useMentionAutocomplete).
const MIRRORED_PROPERTIES = [
  'boxSizing',
  'width',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderStyle',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontSize',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'letterSpacing',
  'wordSpacing',
  'tabSize'
] satisfies Array<keyof CSSStyleDeclaration>

/** Pixel offset of `position` inside `el`, relative to el's own top-left
 *  (post-scroll) — the standard mirror-div trick. */
export function caretCoordinates(
  el: HTMLTextAreaElement,
  position: number
): { top: number; left: number; height: number } {
  const div = document.createElement('div')
  const computed = window.getComputedStyle(el)
  const style = div.style
  style.position = 'absolute'
  style.visibility = 'hidden'
  style.whiteSpace = 'pre-wrap'
  style.wordWrap = 'break-word'
  for (const prop of MIRRORED_PROPERTIES) style[prop] = computed[prop]
  document.body.appendChild(div)
  div.textContent = el.value.slice(0, position)
  const span = document.createElement('span')
  // An empty span at the very end of the text collapses to zero width — give
  // it a character so offsetTop/offsetLeft still land on the caret's line.
  span.textContent = el.value.slice(position) || '.'
  div.appendChild(span)
  const coords = { top: span.offsetTop - el.scrollTop, left: span.offsetLeft, height: span.offsetHeight }
  document.body.removeChild(div)
  return coords
}
