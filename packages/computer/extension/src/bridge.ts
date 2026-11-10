// The worker's form operations: discovery across the active tab's frames, and a fill bound to one discovered document.
import {
  COMPUTER_FORM_FILL_PROTOCOL,
  COMPUTER_FORM_FILL_TIMEOUT_MS,
  COMPUTER_FORM_FORMS_MAX,
  ComputerFormDiscovery,
  ComputerFormFillResult,
  ComputerFormOrigin,
  FormFillRequest,
  type ComputerFormFieldStatus,
  type ComputerFormTarget,
  type ComputerFormValue,
  type FormFillReply
} from '@agentconnect.md/protocol/computer-form-fill'
import { discoverInPage, fillInPage, type PageDiscovery, type PageFillResult } from './page.js'

/** The extension APIs the bridge needs; the worker passes `chrome`, tests a fake. */
export interface BrowserApi {
  tabs: Pick<typeof chrome.tabs, 'query'>
  scripting: Pick<typeof chrome.scripting, 'executeScript'>
  webNavigation: Pick<typeof chrome.webNavigation, 'getFrame' | 'onBeforeNavigate' | 'onCommitted'>
}

export interface BridgeOptions {
  timeoutMs?: number
  // How long after a fill a navigation still counts as caused by it.
  settleMs?: number
  sleep?: (ms: number) => Promise<void>
}

const SETTLE_MS = 400
const REQUESTS_KEPT = 256

const originOf = (url: string | undefined): string | undefined => {
  try {
    const origin = new URL(url ?? '').origin
    return ComputerFormOrigin.safeParse(origin).success ? origin : undefined
  } catch {
    return undefined
  }
}

// Form ids the agent sees name their frame, so one id selects one frame's form.
const formKey = (frameId: number, local: string): string => `${frameId}:${local}`
const localForm = (key: string): { frameId: number; local: string } | undefined => {
  const match = /^(\d+):(.+)$/.exec(key)
  return match ? { frameId: Number(match[1]), local: match[2]! } : undefined
}

export class FormFillBridge {
  private readonly timeoutMs: number
  private readonly settleMs: number
  private readonly sleep: (ms: number) => Promise<void>
  // Request ids already seen: a repeat is refused, never written twice.
  private readonly seen = new Set<string>()

  constructor(
    private readonly api: BrowserApi,
    options: BridgeOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? COMPUTER_FORM_FILL_TIMEOUT_MS
    this.settleMs = options.settleMs ?? SETTLE_MS
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** One daemon request in, its reply out; anything unparseable gets no reply. */
  async handle(raw: string): Promise<FormFillReply | undefined> {
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      return undefined
    }
    const parsed = FormFillRequest.safeParse(message)
    if (!parsed.success) {
      const id = (message as { id?: unknown })?.id
      return typeof id === 'number' && id >= 1 ? { type: 'reply', id, error: 'unsupported request' } : undefined
    }
    const request = parsed.data
    try {
      if (request.type === 'ping') return { type: 'reply', id: request.id }
      if (request.type === 'discover')
        return { type: 'reply', id: request.id, discovery: await this.discover(request.form) }
      return { type: 'reply', id: request.id, fill: await this.fill(request.requestId, request.target, request.values) }
    } catch (error) {
      return { type: 'reply', id: request.id, error: String((error as Error)?.message ?? error).slice(0, 500) }
    }
  }

  async discover(form?: string): Promise<ComputerFormDiscovery> {
    const base = { v: COMPUTER_FORM_FILL_PROTOCOL } as const
    const [tab] = await this.api.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab?.id === undefined) return { ...base, status: 'none', forms: [], reason: 'no browser tab is open' }
    const topOrigin = originOf(tab.url)
    if (!topOrigin) return { ...base, status: 'unsupported', forms: [], reason: 'the active tab is not a website' }
    const title = (tab.title ?? '').slice(0, 200)
    const tabInfo = { tabId: tab.id, topOrigin, ...(title ? { title } : {}) }
    let frames: chrome.scripting.InjectionResult<PageDiscovery>[]
    try {
      frames = await this.api.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: discoverInPage
      })
    } catch (error) {
      return {
        ...base,
        status: 'unsupported',
        tab: tabInfo,
        forms: [],
        reason: `the page cannot be read: ${(error as Error).message}`.slice(0, 500)
      }
    }
    const forms: ComputerFormDiscovery['forms'] = []
    for (const frame of frames) {
      const page = frame.result
      // Sandboxed and opaque-origin frames have no origin to bind a fill to.
      const frameOrigin = page ? originOf(page.origin) : undefined
      if (!page || !frameOrigin || page.origin !== frameOrigin) continue
      for (const pageForm of page.forms) {
        if (forms.length >= COMPUTER_FORM_FORMS_MAX) break
        forms.push({
          ...pageForm,
          id: formKey(frame.frameId, pageForm.id),
          frameOrigin,
          frameId: frame.frameId,
          documentId: frame.documentId
        } as ComputerFormDiscovery['forms'][number])
      }
    }
    const result = (status: ComputerFormDiscovery['status'], chosen?: (typeof forms)[number], reason?: string) =>
      ComputerFormDiscovery.parse({
        ...base,
        status,
        tab: tabInfo,
        ...(chosen
          ? {
              target: {
                tabId: tab.id!,
                frameId: chosen.frameId,
                documentId: chosen.documentId,
                topOrigin,
                frameOrigin: chosen.frameOrigin,
                formId: chosen.id
              }
            }
          : {}),
        forms,
        ...(reason ? { reason } : {})
      })
    if (form !== undefined) {
      const named = forms.find((candidate) => candidate.id === form)
      return named
        ? result('found', named)
        : result('none', undefined, `no form ${form} on this page now; discover again`)
    }
    if (forms.length === 0) return result('none', undefined, 'no fillable form on this page')
    const focused = forms.filter((candidate) => candidate.focused)
    if (focused.length === 1) return result('found', focused[0])
    if (forms.length === 1) return result('found', forms[0])
    return result('ambiguous', undefined, 'several forms are on this page: pass one form id')
  }

  async fill(
    requestId: string,
    target: ComputerFormTarget,
    values: ComputerFormValue[]
  ): Promise<ComputerFormFillResult> {
    const outcome = (
      status: ComputerFormFillResult['status'],
      fields: ComputerFormFillResult['fields'],
      navigated: boolean,
      reason?: string
    ) =>
      ComputerFormFillResult.parse({
        v: COMPUTER_FORM_FILL_PROTOCOL,
        requestId,
        status,
        fields,
        navigated,
        ...(reason ? { reason } : {})
      })
    if (this.seen.has(requestId))
      return outcome('failed', [], false, 'this request id was already used; nothing was written again')
    this.remember(requestId)
    const local = localForm(target.formId)
    if (!local || local.frameId !== target.frameId)
      return outcome('target_changed', [], false, 'the form id does not name this frame')
    // The tab's top document and the target frame's document must still be the discovered ones.
    const [top, frame] = await Promise.all([
      this.api.webNavigation.getFrame({ tabId: target.tabId, frameId: 0 }).catch(() => null),
      this.api.webNavigation.getFrame({ tabId: target.tabId, frameId: target.frameId }).catch(() => null)
    ])
    if (!top || originOf(top.url) !== target.topOrigin)
      return outcome('target_changed', [], false, 'the tab is on another website now')
    if (!frame || frame.documentId !== target.documentId || originOf(frame.url) !== target.frameOrigin)
      return outcome('target_changed', [], false, 'the page was reloaded or navigated since the form was found')

    let navigated = false
    const onNavigation = (details: { tabId: number; frameId: number }) => {
      if (details.tabId === target.tabId && (details.frameId === 0 || details.frameId === target.frameId))
        navigated = true
    }
    this.api.webNavigation.onBeforeNavigate.addListener(onNavigation)
    this.api.webNavigation.onCommitted.addListener(onNavigation)
    try {
      const injected = this.api.scripting
        .executeScript({
          target: { tabId: target.tabId, documentIds: [target.documentId] },
          func: fillInPage,
          args: [{ formId: local.local, frameOrigin: target.frameOrigin, values }]
        })
        .then(
          (results) => ({ results }),
          (error: unknown) => ({ error })
        )
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.timeoutMs)
      })
      // A late reply after the timeout is dropped: the outcome stays uncertain and nothing is retried.
      const settled = await Promise.race([injected, timedOut])
      clearTimeout(timer)
      if (settled === 'timeout')
        return outcome(
          'uncertain',
          [],
          navigated,
          'the page did not answer in time; the fill may or may not have happened and was not retried'
        )
      if ('error' in settled)
        return outcome(
          'uncertain',
          [],
          navigated,
          'the page went away while filling; the fill may or may not have happened and was not retried'
        )
      const page = settled.results[0]?.result as PageFillResult | undefined
      if (!page) return outcome('uncertain', [], navigated, 'the page returned no result; the fill was not retried')
      if (page.status === 'target_changed') return outcome('target_changed', [], navigated, page.reason)
      await this.sleep(this.settleMs)
      const written = page.fields.filter((field) => field.status === 'filled' || field.status === 'unverified').length
      const allFilled = page.fields.length > 0 && page.fields.every((field) => field.status === 'filled')
      const status = allFilled ? 'filled' : written > 0 ? 'partial' : 'failed'
      return outcome(
        status,
        page.fields.map((field) => ({ field: field.field, status: field.status as ComputerFormFieldStatus })),
        navigated
      )
    } finally {
      this.api.webNavigation.onBeforeNavigate.removeListener(onNavigation)
      this.api.webNavigation.onCommitted.removeListener(onNavigation)
    }
  }

  private remember(requestId: string): void {
    this.seen.add(requestId)
    if (this.seen.size > REQUESTS_KEPT) this.seen.delete(this.seen.values().next().value!)
  }
}
