# AgentConnect Helm chart

Deploys the AgentConnect stack on Kubernetes: the Control Plane (REST BFF + daemon
WebSocket gateway), the web console, the Setup Server, and — each behind its own values
switch — the relay ingress pool, the install-wide daemon pool with its agent-sandbox
runtime plane, open-connector, and the centralized Mem0 external-memory wrapper/backend.

For a first local evaluation prefer the Docker Compose stack in the repository root;
this chart is the production shape.

## Installing

The chart is published to GHCR as an OCI artifact on every AgentConnect release. The
chart version tracks the release (`1.2.3`, `1.2.3-rc.4`), and `appVersion` is that
release's image tag.

```bash
kubectl create namespace agentconnect
kubectl -n agentconnect create secret generic agentconnect-secrets \
  --from-literal=DATABASE_URL='postgresql://USER:PASS@HOST:5432/agentconnect?schema=public' \
  --from-literal=API_KEY_PEPPER="$(openssl rand -hex 32)"

# --version: any released AgentConnect version, e.g. 1.2.3
helm install agentconnect oci://ghcr.io/agentconnect-md/charts/agentconnect \
  --version 1.2.3 --namespace agentconnect \
  --set publicUrl=https://app.example.test
```

Every value is documented inline in [values.yaml](values.yaml) — it is the reference.
The chart holds no secrets: it references the namespace Secret above by name
(`secrets.existingSecret`), and provider credentials are entered later through the
Setup Server, not through values.

## Requirements

- **Kubernetes >= 1.28** (the relay reads the `apps.kubernetes.io/pod-index` label).
- **PostgreSQL** you operate, reachable as `DATABASE_URL`. Migrations run in an init
  container on Control Plane startup (`migrate.enabled`).
- **Gateway API** for public routing: the chart renders HTTPRoutes attached to a Gateway
  you already run (`route.gateway`), with TLS terminated at your edge. Set
  `route.enabled=false` to manage routing yourself; with `publicUrl` empty the chart
  renders no route at all.
- **agent-sandbox** (only for the daemon pool): the chart vendors the pinned upstream
  stack. Install it once per cluster with
  `helm template --set installCRD=true --show-only templates/agent-sandbox.yaml`, or set
  `installCRD=true` on a cluster this release has to itself. Turning on
  `daemonPool.enabled` also renders cluster-scoped RBAC, so that install needs an
  installer identity allowed to write ClusterRoles/Bindings.

## After installing

The Setup Server is deliberately unrouted — bootstrap sign-in, provider apps, and
deployment secrets over a port-forward:

```bash
kubectl -n agentconnect port-forward deployment/agentconnect-setup-server 8091:8091
```

The full self-hosting walkthrough (authentication, public URLs, provider apps, image
pinning) is the [AgentConnect OSS guide](https://docs.agentconnect.md/docs/oss-get-started).
