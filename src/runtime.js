import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readJsonSafe, writeJson } from './utils.js';
import { packagedBackendEntry } from './backend-server.js';

export const BACKEND_VERSION = '2.0.0';
export const REQUIRED_TOOLS = ['create_element', 'query_elements', 'export_scene', 'import_scene', 'snapshot_scene'];
export function backendEntry() {
  return packagedBackendEntry('mcp');
}
export const runtimeDir = home => join(home, '.excalidraw-toolkit');
export function configuredPort(home) {
  const config = readJsonSafe(join(home, '.claude.json'));
  const configured = config.mcpServers?.excalidraw?.env?.EXPRESS_SERVER_URL;
  let port = '3000';
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('CONFIG_URL: expected a local HTTP canvas URL');
    port = url.port || '80';
  }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('CONFIG_PORT: expected port 1–65535');
  return Number(port);
}
export async function health(url, timeout = 1000) {
  let res;
  try { res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeout), redirect: 'error' }); }
  catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return null;
    throw new Error(`CANVAS_UNREACHABLE: ${error.message}`);
  }
  let data;
  try { data = await res.json(); } catch { throw new Error('FOREIGN_SERVICE: port does not serve canvas JSON'); }
  if (!res.ok || data.service !== 'mcp-excalidraw-canvas' || data.status !== 'healthy' || !Number.isSafeInteger(data.pid) || data.pid <= 0) throw new Error('FOREIGN_SERVICE: port does not identify as an Excalidraw canvas');
  return data;
}
export async function mcpClient(home, callback, registration) {
  const dir = runtimeDir(home);
  mkdirSync(dir, { recursive: true });
  // A doctor probe must exercise the registered environment unchanged. Defaults
  // belong only to the direct package probe, otherwise a broken registration
  // (for example an unwritable log path) can appear healthy here.
  const server = registration ?? {
    command: process.execPath,
    args: [backendEntry()],
    env: { EXPRESS_SERVER_URL: `http://127.0.0.1:${configuredPort(home)}`, EXCALIDRAW_NO_AUTOSTART: '1', LOG_FILE_PATH: join(dir, 'mcp.log') },
  };
  const transport = new StdioClientTransport({ command: server.command, args: server.args, cwd: dir, stderr: 'pipe', env: { ...process.env, ...server.env } });
  const client = new Client({ name: 'excalidraw-toolkit', version: '0.2.0' });
  transport.stderr?.resume();
  try {
    await client.connect(transport, { timeout: 10000 });
    const info = client.getServerVersion();
    if (info?.name !== 'mcp-excalidraw-server' || info.version !== BACKEND_VERSION) throw new Error('MCP_IDENTITY: unexpected backend name/version');
    const result = await client.listTools({}, { timeout: 10000 });
    for (const name of REQUIRED_TOOLS) if (!result.tools.some(tool => tool.name === name)) throw new Error(`MCP_CAPABILITY: missing ${name}`);
    return await callback(client, { server: info, tools: result.tools });
  } finally { await client.close(); }
}
export async function status(home, { probeMcp = true } = {}) {
  const url = `http://127.0.0.1:${configuredPort(home)}`;
  const record = readJsonSafe(join(runtimeDir(home), 'runtime.json'));
  const live = await health(url);
  let identity;
  if (live) {
    const response = await fetch(`${url}/toolkit/identity`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
    if (response.ok) { try { identity = await response.json(); } catch { /* An older canvas has no toolkit identity. */ } }
  }
  const mcp = probeMcp ? await mcpClient(home, (_client, info) => ({ server: info.server, tools: info.tools.map(t => t.name) })) : null;
  return { ok: Boolean(live), url, backendVersion: BACKEND_VERSION, pid: live?.pid ?? null, owned: Boolean(live && record.pid === live.pid && record.url === url && record.backendEntry === backendEntry() && record.launchId && identity?.launchId === record.launchId && identity?.pid === live.pid), browserClients: live?.websocket_clients ?? 0, logPath: join(runtimeDir(home), 'canvas.log'), mcp };
}
export async function start(home, { open = true, timeoutMs = 15000 } = {}) {
  const dir = runtimeDir(home);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'start.lock');
  let fd;
  try { fd = openSync(lock, 'wx'); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('START_BUSY: another start is in progress; inspect the lock after an interrupted start');
    throw error;
  }
  let child;
  try {
    const existing = await status(home);
    if (existing.ok) {
      if (!existing.owned) throw new Error('CANVAS_UNOWNED: this canvas was not started by this installation');
      if (open) openBrowser(existing.url);
      return existing;
    }
    const log = openSync(existing.logPath, 'a', 0o600);
    const launchId = randomUUID();
    try {
      child = spawn(process.execPath, [fileURLToPath(new URL('./canvas-server.mjs', import.meta.url))], { cwd: dir, env: { ...process.env, PORT: String(configuredPort(home)), HOST: '127.0.0.1', EXCALIDRAW_TOOLKIT_HOME: home, EXCALIDRAW_TOOLKIT_LAUNCH_ID: launchId, LOG_FILE_PATH: join(dir, 'backend.log') }, detached: true, stdio: ['ignore', log, log] });
    } finally { closeSync(log); }
    let spawnError;
    child.on('error', error => { spawnError = error; });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`START_FAILED: canvas exited; see ${existing.logPath}`);
      const live = await health(existing.url);
      if (live) {
        if (live.pid !== child.pid) throw new Error('START_CONFLICT: a different process claimed the port');
        writeJson(join(dir, 'runtime.json'), { pid: child.pid, url: existing.url, launchId, backendEntry: backendEntry(), backendVersion: BACKEND_VERSION, startedAt: new Date().toISOString() });
        child.unref();
        const result = await status(home, { probeMcp: false });
        if (open) openBrowser(result.url);
        return result;
      }
      await delay(150);
    }
    throw new Error(`START_TIMEOUT: canvas did not become ready; see ${existing.logPath}`);
  } catch (error) {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    throw error;
  } finally { closeSync(fd); rmSync(lock); }
}
export async function stop(home) {
  const state = await status(home, { probeMcp: false });
  if (!state.ok) return { stopped: false, reason: 'not running', url: state.url };
  if (!state.owned) throw new Error('CANVAS_UNOWNED: refusing to signal an unowned process');
  process.kill(state.pid, 'SIGTERM');
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    let live;
    try { live = await health(state.url); }
    catch (error) {
      if (!error.message.startsWith('CANVAS_UNREACHABLE:')) throw error;
      await delay(150);
      continue;
    }
    if (!live) { rmSync(join(runtimeDir(home), 'runtime.json'), { force: true }); return { stopped: true, pid: state.pid, url: state.url }; }
    if (live.pid !== state.pid) throw new Error('STOP_CONFLICT: port now belongs to another process');
    await delay(150);
  }
  throw new Error(`STOP_TIMEOUT: pid ${state.pid} did not stop`);
}
export function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(command, [url], { stdio: 'ignore' });
  child.on('error', () => { console.error(`Open ${url} in a browser`); });
  child.unref();
}
