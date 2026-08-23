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
chart it picked.

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
The chart holds no secrets: it references the namespace Secrets above by name, and
provider credentials are entered later through the Setup Server, not through values.

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
- **PostgreSQL** you operate, reachable as `DATABASE_URL`. Migrations run in an init
  container on Control Plane startup (`migrate.enabled`).
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
pinning) is the [AgentConnect OSS guide](https://docs.agentconnect.md/docs/oss-get-started).
