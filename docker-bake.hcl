variable "REGISTRY" {
  default = "ghcr.io"
}

variable "OWNER" {
  default = "example-org"
}

variable "VERSION" {
  default = "local"
}

variable "LATEST" {
  default = false
}

variable "GIT_SHA" {
  default = ""
}

variable "SETUP_VERSION" {
  default = "1.0.0-dev"
}

# Mem0 OSS does not publish its REST server as a container image. Build the
# official server source at the immutable commit behind upstream v2.0.12 and
# constrain the installed Python SDK to the matching release. Update these two
# values together after reviewing a newer upstream release.
variable "MEM0_BACKEND_SOURCE_COMMIT" {
  default = "42cf18c4e6adb448e981aa1c7b55c1602b0cb670"
}

variable "MEM0_BACKEND_VERSION" {
  default = "2.0.12"
}

group "default" {
  targets = ["control-plane", "relay", "web", "mem0", "mem0-backend"]
}

target "_release" {
  context    = "."
  dockerfile = "docker/Dockerfile"
  platforms  = ["linux/amd64"]
}

target "control-plane" {
  inherits = ["_release"]
  target   = "control-plane"
  args = {
    SETUP_VERSION = SETUP_VERSION
  }
  tags = concat(
    ["${REGISTRY}/${OWNER}/control-plane:${VERSION}"],
    LATEST ? ["${REGISTRY}/${OWNER}/control-plane:latest"] : []
  )
}

target "relay" {
  inherits = ["_release"]
  target   = "relay"
  tags = concat(
    ["${REGISTRY}/${OWNER}/relay:${VERSION}"],
    LATEST ? ["${REGISTRY}/${OWNER}/relay:latest"] : []
  )
}

target "web" {
  inherits = ["_release"]
  target   = "web"
  args = {
    APP_VERSION = VERSION
    GIT_SHA     = GIT_SHA
  }
  tags = concat(
    ["${REGISTRY}/${OWNER}/web:${VERSION}"],
    LATEST ? ["${REGISTRY}/${OWNER}/web:latest"] : []
  )
}

# Centralized (remote) external-memory wrapper — the memory-plugin-mem0 CLI in
# HTTP mode. Environment-specific deployment configuration is maintained
# outside this application repository.
target "mem0" {
  inherits = ["_release"]
  target   = "mem0"
  tags = concat(
    ["${REGISTRY}/${OWNER}/memory-plugin-mem0:${VERSION}"],
    LATEST ? ["${REGISTRY}/${OWNER}/memory-plugin-mem0:latest"] : []
  )
}

# Pinned build of the official Mem0 OSS REST server. The source is a BuildKit
# named context rooted at upstream's `server/` directory; our Dockerfile adds a
# pinned SDK constraint and a non-root runtime without vendoring the source.
target "mem0-backend" {
  inherits   = ["_release"]
  dockerfile = "docker/mem0-backend.Dockerfile"
  contexts = {
    mem0_source = "https://github.com/mem0ai/mem0.git#${MEM0_BACKEND_SOURCE_COMMIT}:server"
  }
  args = {
    MEM0_VERSION = MEM0_BACKEND_VERSION
  }
  labels = {
    # Custom labels preserve separately auditable application and upstream revisions.
    "org.opencontainers.image.revision"        = GIT_SHA
    "org.opencontainers.image.version"         = VERSION
    "org.opencontainers.image.licenses"        = "Apache-2.0"
    "io.agentconnect.mem0.source"               = "https://github.com/mem0ai/mem0"
    "io.agentconnect.mem0.revision"             = MEM0_BACKEND_SOURCE_COMMIT
    "io.agentconnect.mem0.version"              = MEM0_BACKEND_VERSION
  }
  tags = concat(
    ["${REGISTRY}/${OWNER}/mem0-server:${VERSION}"],
    LATEST ? ["${REGISTRY}/${OWNER}/mem0-server:latest"] : []
  )
}
