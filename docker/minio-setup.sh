#!/bin/sh
# Idempotent setup of the bundled Source Cache store: the bucket, its lifecycle rules, and a client scoped to <prefix>/src/.
set -eu

: "${AC_STORE_URL:?AC_STORE_URL is required}"
: "${AC_STORE_BUCKET:?AC_STORE_BUCKET is required}"
: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
: "${AC_STORE_CLIENT_ACCESS_KEY:?AC_STORE_CLIENT_ACCESS_KEY is required}"
: "${AC_STORE_CLIENT_SECRET_KEY:?AC_STORE_CLIENT_SECRET_KEY is required}"

src="${AC_STORE_PREFIX:+${AC_STORE_PREFIX}/}src/"
policy_name=agentconnect-source-cache
deadline=$(($(date +%s) + ${AC_STORE_WAIT_SECONDS:-300}))
until wget -q -O /dev/null "${AC_STORE_URL}/minio/health/ready" 2>/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "object store at ${AC_STORE_URL} did not become ready" >&2
    exit 1
  fi
  sleep 2
done

MC_CONFIG_DIR="$(mktemp -d)"
export MC_CONFIG_DIR
trap 'rm -rf "$MC_CONFIG_DIR"' EXIT
mc alias set store "$AC_STORE_URL" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing "store/${AC_STORE_BUCKET}"

# The bucket belongs to this store alone, so replacing its whole lifecycle configuration drops nothing.
mc ilm import "store/${AC_STORE_BUCKET}" <<JSON
{
  "Rules": [
    {
      "ID": "ac-source-cache-pending",
      "Status": "Enabled",
      "Filter": { "And": { "Prefix": "${src}", "Tags": [{ "Key": "ac-cache", "Value": "pending" }] } },
      "Expiration": { "Days": 2 }
    },
    {
      "ID": "ac-source-cache-unreferenced",
      "Status": "Enabled",
      "Filter": { "And": { "Prefix": "${src}", "Tags": [{ "Key": "ac-cache", "Value": "unreferenced" }] } },
      "Expiration": { "Days": 7 }
    }
  ]
}
JSON

# The grants the chart README lists for pool members and the Control Plane, and nothing else.
cat >"${MC_CONFIG_DIR}/policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:PutObjectTagging"],
      "Resource": ["arn:aws:s3:::${AC_STORE_BUCKET}/${src}*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetLifecycleConfiguration"],
      "Resource": ["arn:aws:s3:::${AC_STORE_BUCKET}"]
    }
  ]
}
JSON
mc admin policy create store "$policy_name" "${MC_CONFIG_DIR}/policy.json"
# Re-adding an existing user rotates its secret to the current one.
mc admin user add store "$AC_STORE_CLIENT_ACCESS_KEY" "$AC_STORE_CLIENT_SECRET_KEY"
if ! mc admin user info store "$AC_STORE_CLIENT_ACCESS_KEY" --json | grep -q "\"${policy_name}\""; then
  mc admin policy attach store "$policy_name" --user "$AC_STORE_CLIENT_ACCESS_KEY"
fi
echo "object store ready: bucket ${AC_STORE_BUCKET}, lifecycle rules under ${src}"
