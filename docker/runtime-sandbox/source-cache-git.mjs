// Source Cache Git checks for verify-image.mjs, kept side-effect free so scripts/source-cache-git.test.mjs can import it.

// The 2024-05 security releases are the first to honor GIT_NO_LAZY_FETCH; 2.38.0 and 2.39.3 ignore it.
const NO_LAZY_FETCH_PATCH_FLOORS = { 39: 4, 40: 2, 41: 1, 42: 2, 43: 4, 44: 1, 45: 1 }

export const NO_LAZY_FETCH_FLOOR = '2.39.4, 2.40.2, 2.41.1, 2.42.2, 2.43.4, 2.44.1 or 2.45.1+'

/** Parses `git --version` output, vendor suffixes included; a missing patch counts as 0. */
export function parseGitVersion(output) {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output.trim())
  if (!match) throw new Error(`unexpected git --version output: ${output}`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) }
}

/** Whether this Git release honors GIT_NO_LAZY_FETCH, which the probe and write-back rely on as a guard. */
export function honorsNoLazyFetch({ major, minor, patch }) {
  if (major !== 2) return major > 2
  if (minor > 45) return true
  const floor = NO_LAZY_FETCH_PATCH_FLOORS[minor]
  return floor !== undefined && patch >= floor
}

// POSIX sh, run as the image's final user: a refs/heads blob:none bundle, its --bundle-uri import, fsck, and the lazy-fetch guard.
export const SOURCE_CACHE_GIT_PROBE = String.raw`
set -eu
tmp=$(mktemp -d)
# Keep the staging directory on failure and print the last captured stderr, since a failed build stage is discarded.
trap 'rc=$?; if [ "$rc" -eq 0 ]; then rm -rf "$tmp"; else echo "source cache probe kept $tmp" >&2; if [ -s "$tmp/err" ]; then cat "$tmp/err" >&2; fi; fi' EXIT
mkdir "$tmp/source"
git init -q -b main "$tmp/source"
git -C "$tmp/source" config user.name agentconnect-image-check
git -C "$tmp/source" config user.email image-check@example.invalid
git -C "$tmp/source" config uploadpack.allowfilter true
printf 'content\n' >"$tmp/source/file"
git -C "$tmp/source" add file
git -C "$tmp/source" commit -qm source
want=$(git -C "$tmp/source" rev-parse refs/heads/main)
GIT_NO_LAZY_FETCH=1 git -C "$tmp/source" bundle create "$tmp/blobless.bundle" --filter=blob:none refs/heads/main
git -C "$tmp/source" bundle verify "$tmp/blobless.bundle" 2>/dev/null | grep -F 'The bundle uses this filter: blob:none' >/dev/null
# --bundle-uri applies only refs/heads/* refs a bundle names; a HEAD bundle is silently ignored.
heads=$(git -C "$tmp/source" bundle list-heads "$tmp/blobless.bundle")
if [ "$heads" != "$want refs/heads/main" ]; then
  echo "bundle does not name exactly refs/heads/main: $heads" >&2
  exit 1
fi
git clone -q --filter=blob:none --no-checkout --bundle-uri="file://$tmp/blobless.bundle" "file://$tmp/source" "$tmp/bundled"
# Git 2.50 moved the imported ref from refs/bundles/<b> to refs/bundles/heads/<b>, so match every ref under refs/bundles.
refs=$(git -C "$tmp/bundled" for-each-ref --format='%(objectname)' refs/bundles)
if [ -z "$refs" ]; then
  echo '--bundle-uri imported nothing under refs/bundles' >&2
  exit 1
fi
if printf '%s\n' "$refs" | grep -vqx "$want"; then
  echo "refs/bundles holds a commit other than $want: $refs" >&2
  exit 1
fi
git -C "$tmp/bundled" rev-parse --verify HEAD >/dev/null
git -C "$tmp/bundled" fsck --connectivity-only --no-dangling >/dev/null
git clone -q --filter=blob:none --no-checkout "file://$tmp/source" "$tmp/partial"
cat >"$tmp/fake-upload-pack" <<'EOF'
#!/bin/sh
touch "$TMP_MARKER"
exit 1
EOF
chmod +x "$tmp/fake-upload-pack"
git -C "$tmp/partial" config remote.origin.uploadpack "$tmp/fake-upload-pack"
if TMP_MARKER="$tmp/marker" GIT_NO_LAZY_FETCH=1 git -C "$tmp/partial" cat-file -p HEAD:file >"$tmp/out" 2>"$tmp/err"; then
  echo 'GIT_NO_LAZY_FETCH=1 did not block lazy fetch' >&2
  exit 1
fi
# Newer Git blocks without the 'lazy fetching disabled' warning, so the helper never running is the signal.
if [ -e "$tmp/marker" ]; then
  echo 'GIT_NO_LAZY_FETCH=1 still ran the lazy-fetch helper' >&2
  exit 1
fi
# Control: without the variable the same read reaches the helper, so the check above is not vacuous.
TMP_MARKER="$tmp/marker" git -C "$tmp/partial" cat-file -p HEAD:file >/dev/null 2>&1 || true
if [ ! -e "$tmp/marker" ]; then
  echo 'the lazy-fetch control did not reach the fake upload-pack' >&2
  exit 1
fi
`
