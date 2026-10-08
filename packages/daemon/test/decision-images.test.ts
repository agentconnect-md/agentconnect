import { describe, expect, it, vi } from 'vitest'
import { DecisionEvaluator, type DecisionEvaluationInput } from '../src/decisions/evaluator.js'
import {
  DECISION_IMAGE_MAX_BYTES,
  DECISION_IMAGE_MAX_COUNT,
  DECISION_IMAGES_MAX_BYTES,
  resolveDecisionImages,
  type DecisionImageDownload
} from '../src/decisions/images.js'
import type { Attachment } from '../src/messages/normalized.js'

const png = Buffer.from('89504e470d0a1a0a00000000494d414745', 'hex')
const image = (over: Partial<Attachment> = {}): Attachment => ({
  id: 'image-1',
  name: 'item.png',
  mimeType: 'image/png',
  inlineData: png,
  ...over
})
const input = (attachments: Attachment[]): DecisionEvaluationInput => ({
  agentId: 'agent',
  evaluationId: 'image-evaluation',
  decision: {
    providerId: 'openai',
    model: 'gpt-6-luna',
    question: {
      type: 'boolean',
      instructions: 'Is the item damaged?',
      criteria: { true: 'Visible damage', false: 'Intact' }
    }
  },
  state: { currentMessage: { id: 'message-1', text: '' }, history: [] },
  imageInput: { attachments, messageId: 'message-1', integrationId: 'integration-1' }
})
function setup(timeoutMs = 5000) {
  const download = vi.fn<DecisionImageDownload>(async () => png)
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      model: 'gpt-6-luna',
      answers: [{ type: 'predicate', name: 'decision', probability: 0.9 }],
      usage: { input_tokens: 120, output_tokens: 0 },
      echoedImage: png.toString('base64')
    })
  )
  const credentials = vi.fn(async () => ({ credentials: { apiKey: 'example-key', endpoint: null, headers: {} } }))
  const evaluator = new DecisionEvaluator({
    orgForAgent: () => 'org',
    credentials,
    keyServer: () => undefined,
    downloadImage: download,
    fetch: fetcher,
    timeoutMs
  })
  return { evaluator, download, fetcher, credentials }
}

describe('Decision image inputs', () => {
  it('sends real image parts alongside text and keeps image bytes out of diagnostic callbacks', async () => {
    const { evaluator, download, fetcher } = setup()
    const rawRequest = vi.fn(),
      rawResponse = vi.fn()
    expect(
      await evaluator.evaluate({ ...input([image()]), onRawRequest: rawRequest, onRawResponse: rawResponse })
    ).toMatchObject({ status: 'answered', answer: { value: true } })
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string)
    expect(body.input[0].role).toBe('user')
    expect(JSON.parse(body.input[0].content[0].text)).toEqual(input([]).state)
    expect(JSON.parse(body.input[0].content[1].text)).toMatchObject({
      currentMessageImage: { messageId: 'message-1', name: 'item.png', bytes: png.length }
    })
    expect(body.input[0].content[2]).toEqual({
      type: 'input_image',
      image_url: `data:image/png;base64,${png.toString('base64')}`,
      detail: 'auto'
    })
    expect(download).not.toHaveBeenCalled()
    expect(rawRequest.mock.calls[0]![0]).toContain('[image bytes omitted]')
    expect(rawRequest.mock.calls[0]![0]).not.toContain(png.toString('base64'))
    expect(rawResponse.mock.calls[0]![0]).not.toContain(png.toString('base64'))
  })

  it('uses the owning integration for private downloads and reuses bytes for later chain steps', async () => {
    const { evaluator, download, fetcher } = setup()
    const attachment = image({ inlineData: undefined, sourceUrl: 'https://private.example.test/image' })
    const request = input([attachment])
    await evaluator.evaluate(request)
    await evaluator.evaluate(request)
    expect(download).toHaveBeenCalledExactlyOnceWith(
      'agent',
      'integration-1',
      attachment,
      DECISION_IMAGE_MAX_BYTES,
      expect.any(AbortSignal)
    )
    expect(fetcher.mock.calls[0]![1]!.body).not.toContain('private.example.test')
    expect(attachment.inlineData).toEqual(png)
  })

  it('supports replayed inline bytes and sniffs images with an unknown provider MIME type', async () => {
    const attachment = JSON.parse(JSON.stringify(image({ mimeType: 'application/octet-stream' }))) as Attachment
    const result = await resolveDecisionImages('agent', input([attachment]).imageInput!, new AbortController().signal)
    expect(result).toMatchObject([{ mimeType: 'image/png', data: png.toString('base64') }])
    expect(Buffer.isBuffer(attachment.inlineData)).toBe(true)
  })

  it('keeps ordinary unknown files as text metadata even when probes cannot read them', async () => {
    const { evaluator, download, fetcher } = setup()
    const unknown = (over: Partial<Attachment> = {}) =>
      image({
        mimeType: 'application/octet-stream',
        inlineData: undefined,
        sourceUrl: 'https://private.example.test/file',
        ...over
      })
    download
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(Buffer.alloc(DECISION_IMAGE_MAX_BYTES + 1))
    const attachments = [
      unknown({ size: DECISION_IMAGE_MAX_BYTES + 1 }),
      unknown(),
      unknown(),
      unknown(),
      ...Array.from({ length: 9 }, () => unknown({ inlineData: Buffer.from('ordinary file') })),
      image()
    ]
    expect((await evaluator.evaluate(input(attachments))).status).toBe('answered')
    expect(download).toHaveBeenCalledTimes(3)
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string)
    expect(body.input[0].content.filter((part: { type: string }) => part.type === 'input_image')).toHaveLength(1)
  })

  it('counts unknown files once their bytes identify them as images', async () => {
    const { evaluator, fetcher } = setup()
    expect(
      await evaluator.evaluate(input(Array.from({ length: 9 }, () => image({ mimeType: 'application/octet-stream' }))))
    ).toEqual({ status: 'unavailable', reason: 'unsupported_input' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps image bytes outside the text budget', async () => {
    const { evaluator, fetcher } = setup()
    const bytes = Buffer.concat([png, Buffer.alloc(64 * 1024)])
    expect((await evaluator.evaluate(input([image({ inlineData: bytes })]))).status).toBe('answered')
    expect(Buffer.byteLength(fetcher.mock.calls[0]![1]!.body as string)).toBeGreaterThan(32 * 1024)
  })

  it('does not download images for a text-only provider or without provider credentials', async () => {
    const { evaluator, download, fetcher } = setup()
    const request = input([image({ inlineData: undefined, sourceUrl: 'https://private.example.test/image' })])
    fetcher.mockResolvedValueOnce(
      Response.json({
        model: 'jev-latest',
        answers: { decision: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    )
    expect(
      (
        await evaluator.evaluate({
          ...request,
          decision: { ...request.decision, providerId: 'typesafe', model: 'jev-latest' }
        })
      ).status
    ).toBe('answered')
    expect(download).not.toHaveBeenCalled()
    const missing = new DecisionEvaluator({
      orgForAgent: () => 'org',
      credentials: async () => ({ credentials: null }),
      keyServer: () => undefined,
      downloadImage: download,
      fetch: fetcher
    })
    expect(await missing.evaluate(request)).toEqual({ status: 'unavailable', reason: 'credentials' })
    expect(download).not.toHaveBeenCalled()
  })

  it('rejects excessive image count and declared bytes before downloading', async () => {
    const { evaluator, download, fetcher } = setup()
    for (const attachments of [
      Array.from({ length: DECISION_IMAGE_MAX_COUNT + 1 }, () => image()),
      [
        image({
          inlineData: undefined,
          sourceUrl: 'https://private.example.test/image',
          size: DECISION_IMAGE_MAX_BYTES + 1
        })
      ]
    ]) {
      expect(await evaluator.evaluate(input(attachments))).toEqual({
        status: 'unavailable',
        reason: 'unsupported_input'
      })
    }
    expect(download).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects actual oversize, total overflow, corrupt bytes and unavailable images without a text-only fallback', async () => {
    const { evaluator, download, fetcher } = setup()
    download.mockResolvedValue(null)
    const full = Buffer.concat([png, Buffer.alloc(DECISION_IMAGE_MAX_BYTES - png.length)])
    expect(full.length * 2).toBe(DECISION_IMAGES_MAX_BYTES)
    for (const attachments of [
      [image({ inlineData: Buffer.alloc(DECISION_IMAGE_MAX_BYTES + 1) })],
      [image({ inlineData: full }), image({ inlineData: full }), image()],
      [image({ inlineData: Buffer.from('not an image') })],
      [image({ inlineData: undefined, sourceUrl: 'https://private.example.test/image' })]
    ])
      expect(await evaluator.evaluate(input(attachments))).toEqual({
        status: 'unavailable',
        reason: 'unsupported_input'
      })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('times out a hanging download and never starts a late provider request', async () => {
    const { evaluator, download, fetcher } = setup(20)
    let finish!: (value: Buffer) => void
    download.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const attachment = image({ inlineData: undefined, sourceUrl: 'https://private.example.test/image' })
    expect(await evaluator.evaluate(input([attachment]))).toEqual({ status: 'unavailable', reason: 'timeout' })
    finish(png)
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
    expect(attachment.inlineData).toBeUndefined()
  })

  it('propagates cancellation during download', async () => {
    const { evaluator, download, fetcher } = setup()
    const controller = new AbortController()
    download.mockImplementationOnce(async () => {
      controller.abort(new Error('user stopped'))
      return png
    })
    await expect(
      evaluator.evaluate(
        input([image({ inlineData: undefined, sourceUrl: 'https://private.example.test/image' })]),
        controller.signal
      )
    ).rejects.toThrow('user stopped')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('omits upstream error bodies that could echo image bytes', async () => {
    const { evaluator, fetcher } = setup()
    fetcher.mockResolvedValueOnce(new Response(png.toString('base64'), { status: 413 }))
    const rawResponse = vi.fn()
    expect(await evaluator.evaluate({ ...input([image()]), onRawResponse: rawResponse })).toEqual({
      status: 'unavailable',
      reason: 'unsupported_input'
    })
    expect(rawResponse).not.toHaveBeenCalled()
  })
})
