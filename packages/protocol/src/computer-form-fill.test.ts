import { describe, expect, it } from 'vitest'
import {
  ComputerFormDiscovery,
  ComputerFormField,
  ComputerFormFillArgs,
  ComputerFormFillResult,
  ComputerFormOrigin,
  ComputerFormValue,
  FormFillHello,
  FormFillRequest
} from './computer-form-fill.js'
import { ComputerCapabilitiesSchema } from './frames/computer.js'

const target = {
  tabId: 3,
  frameId: 0,
  documentId: 'C0FFEE',
  topOrigin: 'https://login.example.test',
  frameOrigin: 'https://login.example.test',
  formId: 'form-1'
}
const requestId = '7f9d6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f'

describe('computer form fill contract (computer-form-fill-and-vault.md §5, §8)', () => {
  it('accepts only serialized http(s) origins, never a URL with a path or query', () => {
    expect(ComputerFormOrigin.safeParse('https://login.example.test').success).toBe(true)
    expect(ComputerFormOrigin.safeParse('http://127.0.0.1:8080').success).toBe(true)
    expect(ComputerFormOrigin.safeParse('https://login.example.test/').success).toBe(false)
    expect(ComputerFormOrigin.safeParse('https://login.example.test/signin?token=x').success).toBe(false)
    expect(ComputerFormOrigin.safeParse('https://LOGIN.example.test').success).toBe(false)
    expect(ComputerFormOrigin.safeParse('chrome-extension://abc').success).toBe(false)
    expect(ComputerFormOrigin.safeParse('file:///tmp/x').success).toBe(false)
  })

  it('has no place for a field value in a descriptor', () => {
    const field = {
      id: 'f1',
      control: 'password',
      purpose: 'current-password',
      required: true,
      secret: true,
      empty: true
    }
    expect(ComputerFormField.safeParse(field).success).toBe(true)
    expect(ComputerFormField.safeParse({ ...field, value: 'hunter2' }).success).toBe(false)
    expect(ComputerFormField.safeParse({ ...field, id: 'has space' }).success).toBe(false)
  })

  it('takes exactly one of a text value or a checked state per field', () => {
    expect(ComputerFormValue.safeParse({ field: 'f1', value: 'x' }).success).toBe(true)
    expect(ComputerFormValue.safeParse({ field: 'f1', checked: true }).success).toBe(true)
    expect(ComputerFormValue.safeParse({ field: 'f1' }).success).toBe(false)
    expect(ComputerFormValue.safeParse({ field: 'f1', value: 'x', checked: true }).success).toBe(false)
  })

  it('binds a fill to one document and form, under the current protocol only', () => {
    const args = { v: 1, requestId, target, values: [{ field: 'f1', value: 'ada@example.test' }] }
    expect(ComputerFormFillArgs.safeParse(args).success).toBe(true)
    expect(ComputerFormFillArgs.safeParse({ ...args, v: 2 }).success).toBe(false)
    expect(ComputerFormFillArgs.safeParse({ ...args, values: [] }).success).toBe(false)
    const { documentId: _, ...withoutDocument } = target
    expect(ComputerFormFillArgs.safeParse({ ...args, target: withoutDocument }).success).toBe(false)
  })

  it('reports per-field outcomes without values', () => {
    const result = {
      v: 1,
      requestId,
      status: 'partial',
      fields: [
        { field: 'f1', status: 'filled' },
        { field: 'f2', status: 'not_found' }
      ],
      navigated: false
    }
    expect(ComputerFormFillResult.safeParse(result).success).toBe(true)
    expect(
      ComputerFormFillResult.safeParse({ ...result, fields: [{ field: 'f1', status: 'filled', value: 'x' }] }).success
    ).toBe(false)
  })

  it('carries discovered forms with the document each lives in', () => {
    const discovery = {
      v: 1,
      status: 'ambiguous',
      tab: { tabId: 3, topOrigin: 'https://login.example.test', title: 'Sign in' },
      forms: [
        {
          id: 'form-1',
          kind: 'login',
          focused: false,
          frameOrigin: target.frameOrigin,
          frameId: 0,
          documentId: 'C0FFEE',
          fields: []
        },
        {
          id: 'form-2',
          kind: 'other',
          focused: false,
          frameOrigin: target.frameOrigin,
          frameId: 0,
          documentId: 'C0FFEE',
          fields: []
        }
      ]
    }
    expect(ComputerFormDiscovery.safeParse(discovery).success).toBe(true)
  })

  it('parses the extension wire', () => {
    expect(FormFillHello.safeParse({ type: 'hello', protocol: 1, buildId: 'b1', version: '1.0.0' }).success).toBe(true)
    expect(FormFillRequest.safeParse({ type: 'discover', id: 1 }).success).toBe(true)
    expect(
      FormFillRequest.safeParse({ type: 'fill', id: 2, requestId, target, values: [{ field: 'f1', value: 'x' }] })
        .success
    ).toBe(true)
    expect(FormFillRequest.safeParse({ type: 'eval', id: 3 }).success).toBe(false)
  })

  it('lets a desktop report the capability, and an older one omit it', () => {
    expect(ComputerCapabilitiesSchema.parse({ formFill: true }).formFill).toBe(true)
    expect(ComputerCapabilitiesSchema.parse({}).formFill).toBeUndefined()
  })
})
