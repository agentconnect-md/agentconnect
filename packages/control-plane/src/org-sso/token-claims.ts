/** What the access token says about how its browser session signed in (organization-sso.md §4.5); the Setup Server installs the script. */

/** The SSO connector this session's latest sign-in went through, present only when its identity is linked to the account. */
export const SSO_CONNECTOR_CLAIM = 'sso_connector_id'

/** The identity service's access-token claims script; it also carries the role names the Control Plane reads for `ADMIN`. */
export const ACCESS_TOKEN_CLAIMS_SCRIPT = `const getCustomJwtClaims = async ({ context }) => {
  const user = context?.user;
  if (!user) return {};
  const claims = { roles: (user.roles ?? []).map((role) => role.name) };
  const interaction = context.interaction;
  if (interaction?.userId !== user.id) return claims;
  const linked = new Set((user.ssoIdentities ?? []).map((identity) => identity.issuer + ' ' + identity.identityId));
  const record = (interaction.verificationRecords ?? []).find(
    (r) => r.type === 'EnterpriseSso' && r.issuer && r.enterpriseSsoUserInfo && linked.has(r.issuer + ' ' + r.enterpriseSsoUserInfo.id)
  );
  if (record) claims.${SSO_CONNECTOR_CLAIM} = record.connectorId;
  return claims;
};
`
