// YAML frontmatter in a Markdown preview, rendered the way GitHub renders it: a
// keyed table above the document instead of the setext heading CommonMark would
// otherwise make of `---\nkey: value\n---`.
//
// The pieces are off the shelf — `remark-frontmatter` recognizes the block (so it
// never reaches the paragraph/heading rules) and `yaml` reads it. Only the table
// shape below is ours, because GitHub's renderer is not published as a plugin.

import { parse as parseYaml } from 'yaml'
import type { Element, ElementContent } from 'hast'
import type { Handler } from 'mdast-util-to-hast'

function element(tagName: string, children: ElementContent[]): Element {
  return { type: 'element', tagName, properties: {}, children }
}

function text(value: string): ElementContent {
  return { type: 'text', value }
}

/** One value. A sequence becomes a row of cells and a mapping a keyed table — nesting
 *  a table inside a cell is why this builds hast rather than an mdast table node. */
function valueContent(value: unknown): ElementContent[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) {
    if (value.length === 0) return []
    const cells = value.map((item) => element('td', valueContent(item)))
    return [element('table', [element('tbody', [element('tr', cells)])])]
  }
  if (typeof value === 'object') {
    const rows = mappingRows(value as Record<string, unknown>)
    return rows.length > 0 ? [element('table', [element('tbody', rows)])] : []
  }
  return [text(String(value))]
}

function mappingRows(mapping: Record<string, unknown>): Element[] {
  return Object.entries(mapping).map(([key, value]) => {
    const th: Element = { type: 'element', tagName: 'th', properties: { scope: 'row' }, children: [text(key)] }
    return element('tr', [th, element('td', valueContent(value))])
  })
}

/**
 * mdast-to-hast handler for the `yaml` node `remark-frontmatter` produces.
 *
 * Anything that is not a mapping — invalid YAML, a bare scalar, a sequence — returns
 * `undefined`, which drops the node from the output. The block is metadata, so hiding
 * an unreadable one beats rendering it as prose that was never meant to be read.
 */
export const frontmatterTableHandler: Handler = (_state, node) => {
  const raw = typeof (node as { value?: unknown }).value === 'string' ? (node as { value: string }).value : ''
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const rows = mappingRows(parsed as Record<string, unknown>)
  if (rows.length === 0) return undefined
  return {
    type: 'element',
    tagName: 'table',
    properties: { className: ['md-frontmatter'] },
    children: [element('tbody', rows)]
  }
}
