-- The previous Lark flow minted device codes directly from accounts.larksuite.com.
-- Its launcher rejects those codes immediately, so no pending row using that
-- issuer can complete. Release the short-lived target slot so users can retry
-- with the canonical issuer after this deployment.
UPDATE "feishu_app_registration"
SET
  "status" = 'failed',
  "failureReason" = 'expired',
  "targetKey" = NULL,
  "deviceCode" = NULL,
  "appSecret" = NULL,
  "claimToken" = NULL,
  "claimedUntil" = NULL,
  "settledAt" = CURRENT_TIMESTAMP
WHERE
  "status" = 'pending'
  AND "providerDomain" = 'accounts.larksuite.com';
