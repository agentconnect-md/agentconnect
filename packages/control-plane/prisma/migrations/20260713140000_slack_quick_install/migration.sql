-- slack-http-mode quick-install: the finalize path + the http signing secret that
-- apps.manifest.create returns at start (the browser never sees it), so an http
-- config-token auto-install completes with no manual paste. `shareable` is NOT stored
-- here — it's a non-secret choice the console re-sends in the finalize body.
ALTER TABLE "slack_install" ADD COLUMN "transport" "SlackTransport" NOT NULL DEFAULT 'socket';
ALTER TABLE "slack_install" ADD COLUMN "signingSecret" TEXT;
