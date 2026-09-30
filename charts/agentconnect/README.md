# AgentConnect Helm chart

Deploys the AgentConnect stack on Kubernetes. A default install carries the whole product:
the Control Plane (REST BFF + daemon WebSocket gateway), the web console, the Setup Server,
the relay ingress pool, the install-wide daemon pool with its agent-sandbox runtime plane
(three pre-warmed sandboxes), and open-connector. The centralized Mem0 external-memory
wrapper/backend is the one opt-in extra, and each default-on component has a values switch
to turn it off.

For a first local evaluation prefer the Docker Compose stack in the repository root;
this chart is the production shape.

## Installing

The chart is published to GHCR as an OCI artifact on every AgentConnect release. The
chart version tracks the release (`1.2.3`, `1.2.3-rc.4`), and `appVersion` is that
release's image tag — so an install that sets no `image.tag` runs the release whose
chart it picked. Release candidates, charts and images alike, may be pruned from GHCR
after 14 days, so install a stable version.

Use a version only after its Release workflow succeeds. The chart publishes in parallel
with images and can remain available if an image build fails; the final workflow
notification waits for all artifacts to be ready.

```bash
kubectl create namespace agentconnect
kubectl -n agentconnect create secret generic agentconnect-secrets \
  --from-literal=DATABASE_URL='postgresql://USER:PASS@HOST:5432/agentconnect?schema=public' \
  --from-literal=API_KEY_PEPPER="$(openssl rand -hex 32)" \
  --from-literal=RELAY_TOKEN="$(openssl rand -hex 24)"

# The daemon pool's data-plane document (see values.yaml, daemonPool.dataPlane):
kubectl -n agentconnect create secret generic agentconnect-data-plane \
  --from-file=config.json=./data-plane.json

# --version: any released AgentConnect version, e.g. 1.2.3
helm install agentconnect oci://ghcr.io/agentconnect-md/charts/agentconnect \
  --version 1.2.3 --namespace agentconnect \
  --set publicUrl=https://app.example.test
```

Every value is documented inline in [values.yaml](values.yaml) — it is the reference.
The chart holds no secret values: it references namespace Secrets by name. Configure
install-wide model API keys through a Secret, or add organization keys later in the console.

The pool uses `runtime-sandbox` by default, with Claude Code, Codex, DeepSeek Harness,
and OpenCode. To run additional ACP runtimes such as Qwen Code, set
`daemonPool.runtime.repository` to
`ghcr.io/agentconnect-md/runtime-sandbox-full`. The chart keeps the selected
release tag; `daemonPool.runtime.image` remains available for an exact image pin.
OpenCode reuses the Anthropic, OpenAI, and DeepSeek pairs from
`daemonPool.modelCredentials` or `modelEgress.clients`, so existing provider configuration
needs no separate OpenCode mapping. For Qwen Code, other providers, or additional settings,
map the runtime's environment variables from a Secret with
`daemonPool.runtimeEnvironment.runtimes`. The mapping reaches both
the pool's model probe and agent sessions. See the
[Kubernetes runtime authentication guide](https://www.agentconnect.md/docs/self-hosting/kubernetes/runtime-authentication).

A slimmer install turns the extras off explicitly — for example, no agent execution in
this cluster and no public ingress:

```bash
# --skip-crds: installCRD=false suppresses only the controller templates; the
# CRDs in crds/ install on first install unless the CLI opts out.
helm install agentconnect oci://ghcr.io/agentconnect-md/charts/agentconnect \
  --version 1.2.3 --namespace agentconnect --skip-crds \
  --set daemonPool.enabled=false --set installCRD=false --set relay.enabled=false
```

## Requirements

- **Kubernetes >= 1.28** (the relay reads the `apps.kubernetes.io/pod-index` label).
- **PostgreSQL** you operate, reachable as `DATABASE_URL`. Migrations run once per
  install and upgrade in a pre-install/pre-upgrade hook Job, before any new Control Plane
  pod starts (`migrate.enabled`). Helm waits for that Job, so give a release with a long
  migration a longer `--timeout`.
- **Cluster-scoped install rights** by default: the daemon pool renders the TokenReview
  ClusterRole/Bindings, the agent-sandbox CRDs ship in the chart's `crds/` directory
  (applied on first install, skipped when present, never upgraded or deleted by Helm —
  `--skip-crds` opts out), and the vendored controller stack installs with the release
  (`installCRD`). `daemonPool.enabled=false` with `--skip-crds` needs none of it. On a
  cluster shared by several releases, no single release may own the cluster-shared stack:
  install every release with `--skip-crds` and `installCRD=false`, and apply the stack
  once out-of-band (`kubectl apply --server-side -f crds/agent-sandbox.yaml`, then
  `helm template --set installCRD=true --show-only templates/agent-sandbox.yaml`).
- **Gateway API** for public routing: the chart renders HTTPRoutes attached to a Gateway
  you already run (`route.gateway`), with TLS terminated at your edge. Set
  `route.enabled=false` to manage routing yourself; with `publicUrl` empty the chart
  renders no route at all.

## After installing

The Setup Server is deliberately unrouted — bootstrap sign-in, provider apps, and
deployment secrets over a port-forward:

```bash
kubectl -n agentconnect port-forward deployment/agentconnect-setup-server 8091:8091
```

The full self-hosting walkthrough (authentication, public URLs, provider apps, image
pinning) is the [AgentConnect OSS guide](https://www.agentconnect.md/docs/self-hosting).

## Node maintenance

The Control Plane runs as one replica, and it also serves the API. Evicting its pod, as a
node drain does, leaves the API unavailable until the replacement is ready — several
seconds. A rolling update has no such gap, because its replacement is ready before the old
pod stops.

Set `controlPlane.podDisruptionBudget=true` to turn drains into that rolling update. The
drain then stops at the Control Plane pod; move it first, and the drain proceeds:

```bash
kubectl -n agentconnect rollout restart deployment/agentconnect-control-plane
```

The cordoned node takes no new pods, so the replacement starts elsewhere. Leave the budget
off where nobody can act on a drain that is waiting.
