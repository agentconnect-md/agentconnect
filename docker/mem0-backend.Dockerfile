# syntax=docker/dockerfile:1.4

# AgentConnect's pinned build of the upstream Mem0 OSS REST server.
#
# `mem0_source` is a BuildKit named context supplied by docker-bake.hcl. It is
# pinned to an immutable upstream commit there; keeping the source outside this
# repository avoids vendoring Mem0 while still making the exact input auditable.
# The upstream server requirements intentionally use `mem0ai>=...`, so constrain
# the SDK to the release matching that source commit instead of silently pulling a
# newer SDK on a later rebuild.
FROM python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de

ARG MEM0_VERSION

WORKDIR /app

COPY --from=mem0_source requirements.txt /tmp/mem0-server-requirements.txt
RUN printf 'mem0ai==%s\n' "$MEM0_VERSION" > /tmp/mem0-constraints.txt \
  && python -m pip install --no-cache-dir \
    --constraint /tmp/mem0-constraints.txt \
    --requirement /tmp/mem0-server-requirements.txt \
  && rm -f /tmp/mem0-constraints.txt /tmp/mem0-server-requirements.txt

# `psycopg` is installed in pure-Python mode by upstream's requirements and
# dynamically loads libpq at runtime. The slim Python base does not include it.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends libpq5 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=mem0_source . .

# The server writes its local history database below /app/history. Run as an
# unprivileged account while leaving the source and installed dependencies
# read-only to the process.
RUN addgroup --system mem0 \
  && adduser --system --ingroup mem0 --home /home/mem0 mem0 \
  && mkdir -p /app/history \
  && chown -R mem0:mem0 /app/history

USER mem0

EXPOSE 8000

ENV PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1 \
  MEM0_TELEMETRY=false

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
