import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';

test('App Store status uses read-only collection requests and never prints credentials', async () => {
  const workflow = parse(readFileSync('.github/workflows/appstore-status.yml', 'utf8'));
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  const step = workflow.jobs.status.steps.find((item) => item.run);
  const script = step.run.split("<<'NODE'\n")[1].split('\nNODE')[0];
  const responses = new Map([
    ['apps?filter[bundleId]=tech.dongdongbh.mindwtr', { data: [{ id: 'app' }] }],
    ['apps/app/appStoreVersions?limit=200&include=build', {
      data: [{ attributes: { versionString: '1.3.4', platform: 'IOS', appStoreState: 'WAITING_FOR_REVIEW' }, relationships: { build: { data: { id: 'build' } } } }],
      included: [{ id: 'build', attributes: { version: '123' } }],
    }],
    ['builds?filter[app]=app&sort=-uploadedDate&limit=50&include=preReleaseVersion', {
      data: [{ attributes: { version: '123', processingState: 'VALID' }, relationships: { preReleaseVersion: { data: { id: 'marketing' } } } }],
      included: [{ id: 'marketing', attributes: { version: '1.3.4', platform: 'IOS' } }],
    }],
  ]);
  const output = [];
  const context = {
    process: { env: { VERSION: '1.3.4', ASC_JWT: 'fixture-secret' } }, AbortSignal,
    console: { log: (line) => output.push(line) },
    fetch: async (url, options) => {
      expect(options.method ?? 'GET').toBe('GET');
      const path = url.replace('https://api.appstoreconnect.apple.com/v1/', '');
      expect(responses.has(path)).toBe(true);
      return { ok: true, json: async () => responses.get(path) };
    },
  };
  await runInNewContext(`(async () => { ${script} })()`, context);
  expect(JSON.parse(output[0]).versions[0].selectedBuild).toBe('123');
  expect(JSON.parse(output[1]).builds[0].state).toBe('VALID');
  expect(output.join('')).not.toContain('fixture-secret');
  await expect(runInNewContext(`(async () => { ${script} })()`, { ...context, process: { env: { VERSION: 'invalid' } } })).rejects.toThrow('Expected a stable marketing version');
});
