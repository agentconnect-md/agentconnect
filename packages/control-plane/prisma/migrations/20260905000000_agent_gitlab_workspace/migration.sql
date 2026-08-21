-- gitlab-com-integration.md M4: the gitlab workspace mode. The §17.3 projection
-- gate (daemon-features.ts) keys on this value, so a row carrying it is born
-- withheld from daemons that have not advertised gitlab-com-v1.
ALTER TYPE "WorkspaceMode" ADD VALUE 'gitlab';
