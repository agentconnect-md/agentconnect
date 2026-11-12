// The git credential helper a proxied environment runs: it hands git the placeholder the proxy exchanges, and nothing else.

/** The variable a proxied environment's placeholder rides in, which the helper below hands git. */
export const CODE_HOST_CREDENTIAL_ENV = 'AC_CODEHOST_CREDENTIAL'

// It answers only `get`, with the placeholder the proxy exchanges, and nothing in an environment without one.
export const PLACEHOLDER_HELPER_COMMAND = `!f() { test "$1" = get && test -n "$${CODE_HOST_CREDENTIAL_ENV}" || return 0; echo username=x-access-token; echo "password=$${CODE_HOST_CREDENTIAL_ENV}"; }; f`
