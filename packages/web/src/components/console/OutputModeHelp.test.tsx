import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OutputModeHelp } from './OutputModeHelp'
import { OutputModeField } from './OutputModeField'
import { DEFAULT_AGENT_OUTPUT_MODE, OUTPUT_MODE_OPTIONS } from '@/lib/output-mode'

describe('OutputModeHelp', () => {
  it('documents all channel-visibility levels accessibly', () => {
    const html = renderToStaticMarkup(<OutputModeHelp activeMode="medium" />)

    expect(html).toContain('aria-label="Compare output modes"')
    expect(html).toContain('aria-describedby=')
    expect(html).toContain('role="tooltip"')
    expect(html).toContain('group-hover:visible')
    expect(html).toContain('group-focus-within:visible')
    for (const mode of OUTPUT_MODE_OPTIONS) {
      expect(html).toContain(mode.label)
      expect(html).toContain(mode.description)
    }
    expect(html).toContain('All modes keep full activity in session history.')
  })

  it('defaults newly-created agents to low output', () => {
    expect(DEFAULT_AGENT_OUTPUT_MODE).toBe('low')

    const html = renderToStaticMarkup(
      <OutputModeField
        value={DEFAULT_AGENT_OUTPUT_MODE}
        onChange={() => undefined}
        showFooter
        onShowFooterChange={() => undefined}
        showStatusBar
        onShowStatusBarChange={() => undefined}
      />
    )
    expect(html).toContain('Low</button>')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-label="About Show footer"')
    expect(html).toContain('aria-label="About Show status bar"')
    expect(html).toContain('aria-describedby=')
    expect(html).toContain('group-hover:visible')
    expect(html).toContain('group-focus-within:visible')
    expect(html).toContain('On</button>')
    expect(html).toContain('Off</button>')
    expect(html).toContain('pill on px-[10px] py-1 text-[12px]" aria-pressed="true">On')
    expect(html).toContain('desktop:grid-cols-[minmax(0,1fr)_auto_auto]')
    expect(html).toContain('fld min-w-0 desktop:items-end')
    expect(html).toContain('pillbar self-start desktop:self-end')
    expect(html).toContain('data-align="right"')
    expect(html).toContain('data-[align=right]:right-0')
  })
})
