import type { K8sRuntimeTable } from '../../packages/daemon/src/runtimes/k8s-runtimes.js'

export declare const ACP_AUTH_REQUIRED_CODE: number
export declare function isAuthRequired(error: unknown): boolean
export declare function buildTable(
  provided?: readonly { id: string; command: string; args?: readonly string[] }[]
): Promise<K8sRuntimeTable>
