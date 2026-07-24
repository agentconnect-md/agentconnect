-- Reuse the shared ResourceVisibility model for MCP providers (was a bespoke
-- McpVisibility enum, org-only). All existing rows are 'org', so the enum swap is a
-- lossless USING cast; add the sharedWith set that 'restricted' visibility needs.
ALTER TABLE "public"."mcp_provider" ALTER COLUMN "visibility" DROP DEFAULT;
ALTER TABLE "public"."mcp_provider"
  ALTER COLUMN "visibility" TYPE "public"."ResourceVisibility"
  USING ("visibility"::text::"public"."ResourceVisibility");
ALTER TABLE "public"."mcp_provider" ALTER COLUMN "visibility" SET DEFAULT 'org';

ALTER TABLE "public"."mcp_provider" ADD COLUMN "sharedWith" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

DROP TYPE "public"."McpVisibility";
