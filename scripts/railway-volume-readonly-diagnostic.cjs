const { execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');

const ROOT = '/app/data';

function runDu(target) {
  try {
    return execFileSync('du', ['-h', '--max-depth=1', target], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    }).trim();
  } catch (error) {
    return `du failed for ${target}: ${String(error?.message || error)}`;
  }
}

function bytes(value) {
  return typeof value === 'bigint' ? Number(value) : Number(value || 0);
}

console.log('=== RAILWAY VOLUME READ-ONLY DIAGNOSTIC ===');
console.log(`root=${ROOT}`);
console.log(`exists=${fs.existsSync(ROOT)}`);

try {
  const stat = fs.statfsSync(ROOT, { bigint: true });
  const blockSize = bytes(stat.bsize);
  const total = bytes(stat.blocks) * blockSize;
  const free = bytes(stat.bavail) * blockSize;
  console.log(`filesystem_total_bytes=${total}`);
  console.log(`filesystem_free_bytes=${free}`);
  console.log(`filesystem_used_bytes=${Math.max(0, total - free)}`);
} catch (error) {
  console.log(`statfs_error=${String(error?.message || error)}`);
}

console.log('=== /app/data TOP LEVEL ===');
console.log(runDu(ROOT));

const backups = `${ROOT}/backups`;
if (fs.existsSync(backups)) {
  console.log('=== /app/data/backups BREAKDOWN ===');
  console.log(runDu(backups));
} else {
  console.log('=== /app/data/backups MISSING ===');
}

console.log('=== END READ-ONLY DIAGNOSTIC ===');

const port = Number(process.env.PORT || 3000);
http.createServer((_req, res) => {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'maintenance-readonly-diagnostic', writesPerformed: 0 }));
}).listen(port, '0.0.0.0', () => {
  console.log(`diagnostic health server listening on ${port}`);
});
