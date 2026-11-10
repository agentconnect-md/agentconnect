// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { discoverInPage, fillInPage, type PageDiscovery, type PageFillArgs, type PageFillResult } from '../src/page.js'

// The functions run in frames as serialized source: rebuilt from their text, they must still work alone.
const discover = new Function(`return (${discoverInPage.toString()})`)() as () => PageDiscovery
const fill = new Function(`return (${fillInPage.toString()})`)() as (args: PageFillArgs) => PageFillResult

const CANARY = 'canary-7d1f-existing-value'
const ORIGIN = 'https://login.example.test'

function page(html: string): void {
  delete (globalThis as { __agentconnectFormFill?: unknown }).__agentconnectFormFill
  ;(window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`${ORIGIN}/signin?next=/home`)
  document.title = 'Sign in'
  document.body.innerHTML = html
}

const only = (discovery: PageDiscovery) => {
  expect(discovery.forms).toHaveLength(1)
  return discovery.forms[0]!
}

describe('discoverInPage', () => {
  beforeEach(() => page(''))

  it('describes a login form by autocomplete and type, without any field value', () => {
    page(`<form>
      <label for="u">Email or phone</label><input id="u" name="identifier" autocomplete="username" value="${CANARY}">
      <label>Password <input type="password" name="pw"></label>
      <input type="hidden" name="csrf" value="${CANARY}">
      <button>Next</button>
    </form>`)
    const discovery = discover()
    expect(discovery.origin).toBe(ORIGIN)
    expect(discovery.title).toBe('Sign in')
    const form = only(discovery)
    expect(form.kind).toBe('login')
    expect(form.fields.map((field) => [field.purpose, field.control, field.secret, field.empty, field.label])).toEqual([
      ['username', 'text', false, false, 'Email or phone'],
      ['current-password', 'password', true, true, 'Password']
    ])
    expect(JSON.stringify(discovery)).not.toContain(CANARY)
  })

  it('maps fields by name and label when autocomplete is absent, and flags disagreement', () => {
    page(`<form>
      <input name="first_name" placeholder="First name">
      <input name="lname">
      <label>Company name <input name="company"></label>
      <input name="zip" aria-label="Postal code">
      <input name="email" aria-label="Phone number">
      <textarea name="address"></textarea>
    </form>`)
    const fields = only(discover()).fields
    expect(fields.map((field) => field.purpose)).toEqual([
      'given-name',
      'family-name',
      'organization',
      'postal-code',
      'email',
      'street-address'
    ])
    expect(fields.map((field) => field.ambiguous ?? false)).toEqual([false, false, false, false, true, false])
  })

  it('treats two password fields as a registration with new passwords', () => {
    page(`<form>
      <input type="email" name="email">
      <input type="password" name="password">
      <input type="password" name="confirm">
    </form>`)
    const form = only(discover())
    expect(form.kind).toBe('registration')
    expect(form.fields.map((field) => field.purpose)).toEqual(['email', 'new-password', 'new-password'])
  })

  it('groups loose fields of the page into one form, and keeps ids stable across discoveries', () => {
    page(`<div><input name="username"></div><div><input type="password" name="password"></div>`)
    const first = only(discover())
    const second = only(discover())
    expect(first.id).toBe('page')
    expect(second.fields.map((field) => field.id)).toEqual(first.fields.map((field) => field.id))
  })

  it('leaves out hidden, disabled and read-only fields, and reports select and radio choices', () => {
    page(`<form>
      <input name="a" style="display:none"><input name="b" disabled><input name="c" readonly>
      <div hidden><input name="d"></div>
      <select name="country"><option value="">Choose</option><option value="DE">Germany</option></select>
      <label><input type="radio" name="plan" value="free"> Free</label>
      <label><input type="radio" name="plan" value="pro" checked> Pro</label>
      <label><input type="checkbox" name="terms" required> I agree</label>
    </form>`)
    const fields = only(discover()).fields
    expect(fields.map((field) => field.control)).toEqual(['select', 'radio', 'checkbox'])
    expect(fields[0]).toMatchObject({
      purpose: 'country',
      empty: true,
      options: [
        { value: '', label: 'Choose' },
        { value: 'DE', label: 'Germany' }
      ]
    })
    expect(fields[1]).toMatchObject({
      empty: false,
      options: [
        { value: 'free', label: 'Free' },
        { value: 'pro', label: 'Pro' }
      ]
    })
    expect(fields[2]).toMatchObject({ required: true, empty: true, label: 'I agree' })
  })

  it('marks the focused form', () => {
    page(
      `<form id="search"><input name="q" type="search"></form><form><input name="username"><input type="password" name="p"></form>`
    )
    ;(document.querySelector('input[name="p"]') as HTMLInputElement).focus()
    const forms = discover().forms
    expect(forms.map((form) => form.focused)).toEqual([false, true])
  })
})

describe('fillInPage', () => {
  it('writes values, fires input and change, and reports each field without its value', () => {
    page(`<form><input name="username"><input type="password" name="password" maxlength="8">
      <select name="country"><option value="">-</option><option value="DE">Germany</option></select>
      <input type="checkbox" name="remember"></form>`)
    const form = only(discover())
    const [user, password, country, remember] = form.fields.map((field) => field.id) as [string, string, string, string]
    const events: string[] = []
    for (const type of ['input', 'change'])
      document.addEventListener(type, (event) => events.push(`${type}:${(event.target as HTMLInputElement).name}`))
    const result = fill({
      formId: form.id,
      frameOrigin: ORIGIN,
      values: [
        { field: user, value: 'ada@example.test' },
        { field: password, value: 'way-too-long-password' },
        { field: country, value: 'Germany' },
        { field: remember, checked: true }
      ]
    })
    expect(result).toEqual({
      status: 'done',
      fields: [
        { field: user, status: 'filled' },
        { field: password, status: 'invalid_value' },
        { field: country, status: 'filled' },
        { field: remember, status: 'filled' }
      ]
    })
    expect((document.querySelector('input[name="username"]') as HTMLInputElement).value).toBe('ada@example.test')
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('DE')
    expect((document.querySelector('input[name="password"]') as HTMLInputElement).value).toBe('')
    expect(events).toContain('input:username')
    expect(events).toContain('change:username')
    expect(JSON.stringify(result)).not.toContain('ada@example.test')
  })

  it('refuses a frame that moved to another origin', () => {
    page(`<form><input name="username"></form>`)
    const form = only(discover())
    expect(
      fill({
        formId: form.id,
        frameOrigin: 'https://evil.example.test',
        values: [{ field: form.fields[0]!.id, value: 'x' }]
      }).status
    ).toBe('target_changed')
  })

  it('reports a field of another form, an unknown field and a disabled field without writing', () => {
    page(`<form><input name="a"></form><form><input name="b"><input name="c"></form>`)
    const [first, second] = discover().forms as [PageDiscovery['forms'][number], PageDiscovery['forms'][number]]
    ;(document.querySelector('input[name="c"]') as HTMLInputElement).disabled = true
    const result = fill({
      formId: second.id,
      frameOrigin: ORIGIN,
      values: [
        { field: first.fields[0]!.id, value: 'x' },
        { field: 'f999', value: 'x' },
        { field: second.fields[1]!.id, value: 'x' }
      ]
    })
    expect(result).toEqual({
      status: 'done',
      fields: [
        { field: first.fields[0]!.id, status: 'not_found' },
        { field: 'f999', status: 'not_found' },
        { field: second.fields[1]!.id, status: 'disabled' }
      ]
    })
    expect((document.querySelector('input[name="a"]') as HTMLInputElement).value).toBe('')
  })

  it('selects a radio by value and refuses an unknown choice', () => {
    page(`<form><input type="radio" name="plan" value="free"><input type="radio" name="plan" value="pro"></form>`)
    const form = only(discover())
    const plan = form.fields[0]!.id
    expect(fill({ formId: form.id, frameOrigin: ORIGIN, values: [{ field: plan, value: 'pro' }] })).toEqual({
      status: 'done',
      fields: [{ field: plan, status: 'filled' }]
    })
    expect((document.querySelector('input[value="pro"]') as HTMLInputElement).checked).toBe(true)
    expect(fill({ formId: form.id, frameOrigin: ORIGIN, values: [{ field: plan, value: 'gold' }] }).status).toBe('done')
  })

  it('selects a loose radio only within its own group, never a same-named radio of another form', () => {
    page(`<form><input type="radio" name="plan" value="pro"></form>
      <input type="radio" name="plan" value="free"><input type="radio" name="plan" value="pro">`)
    const loose = discover().forms.find((form) => form.id === 'page')!
    const plan = loose.fields[0]!.id
    expect(fill({ formId: loose.id, frameOrigin: ORIGIN, values: [{ field: plan, value: 'pro' }] })).toEqual({
      status: 'done',
      fields: [{ field: plan, status: 'filled' }]
    })
    const [inForm, , looseChoice] = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="plan"]'))
    expect(inForm!.checked).toBe(false)
    expect(looseChoice!.checked).toBe(true)
  })

  it('needs a discovery in this document first', () => {
    page(`<form><input name="a"></form>`)
    expect(fill({ formId: 'page', frameOrigin: ORIGIN, values: [{ field: 'f1', value: 'x' }] }).status).toBe(
      'target_changed'
    )
  })
})
