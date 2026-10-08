import {
  ProviderEndpoint,
  type DecisionEvaluation,
  type DecisionQuestion,
  type ProviderCredential
} from '@agentconnect.md/protocol'

export type DecisionProviderEvaluator = (
  question: DecisionQuestion,
  body: string,
  credentials: ProviderCredential,
  signal: AbortSignal,
  fetcher?: typeof fetch,
  onRawResponse?: (text: string) => void
) => Promise<DecisionEvaluation>

type UnavailableReason = Extract<DecisionEvaluation, { status: 'unavailable' }>['reason']
export class DecisionProviderError extends Error {
  constructor(readonly reason: UnavailableReason) {
    super(`Decision evaluation unavailable: ${reason}`)
  }
}

async function readText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new DecisionProviderError('invalid_response')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 128 * 1024) throw new DecisionProviderError('invalid_response')
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function requestDecision(
  path: string,
  body: string,
  credentials: ProviderCredential,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  onRawResponse?: (text: string) => void
): Promise<string> {
  const base = ProviderEndpoint.safeParse(credentials.endpoint)
  if (!base.success) throw new DecisionProviderError('credentials')
  const url = new URL(path, `${base.data.replace(/\/+$/, '')}/`)
  const headers = new Headers(credentials.headers)
  headers.set('authorization', `Bearer ${credentials.apiKey}`)
  headers.set('content-type', 'application/json')
  const response = await fetcher(url, { method: 'POST', headers, body, signal, redirect: 'error' })
  if (!response.ok) {
    // An error body is kept best effort for the evaluation record; the status still decides the reason.
    const text = await readText(response).catch(() => null)
    if (text !== null) onRawResponse?.(text)
    const reason = [401, 403].includes(response.status)
      ? 'credentials'
      : [429, 529].includes(response.status)
        ? 'capacity'
        : [400, 413, 422].includes(response.status)
          ? 'unsupported_input'
          : 'provider'
    throw new DecisionProviderError(reason)
  }
  const text = await readText(response)
  onRawResponse?.(text)
  return text
}
