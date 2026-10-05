#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = {
  'x86_64-unknown-linux-gnu': 'bun-linux-x64-baseline',
  'aarch64-unknown-linux-gnu': 'bun-linux-arm64',
  'x86_64-unknown-linux-musl': 'bun-linux-x64-musl-baseline',
  'aarch64-unknown-linux-musl': 'bun-linux-arm64-musl',
  'x86_64-apple-darwin': 'bun-darwin-x64-baseline',
  'aarch64-apple-darwin': 'bun-darwin-arm64',
  'x86_64-pc-windows-msvc': 'bun-windows-x64-baseline',
};

export const sidecarPlan = (target, root = repoRoot, outputDirectory = join(root, 'apps/desktop/src-tauri/binaries')) => {
  const slices = target === 'universal-apple-darwin' ? ['x86_64-apple-darwin', 'aarch64-apple-darwin'] : [target];
  if (slices.some((slice) => !targets[slice])) throw new Error(`Unsupported MCP sidecar target: ${target}`);
  const version = JSON.parse(readFileSync(join(root, 'apps/mcp-server/package.json'), 'utf8')).version;
  const filename = (slice) => join(outputDirectory, `mindwtr-mcp-${slice}${slice.includes('windows') ? '.exe' : ''}`);
  return {
    target,
    output: filename(target),
    builds: slices.map((slice) => ({
      target: slice,
      output: filename(slice),
      args: [
        'build', join(root, 'apps/mcp-server/src/managed.ts'), '--compile', `--target=${targets[slice]}`,
        `--outfile=${filename(slice)}.building${slice.includes('windows') ? '.exe' : ''}`, '--external=better-sqlite3',
        '--define', 'process.env.NODE_ENV="production"',
        '--define', `__MINDWTR_MCP_VERSION__=${JSON.stringify(version)}`,
        '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
      ],
    })),
  };
};

const runChecked = (command, args, options) => {
  const result = spawnSync(command, args, { ...options, stdio: 'inherit', timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`MCP sidecar ${command} failed (${result.status ?? result.signal})`);
};

export const buildSidecar = (target, { root = repoRoot, outputDirectory, platform = process.platform, run = runChecked } = {}) => {
  const plan = sidecarPlan(target, root, outputDirectory);
  if (target === 'universal-apple-darwin' && platform !== 'darwin') {
    throw new Error('The universal macOS MCP sidecar must be assembled with lipo on macOS.');
  }
  mkdirSync(dirname(plan.output), { recursive: true });
  // Bun 1.3.5 extracts cross-compile runtimes in cwd; the cache must share its drive on Windows.
  const environment = {
    ...process.env, TMPDIR: dirname(plan.output), BUN_TMPDIR: dirname(plan.output),
    BUN_INSTALL_CACHE_DIR: join(root, 'node_modules', '.cache', 'mcp-sidecar'),
  };
  const bun = typeof globalThis.Bun === 'undefined' ? 'bun' : process.execPath;
  for (const build of plan.builds) {
    const temporary = `${build.output}.building${build.target.includes('windows') ? '.exe' : ''}`;
    try {
      run(bun, build.args, { cwd: root, env: environment });
      renameSync(temporary, build.output);
      if (!build.target.includes('windows')) chmodSync(build.output, 0o755);
    } finally { rmSync(temporary, { force: true }); }
  }
  if (target === 'universal-apple-darwin') {
    const temporary = `${plan.output}.building`;
    try {
      run('lipo', ['-create', ...plan.builds.map((build) => build.output), '-output', temporary], { cwd: root, env: environment });
      run('lipo', [temporary, '-verify_arch', 'x86_64', 'arm64'], { cwd: root, env: environment });
      renameSync(temporary, plan.output);
      chmodSync(plan.output, 0o755);
    } finally { rmSync(temporary, { force: true }); }
  }
  return plan.output;
};

export const resolveTarget = (argv, env = process.env, run = spawnSync) => {
  if (argv.length) {
    if (argv.length !== 2 || argv[0] !== '--target' || !argv[1]) throw new Error('Usage: build-mcp-sidecar.mjs [--target <Rust target triple>]');
    return argv[1];
  }
  if (env.TAURI_ENV_TARGET_TRIPLE) return env.TAURI_ENV_TARGET_TRIPLE;
  const result = run('rustc', ['-vV'], { encoding: 'utf8', timeout: 10_000 });
  const host = result.stdout?.match(/^host: (\S+)$/m)?.[1];
  if (result.status !== 0 || !host) throw new Error('Cannot determine MCP sidecar host target from rustc -vV.');
  return host;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildSidecar(resolveTarget(process.argv.slice(2))); } catch (error) {
    console.error(error instanceof Error ? error.message : 'MCP sidecar build failed');
    process.exitCode = 1;
  }
}
