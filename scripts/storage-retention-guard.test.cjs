'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MIB,
  buildDefaultPolicies,
  cleanupOrphanTemps,
  effectivePolicy,
  pruneSnapshotDirectory,
  runRetentionCycle,
} = require('./storage-retention-guard.cjs');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'courtedge-retention-'));
}

function writeSizedFile(filePath, size, mtimeMs) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(size, 0x61));
  const seconds = mtimeMs / 1000;
  fs.utimesSync(filePath, seconds, seconds);
}

function listJson(directory) {
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
}

test('count retention keeps the newest 100 snapshots and removes only older json files', () => {
  const root = tempRoot();
  const snapshots = path.join(root, 'snapshots');
  fs.mkdirSync(snapshots, { recursive: true });
  const base = Date.now() - 1_000_000;
  for (let index = 0; index < 120; index += 1) {
    writeSizedFile(path.join(snapshots, `snapshot-${String(index).padStart(3, '0')}.json`), 128, base + index * 1000);
  }
  fs.writeFileSync(path.join(snapshots, 'do-not-touch.txt'), 'sentinel');

  const result = pruneSnapshotDirectory(snapshots, {
    maxFiles: 100,
    maxBytes: 64 * MIB,
    minFiles: 10,
  });

  assert.equal(result.beforeFiles, 120);
  assert.equal(result.deletedFiles, 20);
  assert.equal(result.afterFiles, 100);
  const remaining = listJson(snapshots);
  assert.equal(remaining[0], 'snapshot-020.json');
  assert.equal(remaining.at(-1), 'snapshot-119.json');
  assert.equal(fs.readFileSync(path.join(snapshots, 'do-not-touch.txt'), 'utf8'), 'sentinel');
  fs.rmSync(root, { recursive: true, force: true });
});

test('byte retention keeps newest snapshots until the byte ceiling is reached', () => {
  const root = tempRoot();
  const snapshots = path.join(root, 'snapshots');
  fs.mkdirSync(snapshots, { recursive: true });
  const base = Date.now() - 1_000_000;
  for (let index = 0; index < 10; index += 1) {
    writeSizedFile(path.join(snapshots, `snapshot-${index}.json`), MIB, base + index * 1000);
  }

  const result = pruneSnapshotDirectory(snapshots, {
    maxFiles: 100,
    maxBytes: 4 * MIB,
    minFiles: 2,
  });

  assert.equal(result.afterFiles, 4);
  assert.equal(result.afterBytes, 4 * MIB);
  assert.deepEqual(listJson(snapshots), [
    'snapshot-6.json',
    'snapshot-7.json',
    'snapshot-8.json',
    'snapshot-9.json',
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('orphan temp cleanup deletes only old direct-child tmp files', () => {
  const root = tempRoot();
  const snapshots = path.join(root, 'snapshots');
  fs.mkdirSync(snapshots, { recursive: true });
  const now = Date.now();
  const old = now - 48 * 60 * 60 * 1000;
  const recent = now - 60 * 60 * 1000;
  writeSizedFile(path.join(root, 'latest.json.1.deadbeef.tmp'), 512, old);
  writeSizedFile(path.join(root, 'recent.tmp'), 512, recent);
  writeSizedFile(path.join(snapshots, 'snapshot.json.2.deadbeef.tmp'), 512, old);
  writeSizedFile(path.join(root, 'latest.json'), 512, old);
  writeSizedFile(path.join(root, 'ledger.sqlite'), 512, old);

  const result = cleanupOrphanTemps([root, snapshots], 24 * 60 * 60 * 1000, { nowMs: now });

  assert.equal(result.deletedFiles, 2);
  assert.equal(fs.existsSync(path.join(root, 'latest.json.1.deadbeef.tmp')), false);
  assert.equal(fs.existsSync(path.join(snapshots, 'snapshot.json.2.deadbeef.tmp')), false);
  assert.equal(fs.existsSync(path.join(root, 'recent.tmp')), true);
  assert.equal(fs.existsSync(path.join(root, 'latest.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'ledger.sqlite')), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('pressure policy becomes stricter at 75 and 85 percent without dropping below minimum retention', () => {
  const baseline = { maxFiles: 500, maxBytes: 128 * MIB, minFiles: 25 };
  const normal = effectivePolicy(baseline, 0.30);
  const pressure = effectivePolicy(baseline, 0.80);
  const critical = effectivePolicy(baseline, 0.90);

  assert.equal(normal.maxFiles, 500);
  assert.equal(normal.maxBytes, 128 * MIB);
  assert.equal(pressure.maxFiles, 50);
  assert.equal(pressure.maxBytes, 96 * MIB);
  assert.equal(critical.maxFiles, 25);
  assert.equal(critical.maxBytes, 64 * MIB);
});

test('default allowlist contains only the two proven runaway snapshot directories', () => {
  const policies = buildDefaultPolicies('/app/data', {});
  assert.deepEqual(policies.map((policy) => policy.name), [
    'mlb-s5f-certification',
    'mlb-s6k-first-ten-cycles',
  ]);
  assert.deepEqual(policies.map((policy) => policy.snapshotDir), [
    '/app/data/mlb-s5f-certification/snapshots',
    '/app/data/mlb-s6k-first-ten-cycles/snapshots',
  ]);
  assert.equal(policies.some((policy) => /ledger|settlement|picks|milestone/i.test(policy.snapshotDir)), false);
});

test('retention cycle never discovers or prunes an unlisted evidence directory', () => {
  const root = tempRoot();
  const allowedRoot = path.join(root, 'mlb-s5f-certification');
  const allowedSnapshots = path.join(allowedRoot, 'snapshots');
  const protectedSnapshots = path.join(root, 'immutable-certification', 'snapshots');
  fs.mkdirSync(allowedSnapshots, { recursive: true });
  fs.mkdirSync(protectedSnapshots, { recursive: true });
  const base = Date.now() - 1_000_000;
  for (let index = 0; index < 20; index += 1) {
    writeSizedFile(path.join(allowedSnapshots, `a-${index}.json`), 256, base + index * 1000);
    writeSizedFile(path.join(protectedSnapshots, `p-${index}.json`), 256, base + index * 1000);
  }

  const summary = runRetentionCycle({
    dataRoot: root,
    usageBefore: { totalBytes: 1000, availableBytes: 700, usedBytes: 300, usedRatio: 0.30 },
    policies: [{
      name: 'allowed',
      serviceRoot: allowedRoot,
      snapshotDir: allowedSnapshots,
      maxFiles: 5,
      maxBytes: MIB,
      minFiles: 2,
    }],
    env: {},
  });

  assert.equal(summary.results[0].snapshots.afterFiles, 5);
  assert.equal(listJson(protectedSnapshots).length, 20);
  fs.rmSync(root, { recursive: true, force: true });
});

test('symlink snapshot directories are fail-closed and never followed', () => {
  const root = tempRoot();
  const outside = tempRoot();
  writeSizedFile(path.join(outside, 'protected.json'), 128, Date.now() - 1000);
  const linked = path.join(root, 'snapshots');
  fs.symlinkSync(outside, linked, 'dir');

  const result = pruneSnapshotDirectory(linked, {
    maxFiles: 0,
    maxBytes: 1,
    minFiles: 0,
  });

  assert.equal(result.skipped, true);
  assert.equal(fs.existsSync(path.join(outside, 'protected.json')), true);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
