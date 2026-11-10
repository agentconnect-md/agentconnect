import { authorizeGithubAppOwners, fetchGithubAppOwners, type GithubAppOwners } from './api'

const PURPOSE = 'github-app-owners:'

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// The callback only delivers a code; the opener owns the state and PKCE verifier.
export function completeGithubAppOwnerAuthorization(): boolean {
  const params = new URLSearchParams(window.location.search)
  const state = params.get('state')
  if (!state?.startsWith(PURPOSE) || !window.opener) return false
  window.opener.postMessage(
    { type: PURPOSE, state, code: params.get('code'), error: params.get('error') },
    window.location.origin
  )
  window.close()
  return true
}

export async function selectGithubAppOwners(
  agentId: string,
  orgId: string | undefined,
  signal: AbortSignal
): Promise<GithubAppOwners> {
  const state = PURPOSE + base64url(crypto.getRandomValues(new Uint8Array(32)))
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const popup = window.open('about:blank', '_blank', 'popup,width=640,height=760')
  if (!popup) throw new Error('popup-blocked')
  try {
    const challenge = base64url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    )
    const { authorizationUri } = await authorizeGithubAppOwners(agentId, state, challenge, orgId)
    signal.throwIfAborted()
    const code = await new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        window.removeEventListener('message', receive)
        signal.removeEventListener('abort', cancelled)
        clearInterval(closed)
        clearTimeout(timeout)
      }
      const cancelled = () => {
        cleanup()
        reject(new Error('authorization-cancelled'))
      }
      const receive = (event: MessageEvent) => {
        if (
          event.origin !== window.location.origin ||
          event.source !== popup ||
          event.data?.type !== PURPOSE ||
          event.data.state !== state
        )
          return
        cleanup()
        if (event.data.error || typeof event.data.code !== 'string' || !event.data.code) {
          reject(new Error('authorization-failed'))
        } else resolve(event.data.code)
      }
      const closed = setInterval(() => {
        if (popup.closed) cancelled()
      }, 500)
      const timeout = setTimeout(cancelled, 5 * 60_000)
      window.addEventListener('message', receive)
      signal.addEventListener('abort', cancelled, { once: true })
      popup.location.href = authorizationUri
    })
    return await fetchGithubAppOwners(agentId, code, verifier, orgId)
  } finally {
    popup.close()
  }
}
