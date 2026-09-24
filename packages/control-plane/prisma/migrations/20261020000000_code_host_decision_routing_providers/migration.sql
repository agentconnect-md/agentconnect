-- Decision routing for GitLab and Gitea repositories too (code-host-decisions.md §3.1): each provider routes its own families.
BEGIN;

ALTER TABLE "code_host_decision_routing" DROP CONSTRAINT "code_host_decision_routing_provider";
ALTER TABLE "code_host_decision_routing" DROP CONSTRAINT "code_host_decision_routing_family";
ALTER TABLE "code_host_decision_routing" ADD CONSTRAINT "code_host_decision_routing_scope" CHECK (
    ("provider" = 'github' AND "family" IN ('issues', 'pull_request'))
    OR ("provider" IN ('gitlab', 'gitea') AND "family" IN ('issues', 'merge_request'))
);

COMMIT;
