// @vitest-environment happy-dom

// Frontmatter rendering, driven through the REAL react-markdown pipeline: the bug was
// that `---\nkey: value\n---` came out as one giant setext heading, which only shows up
// once remark actually parses the document.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import MarkdownView from './MarkdownView'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(content: string): HTMLDivElement {
  act(() => root.render(<MarkdownView content={content} />))
  return host
}

describe('MarkdownView frontmatter', () => {
  it('renders a memory header as a keyed table, not a heading', () => {
    const out = render('---\nname: deploys\ndescription: how we ship\n---\n\nDeploy only from main.\n')
    const table = out.querySelector('table.md-frontmatter')
    expect(table).not.toBeNull()
    expect([...table!.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['name', 'description'])
    expect([...table!.querySelectorAll('tr > td')].map((td) => td.textContent)).toEqual(['deploys', 'how we ship'])
    // The regression: the header used to become an <h2> and the body followed it.
    expect(out.querySelector('h1, h2')).toBeNull()
    expect(out.textContent).toContain('Deploy only from main.')
  })

  it('nests a sequence as a row of cells and a mapping as its own table', () => {
    const out = render(
      '---\ntitle: ACP\nread_when:\n  - Setting up IDE integrations\n  - Debugging session routing\nmetadata:\n  type: reference\n---\nbody\n'
    )
    const rows = [...out.querySelectorAll('table.md-frontmatter > tbody > tr')]
    expect(rows.map((row) => row.querySelector('th')?.textContent)).toEqual(['title', 'read_when', 'metadata'])
    const listCells = [...rows[1]!.querySelectorAll('table td')]
    expect(listCells.map((td) => td.textContent)).toEqual(['Setting up IDE integrations', 'Debugging session routing'])
    const nested = rows[2]!.querySelector('table')
    expect(nested?.querySelector('th')?.textContent).toBe('type')
    expect(nested?.querySelector('td')?.textContent).toBe('reference')
  })

  it('keeps quoted scalars intact and does not print YAML syntax', () => {
    const out = render('---\ndescription: "ship: only from main"\nmodified: 2026-08-20T05:48:55.191Z\n---\nbody\n')
    expect(out.querySelector('table.md-frontmatter')?.textContent).toContain('ship: only from main')
    expect(out.textContent).not.toContain('"ship')
  })

  it('drops an unreadable block instead of rendering it as prose', () => {
    // Invalid YAML, and a scalar or sequence where a mapping belongs: metadata the
    // viewer cannot key is hidden, but the document body still renders.
    for (const header of ['description: ship: prod', 'just text', '- one\n- two']) {
      const out = render(`---\n${header}\n---\n\nthe body\n`)
      expect(out.querySelector('table')).toBeNull()
      expect(out.textContent).toContain('the body')
      expect(out.textContent).not.toContain('just text')
    }
  })

  it('leaves a mid-document thematic break alone', () => {
    const out = render('# Title\n\n---\n\nnot a header\n')
    expect(out.querySelector('table')).toBeNull()
    expect(out.querySelector('hr')).not.toBeNull()
    expect(out.querySelector('h1')?.textContent).toBe('Title')
  })
})
