// Runs inside a page frame through chrome.scripting (isolated world); each function is serialized, so it must be self-contained.
import type {
  ComputerFormFieldStatus,
  ComputerFormKind,
  ComputerFormPurpose
} from '@agentconnect.md/protocol/computer-form-fill'

/** One frame's forms, as the page sees them: ids are local to this document. */
export interface PageDiscovery {
  origin: string
  title: string
  forms: PageForm[]
}

export interface PageForm {
  id: string
  kind: ComputerFormKind
  focused: boolean
  fields: PageField[]
}

export interface PageField {
  id: string
  control: string
  purpose: ComputerFormPurpose
  ambiguous?: boolean
  label?: string
  name?: string
  placeholder?: string
  autocomplete?: string
  required: boolean
  secret: boolean
  empty: boolean
  maxLength?: number
  options?: { value: string; label: string }[]
}

export interface PageFillArgs {
  formId: string
  frameOrigin: string
  values: { field: string; value?: string; checked?: boolean }[]
}

export type PageFillResult =
  | { status: 'target_changed'; reason: string }
  | { status: 'done'; fields: { field: string; status: ComputerFormFieldStatus }[] }

/** Finds the frame's visible editable fields, grouped by form, without reading any value out. */
export function discoverInPage(): PageDiscovery {
  const MAX_FIELDS = 100
  const MAX_FORMS = 20
  const MAX_OPTIONS = 200
  const TEXT = 200
  const INPUT_TYPES = new Set([
    'text',
    'email',
    'password',
    'tel',
    'number',
    'url',
    'search',
    'date',
    'checkbox',
    'radio'
  ])
  const AUTOCOMPLETE: Record<string, ComputerFormPurpose> = {
    username: 'username',
    email: 'email',
    'current-password': 'current-password',
    'new-password': 'new-password',
    'one-time-code': 'one-time-code',
    name: 'name',
    'given-name': 'given-name',
    'family-name': 'family-name',
    tel: 'tel',
    'tel-national': 'tel',
    organization: 'organization',
    'street-address': 'street-address',
    'address-line1': 'address-line1',
    'address-line2': 'address-line2',
    'address-level2': 'address-level2',
    'address-level1': 'address-level1',
    'postal-code': 'postal-code',
    country: 'country',
    'country-name': 'country'
  }
  // Most specific first: the first rule that matches a text decides its purpose.
  const RULES: [ComputerFormPurpose, RegExp][] = [
    ['one-time-code', /\b(otp|one[\s_-]?time|2fa|mfa|totp|passcode)\b|verification[\s_-]?code|security[\s_-]?code/],
    ['email', /e[\s_-]?mail/],
    ['username', /user|login|account|identifier/],
    ['given-name', /first[\s_-]?name|given[\s_-]?name|\bfname\b|forename/],
    ['family-name', /last[\s_-]?name|family[\s_-]?name|surname|\blname\b/],
    ['organization', /company|organi[sz]ation|employer|business/],
    ['tel', /phone|mobile|\btel\b|telephone/],
    ['address-line2', /address[\s_-]?(line)?[\s_-]?2|\bapt\b|apartment|suite/],
    ['address-level2', /\bcity\b|\btown\b|locality/],
    ['address-level1', /\bstate\b|province|\bregion\b|county/],
    ['postal-code', /\bzip\b|zip[\s_-]?code|postal|post[\s_-]?code/],
    ['country', /country/],
    ['address-line1', /address[\s_-]?(line)?[\s_-]?1|street|address/],
    ['name', /full[\s_-]?name|your[\s_-]?name|^name$|\bname\b/]
  ]
  const PERSONAL = new Set<ComputerFormPurpose>([
    'name',
    'given-name',
    'family-name',
    'tel',
    'organization',
    'street-address',
    'address-line1',
    'address-line2',
    'address-level2',
    'address-level1',
    'postal-code',
    'country'
  ])

  type Registry = {
    next: number
    ids: WeakMap<Element, string>
    byId: Map<string, WeakRef<Element>>
    forms: WeakMap<object, string>
  }
  const scope = globalThis as unknown as { __agentconnectFormFill?: Registry }
  const registry = (scope.__agentconnectFormFill ??= {
    next: 1,
    ids: new WeakMap(),
    byId: new Map(),
    forms: new WeakMap()
  })
  const idOf = (element: Element): string => {
    let id = registry.ids.get(element)
    if (!id) {
      id = `f${registry.next++}`
      registry.ids.set(element, id)
      registry.byId.set(id, new WeakRef(element))
    }
    return id
  }
  const formIdOf = (owner: HTMLFormElement | Document): string => {
    let id = registry.forms.get(owner)
    if (!id) {
      id = owner === document ? 'page' : `form${registry.next++}`
      registry.forms.set(owner, id)
    }
    return id
  }

  const clean = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, TEXT)
  // A label's own words, without the text of controls (a select's options) it may wrap.
  const ownText = (node: Element): string => {
    const copy = node.cloneNode(true) as Element
    for (const control of copy.querySelectorAll('input, select, textarea, option, button')) control.remove()
    return clean(copy.textContent)
  }
  const labelOf = (element: HTMLElement): string => {
    const parts: string[] = []
    const labels = (element as HTMLInputElement).labels
    if (labels) for (const label of labels) parts.push(ownText(label))
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy)
      for (const id of labelledBy.split(/\s+/)) {
        const node = document.getElementById(id)
        if (node) parts.push(ownText(node))
      }
    parts.push(clean(element.getAttribute('aria-label')))
    if (!parts.some(Boolean)) {
      const wrapping = element.closest('label')
      if (wrapping) parts.push(ownText(wrapping))
    }
    if (!parts.some(Boolean)) parts.push(clean(element.getAttribute('title')))
    return clean(parts.filter(Boolean).join(' '))
  }
  const layout = document.documentElement.getBoundingClientRect().width > 0
  const visible = (element: HTMLElement): boolean => {
    if (element.hidden || element.closest('[hidden], [aria-hidden="true"]')) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    if (typeof element.checkVisibility === 'function' && !element.checkVisibility()) return false
    if (!layout) return true
    const rect = element.getBoundingClientRect()
    return rect.width >= 2 && rect.height >= 2
  }
  const firstRule = (text: string): ComputerFormPurpose | undefined =>
    text ? RULES.find(([, pattern]) => pattern.test(text))?.[0] : undefined
  const fromAutocomplete = (value: string): ComputerFormPurpose | undefined => {
    const tokens = value
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token && !/^section-/.test(token))
      .filter((token) => !['shipping', 'billing', 'home', 'work', 'mobile', 'fax', 'pager', 'webauthn'].includes(token))
    return AUTOCOMPLETE[tokens[tokens.length - 1] ?? '']
  }

  const controls = Array.from(document.querySelectorAll<HTMLElement>('input, select, textarea'))
  const groups = new Map<HTMLFormElement | Document, HTMLElement[]>()
  for (const element of controls) {
    if (element instanceof HTMLInputElement) {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase()
      if (!INPUT_TYPES.has(type)) continue
      if (element.readOnly) continue
    }
    if ((element as HTMLInputElement).disabled || !visible(element)) continue
    const owner = (element as HTMLInputElement).form ?? document
    const list = groups.get(owner) ?? []
    list.push(element)
    groups.set(owner, list)
  }

  const active = document.activeElement
  const forms: PageForm[] = []
  let total = 0
  for (const [owner, elements] of groups) {
    if (forms.length >= MAX_FORMS) break
    const fields: PageField[] = []
    const radios = new Set<string>()
    const passwords = elements.filter((element) => (element as HTMLInputElement).type === 'password').length
    let focused = false
    for (const element of elements) {
      if (total >= MAX_FIELDS) break
      if (element === active) focused = true
      const input = element as HTMLInputElement
      const tag = element.tagName.toLowerCase()
      const control = tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : input.type
      // A radio group is one field whose options are its radios.
      let group: HTMLInputElement[] = [input]
      if (control === 'radio') {
        const name = input.name
        if (name && radios.has(name)) continue
        if (name) radios.add(name)
        group = name
          ? elements.filter(
              (other): other is HTMLInputElement =>
                (other as HTMLInputElement).type === 'radio' && (other as HTMLInputElement).name === name
            )
          : [input]
        if (group.some((radio) => radio === active)) focused = true
      }
      const name = clean(input.getAttribute('name') ?? input.id)
      const label = labelOf(element)
      const placeholder = clean(input.getAttribute('placeholder'))
      const autocomplete = clean(input.getAttribute('autocomplete')).slice(0, 100)
      let purpose: ComputerFormPurpose = fromAutocomplete(autocomplete) ?? 'unknown'
      let ambiguous = false
      if (purpose === 'unknown') {
        const byAttribute = firstRule(`${name} ${input.id}`.toLowerCase().trim())
        const byLabel = firstRule(`${label} ${placeholder}`.toLowerCase().trim())
        purpose = byAttribute ?? byLabel ?? 'unknown'
        ambiguous = byAttribute !== undefined && byLabel !== undefined && byAttribute !== byLabel
        if (control === 'password') {
          const renewing = /new|confirm|repeat|retype|again|create|choose/.test(
            `${name} ${label} ${placeholder}`.toLowerCase()
          )
          purpose = renewing || passwords > 1 ? 'new-password' : 'current-password'
          ambiguous = false
        } else if (control === 'email' && purpose !== 'username') purpose = 'email'
        else if (control === 'tel' && purpose === 'unknown') purpose = 'tel'
        if (purpose === 'address-line1' && control === 'textarea') purpose = 'street-address'
      }
      const secret =
        control === 'password' ||
        purpose === 'current-password' ||
        purpose === 'new-password' ||
        purpose === 'one-time-code'
      let empty: boolean
      let options: { value: string; label: string }[] | undefined
      if (control === 'select') {
        const select = element as HTMLSelectElement
        empty = select.selectedIndex < 0 || select.value === ''
        options = Array.from(select.options)
          .slice(0, MAX_OPTIONS)
          .map((option) => ({ value: option.value.slice(0, 512), label: clean(option.label || option.text) }))
      } else if (control === 'radio') {
        empty = !group.some((radio) => radio.checked)
        options = group
          .slice(0, MAX_OPTIONS)
          .map((radio) => ({ value: radio.value.slice(0, 512), label: labelOf(radio) }))
      } else if (control === 'checkbox') empty = !input.checked
      else empty = input.value === ''
      const maxLength = input.maxLength > 0 ? input.maxLength : undefined
      fields.push({
        id: idOf(element),
        control,
        purpose,
        ...(ambiguous ? { ambiguous } : {}),
        ...(label ? { label } : {}),
        ...(name ? { name } : {}),
        ...(placeholder ? { placeholder } : {}),
        ...(autocomplete ? { autocomplete } : {}),
        required: group.some((radio) => radio.required),
        secret,
        empty,
        ...(maxLength ? { maxLength } : {}),
        ...(options ? { options } : {})
      })
      total++
    }
    if (fields.length === 0) continue
    const purposes = fields.map((field) => field.purpose)
    const secrets = purposes.filter((purpose) => purpose === 'current-password' || purpose === 'new-password').length
    const personal = purposes.filter((purpose) => PERSONAL.has(purpose)).length
    const kind: ComputerFormKind =
      purposes.includes('new-password') || secrets > 1
        ? 'registration'
        : secrets === 1 || purposes.includes('one-time-code') || (purposes.includes('username') && fields.length <= 2)
          ? personal >= 2
            ? 'registration'
            : 'login'
          : personal >= 2
            ? 'personal_info'
            : 'other'
    forms.push({ id: formIdOf(owner), kind, focused, fields })
  }
  return { origin: location.origin, title: clean(document.title), forms }
}

/** Writes values into one discovered form; checks the frame is still the discovered origin first. Never reads values back out. */
export function fillInPage(args: PageFillArgs): PageFillResult {
  type Registry = { byId: Map<string, WeakRef<Element>>; forms: WeakMap<object, string> }
  const registry = (globalThis as unknown as { __agentconnectFormFill?: Registry }).__agentconnectFormFill
  if (location.origin !== args.frameOrigin)
    return { status: 'target_changed', reason: 'the frame is on another origin now' }
  if (!registry) return { status: 'target_changed', reason: 'the page was replaced since the form was discovered' }
  const fire = (element: Element) => {
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const fields: { field: string; status: ComputerFormFieldStatus }[] = []
  for (const entry of args.values) {
    const element = registry.byId.get(entry.field)?.deref()
    const owner = element ? ((element as HTMLInputElement).form ?? document) : undefined
    if (!element || !element.isConnected || !owner || registry.forms.get(owner) !== args.formId) {
      fields.push({ field: entry.field, status: 'not_found' })
      continue
    }
    const input = element as HTMLInputElement
    if (input.disabled || input.readOnly) {
      fields.push({ field: entry.field, status: 'disabled' })
      continue
    }
    const tag = element.tagName.toLowerCase()
    if (tag === 'select') {
      const select = element as HTMLSelectElement
      const wanted = entry.value ?? ''
      const option =
        Array.from(select.options).find((candidate) => candidate.value === wanted) ??
        Array.from(select.options).find((candidate) => (candidate.label || candidate.text).trim() === wanted.trim())
      if (!option || entry.value === undefined) {
        fields.push({ field: entry.field, status: 'invalid_value' })
        continue
      }
      select.value = option.value
      fire(select)
      fields.push({ field: entry.field, status: select.value === option.value ? 'filled' : 'unverified' })
      continue
    }
    if (input.type === 'radio') {
      const group =
        input.name && input.form
          ? Array.from(input.form.elements)
          : input.name
            ? Array.from(document.getElementsByName(input.name))
            : [input]
      const radios = group.filter(
        (other): other is HTMLInputElement =>
          // Only the discovered group: a loose radio's name also matches same-named radios inside other forms.
          other instanceof HTMLInputElement &&
          other.type === 'radio' &&
          other.name === input.name &&
          other.form === input.form
      )
      const choice = entry.value === undefined ? undefined : radios.find((radio) => radio.value === entry.value)
      if (!choice || choice.disabled) {
        fields.push({ field: entry.field, status: 'invalid_value' })
        continue
      }
      if (!choice.checked) choice.click()
      fields.push({ field: entry.field, status: choice.checked ? 'filled' : 'unverified' })
      continue
    }
    if (input.type === 'checkbox') {
      if (entry.checked === undefined) {
        fields.push({ field: entry.field, status: 'invalid_value' })
        continue
      }
      // A click toggles it the way a person would, so frameworks see their own change event.
      if (input.checked !== entry.checked) input.click()
      fields.push({ field: entry.field, status: input.checked === entry.checked ? 'filled' : 'unverified' })
      continue
    }
    const value = entry.value
    if (value === undefined || (input.maxLength > 0 && value.length > input.maxLength)) {
      fields.push({ field: entry.field, status: 'invalid_value' })
      continue
    }
    // The native setter from the isolated world, then the events a framework's controlled input listens for.
    input.value = value
    fire(input)
    const landed = input.value === value
    fields.push({
      field: entry.field,
      status: landed ? 'filled' : input.value === '' && value !== '' ? 'invalid_value' : 'unverified'
    })
  }
  return { status: 'done', fields }
}
