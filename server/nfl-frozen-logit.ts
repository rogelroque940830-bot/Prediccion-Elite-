export type FrozenLogitSpec = {
  kind: "STANDARDIZED_LOGISTIC_REGRESSION";
  features: string[];
  imputer: { strategy: "median"; statistics: number[] };
  scaler: { mean: number[]; scale: number[] };
  logistic: {
    C: number;
    classes: number[];
    coef: number[];
    intercept: number;
  };
};

export type NumericFeatureMap = Record<string, number | null | undefined>;

function finiteOr(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const e = Math.exp(value);
  return e / (1 + e);
}

/** Pure TypeScript equivalent of sklearn SimpleImputer -> StandardScaler -> LogisticRegression. */
export function predictFrozenLogit(spec: FrozenLogitSpec, features: NumericFeatureMap): number {
  const n = spec.features.length;
  if (
    spec.imputer.statistics.length !== n
    || spec.scaler.mean.length !== n
    || spec.scaler.scale.length !== n
    || spec.logistic.coef.length !== n
  ) {
    throw new Error("NFL frozen logit artifact dimensionality mismatch");
  }
  if (spec.logistic.classes.length !== 2 || spec.logistic.classes[1] !== 1) {
    throw new Error("NFL frozen logit artifact must encode binary class 1 as the positive class");
  }

  let logit = spec.logistic.intercept;
  for (let i = 0; i < n; i += 1) {
    const median = spec.imputer.statistics[i];
    const mean = spec.scaler.mean[i];
    const scale = spec.scaler.scale[i];
    const coef = spec.logistic.coef[i];
    if (![median, mean, scale, coef].every(Number.isFinite) || Math.abs(scale) <= 0) {
      throw new Error(`NFL frozen logit artifact contains invalid parameter at ${spec.features[i]}`);
    }
    const raw = finiteOr(features[spec.features[i]], median);
    logit += ((raw - mean) / scale) * coef;
  }
  const probability = sigmoid(logit);
  return Math.min(1 - 1e-6, Math.max(1e-6, probability));
}
