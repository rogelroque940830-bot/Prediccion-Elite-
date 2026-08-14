import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_UNIFIED_PRICED_V16_ROUTE,
  MlbUnifiedPricedV16RuntimeConfigError,
  resolveMlbUnifiedPricedV16RuntimeConfig,
} from "./mlb-unified-priced-v16-routes";

test("priced V16 route remains explicit and server-side configured", () => {
  assert.equal(MLB_UNIFIED_PRICED_V16_ROUTE, "/api/mlb/unified-v16/run");
  const config = resolveMlbUnifiedPricedV16RuntimeConfig({
    MLB_ODDS_PROVIDER_ACCOUNT_SCOPE_KEY: "provider-account-main",
    ODDS_API_KEY: "secret-key-not-returned-to-browser",
    MLB_ODDS_MAX_RUN_CREDITS: "6",
    MLB_ODDS_RESERVE_CREDITS: "30",
  });
  assert.deepEqual(config, {
    providerAccountScopeKey: "provider-account-main",
    apiKey: "secret-key-not-returned-to-browser",
    maxRunCredits: 6,
    reserveCredits: 30,
  });
  assert.equal(Object.isFrozen(config), true);
});

test("priced V16 route fails closed when quota/account custody is not explicitly configured", () => {
  assert.throws(
    () => resolveMlbUnifiedPricedV16RuntimeConfig({ ODDS_API_KEY: "secret" }),
    (error: unknown) => error instanceof MlbUnifiedPricedV16RuntimeConfigError
      && error.code === "MISSING_MLB_ODDS_PROVIDER_ACCOUNT_SCOPE_KEY",
  );
  assert.throws(
    () => resolveMlbUnifiedPricedV16RuntimeConfig({
      MLB_ODDS_PROVIDER_ACCOUNT_SCOPE_KEY: "acct",
      ODDS_API_KEY: "secret",
      MLB_ODDS_MAX_RUN_CREDITS: "not-a-number",
      MLB_ODDS_RESERVE_CREDITS: "10",
    }),
    (error: unknown) => error instanceof MlbUnifiedPricedV16RuntimeConfigError
      && error.code === "INVALID_MLB_ODDS_MAX_RUN_CREDITS",
  );
});
