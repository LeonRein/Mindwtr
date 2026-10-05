#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import console from 'node:console';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiToken = 'sidecar-api-fixture-secret-1337';
const httpToken = 'sidecar-http-fixture-secret-1337-strong';
const listen = (server) => new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolveListen(server.address().port));
});
const close = (server) => new Promise((resolveClose) => {
  server.closeAllConnections();
  server.close(() => resolveClose());
});

export const smokeSidecar = async (binary) => {
  const directory = mkdtempSync(join(homedir(), 'mindwtr-mcp-smoke-'));
  const timestamp = '2026-01-01T00:00:00.000Z';
  const tasks = [{ id: 'fixture-task', title: 'Sidecar fixture', status: 'next', tags: [], contexts: [], createdAt: timestamp, updatedAt: timestamp }];
  const apiRequests = [];
  let posts = 0;
  const fixture = createServer(async (req, res) => {
    const respond = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${apiToken}`) { respond(401, { error: 'Unauthorized' }); return; }
    apiRequests.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/tasks?all=1&deleted=1') { respond(200, { tasks }); return; }
    if (req.method === 'POST' && req.url === '/tasks') {
      let raw = '';
      for await (const chunk of req) raw += chunk.toString();
      const body = JSON.parse(raw);
      assert.equal(body.title, 'Sidecar write fixture');
      assert.deepEqual(Object.keys(body).sort(), ['props', 'title']);
      const task = { id: 'fixture-created', status: 'inbox', tags: [], contexts: [], ...body.props, title: body.title, createdAt: timestamp, updatedAt: timestamp };
      posts++;
      tasks.push(task);
      respond(201, { task });
      return;
    }
    respond(404, { error: 'Not found' });
  });
  const active = [];
  const apiPort = await listen(fixture);
  const portReservation = createServer();
  const publicPort = await listen(portReservation);
  await close(portReservation);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('MINDWTR_')));
  const start = (allowWrite) => {
    const env = {
      ...environment, PATH: directory, TMPDIR: directory,
      MINDWTR_MCP_API_URL: `http://127.0.0.1:${apiPort}`, MINDWTR_MCP_API_TOKEN: apiToken,
      MINDWTR_MCP_HTTP_PORT: String(publicPort), MINDWTR_MCP_HTTP_TOKEN: httpToken,
      // Ambient backend configuration cannot redirect the managed helper.
      MINDWTR_DB_PATH: join(directory, 'must-not-open.db'),
      MINDWTR_MCP_CLOUD_URL: 'https://must-not-connect.invalid', MINDWTR_MCP_CLOUD_TOKEN: 'unused-cloud-secret',
    };
    if (allowWrite !== undefined) env.MINDWTR_MCP_ALLOW_WRITE = String(allowWrite);
    const child = spawn(resolve(binary), [], { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '';
    const events = [];
    const closed = new Promise((resolveClose) => child.once('close', resolveClose));
    const ready = new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Sidecar readiness exceeded 10 seconds')); }, 10_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', () => { clearTimeout(timer); reject(new Error('Sidecar exited before readiness')); });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk; pending += chunk;
        while (pending.includes('\n')) {
          const end = pending.indexOf('\n'), line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line.trim()) continue;
          const event = JSON.parse(line); events.push(event);
          if (event.event === 'mindwtr-mcp-ready') { clearTimeout(timer); resolveReady(event); }
          if (event.event === 'mindwtr-mcp-error') { clearTimeout(timer); reject(new Error(event.code)); }
        }
      });
    });
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { stdout += chunk; });
    const instance = { child, ready, closed, events, assertOutput() {
      assert.equal(stdout, '');
      assert.equal(stderr.includes(apiToken), false);
      assert.equal(stderr.includes(httpToken), false);
      assert.equal(stderr.includes('unused-cloud-secret'), false);
    } };
    active.push(instance);
    return instance;
  };
  let id = 0;
  const request = async (method, params, authorized = true) => {
    const response = await globalThis.fetch(`http://127.0.0.1:${publicPort}/mcp`, {
      method: 'POST', headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(authorized ? { Authorization: `Bearer ${httpToken}` } : {}),
      }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: globalThis.AbortSignal.timeout(5000),
    });
    if (!authorized) { assert.equal(response.status, 401); return; }
    assert.equal(response.status, 200);
    const text = await response.text();
    const records = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
      : [JSON.parse(text)];
    assert.equal(records.length, 1);
    const record = records[0]; assert.equal(record.jsonrpc, '2.0'); assert.equal(record.error, undefined);
    return record.result;
  };
  const initialized = () => request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'standalone-smoke', version: '1' } });
  const read = async () => {
    const result = await request('tools/call', { name: 'mindwtr_list_tasks', arguments: {} });
    assert.equal(Boolean(result.isError), false);
    return JSON.parse(result.content[0].text).tasks;
  };
  const eof = async (instance) => {
    instance.child.stdin.end();
    const timer = setTimeout(() => instance.child.kill('SIGKILL'), 3000);
    try { assert.equal(await instance.closed, 0); } finally { clearTimeout(timer); }
    instance.assertOutput();
  };
  try {
    const reader = start(); await reader.ready;
    await request('tools/list', {}, false);
    const info = await initialized();
    assert.equal(info.serverInfo.version, JSON.parse(readFileSync(join(root, 'apps/mcp-server/package.json'), 'utf8')).version);
    assert.notEqual(info.serverInfo.version, '0.0.0');
    const listed = await request('tools/list', {});
    assert(listed.tools.some((tool) => tool.name === 'mindwtr_list_tasks'));
    assert.equal((await read())[0].id, 'fixture-task');
    const denied = await request('tools/call', { name: 'mindwtr_add_task', arguments: { title: 'Sidecar write fixture' } });
    assert.equal(denied.isError, true); assert.equal(posts, 0);
    await eof(reader);
    const writer = start(true); await writer.ready; await initialized();
    const added = await request('tools/call', { name: 'mindwtr_add_task', arguments: { title: 'Sidecar write fixture', status: 'next' } });
    assert.equal(Boolean(added.isError), false); assert.equal(posts, 1);
    assert((await read()).some((task) => task.id === 'fixture-created'));
    await eof(writer);
    const occupied = createServer(); await new Promise((resolveListen) => occupied.listen(publicPort, '127.0.0.1', resolveListen));
    try {
      const failed = start(); await assert.rejects(failed.ready, /port_in_use/);
      assert.equal(await failed.closed, 1);
      assert.deepEqual(failed.events.filter((event) => event.event === 'mindwtr-mcp-error'), [{ event: 'mindwtr-mcp-error', code: 'port_in_use' }]);
      failed.assertOutput();
    } finally { await close(occupied); }
    return { passed: true, runtimeInstallRequired: false, path: 'empty directory', version: info.serverInfo.version, authRejected: true, readonlyDenied: true, persistedWrite: true, parentEofExit: true, conflictCode: 'port_in_use', apiRequests };
  } finally {
    for (const instance of active) if (instance.child.exitCode === null) instance.child.kill('SIGKILL');
    await close(fixture);
    rmSync(directory, { recursive: true, force: true });
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: build-mcp-sidecar-smoke.mjs <compiled binary>');
    console.log(JSON.stringify(await smokeSidecar(process.argv[2]), null, 2));
  } catch (error) { console.error(error); process.exitCode = 1; }
}
