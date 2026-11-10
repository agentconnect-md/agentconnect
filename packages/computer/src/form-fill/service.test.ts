import type { FormFillReply } from '@agentconnect.md/protocol/computer-form-fill'
import { describe, expect, it } from 'vitest'
import type { AuditRecord } from '../audit.js'
import { Computer, type ToolOutput } from '../computer.js'
import { FakeDriver, testConfig } from '../testing.js'
import { FormFillLinkError } from './endpoint.js'
import { FormFillService } from './service.js'

const CANARY = 'canary-4b2e-password'
const requestId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const target = {
  tabId: 1,
  frameId: 0,
  documentId: 'D0',
  topOrigin: 'https://login.example.test',
  frameOrigin: 'https://login.example.test',
  formId: '0:form1'
}
const fillArgs = (n: number) => ({
  v: 1 as const,
  requestId: requestId(n),
  target,
  values: [{ field: 'f2', value: CANARY }]
})

function setup(reply: (body: { type: string; requestId?: string }) => Promise<FormFillReply>, connected = true) {
  const audit: AuditRecord[] = []
  const computer = new Computer({
    driver: new FakeDriver(),
    config: testConfig({ humanIdleSeconds: 0 }),
    audit: (record) => audit.push(record)
  })
  const sent: unknown[] = []
  const service = new FormFillService({
    connected: () => connected,
    unavailableReason: () => "this desktop's browser runs another extension build; restart the browser",
    request: async (_desktop, body) => {
      sent.push(body)
      return reply(body as { type: string; requestId?: string })
    }
  })
  return { audit, computer, sent, service }
}

const json = (output: ToolOutput) =>
  JSON.parse(output.content[0]!.type === 'text' ? output.content[0]!.text! : '') as Record<string, unknown>

const filled = async (body: { requestId?: string }): Promise<FormFillReply> => ({
  type: 'reply',
  id: 1,
  fill: {
    v: 1,
    requestId: body.requestId!,
    status: 'filled',
    fields: [{ field: 'f2', status: 'filled' }],
    navigated: false
  }
})

describe('FormFillService (computer-form-fill-and-vault.md §5.2, §8)', () => {
  it('fills under the control lease and audits no value', async () => {
    const { audit, computer, sent, service } = setup(filled)
    const output = await service.fill(computer, 'main', 'agent-1', fillArgs(1))
    expect(json(output)).toMatchObject({ status: 'filled', fields: [{ field: 'f2', status: 'filled' }] })
    expect(computer.info().lease).toMatchObject({ holder: 'agent-1' })
    expect(sent).toHaveLength(1)
    expect(audit).toEqual([
      expect.objectContaining({
        tool: 'computer_form_fill',
        outcome: 'ok',
        args: { requestId: requestId(1), origin: target.frameOrigin, fields: 1 }
      })
    ])
    expect(JSON.stringify(audit)).not.toContain(CANARY)
    expect(JSON.stringify(output)).not.toContain(CANARY)
  })

  it('refuses while another holder has the computer or the owner paused it, sending nothing', async () => {
    const { computer, sent, service } = setup(filled)
    computer.acquire('agent-2')
    expect(json(await service.fill(computer, 'main', 'agent-1', fillArgs(2)))).toMatchObject({ error: 'computer_busy' })
    computer.release('agent-2')
    computer.pause('owner stopped agents')
    expect(json(await service.fill(computer, 'main', 'agent-1', fillArgs(3)))).toMatchObject({
      error: 'human_in_control'
    })
    expect(sent).toEqual([])
  })

  it('never sends one request id twice, and reports it by status', async () => {
    const { computer, sent, service } = setup(filled)
    await service.fill(computer, 'main', 'agent-1', fillArgs(4))
    expect(json(await service.fill(computer, 'main', 'agent-1', fillArgs(4)))).toMatchObject({
      error: 'invalid_argument'
    })
    expect(sent).toHaveLength(1)
    expect(json(service.status({ v: 1, requestId: requestId(4) }))).toMatchObject({
      state: 'done',
      result: { status: 'filled' }
    })
    expect(json(service.status({ v: 1, requestId: requestId(99) }))).toMatchObject({ state: 'unknown' })
  })

  it('is uncertain when the link drops after sending, and unsupported when nothing could be sent', async () => {
    const lost = setup(async () => {
      throw new FormFillLinkError('the browser extension link closed (closed)', true)
    })
    const uncertain = json(await lost.service.fill(lost.computer, 'main', 'agent-1', fillArgs(5)))
    expect(uncertain).toMatchObject({ status: 'uncertain' })
    expect(String(uncertain.reason)).toMatch(/not retried/)
    const offline = setup(filled, false)
    expect(json(await offline.service.fill(offline.computer, 'main', 'agent-1', fillArgs(6)))).toMatchObject({
      status: 'unsupported',
      reason: expect.stringMatching(/restart the browser; nothing was sent/)
    })
    expect(offline.sent).toEqual([])
  })

  it('is cancelled when the caller gave up before anything was sent', async () => {
    const { computer, sent, service } = setup(filled)
    const abort = new AbortController()
    abort.abort()
    expect(json(await service.fill(computer, 'main', 'agent-1', fillArgs(7), abort.signal))).toMatchObject({
      status: 'cancelled'
    })
    expect(sent).toEqual([])
  })

  it('discovers without a lease and reports a missing extension as unsupported', async () => {
    const discovery = { v: 1, status: 'none', forms: [], reason: 'no fillable form on this page' }
    const { computer, service } = setup(async () => ({ type: 'reply', id: 1, discovery }) as FormFillReply)
    expect(json(await service.discover(computer, 'main', 'agent-1', { v: 1 }))).toEqual(discovery)
    expect(computer.info().lease).toBeNull()
    const offline = setup(async () => {
      throw new FormFillLinkError("this desktop's browser extension is not connected", false)
    }, false)
    expect(json(await offline.service.discover(offline.computer, 'main', 'agent-1', { v: 1 }))).toMatchObject({
      status: 'unsupported'
    })
  })
})
