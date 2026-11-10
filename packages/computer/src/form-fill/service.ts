// The desktop's form operations behind computer_form_* (computer-form-fill-and-vault.md §5.2): discovery, a leased fill, status.
import {
  COMPUTER_FORM_FILL_PROTOCOL,
  COMPUTER_FORM_FILL_TIMEOUT_MS,
  ComputerFormDiscovery,
  ComputerFormFillResult,
  type ComputerFormDiscoverArgs,
  type ComputerFormFillArgs,
  type ComputerFormStatus,
  type ComputerFormStatusArgs
} from '@agentconnect.md/protocol/computer-form-fill'
import type { ToolOutput } from '../computer.js'
import { FormFillLinkError, type FormFillEndpoint } from './endpoint.js'

/** What the service needs of a desktop's Computer: an audited observation, and an action under its control lease. */
export interface FormFillComputer {
  observe(
    client: string,
    tool: string,
    args: Record<string, unknown>,
    run: () => Promise<ToolOutput>
  ): Promise<ToolOutput>
  formAction(
    client: string,
    tool: string,
    args: Record<string, unknown>,
    run: () => Promise<ToolOutput>
  ): Promise<ToolOutput>
}

interface FillRecord {
  state: 'running' | 'done'
  result?: ComputerFormFillResult
  at: number
}

const DISCOVER_TIMEOUT_MS = 10_000
// The extension gives up at its own timeout first; this covers the link on top.
const LINK_MARGIN_MS = 5000
const KEPT = 256
const KEPT_MS = 10 * 60_000

const text = (value: unknown, isError = false): ToolOutput => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {})
})

export class FormFillService {
  private readonly requests = new Map<string, FillRecord>()
  private readonly now: () => number

  constructor(
    private readonly endpoint: Pick<FormFillEndpoint, 'request' | 'connected' | 'unavailableReason'>,
    options: { now?: () => number } = {}
  ) {
    this.now = options.now ?? Date.now
  }

  async discover(
    computer: FormFillComputer,
    desktop: string,
    client: string,
    args: ComputerFormDiscoverArgs
  ): Promise<ToolOutput> {
    return computer.observe(client, 'computer_form_discover', args.form ? { form: args.form } : {}, async () => {
      try {
        const reply = await this.endpoint.request(
          desktop,
          { type: 'discover', ...(args.form ? { form: args.form } : {}) },
          DISCOVER_TIMEOUT_MS
        )
        if (reply.error || !reply.discovery)
          return text(
            { error: 'unavailable', message: `the browser could not read the page: ${reply.error ?? 'no answer'}` },
            true
          )
        return text(ComputerFormDiscovery.parse(reply.discovery))
      } catch (error) {
        if (!(error instanceof FormFillLinkError)) throw error
        return text({ v: COMPUTER_FORM_FILL_PROTOCOL, status: 'unsupported', forms: [], reason: error.message })
      }
    })
  }

  async fill(
    computer: FormFillComputer,
    desktop: string,
    client: string,
    args: ComputerFormFillArgs,
    signal?: AbortSignal
  ): Promise<ToolOutput> {
    this.sweep()
    const known = this.requests.get(args.requestId)
    if (known) {
      return text(
        {
          error: 'invalid_argument',
          message: 'this requestId was already used; a fill is never sent twice, ask computer_form_status'
        },
        true
      )
    }
    const record: FillRecord = { state: 'running', at: this.now() }
    this.requests.set(args.requestId, record)
    const outcome = (status: ComputerFormFillResult['status'], reason: string): ComputerFormFillResult => ({
      v: COMPUTER_FORM_FILL_PROTOCOL,
      requestId: args.requestId,
      status,
      fields: [],
      navigated: false,
      reason
    })
    // Only what was filled where is audited: never a value.
    const audited = { requestId: args.requestId, origin: args.target.frameOrigin, fields: args.values.length }
    const output = await computer.formAction(client, 'computer_form_fill', audited, async () => {
      let result: ComputerFormFillResult
      if (signal?.aborted) result = outcome('cancelled', 'cancelled before anything was sent to the browser')
      else if (!this.endpoint.connected(desktop))
        result = outcome('unsupported', `${this.endpoint.unavailableReason(desktop)}; nothing was sent`)
      else {
        try {
          const reply = await this.endpoint.request(
            desktop,
            { type: 'fill', requestId: args.requestId, target: args.target, values: args.values },
            COMPUTER_FORM_FILL_TIMEOUT_MS + LINK_MARGIN_MS
          )
          const parsed = ComputerFormFillResult.safeParse(reply.fill)
          result =
            parsed.success && parsed.data.requestId === args.requestId
              ? parsed.data
              : outcome(
                  'uncertain',
                  `the browser answered without a result (${reply.error ?? 'malformed'}); the fill was not retried`
                )
        } catch (error) {
          if (!(error instanceof FormFillLinkError)) throw error
          result = error.sent
            ? outcome('uncertain', `${error.message}; the fill may or may not have happened and was not retried`)
            : outcome('unsupported', `${error.message}; nothing was sent`)
        }
      }
      record.result = result
      return text(result)
    })
    record.state = 'done'
    record.at = this.now()
    // Refused before running (busy, paused, a person active): no result, and the id stays spent.
    return output
  }

  status(args: ComputerFormStatusArgs): ToolOutput {
    this.sweep()
    const record = this.requests.get(args.requestId)
    const status: ComputerFormStatus = !record
      ? { v: COMPUTER_FORM_FILL_PROTOCOL, requestId: args.requestId, state: 'unknown' }
      : record.state === 'running'
        ? { v: COMPUTER_FORM_FILL_PROTOCOL, requestId: args.requestId, state: 'running' }
        : record.result
          ? { v: COMPUTER_FORM_FILL_PROTOCOL, requestId: args.requestId, state: 'done', result: record.result }
          : { v: COMPUTER_FORM_FILL_PROTOCOL, requestId: args.requestId, state: 'unknown' }
    return text(status)
  }

  private sweep(): void {
    const cutoff = this.now() - KEPT_MS
    for (const [id, record] of this.requests) {
      if (this.requests.size <= KEPT && record.at >= cutoff) break
      if (record.state === 'done') this.requests.delete(id)
    }
  }
}
