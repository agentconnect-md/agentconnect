/** Kubernetes namespaces are DNS labels: ≤63 chars, lowercase alphanumeric and dashes (RFC 1123). */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const MAX_DNS_LABEL = 63

/** Degraded reason for a resolved name that could never be a namespace. */
export const REASON_INVALID_NAMESPACE_NAME = 'InvalidNamespaceName'
/** Degraded reason for an override naming a namespace this install does not own. */
export const REASON_NAMESPACE_OUTSIDE_PREFIX = 'NamespaceOutsidePrefix'

/**
 * The org's envelope namespace. Normally derived — the install's prefix plus the
 * CR name, which is unique within the control namespace, so nothing has to be
 * declared and nothing can collide. `spec.targetNamespace` is the deployment's
 * escape hatch when a specific namespace is required; it is fenced by the same
 * prefix and validated below.
 */
export function orgNamespace(prefix: string, orgName: string, declared?: string): string {
  return declared ?? `${prefix}${orgName}`
}

/** Why the resolved namespace is unusable, or undefined when it is fine. */
export function namespaceFault(prefix: string, namespace: string): { reason: string; message: string } | undefined {
  if (!namespace.startsWith(prefix)) {
    return {
      reason: REASON_NAMESPACE_OUTSIDE_PREFIX,
      message: `namespace ${namespace} is outside this install's prefix ${prefix}`
    }
  }
  if (namespace.length > MAX_DNS_LABEL) {
    return {
      reason: REASON_INVALID_NAMESPACE_NAME,
      message: `namespace ${namespace} is longer than the ${MAX_DNS_LABEL}-character DNS label limit`
    }
  }
  if (!DNS_LABEL.test(namespace)) {
    return { reason: REASON_INVALID_NAMESPACE_NAME, message: `namespace ${namespace} is not a DNS label` }
  }
  return undefined
}
