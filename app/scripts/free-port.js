#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// free-port.js — predev guard
// Safely kills dev processes on dev port. Refuses to kill infra.
// macOS + Linux compatible.
// ═══════════════════════════════════════════════════════════
'use strict';

const { execSync } = require('child_process');
const PORT = process.env.PORT || 3001;

// Patterns considered safe dev processes
const SAFE = ['node', 'nodemon', 'tsx', 'next', 'server.js', 'vite', 'esbuild'];
// Patterns that are never safe to kill
const UNSAFE = ['docker', 'nginx', 'caddy', 'cloudflared', 'postgres', 'redis', 'mongod'];

function exec(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim(); }
  catch { return ''; }
}

function getPids() {
  const raw = exec(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t`);
  if (!raw) return [];
  return raw.split('\n').map(Number).filter(Boolean);
}

function getCommand(pid) {
  return exec(`ps -p ${pid} -o command=`);
}

function isSafe(cmd) {
  const lower = cmd.toLowerCase();
  if (UNSAFE.some(p => lower.includes(p))) return false;
  if (SAFE.some(p => lower.includes(p)))   return true;
  if (lower.includes(process.cwd().toLowerCase())) return true;
  return false;
}

function killPid(pid) {
  try { process.kill(pid, 'SIGTERM'); } catch { return; }

  // Wait 800ms then check
  const start = Date.now();
  while (Date.now() - start < 800) { /* busy wait */ }

  try {
    process.kill(pid, 0); // test if alive
    // Still alive → force kill
    console.log(`[dev] PID ${pid} didn't exit, sending SIGKILL`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  } catch {
    // Already dead, good
  }
}

// ── Main ────────────────────────────────────────────────
(function main() {
  // Verify lsof exists
  if (!exec('which lsof')) {
    console.error('[dev] lsof not found. Install it or free port 3000 manually.');
    process.exit(1);
  }

  const pids = getPids();

  if (pids.length === 0) {
    console.log(`[dev] Port ${PORT} is free ✓`);
    return;
  }

  for (const pid of pids) {
    const cmd = getCommand(pid);
    console.log(`[dev] Port ${PORT} occupied by PID ${pid}: ${cmd}`);

    if (isSafe(cmd)) {
      console.log(`[dev] Safe dev process — terminating PID ${pid}...`);
      killPid(pid);
      console.log(`[dev] PID ${pid} terminated ✓`);
    } else {
      console.error('');
      console.error(`  ┌─────────────────────────────────────────────────────┐`);
      console.error(`  │  REFUSED: Port ${PORT} is used by a non-dev process  │`);
      console.error(`  ├─────────────────────────────────────────────────────┤`);
      console.error(`  │  PID:  ${pid}`);
      console.error(`  │  CMD:  ${cmd}`);
      console.error(`  │                                                     │`);
      console.error(`  │  Stop it manually or move it to another port.       │`);
      console.error(`  └─────────────────────────────────────────────────────┘`);
      console.error('');
      process.exit(1);
    }
  }

  // Re-check
  const remaining = getPids();
  if (remaining.length > 0) {
    console.error(`[dev] Unable to free port ${PORT}. PIDs still listening: ${remaining.join(', ')}`);
    process.exit(1);
  }

  console.log(`[dev] Port ${PORT} is free ✓`);
})();
