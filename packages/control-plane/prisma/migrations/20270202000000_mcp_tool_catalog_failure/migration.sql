-- A failed first fetch records its reason before any snapshot exists.
ALTER TABLE "mcp_tool_catalog" ALTER COLUMN "fetchedAt" DROP NOT NULL;
