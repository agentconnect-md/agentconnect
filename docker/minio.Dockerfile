# syntax=docker/dockerfile:1.7

# MinIO publishes no images, so build the commit CI tests the signer against (RELEASE.2025-10-15T17-29-55Z) plus mc for bucket setup.
# Publish by hand when a pin changes: docker buildx build --platform linux/amd64 --push -f docker/minio.Dockerfile -t ghcr.io/example-org/minio:RELEASE.2025-10-15T17-29-55Z .
FROM golang:1.24.8-alpine AS build

ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
# mc RELEASE.2025-08-13T08-35-41Z.
ARG MC_COMMIT=7394ce0dd2a80935aded936b09fa12cbb3cb8096

ENV CGO_ENABLED=0
RUN go install "github.com/minio/minio@${MINIO_COMMIT}" \
  && go install "github.com/minio/mc@${MC_COMMIT}"

FROM alpine:3.22

RUN apk add --no-cache ca-certificates \
  && adduser -D -u 1000 minio \
  && mkdir /data \
  && chown minio:minio /data

COPY --from=build /go/bin/minio /go/bin/mc /usr/local/bin/
COPY --chmod=0755 docker/minio-setup.sh /usr/local/bin/ac-object-store-setup

LABEL org.opencontainers.image.description="Pinned MinIO server and mc client for the AgentConnect Source Cache" \
  org.opencontainers.image.licenses="AGPL-3.0-only"

USER 1000
EXPOSE 9000
CMD ["minio", "server", "/data"]
