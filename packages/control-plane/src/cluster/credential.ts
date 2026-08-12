/**
 * The daemon credential a cluster envelope runs on, as a `config.json` document.
 *
 * Pure on purpose: the shape the daemon parses is a contract
 * (`packages/daemon/src/config/config-schema.ts`), and the one place that
 * builds it should be readable and testable without a cluster or a database.
 * `daemonId` is pinned rather than left for the daemon to adopt from `auth/ok`,
 * because a pod's state volume can be replaced under it and the identity must
 * survive that.
 */
export interface DaemonCredentialInput {
  /** The control plane's daemon WebSocket URL, e.g. `wss://api.example.test/daemon/ws`. */
  controlPlaneUrl: string
  apiKey: string
  daemonId: string
}

export function buildDaemonConfigJson(input: DaemonCredentialInput): string {
  return `${JSON.stringify(
    {
      version: 1,
      daemonId: input.daemonId,
      controlPlane: { enabled: true, url: input.controlPlaneUrl, key: input.apiKey }
    },
    null,
    2
  )}\n`
}
