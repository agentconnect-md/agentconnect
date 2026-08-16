-- A webchat MCP delegation belongs to the AGENT, not to the member that happened to serve it when
-- the browser dialled. Keying it on a daemon row made every delegation cascade away the moment the
-- pool reaper retired that member, and made a pool agent's entitlement unreachable, since the column
-- the authority compared is null for a set placement. The serving daemon is resolved at use time.
ALTER TABLE "webchat_mcp_delegation" DROP CONSTRAINT "webchat_mcp_delegation_daemonId_fkey";
ALTER TABLE "webchat_mcp_delegation" DROP COLUMN "daemonId";
