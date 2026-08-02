-- The preference controls the complete ACP process sandbox, not only filesystem access.
ALTER TABLE "agent" RENAME COLUMN "restrictFileAccess" TO "runInSandbox";
