#!/usr/bin/env node
// Sign nested code before re-sealing its host. Widget embedding later signs the
// host again without --deep, preserving this helper's own entitlements.
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const signPlan = (app, identity, distribution = 'developer-id') => {
  if (!['developer-id', 'appstore'].includes(distribution)) throw new Error('Invalid MCP signing distribution');
  if (!identity) throw new Error('An MCP helper signing identity is required');
  const helper = join(app, 'Contents/MacOS/mindwtr-mcp');
  const entitlements = join(root, `apps/desktop/src-tauri/Entitlements.mcp${distribution === 'appstore' ? '.mas' : ''}.plist`);
  return { helper, args: ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, '--entitlements', entitlements, helper] };
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [app, identity, distribution = 'developer-id'] = process.argv.slice(2);
    if (!app) throw new Error('Usage: build-mcp-sidecar-sign.mjs <app> <identity> [developer-id|appstore]');
    const plan = signPlan(app, identity, distribution);
    if (!existsSync(plan.helper)) throw new Error('Bundled MCP helper is missing');
    const extracted = spawnSync('codesign', ['-d', '--entitlements', ':-', app], { encoding: 'utf8', timeout: 10_000 });
    if (extracted.status !== 0 || !extracted.stdout.includes('<plist')) throw new Error('Cannot preserve the host app signing entitlements');
    const temporary = mkdtempSync(join(dirname(resolve(app)), '.mcp-sign-'));
    try {
      const hostEntitlements = join(temporary, 'host.plist');
      writeFileSync(hostEntitlements, extracted.stdout);
      const signed = spawnSync('codesign', plan.args, { stdio: 'inherit', timeout: 60_000 });
      if (signed.error || signed.status !== 0) throw new Error('MCP helper signing failed');
      const verified = spawnSync('codesign', ['--verify', '--strict', plan.helper], { stdio: 'inherit', timeout: 10_000 });
      if (verified.error || verified.status !== 0) throw new Error('MCP helper signature verification failed');
      const hostSigned = spawnSync('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, '--entitlements', hostEntitlements, app], { stdio: 'inherit', timeout: 60_000 });
      if (hostSigned.error || hostSigned.status !== 0) throw new Error('Host app re-signing failed after MCP helper signing');
      const hostVerified = spawnSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit', timeout: 10_000 });
      if (hostVerified.error || hostVerified.status !== 0) throw new Error('Host app signature verification failed after MCP helper signing');
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'MCP helper signing failed');
    process.exitCode = 1;
  }
}
