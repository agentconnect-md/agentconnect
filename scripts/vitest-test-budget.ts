// The budget every test gets before a config scales it. A per-test override can only SHORTEN what
// this grants, never extend it, so one written at or under this value is dead weight that fails
// first on the slowest platform. `packages/daemon/test/no-shortened-test-budget.test.ts` rejects those.
export const BASE_TEST_TIMEOUT = 30_000
