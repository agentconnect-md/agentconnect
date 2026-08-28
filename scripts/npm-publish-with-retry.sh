#!/bin/sh
# Publish the package in the current working directory under a dist-tag, retrying
# transient upstream failures. semantic-release pushes the tag and its channel note
# BEFORE publish plugins run, so a failed publish cannot be recovered by re-running
# the job: the next run sees the release as done and never reaches npm again. The
# observed flake is Sigstore's Fulcio CA answering the provenance attestation with
# `CA_CREATE_SIGNING_CERTIFICATE_ERROR ... (403) Forbidden`; provenance is implicit
# under npm OIDC trusted publishing, so the whole publish is the retry unit.
set -eu

TAG="$1"
ATTEMPTS=3
attempt=1

while :; do
  if OUTPUT=$(pnpm publish --no-git-checks --ignore-scripts --tag "$TAG" 2>&1); then
    printf '%s\n' "$OUTPUT"
    exit 0
  fi
  printf '%s\n' "$OUTPUT"

  # An attempt that uploaded before failing leaves the version on the registry; the
  # conflict is also a 403, so match the message rather than the status code.
  case "$OUTPUT" in
    *EPUBLISHCONFLICT* | *'cannot publish over'* | *'previously published version'*)
      echo "version is already on the registry — treating this publish as done"
      exit 0
      ;;
  esac

  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    echo "publish failed after ${ATTEMPTS} attempts" >&2
    exit 1
  fi

  DELAY=$((attempt * 20))
  echo "publish attempt ${attempt}/${ATTEMPTS} failed — retrying in ${DELAY}s"
  sleep "$DELAY"
  attempt=$((attempt + 1))
done
