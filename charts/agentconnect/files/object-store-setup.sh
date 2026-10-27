#!/bin/sh
# Idempotent setup of the bundled RustFS store: the bucket, its Source Cache lifecycle rules, and browser CORS; curl signs SigV4 itself.
set -eu

: "${AC_STORE_URL:?AC_STORE_URL is required}"
: "${AC_STORE_BUCKET:?AC_STORE_BUCKET is required}"
: "${AC_STORE_CORS_ORIGIN:?AC_STORE_CORS_ORIGIN is required}"
: "${RUSTFS_ACCESS_KEY:?RUSTFS_ACCESS_KEY is required}"
: "${RUSTFS_SECRET_KEY:?RUSTFS_SECRET_KEY is required}"

src="${AC_STORE_PREFIX:+${AC_STORE_PREFIX}/}src/"
bucket_url="${AC_STORE_URL}/${AC_STORE_BUCKET}"
s3() {
  curl -sS --fail-with-body --aws-sigv4 'aws:amz:us-east-1:s3' --user "${RUSTFS_ACCESS_KEY}:${RUSTFS_SECRET_KEY}" "$@"
}

deadline=$(($(date +%s) + ${AC_STORE_WAIT_SECONDS:-300}))
until curl -fsS -o /dev/null "${AC_STORE_URL}/health" 2> /dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "object store at ${AC_STORE_URL} did not become ready" >&2
    exit 1
  fi
  sleep 2
done

if ! s3 -o /dev/null -I "$bucket_url" 2> /dev/null; then
  s3 -o /dev/null -X PUT "$bucket_url"
fi

# The bucket belongs to this store alone, so replacing its whole lifecycle and CORS configuration drops nothing.
rule() {
  printf '<Rule><ID>ac-source-cache-%s</ID><Status>Enabled</Status><Filter><And><Prefix>%s</Prefix><Tag><Key>ac-cache</Key><Value>%s</Value></Tag></And></Filter><Expiration><Days>%s</Days></Expiration></Rule>' "$1" "$src" "$1" "$2"
}
# Unfinished multipart uploads are not objects, so no tag rule reaches them; this one aborts them after a day.
abort_rule="<Rule><ID>ac-source-cache-multipart-abort</ID><Status>Enabled</Status><Filter><Prefix>${src}</Prefix></Filter><AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule>"
s3 -o /dev/null -X PUT "${bucket_url}?lifecycle" \
  --data-binary "<LifecycleConfiguration>$(rule pending 2)$(rule unreferenced 7)${abort_rule}</LifecycleConfiguration>"

# Browsers send the signed checksum and tagging headers on upload, read each part's ETag, and POST a multipart upload's part list.
s3 -o /dev/null -X PUT "${bucket_url}?cors" \
  --data-binary "<CORSConfiguration><CORSRule><AllowedOrigin>${AC_STORE_CORS_ORIGIN}</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>POST</AllowedMethod><AllowedHeader>x-amz-checksum-sha256</AllowedHeader><AllowedHeader>x-amz-tagging</AllowedHeader><AllowedHeader>content-type</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>"

echo "object store ready: bucket ${AC_STORE_BUCKET}, lifecycle rules under ${src}"
