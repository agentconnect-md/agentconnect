/**
 * GitHub App deployment identity (docs/designs/github-app-git-credentials.md).
 *
 * The App (id / slug / private key) is DEPLOYMENT CONFIG — the same GitHub App
 * that backs console login via Logto, reused on its second credential track
 * (App JWT → installation tokens). Logto holds the client id/secret (OAuth
 * login); the CP holds only the private key, which never leaves this process:
 * not PG, not the WS, not any HTTP response, never a log line.
 *
 * Opt-in mirrors OIDC_ISSUER: all three vars set ⇒ enabled; none ⇒ feature off
 * (module not assembled). A PARTIAL set is a deploy mistake ⇒ fail fast with a
 * message naming the missing vars, rather than silently running degraded.
 */
import { createPrivateKey, type KeyObject } from 'node:crypto'
import type { GitCommitIdentity } from '@agentconnect.md/protocol'
import type { AppConfig } from '../config/env.js'

export interface GithubAppConfig {
  appId: number
  slug: string // github.com/apps/<slug> — install deep link
  /** JWT issuer: client id when configured (GitHub's current recommendation), else the App id. */
  jwtIssuer: string
  privateKey: KeyObject
}

type GithubEnvSlice = Pick<
  AppConfig,
  'GITHUB_APP_ID' | 'GITHUB_APP_PRIVATE_KEY_B64' | 'GITHUB_APP_SLUG' | 'GITHUB_APP_CLIENT_ID'
>

/** GitHub attributes this noreply identity to the App's bot account. */
export function githubAppBotIdentity(slug: string, botUserId: number): GitCommitIdentity {
  const name = `${slug}[bot]`
  return { name, email: `${botUserId}+${name}@users.noreply.github.com` }
}

/** Undefined ⇒ feature disabled. Throws on partial config or an unparsable key. */
export function resolveGithubAppConfig(config: GithubEnvSlice): GithubAppConfig | undefined {
  const present = {
    GITHUB_APP_ID: config.GITHUB_APP_ID !== undefined,
    GITHUB_APP_PRIVATE_KEY_B64: config.GITHUB_APP_PRIVATE_KEY_B64 !== undefined,
    GITHUB_APP_SLUG: config.GITHUB_APP_SLUG !== undefined
  }
  const set = Object.values(present).filter(Boolean).length
  if (set === 0) return undefined
  if (set < 3) {
    const missing = Object.entries(present)
      .filter(([, ok]) => !ok)
      .map(([k]) => k)
    throw new Error(`github app config is partial — missing ${missing.join(', ')} (set all three or none)`)
  }

  let pem: string
  try {
    pem = Buffer.from(config.GITHUB_APP_PRIVATE_KEY_B64!, 'base64').toString('utf8')
  } catch {
    throw new Error('GITHUB_APP_PRIVATE_KEY_B64 is not valid base64')
  }
  let privateKey: KeyObject
  try {
    // createPrivateKey handles both PKCS#1 (GitHub's download format,
    // "BEGIN RSA PRIVATE KEY") and PKCS#8 PEM.
    privateKey = createPrivateKey(pem)
  } catch (e) {
    throw new Error(`GITHUB_APP_PRIVATE_KEY_B64 does not decode to a parsable private key: ${(e as Error).message}`)
  }
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new Error(`GITHUB_APP_PRIVATE_KEY_B64 must be an RSA key (got ${privateKey.asymmetricKeyType})`)
  }

  return {
    appId: config.GITHUB_APP_ID!,
    slug: config.GITHUB_APP_SLUG!,
    jwtIssuer: config.GITHUB_APP_CLIENT_ID ?? String(config.GITHUB_APP_ID!),
    privateKey
  }
}
