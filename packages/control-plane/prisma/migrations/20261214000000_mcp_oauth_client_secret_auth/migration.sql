-- How the client secret reaches the token endpoint: HTTP Basic (the OAuth 2.1 default) or the
-- form body, for an authorization server that advertises only `client_secret_post`.
ALTER TABLE "mcp_provider_oauth" ADD COLUMN "clientSecretAuth" TEXT NOT NULL DEFAULT 'basic';
