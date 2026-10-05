import { expect, test } from 'bun:test';
import { parse } from 'yaml';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildSidecar, resolveTarget, sidecarPlan } from './build-mcp-sidecar.mjs';
import { signPlan } from './build-mcp-sidecar-sign.mjs';

test('target mapping uses baseline x64 and stable Tauri sidecar filenames', () => {
  const cases = [
    ['x86_64-unknown-linux-gnu', 'bun-linux-x64-baseline', ''],
    ['aarch64-unknown-linux-gnu', 'bun-linux-arm64', ''],
    ['x86_64-apple-darwin', 'bun-darwin-x64-baseline', ''],
    ['aarch64-apple-darwin', 'bun-darwin-arm64', ''],
    ['x86_64-pc-windows-msvc', 'bun-windows-x64-baseline', '.exe'],
  ];
  for (const [target, bunTarget, extension] of cases) {
    const plan = sidecarPlan(target);
    expect(plan.output.endsWith(`mindwtr-mcp-${target}${extension}`)).toBe(true);
    expect(plan.builds[0].args).toContain(`--target=${bunTarget}`);
    expect(plan.builds[0].args).toContain('--no-compile-autoload-dotenv');
    expect(plan.builds[0].args).toContain('--no-compile-autoload-bunfig');
    expect(plan.builds[0].args).toContain(`__MINDWTR_MCP_VERSION__=${JSON.stringify(JSON.parse(readFileSync('apps/mcp-server/package.json', 'utf8')).version)}`);
  }
  expect(() => sidecarPlan('aarch64-pc-windows-msvc')).toThrow('Unsupported');
});

test('explicit target wins, Tauri cross-build target precedes rustc host, malformed arguments fail', () => {
  const unused = () => { throw new Error('Host must not be consulted'); };
  expect(resolveTarget(['--target', 'universal-apple-darwin'], { TAURI_ENV_TARGET_TRIPLE: 'x86_64-unknown-linux-gnu' }, unused)).toBe('universal-apple-darwin');
  expect(resolveTarget([], { TAURI_ENV_TARGET_TRIPLE: 'aarch64-apple-darwin' }, unused)).toBe('aarch64-apple-darwin');
  expect(resolveTarget([], {}, () => ({ status: 0, stdout: 'rustc 1.0\nhost: x86_64-unknown-linux-gnu\n' }))).toBe('x86_64-unknown-linux-gnu');
  expect(() => resolveTarget(['--target'], {}, unused)).toThrow('Usage');
  expect(() => resolveTarget([], {}, () => ({ status: 1 }))).toThrow('Cannot determine');
});

test('Windows baseline compilation keeps downloaded runtimes on the checkout drive', () => {
  const directory = mkdtempSync(join(homedir(), 'mindwtr-mcp-cache-test-'));
  try {
    const outputDirectory = join(directory, 'binaries');
    let invocation;
    const run = (command, args, options) => {
      invocation = { command, args, options };
      writeFileSync(args.find((arg) => arg.startsWith('--outfile=')).slice('--outfile='.length), 'Windows fixture');
    };
    const output = buildSidecar('x86_64-pc-windows-msvc', {
      outputDirectory, platform: 'win32', run,
    });
    expect(readFileSync(output, 'utf8')).toBe('Windows fixture');
    expect(invocation.args).toContain('--target=bun-windows-x64-baseline');
    expect(invocation.options.env.BUN_INSTALL_CACHE_DIR).toBe(join(invocation.options.cwd, 'node_modules', '.cache', 'mcp-sidecar'));
    expect(invocation.options.env.TMPDIR).toBe(outputDirectory);
    expect(invocation.options.env.BUN_TMPDIR).toBe(outputDirectory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('universal macOS assembles and verifies both slices before publishing, rejects non-mac host', () => {
  const directory = mkdtempSync(join(homedir(), 'mindwtr-mcp-build-test-'));
  try {
    expect(() => buildSidecar('universal-apple-darwin', { outputDirectory: directory, platform: 'linux' })).toThrow('macOS');
    const calls = [];
    const run = (command, args) => {
      calls.push([command, args]);
      const output = args.find((arg) => arg.startsWith('--outfile='))?.slice('--outfile='.length)
        ?? (args.includes('-output') ? args[args.indexOf('-output') + 1] : null);
      if (output) writeFileSync(output, args.includes('-create') ? 'universal fixture' : 'slice fixture');
    };
    const output = buildSidecar('universal-apple-darwin', { outputDirectory: directory, platform: 'darwin', run });
    expect(readFileSync(output, 'utf8')).toBe('universal fixture');
    expect(calls[2][0]).toBe('lipo');
    expect(calls[2][1]).toContain('-create');
    expect(calls[3][1]).toEqual([output + '.building', '-verify_arch', 'x86_64', 'arm64']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Windows signing/staging includes the helper before installers and preserves signed source for bundling', () => {
  const workflow = readFileSync('.github/workflows/release-windows.yml', 'utf8');
  expect(workflow.indexOf('Apply and verify signed MCP helper') < workflow.indexOf('- name: Bundle installer')).toBe(true);
  expect(workflow).toContain('Copy-Item "signing-signed-mcp/mindwtr.exe" $helper -Force');
  expect(workflow).toContain('Copy-Item "apps/desktop/src-tauri/binaries/mindwtr-mcp-x86_64-pc-windows-msvc.exe" -Destination "$portableDir\\mindwtr-mcp.exe"');
  const msix = readFileSync('scripts/ci/build-msstore-package.ps1', 'utf8');
  expect(msix).toContain('Copy-Item "$buildDir/mindwtr-mcp.exe" -Destination "$outDir\\mindwtr-mcp.exe"');
  expect(msix.indexOf('Copy-Item "$buildDir/mindwtr-mcp.exe"') < msix.indexOf('& $makeappx pack')).toBe(true);
});

test('AppImage inserts and smoke-tests the unchanged helper after linuxdeploy has finished', () => {
  const steps = parse(readFileSync('.github/workflows/release-linux.yml', 'utf8')).jobs.linux.steps;
  const build = steps.find((step) => step.name === 'Build Tauri app').run;
  expect(build).toContain('tauri build --verbose --bundles deb,rpm');
  expect(build).toContain('tauri bundle --verbose --bundles appimage --config \'{"bundle":{"externalBin":[]}}\'');
  const repair = steps.find((step) => step.name === 'Repair AppImage metadata').run;
  const insert = repair.indexOf('install -m 0755 "$GITHUB_WORKSPACE/apps/desktop/src-tauri/binaries/mindwtr-mcp-x86_64-unknown-linux-gnu" appdir/usr/bin/mindwtr-mcp');
  const smoke = repair.indexOf('node "$GITHUB_WORKSPACE/scripts/build-mcp-sidecar-smoke.mjs" "$PWD/appdir/usr/bin/mindwtr-mcp"');
  expect(insert).toBeGreaterThan(repair.indexOf('mv squashfs-root appdir'));
  expect(smoke).toBeGreaterThan(insert);
  expect(repair.indexOf('appdir fixed.AppImage')).toBeGreaterThan(smoke);
});

test('macOS helper signatures use separate JIT entitlements and sandbox inheritance for App Store', () => {
  const app = '/Applications/Mindwtr.app';
  const direct = signPlan(app, 'Developer ID', 'developer-id');
  const store = signPlan(app, 'Apple Distribution', 'appstore');
  expect(direct.helper).toBe(join(app, 'Contents/MacOS/mindwtr-mcp'));
  expect(direct.args).toContain(resolve('apps/desktop/src-tauri/Entitlements.mcp.plist'));
  expect(store.args).toContain(resolve('apps/desktop/src-tauri/Entitlements.mcp.mas.plist'));
  const storeEntitlements = readFileSync('apps/desktop/src-tauri/Entitlements.mcp.mas.plist', 'utf8');
  expect(storeEntitlements).toContain('com.apple.security.inherit');
  expect(storeEntitlements).toContain('com.apple.security.cs.allow-jit');
  expect(storeEntitlements).not.toContain('com.apple.security.network.client');
  expect(() => signPlan(app, '', 'appstore')).toThrow('identity');
});

test('native builds compile the helper while web-only builds remain independent', () => {
  const packageJson = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8'));
  const config = JSON.parse(readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8'));
  expect(config.build.beforeBuildCommand).toBe('bun run build:native');
  expect(packageJson.scripts['build:native']).toContain('build:mcp');
  expect(packageJson.scripts['build:vite']).not.toContain('build:mcp');
  expect(config.bundle.externalBin).toContain('binaries/mindwtr-mcp');
  expect(JSON.parse(readFileSync('package.json', 'utf8')).scripts['native:test']).toStartWith('bun scripts/build-mcp-sidecar.mjs && cargo test');
  expect(readFileSync('snap/snapcraft.yaml', 'utf8')).toContain('- network-bind');
});


test('clean native CI prepares the sidecar before the first Cargo build script', () => {
  const cases = [
    ['ci.yml', 'desktop'], ['ci.yml', 'desktop-native-windows'],
    ['native-platform-ci.yml', 'macos-rust'], ['native-platform-ci.yml', 'windows-rust'],
  ];
  for (const [file, job] of cases) {
    const steps = parse(readFileSync(`.github/workflows/${file}`, 'utf8')).jobs[job].steps;
    const install = steps.findIndex((step) => step.run?.includes('bun install --frozen-lockfile'));
    const prepare = steps.findIndex((step) => step.run === 'bun scripts/build-mcp-sidecar.mjs');
    const compile = steps.findIndex((step) => /cargo (check|test|build)|bun run native:test/.test(step.run ?? ''));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeGreaterThan(install);
    expect(compile).toBeGreaterThan(prepare);
  }
});

test('Windows native jobs use the established patch-safe dependency install', () => {
  for (const [file, job] of [['ci.yml', 'desktop-native-windows'], ['native-platform-ci.yml', 'windows-rust']]) {
    const steps = parse(readFileSync(`.github/workflows/${file}`, 'utf8')).jobs[job].steps;
    const install = steps.find((step) => step.name === 'Install bundled MCP build dependencies');
    expect(install.shell).toBe('pwsh');
    expect(install.run).toContain('node scripts/ci/prepare-windows-bun-install.js');
    expect(install.run).toContain('--backend copyfile');
    expect(install.run).toContain('--concurrent-scripts 1');
    expect(install.run).toContain('exit $LASTEXITCODE');
  }
});
