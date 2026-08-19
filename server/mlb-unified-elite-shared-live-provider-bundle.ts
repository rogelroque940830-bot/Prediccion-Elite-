import { MlbC4CertifiedMaterializer } from "./mlb-c4-certified-materializer";
import {
  createMlbUnifiedV16CertifiedBullpenProvider,
  createMlbUnifiedV16CertifiedC4Provider,
  createMlbUnifiedV16CertifiedFrozenRouteProvider,
  createMlbUnifiedV16CertifiedShortlistProvider,
} from "./mlb-unified-v16-live-providers";
import { createMlbUnifiedEliteLowerTierLiveProvider } from "./mlb-unified-elite-lower-tier-live-provider";
import { MlbUnifiedEliteProspectiveCustodyStore } from "./mlb-unified-elite-prospective-custody-v1";
import type { MlbUnifiedV16UiCommandDependencies } from "./mlb-unified-v16-ui-routes";

export const MLB_UNIFIED_ELITE_SHARED_LIVE_PROVIDER_BUNDLE_VERSION =
  "mlb-unified-elite-shared-live-provider-bundle-v1" as const;

function durableProspectiveCustodyAvailable(): boolean {
  const railwayRuntime = Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);
  if (!railwayRuntime) return true;
  return Boolean(
    process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim()
    || process.env.MLB_UNIFIED_ELITE_CUSTODY_DB_PATH?.trim(),
  );
}

function earliestT5DeadlineUtc(context: Parameters<NonNullable<MlbUnifiedV16UiCommandDependencies["unifiedEliteLowerTierShadowProvider"]>>[0]): string | null {
  const deadlines = context.slate.games
    .filter((game) => game.officialDate === context.officialDate && typeof game.startTime === "string")
    .map((game) => Date.parse(game.startTime as string) - 5 * 60_000)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return deadlines.length ? new Date(deadlines[0]).toISOString() : null;
}

export function createMlbUnifiedEliteSharedLiveProviderBundle(): Pick<
  MlbUnifiedV16UiCommandDependencies,
  "liveEvidenceProviders" | "unifiedEliteLowerTierShadowProvider"
> {
  const sharedClassifierMaterializer = new MlbC4CertifiedMaterializer();
  const liveEvidenceProviders = Object.freeze({
    shortlistEvidence: createMlbUnifiedV16CertifiedShortlistProvider(),
    bullpenEvidence: createMlbUnifiedV16CertifiedBullpenProvider(),
    frozenRouteAssessments: createMlbUnifiedV16CertifiedFrozenRouteProvider({
      full13Materializer: sharedClassifierMaterializer,
    }),
    c4Assessments: createMlbUnifiedV16CertifiedC4Provider(sharedClassifierMaterializer),
  });

  const lowerTierLive = createMlbUnifiedEliteLowerTierLiveProvider({
    full13Materializer: sharedClassifierMaterializer,
  });
  const prospectiveCustody = durableProspectiveCustodyAvailable()
    ? new MlbUnifiedEliteProspectiveCustodyStore()
    : null;

  // V16 invokes this provider only when the visible frozen A+/Premium parent is NO_PLAY.
  // Record that enrollment fact outcome-blind before executing the hidden challenger.
  const unifiedEliteLowerTierShadowProvider: NonNullable<
    MlbUnifiedV16UiCommandDependencies["unifiedEliteLowerTierShadowProvider"]
  > = async (context) => {
    if (prospectiveCustody) {
      prospectiveCustody.observeDate({
        officialDate: context.officialDate,
        observedAtUtc: context.now.toISOString(),
        earliestDecisionDeadlineUtc: earliestT5DeadlineUtc(context),
      });
      prospectiveCustody.markParentNoPlayObserved(context.officialDate);
    }
    return lowerTierLive(context);
  };

  return Object.freeze({
    liveEvidenceProviders,
    unifiedEliteLowerTierShadowProvider,
  });
}
