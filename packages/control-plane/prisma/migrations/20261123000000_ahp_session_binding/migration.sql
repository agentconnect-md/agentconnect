CREATE TABLE "ahp_session_binding" (
    "reservationId" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "sessionUri" VARCHAR(512) NOT NULL,
    "operationId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" UUID NOT NULL,
    "sessionId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ahp_session_binding_pkey" PRIMARY KEY ("reservationId"),
    CONSTRAINT "ahp_session_binding_conversationId_fkey" FOREIGN KEY ("conversationId")
      REFERENCES "webchat_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ahp_session_binding_orgId_sessionUri_key" ON "ahp_session_binding"("orgId", "sessionUri");
CREATE UNIQUE INDEX "ahp_session_binding_orgId_operationId_key" ON "ahp_session_binding"("orgId", "operationId");
CREATE UNIQUE INDEX "ahp_session_binding_orgId_sessionId_key" ON "ahp_session_binding"("orgId", "sessionId");
CREATE INDEX "ahp_session_binding_orgId_agentId_userId_reservationId_idx"
  ON "ahp_session_binding"("orgId", "agentId", "userId", "reservationId");
CREATE UNIQUE INDEX "ahp_session_binding_orgId_conversationId_agentId_key"
  ON "ahp_session_binding"("orgId", "conversationId", "agentId");
