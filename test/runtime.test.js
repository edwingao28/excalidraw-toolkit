import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { health, configuredPort, status, start, stop, mcpClient, backendEntry, runtimeDir } from '../src/runtime.js';
import { doctor } from '../src/installer.js';

async function server(t, response) {
  const app = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(typeof response === 'function' ? response(req) : response)); });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  return `http://127.0.0.1:${app.address().port}`;
}
function home(t, url) {
  const dir = mkdtempSync(join(tmpdir(), 'toolkit-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { excalidraw: { env: { EXPRESS_SERVER_URL: url } } } }));
  return dir;
}

function registeredBridge(dir, url) {
  const plugin = join(dir, '.claude/plugins/excalidraw-toolkit/excalidraw');
  mkdirSync(join(plugin, 'skills/excalidraw'), { recursive: true });
  writeFileSync(join(plugin, 'skills/excalidraw/SKILL.md'), '# Test skill');
  copyFileSync(new URL('../plugins/excalidraw/mcp-bridge.mjs', import.meta.url), join(plugin, 'mcp-bridge.mjs'));
  const registration = {
    type: 'stdio', command: process.execPath, args: [join(plugin, 'mcp-bridge.mjs')],
    env: { EXPRESS_SERVER_URL: url, EXCALIDRAW_BACKEND_ENTRY: backendEntry(), EXCALIDRAW_NO_AUTOSTART: '1', LOG_FILE_PATH: join(runtimeDir(dir), 'mcp.log') },
  };
  writeRegistration(dir, registration);
  return registration;
}

function writeRegistration(dir, registration) {
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { excalidraw: registration } }));
}

function rejectSignals(t) {
  return t.mock.method(process, 'kill', () => { throw new Error('Unexpected process signal'); });
}
test('an unrelated HTTP 200 never establishes canvas health', async t => {
  const url = await server(t, { ok: true });
  await assert.rejects(health(url), /FOREIGN_SERVICE/);
});
test('stop preserves an unowned service even when its identity is valid', async t => {
  const signal = rejectSignals(t);
  const url = await server(t, { service: 'mcp-excalidraw-canvas', status: 'healthy', pid: process.pid });
  const dir = home(t, url);
  await assert.rejects(stop(dir), /CANVAS_UNOWNED/);
  assert.equal(signal.mock.callCount(), 0);
});
test('stale PID receipt cannot authorize signaling a different process', async t => {
  const signal = rejectSignals(t);
  const url = await server(t, { service: 'mcp-excalidraw-canvas', status: 'healthy', pid: process.pid });
  const dir = home(t, url);
  mkdirSync(join(dir, '.excalidraw-toolkit'));
  writeFileSync(join(dir, '.excalidraw-toolkit/runtime.json'), JSON.stringify({ url, pid: process.pid + 10000, backendEntry: backendEntry() }));
  await assert.rejects(stop(dir), /CANVAS_UNOWNED/);
  assert.equal(signal.mock.callCount(), 0);
});

test('a matching recycled PID with a different launch UUID remains unowned', async t => {
  const signal = rejectSignals(t);
  const url = await server(t, req => req.url === '/toolkit/identity'
    ? { service: 'excalidraw-toolkit', pid: process.pid, launchId: 'new-launch' }
    : { service: 'mcp-excalidraw-canvas', status: 'healthy', pid: process.pid });
  const dir = home(t, url);
  mkdirSync(runtimeDir(dir));
  const receipt = { url, pid: process.pid, backendEntry: backendEntry(), launchId: 'old-launch' };
  writeFileSync(join(runtimeDir(dir), 'runtime.json'), JSON.stringify(receipt));
  assert.equal((await status(dir, { probeMcp: false })).owned, false);
  await assert.rejects(stop(dir), /CANVAS_UNOWNED/);
  assert.equal(signal.mock.callCount(), 0);
  assert.deepEqual(JSON.parse(readFileSync(join(runtimeDir(dir), 'runtime.json'), 'utf8')), receipt);
});
test('runtime uses persisted port and rejects remote configuration', t => {
  assert.equal(configuredPort(home(t, 'http://127.0.0.1:4401')), 4401);
  assert.throws(() => configuredPort(home(t, 'https://example.com')), /CONFIG_URL/);
});
test('pinned package completes a real MCP handshake and discovery without autostart', async t => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${reservation.address().port}`;
  await new Promise(resolve => reservation.close(resolve));
  const dir = home(t, url);
  assert.equal(await health(url), null);
  const info = await mcpClient(dir, async (client, info) => {
    const result = await client.callTool({ name: 'query_elements', arguments: {} }, undefined, { timeout: 5000 });
    assert.equal(result.isError, true);
    assert.match(result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'), /auto-start disabled by EXCALIDRAW_NO_AUTOSTART=1/);
    return info;
  });
  assert.equal(info.server.version, '2.0.0');
  assert.ok(info.tools.some(tool => tool.name === 'query_elements'));
  assert.equal(await health(url), null);
});

test('doctor rejects an invalid registered executable and a missing bridge', async t => {
  const url = await server(t, { service: 'mcp-excalidraw-canvas', status: 'healthy', pid: process.pid });
  const dir = home(t, url);
  const registration = registeredBridge(dir, url);
  writeRegistration(dir, { ...registration, command: join(dir, 'missing-node') });
  const invalidCommand = await doctor(dir);
  assert.equal(invalidCommand.ok, false);
  assert.equal(invalidCommand.checks.mcpRegistration, false);
  assert.equal(invalidCommand.mcp, null);
  writeRegistration(dir, registration);
  rmSync(registration.args[0]);
  const missingBridge = await doctor(dir);
  assert.equal(missingBridge.ok, false);
  assert.equal(missingBridge.checks.bridge, false);
  assert.equal(missingBridge.mcp, null);
});

test('doctor fails when the actual registered bridge exits before initialization', async t => {
  const url = await server(t, { service: 'mcp-excalidraw-canvas', status: 'healthy', pid: process.pid });
  const dir = home(t, url);
  const registration = registeredBridge(dir, url);
  writeFileSync(registration.args[0], 'process.exit(23);\n');
  await assert.rejects(doctor(dir), /closed/i);
});

test('doctor respects a broken registered log path and recovers after its repair', async t => {
  const url = await server(t, { service: 'mcp-excalidraw-canvas', status: 'healthy', pid: process.pid });
  const dir = home(t, url);
  const registration = registeredBridge(dir, url);
  const blockedParent = join(dir, 'not-a-directory');
  writeFileSync(blockedParent, 'A file cannot be a log directory.');
  writeRegistration(dir, { ...registration, env: { ...registration.env, LOG_FILE_PATH: join(blockedParent, 'mcp.log') } });
  await assert.rejects(doctor(dir), /closed/i);
  writeRegistration(dir, registration);
  const repaired = await doctor(dir);
  assert.equal(repaired.ok, true);
  assert.equal(repaired.mcp.server.version, '2.0.0');
  assert.ok(repaired.mcp.tools.includes('query_elements'));
});

test('failed start releases its lock so a later attempt does not report busy', async t => {
  const url = await server(t, { anotherService: true });
  const dir = home(t, url);
  await assert.rejects(start(dir, { open: false }), /FOREIGN_SERVICE/);
  assert.equal(existsSync(join(runtimeDir(dir), 'start.lock')), false);
  await assert.rejects(start(dir, { open: false }), /FOREIGN_SERVICE/);
  assert.equal(existsSync(join(runtimeDir(dir), 'start.lock')), false);
  assert.equal(existsSync(join(runtimeDir(dir), 'runtime.json')), false);
});
