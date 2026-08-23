{{/* Base name, overridable. */}}
{{- define "agentconnect.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully qualified release-scoped name. */}}
{{- define "agentconnect.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Common labels. */}}
{{- define "agentconnect.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: agentconnect
{{- end -}}

{{/* Per-component selector labels. Call with (dict "ctx" . "component" "web"). */}}
{{- define "agentconnect.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agentconnect.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* The same triple, minus the instance label `agentconnect.labels` already emits — for a
     `metadata.labels` map that includes both. Emitting the key twice renders duplicate YAML,
     which every strict parser rejects. Selectors keep using
     `selectorLabels`: the full triple is what a live Deployment's immutable selector holds. */}}
{{- define "agentconnect.componentLabels" -}}
app.kubernetes.io/name: {{ include "agentconnect.name" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Shared fallback image tag (defaults to appVersion); per-component
`<component>.tag` overrides win at each consumer. */}}
{{- define "agentconnect.imageTag" -}}
{{- default .Chart.AppVersion .Values.image.tag -}}
{{- end -}}

{{/* The runtime-sandbox image agent sandboxes are minted from — the daemon pool's
     SandboxTemplate reads this one helper. Set `daemonPool.runtime.tag` to the release's
     EFFECTIVE runtime-sandbox tag; `daemonPool.runtime.image` pins a full reference outright. */}}
{{- define "agentconnect.runtimeSandboxImage" -}}
{{- .Values.daemonPool.runtime.image | default (printf "%s/runtime-sandbox:%s" .Values.image.registry (.Values.daemonPool.runtime.tag | default (include "agentconnect.imageTag" .))) -}}
{{- end -}}

{{/* The daemon pool's agent-sandbox prerequisites, release-prefixed like every other chart-owned
     object. "Warm pool" here is the SandboxWarmPool, not the member set. Derived rather
     than configured: the warm pool a member claims against (AC_K8S_WARM_POOL) and the one
     the chart renders are the same string by construction, so they cannot drift apart. */}}
{{- define "agentconnect.runtimeTemplateName" -}}
{{- printf "%s-runtime" (include "agentconnect.fullname" .) -}}
{{- end -}}

{{- define "agentconnect.warmPoolName" -}}
{{- printf "%s-runtime-pool" (include "agentconnect.fullname" .) -}}
{{- end -}}

{{/* Setup Server's ServiceAccount. DEFAULTS to the control plane's account — it is the
     identity the Vault kubernetes auth role binds by exact name, and both authenticate to
     Vault with it. Sharing it also means the Setup Server inherits every RBAC grant the
     control plane holds, which is why the two are separable at all. Giving it its own
     account REQUIRES that name to be added to the Vault role FIRST: flip this before the
     role knows the new name and the workload fail-fasts on its first secret operation. */}}
{{- define "agentconnect.setupServerServiceAccountName" -}}
{{- .Values.setupServer.serviceAccount.name | default (include "agentconnect.controlPlaneServiceAccountName" .) -}}
{{- end -}}

{{/* The control-plane's ServiceAccount name. Each release gets its OWN SA
     (`<release>-control-plane`), so a Vault kubernetes auth role can bind a transit
     policy to this release's identity and namespace alone — which is what keeps two
     releases sharing one Vault from reaching each other's keys. Overridable via
     controlPlane.serviceAccount.name. */}}
{{- define "agentconnect.controlPlaneServiceAccountName" -}}
{{- .Values.controlPlane.serviceAccount.name | default (printf "%s-control-plane" (include "agentconnect.fullname" .)) -}}
{{- end -}}

{{/* ServiceAccount of the crypto-shred CronJob. DISTINCT from the control
     plane's on purpose: a Vault role binds to a ServiceAccount, so key
     deletion granted to a role bound to the CP's SA would stay reachable from
     the CP. The separation is the identity, not the role name. */}}
{{- define "agentconnect.secretShredServiceAccountName" -}}
{{- .Values.controlPlane.shred.serviceAccountName | default (printf "%s-secret-shred" (include "agentconnect.fullname" .)) -}}
{{- end -}}

{{/* Public host the relay is reached at (browser /webchat + daemon /rd/ws).
     relay.host wins; else the apiHost (subdomain mode) it co-locates on; else the
     website host. Empty ⇒ no relay routing / no PUBLIC_RELAY_URL. */}}
{{- define "agentconnect.relayHost" -}}
{{- .Values.relay.host | default .Values.apiHost | default (.Values.publicUrl | trimPrefix "https://" | trimPrefix "http://" | trimSuffix "/") -}}
{{- end -}}

{{/* The https:// origin the CP stores as PUBLIC_RELAY_URL. Webchat clients convert
     http(s) to ws(s); webhook callers use this origin for POST /webhooks/in. */}}
{{- define "agentconnect.relayPublicUrl" -}}
{{- printf "https://%s" (include "agentconnect.relayHost" .) -}}
{{- end -}}

{{/* Whether the relay actually renders: enabled AND a public host resolves. With every host
     input empty (the bare local default) an enabled relay would render only broken origins —
     PUBLIC_RELAY_URL "https://", DAEMON_DIAL_URL "wss:///…" — and force RELAY_TOKEN on a CP
     nothing can dial, so like the HTTPRoute it waits for a hostname instead. Emits "true" or
     "": usable directly as an `if` condition. */}}
{{- define "agentconnect.relayActive" -}}
{{- if and .Values.relay.enabled (include "agentconnect.relayHost" .) -}}true{{- end -}}
{{- end -}}

{{/* The verified sender address the waitlist copy names. The CP and web both read it as
     WAITLIST_FROM_EMAIL, from one value, so the two cannot disagree about who the activation
     mail comes from. Whatever actually SENDS that mail is outside this chart, which is why
     this is a plain string and not derived: set it to the same address that sender is
     configured with, or users go looking for mail from an address nothing sent. Empty ⇒
     callers omit the env entirely (no address to name). */}}
{{- define "agentconnect.emailFrom" -}}
{{- .Values.waitlistFromEmail -}}
{{- end -}}

{{/* The per-pod wss:// origin relays register as DAEMON_DIAL_URL. Kubernetes expands
     POD_INDEX from the StatefulSet pod-index label; daemons append /rd/ws, and the
     Gateway rewrites the short ordinal prefix onto that pod's single-endpoint Service. */}}
{{- define "agentconnect.relayDaemonDialUrl" -}}
{{- printf "wss://%s/relays/$(POD_INDEX)" (include "agentconnect.relayHost" .) -}}
{{- end -}}

{{/* The cluster environment BOTH the daemon-pool members and the orphan-reconciler CronJob
     read: the in-cluster control-plane address, the warm pool claims resolve through, the
     namespace sandbox objects live in, and the supervisor declaration. One partial so a
     member and the job that sweeps after it cannot disagree about any of the four —
     disagreeing on the namespace or the warm pool is a sweep that reads the wrong objects.
     Member-only variables (shim port, readiness port, member id, generation) stay at their
     own call site; the job needs none of them. */}}
{{- define "agentconnect.daemonPoolClusterEnv" -}}
- name: AC_CP_URL
  value: {{ printf "ws://%s-control-plane:%v/daemon/ws" (include "agentconnect.fullname" .) .Values.controlPlane.port | quote }}
- name: AC_K8S_WARM_POOL
  value: {{ include "agentconnect.warmPoolName" . | quote }}
{{- /* Where claims are created and swept. Required: a member without it refuses to start
       and the job exits non-zero. */}}
- name: AC_K8S_SANDBOX_NAMESPACE
  value: {{ .Values.daemonPool.sandboxNamespace | default .Release.Namespace | quote }}
- name: AGENTCONNECT_SUPERVISOR
  value: k8s
{{- end -}}

{{/* One env pair per `modelEgress` client, rendered onto whichever surface asks. Two surfaces
     name the same endpoint in different vocabularies — the daemon writes each runtime's own
     provider variables at spawn and wins, the sandbox pod carries a fill-in floor for a runtime
     the daemon aimed nowhere — so the client set, the base resolution and the "is this a runtime
     we can project" refusal live here once instead of drifting between them.
     Args: ctx, prefixes (client → variable prefix), urlSuffix, keySuffix. */}}
{{- define "agentconnect.modelEgressEnv" -}}
{{- $prefixes := .prefixes -}}
{{- $urlSuffix := .urlSuffix -}}
{{- $keySuffix := .keySuffix -}}
{{- $egress := .ctx.Values.modelEgress -}}
{{- /* One gateway address, one path per provider dialect. The runtimes each append their own
       remainder to what they are given (`/v1/messages`, `/responses`, `/chat/completions`), so
       the gateway is what routes those onto its upstreams — the chart states only which dialect
       a client speaks. */ -}}
{{- $providers := dict "claude" "anthropic" "codex" "openai" "deepseek" "deepseek" -}}
{{- range $client, $cfg := $egress.clients }}
{{- $prefix := index $prefixes $client }}
{{- if not $prefix }}{{ fail (printf "modelEgress.clients.%s is not a runtime this chart can project (%s)" $client (join ", " (keys $prefixes | sortAlpha))) }}{{ end }}
{{- $base := $cfg.baseUrl }}
{{- if not $base }}
{{- if not $egress.gatewayUrl }}{{ fail (printf "modelEgress.clients.%s needs a baseUrl, or modelEgress.gatewayUrl to derive one from" $client) }}{{ end }}
{{- $base = printf "%s/%s" (trimSuffix "/" $egress.gatewayUrl) (index $providers $client) }}
{{- end }}
- name: {{ printf "%s%s" $prefix $urlSuffix }}
  value: {{ $base | quote }}
- name: {{ printf "%s%s" $prefix $keySuffix }}
  value: {{ $cfg.apiKey | quote }}
{{- end }}
{{- end -}}
