#!/usr/bin/env ruby
# Render contract for charts/agentconnect: the load-bearing facts of the daemon pool, the
# runtime SandboxTemplate/warm pool, the cluster-scoped RBAC, and the agents namespace —
# rendered with plain `helm template` and synthetic values, no cluster required.

require 'yaml'
require 'open3'

chart = File.expand_path('../charts/agentconnect', __dir__)
command = [
  'helm', 'template', 'example-agentconnect', chart,
  '--namespace', 'agentconnect-example',
  '--set', 'image.tag=v1.41.0-rc.90',
  '--set', 'daemonPool.runtime.tag=v1.41.0-rc.88',
  '--set', 'daemonPool.enabled=true',
  '--set', 'daemonPool.tag=v1.41.0-rc.89',
  '--set', 'daemonPool.sandboxNamespace=agentconnect-example-agents',
  '--set', 'daemonPool.dataPlane.existingSecret=example-data-plane',
  # Placement is per-install, so the contract only holds if a consumer's values can set it.
  '--set-json', 'daemonPool.runtime.nodeSelector={"example.com/agents":"true"}',
  '--set-json', 'daemonPool.runtime.tolerations=' \
    '[{"key":"example.com/agents","operator":"Equal","value":"true","effect":"NoSchedule"}]'
]

rendered, error, status = Open3.capture3(*command)
abort("helm template failed:\n#{error}") unless status.success?

documents = YAML.load_stream(rendered).compact
find = lambda do |kind, name|
  documents.find { |doc| doc['kind'] == kind && doc.dig('metadata', 'name') == name } ||
    abort("missing #{kind}/#{name}")
end

deployment = find.call('Deployment', 'example-agentconnect-daemon-pool')
spec = deployment.fetch('spec')
pod_template = spec.fetch('template')
pod = pod_template.fetch('spec')
container = pod.fetch('containers').find { |item| item['name'] == 'daemon-pool' } || abort('missing daemon-pool container')
env = container.fetch('env').to_h { |item| [item.fetch('name'), item['value']] }
mounts = container.fetch('volumeMounts').to_h { |item| [item.fetch('name'), item] }
volumes = pod.fetch('volumes').to_h { |item| [item.fetch('name'), item] }

abort('daemon pool must default to three replicas') unless spec['replicas'] == 3
# Readiness is a real signal (#1056), so this is only a settle margin on top of it — not a
# timed stand-in for "registered and probed".
abort('daemon-pool rollout must keep a short settle margin over the readiness probe') unless spec['minReadySeconds'] == 10
# Surge the whole pool, then drain the old members: capacity never dips and each agent moves once.
abort('daemon-pool rollout must be a rolling update') unless spec.dig('strategy', 'type') == 'RollingUpdate'
abort('daemon-pool rollout must surge the whole pool at zero unavailability') unless spec.dig('strategy', 'rollingUpdate') == {
  'maxSurge' => '100%', 'maxUnavailable' => 0
}
# The daemon's own `limits.poolShutdownDrainMs` (300s) plus margin. A shorter grace period
# SIGKILLs the drain, and the groups it was releasing wait out their leases instead.
abort('daemon-pool grace period must outlast the shutdown drain budget') unless pod['terminationGracePeriodSeconds'] == 330
# `ac-cloud-daemon`, not `ac-daemon-pool`: the SA name is the app's identity contract and was
# deliberately left behind when everything else took the daemon-pool vocabulary.
abort('daemon pool must use the fixed Kubernetes identity') unless pod['serviceAccountName'] == 'ac-cloud-daemon'
abort('daemon pool must use its effective component tag') unless container['image'] == 'ghcr.io/agentconnect-md/daemon:v1.41.0-rc.89'
abort('runtime image changes must roll daemon-pool probes') unless pod_template.dig('metadata', 'annotations', 'agentconnect.md/runtime-sandbox-tag') == 'v1.41.0-rc.88'
abort('daemon pool must use in-cluster CP websocket') unless env['AC_CP_URL'] == 'ws://example-agentconnect-control-plane:8080/daemon/ws'
abort('daemon pool must declare Kubernetes supervision') unless env['AGENTCONNECT_SUPERVISOR'] == 'k8s'
abort('daemon pool must claim against the release-prefixed warm pool') unless env['AC_K8S_WARM_POOL'] == 'example-agentconnect-runtime-pool'
abort('daemon pool must use the configured sandbox namespace') unless env['AC_K8S_SANDBOX_NAMESPACE'] == 'agentconnect-example-agents'
abort('install-wide daemon pool must not be pinned to one org') if env.key?('AC_K8S_ORG_ID')
# The member publishes readiness only when told which port to serve it on, and the probe must
# read that same port — a mismatch is a pool that never becomes Ready and a wedged rollout.
abort('daemon pool must serve its readiness endpoint') unless env['AC_READINESS_PORT'] == '8081'
readiness = container['readinessProbe'] || abort('daemon pool member must have a readiness probe')
abort('readiness probe must GET /readyz on the readiness port') unless readiness['httpGet'] == { 'path' => '/readyz', 'port' => 8081 }
abort('readiness probe timings must match #1056') unless readiness.reject { |key, _| key == 'httpGet' } == {
  'initialDelaySeconds' => 5, 'periodSeconds' => 5, 'timeoutSeconds' => 2,
  'successThreshold' => 1, 'failureThreshold' => 3
}
# The readiness port is a probe surface. A Service that routed it would send real traffic to a
# port that serves nothing but /readyz, and would publish the member on a second path.
abort('the readiness port must not be exposed through a Service') if documents.any? { |doc|
  doc['kind'] == 'Service' && doc.dig('spec', 'ports').to_a.any? { |port| [port['port'], port['targetPort']].include?(8081) }
}
# The generation the control plane will fence old members by (#1016). A member that cannot
# tell which pod template it came from cannot be excluded from claiming after a rollout.
generation = container.fetch('env').find { |item| item['name'] == 'AC_POD_TEMPLATE_HASH' }
abort('daemon pool must expose its pod-template generation') unless generation&.dig('valueFrom', 'fieldRef', 'fieldPath') == "metadata.labels['pod-template-hash']"
abort('missing data-plane config mount') unless mounts.dig('data-plane', 'mountPath') == '/var/run/ac-data-plane' && mounts.dig('data-plane', 'readOnly')
abort('missing Kubernetes identity mount') unless mounts.dig('cp-identity', 'mountPath') == '/var/run/ac-cp-identity' && mounts.dig('cp-identity', 'readOnly')
abort('wrong data-plane Secret') unless volumes.dig('data-plane', 'secret', 'secretName') == 'example-data-plane'
token = volumes.dig('cp-identity', 'projected', 'sources')&.first&.dig('serviceAccountToken')
abort('wrong CP token projection') unless token == { 'path' => 'token', 'audience' => 'ac-control-plane', 'expirationSeconds' => 3600 }

find.call('ServiceAccount', 'ac-cloud-daemon')
runtime_role = find.call('Role', 'example-agentconnect-daemon-pool-runtime')
abort('runtime Role must live with the sandboxes') unless runtime_role.dig('metadata', 'namespace') == 'agentconnect-example-agents'
runtime_rules = runtime_role.fetch('rules')
abort('daemon pool cannot manage SandboxClaims') unless runtime_rules.any? { |r| r['resources'] == ['sandboxclaims'] && r['verbs'].sort == %w[create delete get list watch] }
abort('daemon pool cannot read warm pools and sandbox templates') unless runtime_rules.any? do |r|
  r['apiGroups'] == ['extensions.agents.x-k8s.io'] &&
    r['resources'].sort == %w[sandboxtemplates sandboxwarmpools] &&
    r['verbs'] == ['get']
end
abort('daemon pool cannot manage Sandboxes') unless runtime_rules.any? { |r| r['resources'] == ['sandboxes'] && r['verbs'].sort == %w[delete get list patch watch] }
runtime_binding = find.call('RoleBinding', 'example-agentconnect-daemon-pool-runtime')
abort('runtime RoleBinding must live with the sandboxes') unless runtime_binding.dig('metadata', 'namespace') == 'agentconnect-example-agents'
abort('runtime RoleBinding must bind the daemon ServiceAccount across namespaces') unless runtime_binding.fetch('subjects') == [{
  'kind' => 'ServiceAccount', 'name' => 'ac-cloud-daemon', 'namespace' => 'agentconnect-example'
}]
network_policy = find.call('NetworkPolicy', 'example-agentconnect-daemon-pool-shim')
abort('shim ingress policy must live with the sandboxes') unless network_policy.dig('metadata', 'namespace') == 'agentconnect-example-agents'
abort('shim ingress policy must select every AgentConnect sandbox') unless network_policy.dig('spec', 'podSelector') == {
  'matchLabels' => { 'agentconnect.md/sandbox' => 'true' }
}
abort('shim policy must isolate ingress only') unless network_policy.dig('spec', 'policyTypes') == ['Ingress']
abort('shim policy must not add sandbox egress rules') if network_policy.fetch('spec').key?('egress')
ingress_rules = network_policy.dig('spec', 'ingress')
abort('shim policy must have one coarse ingress rule') unless ingress_rules&.length == 1
ingress = ingress_rules.first
source_peers = ingress['from']
abort('shim ingress must have one daemon-pool source peer') unless source_peers&.length == 1
abort('shim ingress does not bind namespace and daemon-pool identity') unless source_peers.first == {
  'namespaceSelector' => {
    'matchLabels' => { 'kubernetes.io/metadata.name' => 'agentconnect-example' }
  },
  'podSelector' => {
    'matchLabels' => {
      'app.kubernetes.io/name' => 'agentconnect',
      'app.kubernetes.io/instance' => 'example-agentconnect',
      'app.kubernetes.io/component' => 'daemon-pool'
    }
  }
}
abort('shim ingress policy does not allow TCP/8085') unless ingress['ports'] == [{ 'protocol' => 'TCP', 'port' => 8085 }]
# The peer selector and the daemon pool's own labels must agree, or the policy names a set
# of pods that does not exist and shim ingress silently closes. Both sides come from one
# helper — assert the rendered result so a future edit to either cannot separate them.
peer_selector = source_peers.first.dig('podSelector', 'matchLabels')
abort('shim peer selector does not match the daemon-pool Deployment selector') unless peer_selector == spec.dig('selector', 'matchLabels')
pool_pod_labels = pod_template.dig('metadata', 'labels')
abort('shim peer selector does not select the daemon-pool pods') unless peer_selector.all? { |key, value| pool_pod_labels[key] == value }

# The runtime prerequisites the daemon pool claims through. Both are chart-owned and named like
# every other chart-owned object, derived from the release rather than configured.
sandbox_template = find.call('SandboxTemplate', 'example-agentconnect-runtime')
abort('runtime template must live with the sandboxes') unless sandbox_template.dig('metadata', 'namespace') == 'agentconnect-example-agents'
template_spec = sandbox_template.fetch('spec')
abort('sandbox NetworkPolicy must stay controller-managed') unless template_spec['networkPolicyManagement'] == 'Managed'
abort('a claim must not inject its own env') unless template_spec['envVarsInjectionPolicy'] == 'Disallowed'
abort('a claim must not attach its own volumes') unless template_spec['volumeClaimTemplatesPolicy'] == 'Disallowed'
egress_rules = template_spec.dig('networkPolicy', 'egress') || abort('runtime template must define sandbox egress')
egress_ports = egress_rules.flat_map { |rule| rule.fetch('ports') }
abort('sandbox egress must be exactly DNS and TLS') unless egress_ports.map { |p| p['port'] }.sort == [53, 53, 443]
# A member dials the sandbox and replies ride that connection; a sandbox->daemon-pool rule would
# only widen what an agent can reach.
abort('sandbox egress must not name a peer') if egress_rules.any? { |rule| rule.key?('to') }
# The controller renders the sandbox policy from the field above; a second chart-owned
# NetworkPolicy for the same pods would be a duplicate nobody reconciles.
sandbox_policies = documents.select { |doc| doc['kind'] == 'NetworkPolicy' }
abort('chart must own exactly two NetworkPolicies (the agents baseline and the shim ingress)') unless sandbox_policies.length == 2

# The template stamps the label the shim policy selects, so a sandbox is inside that policy from
# birth rather than from its claim. Assert both ends here: split them and warm spares fall outside
# the policy, where the default-deny baseline drops the pool's first dials in silence.
abort('sandboxes must carry the label the shim ingress policy selects') unless
  template_spec.dig('podTemplate', 'metadata', 'labels') == { 'agentconnect.md/sandbox' => 'true' }
abort('shim policy and sandbox template must name one label') unless
  network_policy.dig('spec', 'podSelector', 'matchLabels') == template_spec.dig('podTemplate', 'metadata', 'labels')

template_pod = template_spec.dig('podTemplate', 'spec')
abort('sandboxes must not mount an API credential') unless template_pod['automountServiceAccountToken'] == false
# Pod- and container-level together are the `restricted` Pod Security profile the agents
# namespace enforces; drop any of these and every sandbox is rejected at admission.
abort('sandboxes must run non-root under the default seccomp profile') unless template_pod.fetch('securityContext') == {
  'runAsNonRoot' => true, 'runAsUser' => 10001, 'runAsGroup' => 10001, 'fsGroup' => 10001,
  'seccompProfile' => { 'type' => 'RuntimeDefault' }
}
abort('agent pods must be pinned to the configured node group') unless template_pod['nodeSelector'] == { 'example.com/agents' => 'true' }
abort('agent pods must tolerate the configured node taint') unless template_pod['tolerations'] == [
  { 'key' => 'example.com/agents', 'operator' => 'Equal', 'value' => 'true', 'effect' => 'NoSchedule' }
]
runtime_container = template_pod.fetch('containers').find { |item| item['name'] == 'runtime' } || abort('missing runtime container')
abort('runtime container must use the effective runtime-sandbox tag') unless runtime_container['image'] == 'ghcr.io/agentconnect-md/runtime-sandbox:v1.41.0-rc.88'
abort('runtime container must root the workspace') unless runtime_container.fetch('env') == [{ 'name' => 'AC_SHIM_WORKSPACE_ROOT', 'value' => '/agent' }]
abort('runtime container must satisfy restricted Pod Security') unless runtime_container['securityContext'] == {
  'allowPrivilegeEscalation' => false, 'capabilities' => { 'drop' => ['ALL'] }
}
runtime_mounts = runtime_container.fetch('volumeMounts').to_h { |item| [item.fetch('name'), item] }
abort('missing workspace mount') unless runtime_mounts.dig('workspace', 'mountPath') == '/agent'
abort('missing shim identity mount') unless runtime_mounts.dig('ac-identity', 'mountPath') == '/var/run/ac-identity' && runtime_mounts.dig('ac-identity', 'readOnly')
identity = template_pod.fetch('volumes').find { |item| item['name'] == 'ac-identity' }
abort('wrong shim callback token projection') unless identity&.dig('projected', 'sources') == [{
  'serviceAccountToken' => { 'path' => 'token', 'audience' => 'ac-daemon-callback', 'expirationSeconds' => 3600 }
}]
workspace_claim = template_spec.fetch('volumeClaimTemplates').find { |item| item.dig('metadata', 'name') == 'workspace' } || abort('missing workspace volumeClaimTemplate')
abort('workspace claim must be a 10Gi standard RWO volume') unless workspace_claim.fetch('spec') == {
  'accessModes' => ['ReadWriteOnce'], 'storageClassName' => 'standard',
  'resources' => { 'requests' => { 'storage' => '10Gi' } }
}

warm_pool = find.call('SandboxWarmPool', 'example-agentconnect-runtime-pool')
abort('warm pool must live with the sandboxes') unless warm_pool.dig('metadata', 'namespace') == 'agentconnect-example-agents'
abort('warm pool must reference the rendered template') unless warm_pool.dig('spec', 'sandboxTemplateRef', 'name') == 'example-agentconnect-runtime'
abort('warm pool must hold no spares by default') unless warm_pool.dig('spec', 'replicas') == 0
abort('warm pool must push template changes to its spares') unless warm_pool.dig('spec', 'updateStrategy', 'type') == 'Recreate'
abort('warm pool name must match what a daemon-pool member claims against') unless warm_pool.dig('metadata', 'name') == env['AC_K8S_WARM_POOL']

# The orphan reconciler (#1074/#1079): the sweep that used to be a timer inside every member,
# now a CronJob the cluster schedules. It rides `daemonPool.enabled` because it sweeps that
# pool's objects with that pool's identity.
reconciler = find.call('CronJob', 'example-agentconnect-daemon-pool-reconciler')
reconciler_spec = reconciler.fetch('spec')
abort('reconciler must sweep every ten minutes') unless reconciler_spec['schedule'] == '*/10 * * * *'
# `Forbid` IS the mutual exclusion the in-process lease used to provide; two sweeps at once would
# read one listing and race each other's deletes.
abort('reconciler must never run two sweeps at once') unless reconciler_spec['concurrencyPolicy'] == 'Forbid'
abort('a missed reconciler tick must be dropped, not run late') unless reconciler_spec['startingDeadlineSeconds'] == 120
abort('reconciler must keep one success and three failures') unless [reconciler_spec['successfulJobsHistoryLimit'], reconciler_spec['failedJobsHistoryLimit']] == [1, 3]
job_spec = reconciler_spec.dig('jobTemplate', 'spec')
# A failed sweep has a reason a retry ten seconds later does not change, and the deadline is what
# keeps a hung run from sitting across the next tick and blocking it under `Forbid`.
abort('a failed sweep must not be retried inside its tick') unless job_spec['backoffLimit'] == 0
abort('a hung sweep must not outlive its tick') unless job_spec['activeDeadlineSeconds'] == 300
job_pod = job_spec.dig('template', 'spec')
abort('reconciler pod must not be restarted in place') unless job_pod['restartPolicy'] == 'Never'
# The members' identity, so the sweep's cluster rights are exactly their claim Role and its
# control-plane identity is the same TokenReview subject — nothing extra is granted to sweep.
abort('reconciler must run as the pool identity') unless job_pod['serviceAccountName'] == 'ac-cloud-daemon'
abort('reconciler needs the Kubernetes API credential it lists and deletes with') unless job_pod['automountServiceAccountToken'] == true
abort('reconciler must run under the members security context') unless job_pod['securityContext'] == pod['securityContext']
reconcile_container = job_pod.fetch('containers').find { |item| item['name'] == 'reconcile' } || abort('missing reconcile container')
# One image, one tag: the sweep's rules ship with the daemon the members run.
abort('reconciler must run the daemon image at the pool tag') unless reconcile_container['image'] == container['image']
# `args` replaces CMD and leaves the image's tini ENTRYPOINT in place, so the node invocation is
# spelled out — `['reconcile', '--once']` alone would ask tini to exec a binary named `reconcile`.
abort('reconciler must run exactly one sweep') unless reconcile_container['args'] == ['node', 'dist/index.js', 'reconcile', '--once']
abort('reconciler must satisfy the same container security context') unless reconcile_container['securityContext'] == container['securityContext']
reconcile_env = reconcile_container.fetch('env').to_h { |item| [item.fetch('name'), item['value']] }
# The anti-drift assertion the shared env partial exists for: a sweep pointed at another
# namespace, warm pool or control plane than the members' silently reads the wrong objects
# and reports a clean run.
%w[AC_CP_URL AC_K8S_WARM_POOL AC_K8S_SANDBOX_NAMESPACE AGENTCONNECT_SUPERVISOR].each do |key|
  abort("reconciler #{key} must match the pool members") unless reconcile_env[key] == env[key]
end
# Dry run by default: deleting a claim deletes the agent's workspace PVC and there is no undo, so
# collection is a value an install flips after watching the summary lines.
abort('reconciler must ship dry-run') if reconcile_env.key?('AC_K8S_ORPHAN_DELETE')
abort('reconciler must leave the grace period at the daemon default') if reconcile_env.key?('AC_K8S_ORPHAN_GRACE_MS')
# Member-only variables have no meaning for a one-shot sweep and must not be implied by the partial.
%w[AC_K8S_MEMBER_ID AC_POD_TEMPLATE_HASH AC_READINESS_PORT].each do |key|
  abort("reconciler must not carry the member-only #{key}") if reconcile_container.fetch('env').any? { |item| item['name'] == key }
end
reconcile_mounts = reconcile_container.fetch('volumeMounts').to_h { |item| [item.fetch('name'), item] }
abort('reconciler needs the CP identity mount the members have') unless reconcile_mounts['cp-identity'] == mounts['cp-identity']
reconcile_token = job_pod.fetch('volumes').find { |item| item['name'] == 'cp-identity' }
abort('reconciler must present the same projected CP token') unless reconcile_token == volumes['cp-identity']
# A one-shot sweep holds no agent state; the data-plane database is the members' business.
abort('reconciler must not mount the data-plane Secret') if reconcile_mounts.key?('data-plane')

# Collection and the grace period are the two knobs an install turns after its observation window.
delete_rendered, delete_error, delete_status = Open3.capture3(*(command + [
  '--set', 'daemonPool.reconciler.delete=true', '--set', 'daemonPool.reconciler.graceMs=1800000'
]))
abort("helm template (reconciler deleting) failed:\n#{delete_error}") unless delete_status.success?
delete_cron = YAML.load_stream(delete_rendered).compact.find do |doc|
  doc['kind'] == 'CronJob' && doc.dig('metadata', 'name') == 'example-agentconnect-daemon-pool-reconciler'
end || abort('missing reconciler CronJob with deletion on')
delete_env = delete_cron.dig('spec', 'jobTemplate', 'spec', 'template', 'spec', 'containers')
  .find { |item| item['name'] == 'reconcile' }.fetch('env').to_h { |item| [item.fetch('name'), item['value']] }
abort('daemonPool.reconciler.delete must enable collection') unless delete_env['AC_K8S_ORPHAN_DELETE'] == 'true'
abort('daemonPool.reconciler.graceMs must set the grace period') unless delete_env['AC_K8S_ORPHAN_GRACE_MS'] == '1800000'

# One chart, one release: the cluster-scoped objects the install needs are rendered here,
# not by a second chart. They ride `daemonPool.enabled` — see the disabled render at the end.
cluster_roles = documents.select { |doc| doc['kind'] == 'ClusterRole' }
abort('chart must own exactly one ClusterRole (the TokenReview grant)') unless cluster_roles.length == 1
token_review = cluster_roles.first
abort('TokenReview ClusterRole must be release-prefixed') unless token_review.dig('metadata', 'name') == 'example-agentconnect-ac-tokenreview'
abort('TokenReview ClusterRole must grant nothing but tokenreviews: create') unless token_review.fetch('rules') == [{
  'apiGroups' => ['authentication.k8s.io'], 'resources' => ['tokenreviews'], 'verbs' => ['create']
}]
cluster_role_bindings = documents.select { |doc| doc['kind'] == 'ClusterRoleBinding' }
abort('chart must own exactly the two TokenReview bindings') unless cluster_role_bindings.length == 2
expected_role_ref = { 'apiGroup' => 'rbac.authorization.k8s.io', 'kind' => 'ClusterRole', 'name' => 'example-agentconnect-ac-tokenreview' }
# The control plane reviews an in-cluster daemon's projected token; a mismatch with the
# deployed ServiceAccount does not fail a deploy, it 403s every in-cluster registration.
cp_binding = find.call('ClusterRoleBinding', 'example-agentconnect-ac-tokenreview-control-plane')
abort('control-plane TokenReview binding has the wrong subject') unless cp_binding['subjects'] == [{
  'kind' => 'ServiceAccount', 'name' => 'example-agentconnect-control-plane', 'namespace' => 'agentconnect-example'
}]
abort('control-plane TokenReview binding uses the wrong role') unless cp_binding['roleRef'] == expected_role_ref
# `cloud-daemon`, like the ServiceAccount: this binding and its subject are the identity contract.
pool_binding = find.call('ClusterRoleBinding', 'example-agentconnect-ac-tokenreview-cloud-daemon')
abort('daemon-pool TokenReview binding has the wrong subject') unless pool_binding['subjects'] == [{
  'kind' => 'ServiceAccount', 'name' => 'ac-cloud-daemon', 'namespace' => 'agentconnect-example'
}]
abort('daemon-pool TokenReview binding uses the wrong role') unless pool_binding['roleRef'] == expected_role_ref

# The agents namespace and its baseline. One value (`daemonPool.sandboxNamespace`) drives both
# sides, so the namespace the chart creates and the one a pool member claims into cannot differ.
agents_namespace = find.call('Namespace', 'agentconnect-example-agents')
namespace_labels = agents_namespace.dig('metadata', 'labels')
%w[enforce audit warn].each do |mode|
  abort("agents namespace must #{mode} restricted Pod Security") unless namespace_labels["pod-security.kubernetes.io/#{mode}"] == 'restricted'
end
abort('agents namespace must be adoptable and Helm-managed') unless namespace_labels['app.kubernetes.io/managed-by'] == 'Helm'
abort('agents namespace must survive an uninstall') unless agents_namespace.dig('metadata', 'annotations', 'helm.sh/resource-policy') == 'keep'
default_deny = find.call('NetworkPolicy', 'example-agentconnect-agents-default-deny')
abort('default-deny must live in the agents namespace') unless default_deny.dig('metadata', 'namespace') == 'agentconnect-example-agents'
abort('default-deny must select every pod') unless default_deny.dig('spec', 'podSelector') == {}
abort('default-deny must deny both directions') unless default_deny.dig('spec', 'policyTypes')&.sort == %w[Egress Ingress]
abort('default-deny must carry no allow rules') if default_deny.fetch('spec').key?('ingress') || default_deny.fetch('spec').key?('egress')
# The vendored agent-sandbox stack is cluster-shared and may be managed out-of-band; nothing
# here may render a CRD unless an install explicitly asks for it.
abort('installCRD must default off') if documents.any? { |doc| doc['kind'] == 'CustomResourceDefinition' }

control_plane = find.call('Deployment', 'example-agentconnect-control-plane')
cp_container = control_plane.dig('spec', 'template', 'spec', 'containers').find { |item| item['name'] == 'control-plane' }
cp_env = cp_container.fetch('env').to_h { |item| [item.fetch('name'), item['value']] }
abort('control plane must carry the daemon-pool switch') unless cp_env['DAEMON_POOL_ENABLED'] == 'true'
# The switch above is the control plane's whole cluster-access switch; neither the retired
# CLUSTER_EXECUTION_ENABLED / POOL_NAMESPACE keys nor the envelope seed envs may come back.
abort('control plane must not render the retired POOL_NAMESPACE') if cp_env.key?('POOL_NAMESPACE')
abort('control plane must not render retired CLUSTER_* envs') if cp_env.keys.any? { |k| k.start_with?('CLUSTER_') }

# An install with the switch off must not grow a single cluster-scoped object just because the
# chart carries them: in-cluster daemons are the only thing that presents a projected token,
# and an install without a pool has none.
disabled_command = command + ['--set', 'daemonPool.enabled=false']
disabled_rendered, disabled_error, disabled_status = Open3.capture3(*disabled_command)
abort("helm template (no daemon pool) failed:\n#{disabled_error}") unless disabled_status.success?
disabled_documents = YAML.load_stream(disabled_rendered).compact
%w[ClusterRole ClusterRoleBinding Namespace NetworkPolicy].each do |kind|
  abort("an install without a daemon pool must render no #{kind}") if disabled_documents.any? { |doc| doc['kind'] == kind }
end
# The reconciler sweeps the pool's own objects, so an install without a pool must not schedule it.
abort('an install without a daemon pool must render no reconciler CronJob') if disabled_documents.any? { |doc|
  doc['kind'] == 'CronJob' && doc.dig('metadata', 'name').to_s.end_with?('-daemon-pool-reconciler')
}

# A single-namespace install keeps sandboxes in the release namespace; the chart must not
# then try to create (or adopt) the namespace it is already deployed in.
same_namespace_command = command + ['--set', 'daemonPool.sandboxNamespace=agentconnect-example']
same_rendered, same_error, same_status = Open3.capture3(*same_namespace_command)
abort("helm template (sandboxes in the release namespace) failed:\n#{same_error}") unless same_status.success?
abort('the chart must not render its own release namespace') if YAML.load_stream(same_rendered).compact.any? { |doc| doc['kind'] == 'Namespace' }

# The vendored agent-sandbox stack: off by default, and the file is still there when asked
# for. `helm template --set installCRD=true` is also how it is applied out-of-band.
vendored_rendered, vendored_error, vendored_status = Open3.capture3(*(command + ['--set', 'installCRD=true']))
abort("helm template (installCRD) failed:\n#{vendored_error}") unless vendored_status.success?
vendored_documents = YAML.load_stream(vendored_rendered).compact
crds = vendored_documents.select { |doc| doc['kind'] == 'CustomResourceDefinition' }
abort('installCRD must render the four vendored agent-sandbox CRDs') unless crds.length == 4
abort('vendored CRDs must survive an uninstall') unless crds.all? { |doc| doc.dig('metadata', 'annotations', 'helm.sh/resource-policy') == 'keep' }
# Without this ConfigMap the controller rejects every claim the daemon makes as InvalidMetadata.
allowlist = vendored_documents.find { |doc| doc['kind'] == 'ConfigMap' && doc.dig('metadata', 'name') == 'agent-sandbox-config' } ||
            abort('installCRD must render the controller label allowlist')
abort('label allowlist must name both domains') unless allowlist.dig('data', 'allowed-label-domains') == 'sandbox.users.io,agentconnect.md'

puts 'chart render contract: ok'
