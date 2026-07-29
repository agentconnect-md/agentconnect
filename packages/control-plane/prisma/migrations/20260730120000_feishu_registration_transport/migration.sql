ALTER TABLE "feishu_app_registration"
  ADD COLUMN "transport" "SlackTransport" NOT NULL DEFAULT 'socket';
