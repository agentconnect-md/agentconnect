import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SessionRetentionField, parseCustomDays } from './SessionRetentionField'

describe('parseCustomDays', () => {
  it('accepts only a complete integer day count', () => {
    expect(parseCustomDays('1')).toBe(1)
    expect(parseCustomDays('3')).toBe(3)
    expect(parseCustomDays('45')).toBe(45)
    expect(parseCustomDays('9999')).toBe(9999)
    expect(parseCustomDays(' 14 ')).toBe(14) // number-input text is trimmed
  })

  it("rejects prefix-parsable text that parseInt would coerce ('1.5' → 1, '1e2' → 1)", () => {
    // A prefix parse would silently save a window the operator didn't type.
    expect(parseCustomDays('1.5')).toBeNull()
    expect(parseCustomDays('1e2')).toBeNull()
    expect(parseCustomDays('7d')).toBeNull()
  })

  it('rejects zero, negatives, and counts past the protocol cap', () => {
    expect(parseCustomDays('0')).toBeNull()
    expect(parseCustomDays('-3')).toBeNull()
    expect(parseCustomDays('10000')).toBeNull() // shared SESSION_RETENTION_RE caps at 4 digits
    expect(parseCustomDays('')).toBeNull()
    expect(parseCustomDays('07')).toBeNull() // no leading zeros — mirrors the wire regex
  })
})

describe('SessionRetentionField', () => {
  it('renders presets and marks the 7d default', () => {
    const html = renderToStaticMarkup(<SessionRetentionField value="7d" onChange={() => undefined} />)
    expect(html).toContain('After 7 days')
    expect(html).toContain('· default')
    expect(html).toContain('Custom…')
    // Preset value ⇒ the custom day input stays hidden.
    expect(html).not.toContain('aria-label="Expire sessions after (days)"')
  })

  it('shows the bounded day input for a custom value', () => {
    const html = renderToStaticMarkup(<SessionRetentionField value="45d" onChange={() => undefined} />)
    expect(html).toContain('After 45 days')
    const input = html.match(/<input[^>]*aria-label="Expire sessions after \(days\)"[^>]*>/)?.[0] ?? ''
    expect(input).toContain('type="number"')
    expect(input).toContain('min="1"')
    expect(input).toContain('max="9999"') // client-side mirror of the protocol cap
    expect(input).toContain('value="45"')
  })

  it("renders 'Never' without the day input", () => {
    const html = renderToStaticMarkup(<SessionRetentionField value="never" onChange={() => undefined} />)
    expect(html).toContain('Never')
    expect(html).not.toContain('aria-label="Expire sessions after (days)"')
  })
})
