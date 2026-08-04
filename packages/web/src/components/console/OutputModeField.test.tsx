import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OutputModeField } from './OutputModeField'
import { OUTPUT_CHROME_COPY, OUTPUT_MODE_OPTIONS } from '@/lib/output-mode'

/**
 * The field's two chrome toggles. Both status-bar sentences shipped naming
 * Slack — on a control that is agent-level, rendered from the Add/Edit agent
 * modals with no platform in scope, so an agent installed only on Telegram or
 * Discord read them too. What these pin is that the copy stays provider-free
 * AND stays wired to the right arm of each toggle.
 */

/** The chat platforms the console registers, plus Lark (Feishu's other regional
 *  brand). Hardcoded rather than read from `platforms/registry`: that module
 *  pulls every wizard Body in with it, and this is a copy test. */
const PLATFORM_WORDS = /slack|telegram|discord|feishu|lark/i

/** Captured from `OutputModeField.tsx` before the copy moved. The footer pair
 *  moved verbatim — only the status-bar pair was rewritten. */
const FOOTER_ON = 'Replies show the agent, runtime, model, and session links.'
const FOOTER_OFF = 'No footer is added to replies.'

function render(props: { showFooter: boolean; showStatusBar: boolean }) {
  return renderToStaticMarkup(
    <OutputModeField
      value="low"
      onChange={() => undefined}
      onShowFooterChange={() => undefined}
      onShowStatusBarChange={() => undefined}
      {...props}
    />
  )
}

describe('Output-mode chrome copy', () => {
  it('describes the status row without naming a platform', () => {
    // The defect: an agent with no Slack integration at all was told about
    // "Slack threads" and "Slack session status rows".
    expect(OUTPUT_CHROME_COPY.statusBar.on).toBe(
      'Threads show model, context, usage, and session controls on platforms with a status row.'
    )
    expect(OUTPUT_CHROME_COPY.statusBar.off).toBe('Session status rows are hidden.')
  })

  it('qualifies the on-state instead of promising a row everywhere', () => {
    // Only a platform whose daemon turn-chrome facet declares
    // `statusSurface: 'turn-bar'` renders one (Slack today); Telegram, Discord
    // and Feishu declare `'on-demand'` and post nothing, so an unqualified
    // sentence would be the same defect with the brand filed off.
    expect(OUTPUT_CHROME_COPY.statusBar.on).toMatch(/on platforms with a status row/)
  })

  it('names no platform anywhere in the output-mode vocabulary', () => {
    const strings = [
      ...Object.values(OUTPUT_CHROME_COPY).flatMap((toggle) => Object.values(toggle)),
      ...OUTPUT_MODE_OPTIONS.flatMap((mode) => [mode.label, mode.description])
    ]
    for (const copy of strings) expect(copy, copy).not.toMatch(PLATFORM_WORDS)
  })

  it('leaves the footer sentences byte-identical', () => {
    // They were already provider-free; extracting them alongside the status-bar
    // pair must not have reworded them.
    expect(OUTPUT_CHROME_COPY.footer.on).toBe(FOOTER_ON)
    expect(OUTPUT_CHROME_COPY.footer.off).toBe(FOOTER_OFF)
  })

  it('renders each toggle’s on-arm and off-arm', () => {
    const on = render({ showFooter: true, showStatusBar: true })
    expect(on).toContain(OUTPUT_CHROME_COPY.footer.on)
    expect(on).toContain(OUTPUT_CHROME_COPY.statusBar.on)
    expect(on).not.toContain(OUTPUT_CHROME_COPY.footer.off)
    expect(on).not.toContain(OUTPUT_CHROME_COPY.statusBar.off)

    const off = render({ showFooter: false, showStatusBar: false })
    expect(off).toContain(OUTPUT_CHROME_COPY.footer.off)
    expect(off).toContain(OUTPUT_CHROME_COPY.statusBar.off)
    expect(off).not.toContain(OUTPUT_CHROME_COPY.footer.on)
    expect(off).not.toContain(OUTPUT_CHROME_COPY.statusBar.on)
  })

  it('keeps both details reachable as tooltips', () => {
    // The copy is only ever read through `CompactFieldLabel`'s tooltip, so a
    // sentence that renders without its describedby wiring is unreadable.
    const html = render({ showFooter: true, showStatusBar: true })
    expect(html).toContain('aria-label="About Show footer"')
    expect(html).toContain('aria-label="About Show status bar"')
    // Each sentence is the body of a `role="tooltip"` element, not loose text.
    // (The third tooltip in this tree is `OutputModeHelp`'s mode comparison.)
    for (const copy of [OUTPUT_CHROME_COPY.footer.on, OUTPUT_CHROME_COPY.statusBar.on]) {
      expect(html, copy).toMatch(new RegExp(`role="tooltip"[^>]*>${copy.replace(/[.]/g, '\\.')}<`))
    }
  })
})
