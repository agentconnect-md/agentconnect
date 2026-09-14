-- MCP Apps (docs/designs/webchat-mcp-apps.md §4): mark a provider as daemon-hosted, so the owning
-- daemon connects to it itself, advertises the `io.modelcontextprotocol/ui` extension, reads its
-- `ui://` templates and renders them in webchat.
--
-- Defaults to false: every existing provider keeps its runtime-attached behavior, and the flag is
-- an explicit operator choice rather than something probed — it decides whether the daemon
-- connects at all, and flipping it renames the provider's tools.
ALTER TABLE "mcp_provider" ADD COLUMN "ui" BOOLEAN NOT NULL DEFAULT false;
