'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MIB = 1024 * 1024;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function dataRootFromEnv(env = process.env) {
  const configured = String(env.COURTEDGE_DATA_ROOT || '').trim();
  if (configured) return path.resolve(configured);
  if (env.RAILWAY_ENVIRONMENT_NAME) return '/app/data';
  return path.resolve(process.cwd(), 'data');
}

function buildDefaultPolicies(dataRoot, env = process.env) {
  const root = path.resolve(dataRoot);
  return [
    {
      name: 'mlb-s5f-certification',
      serviceRoot: path.join(root, 'mlb-s5f-certification'),
      snapshotDir: path.join(root, 'mlb-s5f-certification', 'snapshots'),
      maxFiles: positiveInteger(env.MLB_S5F_SNAPSHOT_MAX_FILES, 100, 10),
      maxBytes: positiveInteger(env.MLB_S5F_SNAPSHOT_MAX_BYTES, 384 * MIB, 16 * MIB),
      minFiles: 10,
    },
    {
      name: 'mlb-s6k-first-ten-cycles',
      serviceRoot: path.join(root, 'mlb-s6k-first-ten-cycles'),
      snapshotDir: path.join(root, 'mlb-s6k-first-ten-cycles', 'snapshots'),
      maxFiles: positiveInteger(env.MLB_S6K_SNAPSHOT_MAX_FILES, 500, 25),
      maxBytes: positiveInteger(env.MLB_S6K_SNAPSHOT_MAX_BYTES, 128 * MIB, 16 * MIB),
      minFiles: 25,
    },
  ];
}

function filesystemUsage(root) {
  try {
    if (!fs.existsSync(root)) return null;
    const stat = fs.statfsSync(root, { bigint: true });
    const totalBytes = Number(stat.blocks * stat.bsize);
    const availableBytes = Number(stat.bavail * stat.bsize);
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    return {
      totalBytes,
      availableBytes,
      usedBytes,
      usedRatio: totalBytes > 0 ? usedBytes / totalBytes : 0,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function pressureLevel(ratio) {
  if (!Number.isFinite(ratio)) return 'UNKNOWN';
  if (ratio >= 0.85) return 'CRITICAL';
  if (ratio >= 0.75) return 'PRESSURE';
  if (ratio >= 0.60) return 'WATCH';
  return 'NORMAL';
}

function effectivePolicy(policy, usedRatio) {
  const baseline = {
    ...policy,
    maxFiles: Math.max(policy.minFiles, policy.maxFiles),
    maxBytes: Math.max(1, policy.maxBytes),
  };
  if (!Number.isFinite(usedRatio) || usedRatio < 0.75) return baseline;
  if (usedRatio >= 0.85) {
    return {
      ...baseline,
      maxFiles: Math.max(policy.minFiles, Math.min(baseline.maxFiles, 25)),
      maxBytes: Math.max(16 * MIB, Math.floor(baseline.maxBytes * 0.50)),
    };
  }
  return {
    ...baseline,
    maxFiles: Math.max(policy.minFiles, Math.min(baseline.maxFiles, 50)),
    maxBytes: Math.max(16 * MIB, Math.floor(baseline.maxBytes * 0.75)),
  };
}

function isSafeDirectChild(filePath, directory) {
  return path.dirname(path.resolve(filePath)) === path.resolve(directory);
}

function safeDirectory(directory) {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function snapshotEntries(snapshotDir) {
  if (!safeDirectory(snapshotDir)) return [];
  const values = [];
  for (const entry of fs.readdirSync(snapshotDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(snapshotDir, entry.name);
    if (!isSafeDirectChild(filePath, snapshotDir)) continue;
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      values.push({
        name: entry.name,
        filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // A concurrent atomic rename can make an entry disappear between readdir and lstat.
    }
  }
  return values.sort((left, right) =>
    right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
}

function directorySnapshotStats(snapshotDir) {
  const entries = snapshotEntries(snapshotDir);
  return {
    files: entries.length,
    bytes: entries.reduce((sum, item) => sum + item.size, 0),
  };
}

function pruneSnapshotDirectory(snapshotDir, policy, options = {}) {
  const dryRun = options.dryRun === true;
  if (!safeDirectory(snapshotDir)) {
    return {
      directory: snapshotDir,
      skipped: true,
      reason: 'missing_or_unsafe_directory',
      beforeFiles: 0,
      beforeBytes: 0,
      deletedFiles: 0,
      deletedBytes: 0,
      afterFiles: 0,
      afterBytes: 0,
      errors: [],
    };
  }

  const entries = snapshotEntries(snapshotDir);
  const beforeBytes = entries.reduce((sum, item) => sum + item.size, 0);
  const minFiles = Math.max(0, Math.min(policy.minFiles || 0, policy.maxFiles));
  const keep = [];
  const remove = [];
  let keptBytes = 0;

  for (const entry of entries) {
    const requiredMinimum = keep.length < minFiles;
    const withinCount = keep.length < policy.maxFiles;
    const withinBytes = keptBytes + entry.size <= policy.maxBytes;
    if (requiredMinimum || (withinCount && withinBytes)) {
      keep.push(entry);
      keptBytes += entry.size;
    } else {
      remove.push(entry);
    }
  }

  let deletedFiles = 0;
  let deletedBytes = 0;
  const errors = [];
  if (!dryRun) {
    for (const entry of remove) {
      if (!isSafeDirectChild(entry.filePath, snapshotDir)) {
        errors.push(`unsafe_path:${entry.name}`);
        continue;
      }
      try {
        fs.unlinkSync(entry.filePath);
        deletedFiles += 1;
        deletedBytes += entry.size;
      } catch (error) {
        errors.push(`${entry.name}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const after = dryRun
    ? { files: entries.length - remove.length, bytes: beforeBytes - remove.reduce((sum, item) => sum + item.size, 0) }
    : directorySnapshotStats(snapshotDir);

  return {
    directory: snapshotDir,
    skipped: false,
    reason: null,
    beforeFiles: entries.length,
    beforeBytes,
    candidateFiles: remove.length,
    candidateBytes: remove.reduce((sum, item) => sum + item.size, 0),
    deletedFiles: dryRun ? 0 : deletedFiles,
    deletedBytes: dryRun ? 0 : deletedBytes,
    afterFiles: after.files,
    afterBytes: after.bytes,
    errors,
  };
}

function cleanupOrphanTemps(directories, maxAgeMs, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const dryRun = options.dryRun === true;
  const unique = [...new Set(directories.map((value) => path.resolve(value)))];
  let candidates = 0;
  let deletedFiles = 0;
  let deletedBytes = 0;
  const errors = [];

  for (const directory of unique) {
    if (!safeDirectory(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue;
      const filePath = path.join(directory, entry.name);
      if (!isSafeDirectChild(filePath, directory)) continue;
      try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        if (nowMs - stat.mtimeMs < maxAgeMs) continue;
        candidates += 1;
        if (!dryRun) {
          fs.unlinkSync(filePath);
          deletedFiles += 1;
          deletedBytes += stat.size;
        }
      } catch (error) {
        errors.push(`${entry.name}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { candidates, deletedFiles, deletedBytes, errors };
}

function runRetentionCycle(options = {}) {
  const env = options.env || process.env;
  const dataRoot = path.resolve(options.dataRoot || dataRootFromEnv(env));
  const usageBefore = options.usageBefore || filesystemUsage(dataRoot);
  const usedRatio = usageBefore && !usageBefore.error ? usageBefore.usedRatio : Number.NaN;
  const policies = options.policies || buildDefaultPolicies(dataRoot, env);
  const tmpMaxAgeMs = positiveInteger(
    env.COURTEDGE_STORAGE_TMP_MAX_AGE_MS,
    DEFAULT_TMP_MAX_AGE_MS,
    60 * 60 * 1000,
  );
  const results = [];

  for (const rawPolicy of policies) {
    const policy = effectivePolicy(rawPolicy, usedRatio);
    const temps = cleanupOrphanTemps(
      [policy.serviceRoot, policy.snapshotDir],
      tmpMaxAgeMs,
      { nowMs: options.nowMs, dryRun: options.dryRun },
    );
    const snapshots = pruneSnapshotDirectory(policy.snapshotDir, policy, { dryRun: options.dryRun });
    results.push({
      name: policy.name,
      policy: {
        maxFiles: policy.maxFiles,
        maxBytes: policy.maxBytes,
        minFiles: policy.minFiles,
      },
      temps,
      snapshots,
    });
  }

  const usageAfter = options.dryRun ? usageBefore : filesystemUsage(dataRoot);
  return {
    dataRoot,
    levelBefore: pressureLevel(usedRatio),
    usageBefore,
    usageAfter,
    results,
  };
}

function formatMiB(bytes) {
  return `${(Number(bytes || 0) / MIB).toFixed(1)}MiB`;
}

function logRetentionSummary(summary, trigger) {
  const beforeRatio = summary.usageBefore && !summary.usageBefore.error
    ? (summary.usageBefore.usedRatio * 100).toFixed(1)
    : 'unknown';
  const afterRatio = summary.usageAfter && !summary.usageAfter.error
    ? (summary.usageAfter.usedRatio * 100).toFixed(1)
    : 'unknown';
  console.log(`[storage-retention] trigger=${trigger} level=${summary.levelBefore} volume=${beforeRatio}%->${afterRatio}%`);
  for (const result of summary.results) {
    const snap = result.snapshots;
    const tmp = result.temps;
    console.log(
      `[storage-retention] ${result.name} snapshots=${snap.beforeFiles}->${snap.afterFiles} `
      + `bytes=${formatMiB(snap.beforeBytes)}->${formatMiB(snap.afterBytes)} `
      + `deleted=${snap.deletedFiles}/${formatMiB(snap.deletedBytes)} `
      + `tmp_deleted=${tmp.deletedFiles}/${formatMiB(tmp.deletedBytes)} `
      + `errors=${snap.errors.length + tmp.errors.length}`,
    );
  }
  const afterRatioNumber = summary.usageAfter && !summary.usageAfter.error
    ? summary.usageAfter.usedRatio
    : Number.NaN;
  if (Number.isFinite(afterRatioNumber) && afterRatioNumber >= 0.85) {
    console.error('[storage-retention] CRITICAL: volume remains >=85% after safe allowlisted pruning; no additional data classes will be deleted automatically.');
  } else if (Number.isFinite(afterRatioNumber) && afterRatioNumber >= 0.60) {
    console.warn('[storage-retention] WARNING: volume remains >=60% after retention cycle.');
  }
}

function runSafely(trigger, options = {}) {
  try {
    const summary = runRetentionCycle(options);
    logRetentionSummary(summary, trigger);
    return summary;
  } catch (error) {
    console.error(`[storage-retention] ${trigger} cycle failed:`, error);
    return null;
  }
}

function startBackendSupervisor(options = {}) {
  const env = options.env || process.env;
  runSafely('startup', { env });

  const backendEntry = path.resolve(options.backendEntry || env.COURTEDGE_BACKEND_ENTRY || path.join(process.cwd(), 'dist', 'index.cjs'));
  const intervalMs = positiveInteger(
    env.COURTEDGE_STORAGE_RETENTION_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    60 * 1000,
  );
  const child = spawn(process.execPath, [backendEntry], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  });

  const timer = setInterval(() => runSafely('scheduled', { env }), intervalMs);
  timer.unref();

  let forwardingSignal = false;
  const forward = (signal) => {
    if (forwardingSignal) return;
    forwardingSignal = true;
    if (!child.killed) child.kill(signal);
  };
  process.once('SIGTERM', () => forward('SIGTERM'));
  process.once('SIGINT', () => forward('SIGINT'));

  child.once('error', (error) => {
    clearInterval(timer);
    console.error('[storage-retention] backend spawn failed:', error);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    clearInterval(timer);
    if (signal) console.log(`[storage-retention] backend exited by signal ${signal}`);
    process.exit(code == null ? 0 : code);
  });
  return child;
}

module.exports = {
  MIB,
  DEFAULT_INTERVAL_MS,
  DEFAULT_TMP_MAX_AGE_MS,
  positiveInteger,
  dataRootFromEnv,
  buildDefaultPolicies,
  filesystemUsage,
  pressureLevel,
  effectivePolicy,
  snapshotEntries,
  pruneSnapshotDirectory,
  cleanupOrphanTemps,
  runRetentionCycle,
  startBackendSupervisor,
};

if (require.main === module) {
  startBackendSupervisor();
}
