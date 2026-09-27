import { BaseClient } from '@logto/browser'

// Keep the SDK's token checks and retry only verification after refreshing stale signing keys.
export function enableJwksCacheRecovery(client: BaseClient): void {
  let verifier = client.jwtVerifier
  client.setJwtVerifier({
    async verifyIdToken(idToken) {
      try {
        await verifier.verifyIdToken(idToken)
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_JWKS_NO_MATCHING_KEY') throw error
        const { jwksUri } = await client.getOidcConfig()
        const response = await fetch(jwksUri, {
          cache: 'reload',
          redirect: 'manual',
          signal: AbortSignal.timeout(5_000)
        })
        if (!response.ok) throw error
        await response.arrayBuffer()
        // The public constructor gives us a fresh SDK verifier without retaining its old in-memory keys.
        verifier = new BaseClient(client.logtoConfig, client.adapter).jwtVerifier
        await verifier.verifyIdToken(idToken)
      }
    }
  })
}
