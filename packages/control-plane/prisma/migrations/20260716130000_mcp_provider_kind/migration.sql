-- Discriminate open-connector connections from operator-entered "custom" MCP
-- providers (docs: connectors integration). All existing rows are custom upstreams,
-- so the new column defaults to 'custom' — a lossless add.
CREATE TYPE "public"."McpProviderKind" AS ENUM ('custom', 'open_connector');

ALTER TABLE "public"."mcp_provider"
  ADD COLUMN "kind" "public"."McpProviderKind" NOT NULL DEFAULT 'custom';
