import { MlbC4CertifiedMaterializer } from "./mlb-c4-certified-materializer";
import {
  createMlbUnifiedV16CertifiedBullpenProvider,
  createMlbUnifiedV16CertifiedC4Provider,
  createMlbUnifiedV16CertifiedFrozenRouteProvider,
  createMlbUnifiedV16CertifiedShortlistProvider,
} from "./mlb-unified-v16-live-providers";
import { createMlbUnifiedEliteLowerTierLiveProvider } from "./mlb-unified-elite-lower-tier-live-provider";
import type { MlbUnifiedV16UiCommandDependencies } from "./mlb-unified-v16-ui-routes";

export const MLB_UNIFIED_ELITE_SHARED_LIVE_PROVIDER_BUNDLE_VERSION =
  "mlb-unified-elite-shared-live-provider-bundle-v1" as const;

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
  const unifiedEliteLowerTierShadowProvider = createMlbUnifiedEliteLowerTierLiveProvider({
    full13Materializer: sharedClassifierMaterializer,
  });

  return Object.freeze({
    liveEvidenceProviders,
    unifiedEliteLowerTierShadowProvider,
  });
}
