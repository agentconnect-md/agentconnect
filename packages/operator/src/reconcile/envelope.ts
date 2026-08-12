import {
  CREDENTIAL_REVISION_ANNOTATION,
  NAMESPACE_CLAIM_LABEL,
  ORG_LABEL,
  type AgentConnectOrgSpec
} from '../crd/types.js'
import type { Observations, ReconcileContext } from './context.js'
import {
  APP_LABEL_KEY,
  RUNTIME_TIER_PREFIX,
  DAEMON_EGRESS_POLICY_NAME,
  DAEMON_INGRESS_POLICY_NAME,
  DAEMON_NAME,
  DAEMON_PVC_NAME,
  LIMIT_RANGE_NAME,
  QUOTA_NAME,
  RUNTIME_SA_NAME,
  SANDBOX_EXTENSIONS_GROUP,
  SHIM_PORT,
  SHIM_SERVICE_NAME,
  applyObject,
  clusterRoleBindingPath,
  corePath,
  deleteIgnoreMissing,
  getOrNull,
  groupPath,
  namespacePath,
  runtimeTierName,
  tokenReviewBindingName,
  type K8sResource
} from './resources.js'

/** One org's resolved envelope inputs, computed once per pass. */
export interface EnvelopeInputs {
  orgName: string
  spec: AgentConnectOrgSpec
}

/** Daemon supervisor resource tiers; unknown tier names fall back to `small` with a warning. */
const DAEMON_TIERS: Record<string, { requests: Record<string, string>; limits: Record<string, string> }> = {
  small: { requests: { cpu: '200m', memory: '512Mi' }, limits: { memory: '2Gi' } },
  medium: { requests: { cpu: '500m', memory: '1Gi' }, limits: { memory: '4Gi' } },
  large: { requests: { cpu: '1', memory: '2Gi' }, limits: { memory: '8Gi' } }
}

function envelopeLabels(orgName: string, extra: Record<string, string> = {}): Record<string, string> {
  return { [ORG_LABEL]: orgName, ...extra }
}

/** Create-or-adopt spec.targetNamespace: claim by label, reject a label-mismatched existing namespace as Degraded. */
export async function ensureNamespace(ctx: ReconcileContext, input: EnvelopeInputs, obs: Observations): Promise<void> {
  const name = input.spec.targetNamespace
  if (!name.startsWith(ctx.config.orgNamespacePrefix)) {
    obs.degraded = {
      reason: 'NamespaceOutsidePrefix',
      message: `targetNamespace ${name} is outside this install's prefix ${ctx.config.orgNamespacePrefix}`
    }
    return
  }
  const existing = await getOrNull<K8sResource>(ctx.http, namespacePath(name))
  if (existing && existing.metadata.labels?.[NAMESPACE_CLAIM_LABEL] !== input.orgName) {
    obs.degraded = {
      reason: 'NamespaceClaimConflict',
      message: `namespace ${name} exists without this org's claim label — refusing to adopt`
    }
    return
  }
  await applyObject(ctx.http, namespacePath(name), {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name,
      labels: envelopeLabels(input.orgName, {
        [NAMESPACE_CLAIM_LABEL]: input.orgName,
        // baseline, not restricted: sandbox pods run non-root but do not carry seccomp/capability stanzas.
        'pod-security.kubernetes.io/enforce': 'baseline'
      })
    }
  })
  obs.namespaceReady = true
  obs.namespace = name
}

/** Daemon SA plus runtime SA (automountServiceAccountToken: false, zero role bindings). */
export async function ensureServiceAccounts(
  ctx: ReconcileContext,
  input: EnvelopeInputs,
  obs: Observations
): Promise<void> {
  const ns = input.spec.targetNamespace
  await applyObject(ctx.http, corePath(ns, 'serviceaccounts', DAEMON_NAME), {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: DAEMON_NAME, namespace: ns, labels: envelopeLabels(input.orgName) }
  })
  // The runtime SA exists only to be named by pod templates; its pods hold no API identity.
  await applyObject(ctx.http, corePath(ns, 'serviceaccounts', RUNTIME_SA_NAME), {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: RUNTIME_SA_NAME, namespace: ns, labels: envelopeLabels(input.orgName) },
    automountServiceAccountToken: false
  })
  void obs
}

/** Namespaced Role/RoleBinding for the daemon SA: SandboxClaim CRUD + Sandbox mode patch, no Secret API. */
export async function ensureRoleAndBinding(
  ctx: ReconcileContext,
  input: EnvelopeInputs,
  obs: Observations
): Promise<void> {
  const ns = input.spec.targetNamespace
  const rbac = 'rbac.authorization.k8s.io/v1'
  await applyObject(ctx.http, groupPath(rbac, ns, 'roles', DAEMON_NAME), {
    apiVersion: rbac,
    kind: 'Role',
    metadata: { name: DAEMON_NAME, namespace: ns, labels: envelopeLabels(input.orgName) },
    rules: [
      {
        apiGroups: ['extensions.agents.x-k8s.io'],
        resources: ['sandboxclaims'],
        verbs: ['get', 'list', 'watch', 'create', 'delete']
      },
      // patch on sandboxes is the guarded operating-mode write (suspend/resume).
      { apiGroups: ['agents.x-k8s.io'], resources: ['sandboxes'], verbs: ['get', 'list', 'watch', 'patch'] }
    ]
  })
  await applyObject(ctx.http, groupPath(rbac, ns, 'rolebindings', DAEMON_NAME), {
    apiVersion: rbac,
    kind: 'RoleBinding',
    metadata: { name: DAEMON_NAME, namespace: ns, labels: envelopeLabels(input.orgName) },
    subjects: [{ kind: 'ServiceAccount', name: DAEMON_NAME, namespace: ns }],
    roleRef: { kind: 'Role', name: DAEMON_NAME, apiGroup: 'rbac.authorization.k8s.io' }
  })
  void obs
}

/** Per-org ClusterRoleBinding of the daemon SA to the install's tokenreview ClusterRole. */
export async function ensureTokenReviewClusterRoleBinding(
  ctx: ReconcileContext,
  input: EnvelopeInputs,
  obs: Observations
): Promise<void> {
  const ns = input.spec.targetNamespace
  // Cluster-scoped, so no namespace cascade covers it — the finalizer deletes it explicitly.
  await applyObject(ctx.http, clusterRoleBindingPath(tokenReviewBindingName(ns)), {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: { name: tokenReviewBindingName(ns), labels: envelopeLabels(input.orgName) },
    subjects: [{ kind: 'ServiceAccount', name: DAEMON_NAME, namespace: ns }],
    roleRef: {
      kind: 'ClusterRole',
      name: ctx.config.tokenreviewClusterRole,
      apiGroup: 'rbac.authorization.k8s.io'
    }
  })
  void obs
}

/** Two NetworkPolicies for the daemon pod; sandbox egress lives on the SandboxTemplate instead. */
export async function ensureNetworkPolicies(
  ctx: ReconcileContext,
  input: EnvelopeInputs,
  obs: Observations
): Promise<void> {
  const ns = input.spec.targetNamespace
  const netv1 = 'networking.k8s.io/v1'
  const daemonPods = { podSelector: { matchLabels: { [APP_LABEL_KEY]: DAEMON_NAME } } }
  await applyObject(ctx.http, groupPath(netv1, ns, 'networkpolicies', DAEMON_EGRESS_POLICY_NAME), {
    apiVersion: netv1,
    kind: 'NetworkPolicy',
    metadata: { name: DAEMON_EGRESS_POLICY_NAME, namespace: ns, labels: envelopeLabels(input.orgName) },
    spec: {
      ...daemonPods,
      policyTypes: ['Egress'],
      egress: [
        {
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 }
          ]
        },
        // 443 covers CP/relay/platform/provider APIs; 6443 is the apiserver on most CNIs (CNI-dependent).
        { ports: [{ protocol: 'TCP', port: 443 }] },
        { ports: [{ protocol: 'TCP', port: 6443 }] }
      ]
    }
  })
  await applyObject(ctx.http, groupPath(netv1, ns, 'networkpolicies', DAEMON_INGRESS_POLICY_NAME), {
    apiVersion: netv1,
    kind: 'NetworkPolicy',
    metadata: { name: DAEMON_INGRESS_POLICY_NAME, namespace: ns, labels: envelopeLabels(input.orgName) },
    spec: {
      ...daemonPods,
      policyTypes: ['Ingress'],
      ingress: [
        // Shim dial-in from this org's sandboxes plus relay forward from the control namespace.
        { from: [{ podSelector: {} }], ports: [{ protocol: 'TCP', port: SHIM_PORT }] },
        {
          from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': ctx.controlNamespace } } }],
          ports: [{ protocol: 'TCP', port: SHIM_PORT }]
        }
      ]
    }
  })
  void obs
}

/** ResourceQuota/LimitRange from spec.quota; zero values mean unlimited. */
export async function ensureQuotaAndLimitRange(
  ctx: ReconcileContext,
  input: EnvelopeInputs,
  obs: Observations
): Promise<void> {
  const ns = input.spec.targetNamespace
  const quota = input.spec.quota
  const hard: Record<string, string> = {}
  if (quota.maxAgents > 0) hard['count/sandboxclaims.extensions.agents.x-k8s.io'] = String(quota.maxAgents)
  if (quota.cpu !== '0') hard['requests.cpu'] = quota.cpu
  if (quota.memory !== '0') hard['requests.memory'] = quota.memory
  if (quota.storage !== '0') hard['requests.storage'] = quota.storage
  if (Object.keys(hard).length === 0) {
    await deleteIgnoreMissing(ctx.http, corePath(ns, 'resourcequotas', QUOTA_NAME))
    await deleteIgnoreMissing(ctx.http, corePath(ns, 'limitranges', LIMIT_RANGE_NAME))
    return
  }
  await applyObject(ctx.http, corePath(ns, 'resourcequotas', QUOTA_NAME), {
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: { name: QUOTA_NAME, namespace: ns, labels: envelopeLabels(input.orgName) },
    spec: { hard }
  })
  // A compute quota rejects limit-less pods; the LimitRange supplies defaults so they still admit.
  if (hard['requests.cpu'] || hard['requests.memory']) {
    await applyObject(ctx.http, corePath(ns, 'limitranges', LIMIT_RANGE_NAME), {
      apiVersion: 'v1',
      kind: 'LimitRange',
      metadata: { name: LIMIT_RANGE_NAME, namespace: ns, labels: envelopeLabels(input.orgName) },
      spec: {
        limits: [
          {
            type: 'Container',
            defaultRequest: { cpu: '250m', memory: '512Mi' },
            default: { memory: '4Gi' }
          }
        ]
      }
    })
  } else {
    await deleteIgnoreMissing(ctx.http, corePath(ns, 'limitranges', LIMIT_RANGE_NAME))
  }
  void obs
}

interface SandboxTemplateResource extends K8sResource {
  spec?: {
    networkPolicy?: unknown
    podTemplate?: {
      spec?: { containers?: Array<{ name?: string; image?: string; env?: Array<{ name: string; value?: string }> }> }
    }
    [key: string]: unknown
  }
}

/** The sandbox egress rule set for one org, keyed by spec.egressPolicy. */
function sandboxEgress(policy: AgentConnectOrgSpec['egressPolicy']): unknown[] {
  const daemonAndDns = [
    {
      to: [{ podSelector: { matchLabels: { [APP_LABEL_KEY]: DAEMON_NAME } } }],
      ports: [{ protocol: 'TCP', port: SHIM_PORT }]
    },
    {
      ports: [
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 }
      ]
    }
  ]
  if (policy === 'locked') return daemonAndDns
  if (policy === 'curated') return [...daemonAndDns, { ports: [{ protocol: 'TCP', port: 443 }] }]
  return [{}]
}

/** Stamp per-org SandboxTemplate + one SandboxWarmPool per runtime tier from the cluster master templates. */
export async function ensureSandboxTemplates(
  ctx: ReconcileContext,
  input: EnvelopeInputs,
  obs: Observations
): Promise<void> {
  const ns = input.spec.targetNamespace
  for (const tier of input.spec.runtime.tiers) {
    const masterName = `${ctx.config.masterTemplatePrefix}${tier.name}`
    const master = await getOrNull<SandboxTemplateResource>(
      ctx.http,
      groupPath(SANDBOX_EXTENSIONS_GROUP, ctx.controlNamespace, 'sandboxtemplates', masterName)
    )
    if (!master) {
      obs.warnings.push(`master template ${masterName} not found in ${ctx.controlNamespace}; tier ${tier.name} skipped`)
      continue
    }
    const spec = structuredClone(master.spec ?? {})
    const container = spec.podTemplate?.spec?.containers?.[0]
    if (container) {
      container.image = input.spec.runtime.image
      const endpoint = `ws://${SHIM_SERVICE_NAME}.${ns}.svc.cluster.local:${SHIM_PORT}`
      const env = (container.env ??= [])
      const shim = env.find((entry) => entry.name === 'AC_SHIM_ENDPOINT')
      if (shim) shim.value = endpoint
      else env.push({ name: 'AC_SHIM_ENDPOINT', value: endpoint })
    }
    // The org's egress tier overrides the master's networkPolicy wholesale — deterministic, not merged.
    spec.networkPolicy = { egress: sandboxEgress(input.spec.egressPolicy) }
    const name = runtimeTierName(tier.name)
    await applyObject(ctx.http, groupPath(SANDBOX_EXTENSIONS_GROUP, ns, 'sandboxtemplates', name), {
      apiVersion: SANDBOX_EXTENSIONS_GROUP,
      kind: 'SandboxTemplate',
      metadata: { name, namespace: ns, labels: envelopeLabels(input.orgName) },
      spec
    })
    await applyObject(ctx.http, groupPath(SANDBOX_EXTENSIONS_GROUP, ns, 'sandboxwarmpools', name), {
      apiVersion: SANDBOX_EXTENSIONS_GROUP,
      kind: 'SandboxWarmPool',
      metadata: { name, namespace: ns, labels: envelopeLabels(input.orgName) },
      spec: {
        replicas: input.spec.suspend ? 0 : tier.warmReplicas,
        updateStrategy: { type: 'Recreate' },
        sandboxTemplateRef: { name }
      }
    })
  }
  await pruneRemovedTiers(ctx, input)
}

/** The CR is the sole desired-state carrier: tiers removed from spec lose their pool and template. */
async function pruneRemovedTiers(ctx: ReconcileContext, input: EnvelopeInputs): Promise<void> {
  const ns = input.spec.targetNamespace
  // A still-desired tier keeps its objects even when its master vanished: they are the
  // last-known-good render, and a control-namespace hiccup must not tear down a live pool.
  const desired = new Set(input.spec.runtime.tiers.map((tier) => runtimeTierName(tier.name)))
  for (const plural of ['sandboxwarmpools', 'sandboxtemplates']) {
    const list = await getOrNull<{ items?: Array<{ metadata?: { name?: string } }> }>(
      ctx.http,
      groupPath(SANDBOX_EXTENSIONS_GROUP, ns, plural),
      { labelSelector: `${ORG_LABEL}=${input.orgName}` }
    )
    for (const item of list?.items ?? []) {
      const name = item.metadata?.name
      // Only operator-named tier objects are candidates; anything else is not ours to prune.
      if (!name || !name.startsWith(RUNTIME_TIER_PREFIX) || desired.has(name)) continue
      await deleteIgnoreMissing(ctx.http, groupPath(SANDBOX_EXTENSIONS_GROUP, ns, plural, name))
    }
  }
}

/** The daemon's ReadWriteOncePod PVC (transcripts + state), sized and classed by the install. */
export async function ensureDaemonPvc(ctx: ReconcileContext, input: EnvelopeInputs, obs: Observations): Promise<void> {
  const ns = input.spec.targetNamespace
  const storageClass = ctx.config.daemonStorageClass
  // RWOP is load-bearing: the Recreate strategy assumes the volume can never double-attach.
  await applyObject(ctx.http, corePath(ns, 'persistentvolumeclaims', DAEMON_PVC_NAME), {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: DAEMON_PVC_NAME, namespace: ns, labels: envelopeLabels(input.orgName) },
    spec: {
      accessModes: ['ReadWriteOncePod'],
      // Omitted rather than emptied when unset: an empty string pins "no class", not the cluster default.
      ...(storageClass ? { storageClassName: storageClass } : {}),
      resources: { requests: { storage: ctx.config.daemonStorageSize } }
    }
  })
  void obs
}

/** Daemon Deployment: strategy Recreate, required credential Secret volume, credentialRevision annotation. */
export async function ensureDaemonDeployment(
  ctx: ReconcileContext,
  input: EnvelopeInputs,
  obs: Observations
): Promise<void> {
  const ns = input.spec.targetNamespace
  const daemon = input.spec.daemon
  const tier = DAEMON_TIERS[daemon.tier]
  if (!tier) obs.warnings.push(`unknown daemon tier ${daemon.tier}; using small`)
  const resources = tier ?? DAEMON_TIERS.small
  const firstTier = input.spec.runtime.tiers[0]
  if (!firstTier) obs.warnings.push('spec.runtime.tiers is empty; the daemon will refuse to start without a warm pool')
  const stateRoot = '/var/lib/agentconnect'
  const annotations = daemon.credentialRevision
    ? { [CREDENTIAL_REVISION_ANNOTATION]: daemon.credentialRevision }
    : undefined
  await applyObject(ctx.http, groupPath('apps/v1', ns, 'deployments', DAEMON_NAME), {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: DAEMON_NAME,
      namespace: ns,
      labels: envelopeLabels(input.orgName, { [APP_LABEL_KEY]: DAEMON_NAME })
    },
    spec: {
      replicas: input.spec.suspend ? 0 : 1,
      // Never two daemons briefly sharing one org's sandboxes and shim channels.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { [APP_LABEL_KEY]: DAEMON_NAME } },
      template: {
        metadata: {
          labels: envelopeLabels(input.orgName, { [APP_LABEL_KEY]: DAEMON_NAME }),
          ...(annotations ? { annotations } : {})
        },
        spec: {
          serviceAccountName: DAEMON_NAME,
          // Must exceed the daemon's shutdown drain or the kubelet SIGKILLs mid-drain.
          terminationGracePeriodSeconds: 60,
          securityContext: { runAsNonRoot: true, runAsUser: 10002, runAsGroup: 10002, fsGroup: 10002 },
          initContainers: [
            {
              // Copies the root-owned read-only Secret file onto the writable state volume at 0600.
              name: 'install-config',
              image: daemon.image,
              command: ['sh', '-c', `install -m 0600 /etc/agentconnect-secret/config.json ${stateRoot}/config.json`],
              volumeMounts: [
                { name: 'config', mountPath: '/etc/agentconnect-secret', readOnly: true },
                { name: 'state', mountPath: stateRoot }
              ]
            }
          ],
          containers: [
            {
              name: 'daemon',
              image: daemon.image,
              // tini is ENTRYPOINT, so args must name the interpreter.
              args: [
                'node',
                'dist/index.js',
                'run',
                '--k8s',
                '--root',
                stateRoot,
                '--config',
                `${stateRoot}/config.json`
              ],
              env: [
                { name: 'AC_K8S_ORG_ID', value: input.orgName },
                ...(firstTier ? [{ name: 'AC_K8S_WARM_POOL', value: runtimeTierName(firstTier.name) }] : []),
                { name: 'AC_K8S_SHIM_PORT', value: String(SHIM_PORT) }
              ],
              ports: [{ name: 'shim', containerPort: SHIM_PORT }],
              volumeMounts: [{ name: 'state', mountPath: stateRoot }],
              resources
            }
          ],
          volumes: [
            // Non-optional: the kubelet gates pod startup on this mount; the operator never reads the Secret.
            { name: 'config', secret: { secretName: daemon.credentialSecretName, optional: false } },
            { name: 'state', persistentVolumeClaim: { claimName: DAEMON_PVC_NAME } }
          ]
        }
      }
    }
  })
}

/** Daemon Service for relay ingress and shim dial-in. */
export async function ensureDaemonService(
  ctx: ReconcileContext,
  input: EnvelopeInputs,
  obs: Observations
): Promise<void> {
  const ns = input.spec.targetNamespace
  await applyObject(ctx.http, corePath(ns, 'services', SHIM_SERVICE_NAME), {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: SHIM_SERVICE_NAME, namespace: ns, labels: envelopeLabels(input.orgName) },
    spec: {
      selector: { [APP_LABEL_KEY]: DAEMON_NAME },
      ports: [{ name: 'shim', port: SHIM_PORT, targetPort: 'shim', protocol: 'TCP' }]
    }
  })
  void obs
}

/** The full envelope inventory in its policy-before-workload order (see the operator design doc). */
export async function reconcileEnvelope(
  ctx: ReconcileContext,
  input: EnvelopeInputs,
  obs: Observations
): Promise<void> {
  await ensureNamespace(ctx, input, obs)
  // A namespace fault (prefix violation, claim conflict) blocks everything downstream.
  if (!obs.namespaceReady) return
  await ensureServiceAccounts(ctx, input, obs)
  await ensureRoleAndBinding(ctx, input, obs)
  await ensureTokenReviewClusterRoleBinding(ctx, input, obs)
  await ensureNetworkPolicies(ctx, input, obs)
  await ensureQuotaAndLimitRange(ctx, input, obs)
  await ensureSandboxTemplates(ctx, input, obs)
  await ensureDaemonPvc(ctx, input, obs)
  await ensureDaemonDeployment(ctx, input, obs)
  await ensureDaemonService(ctx, input, obs)
}
