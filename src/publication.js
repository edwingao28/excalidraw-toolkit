import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readDiagramJob } from './ci.js';
import { sha256 } from './scene.js';

const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9_.-]+$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

function checkedPublication(value) {
  if (!NAME.test(value.owner ?? '') || !NAME.test(value.repo ?? '') ||
      !Number.isSafeInteger(value.pullNumber) || value.pullNumber < 1 ||
      !/^[A-Za-z0-9_\[\]-]+$/.test(value.actor ?? '') || value.forkPolicy !== 'deny' ||
      !['public', 'repository'].includes(value.visibility) || !Array.isArray(value.artifactOrigins) || !value.artifactOrigins.length) {
    fail('INVALID_PUBLICATION', 'Declare destination, managed-comment actor, visibility, artifact origins and forkPolicy: deny');
  }
  const api = new URL(value.apiUrl ?? 'https://api.github.com');
  if ((api.protocol !== 'https:' && !(api.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(api.hostname))) ||
      api.username || api.password || api.search || api.hash || !['', '/'].includes(api.pathname)) {
    fail('INVALID_PUBLICATION', 'Use an HTTPS API origin; HTTP is allowed only for loopback test fixtures');
  }
  for (const origin of value.artifactOrigins) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) fail('INVALID_PUBLICATION', 'Artifact origins must be explicit HTTPS origins');
  }
  return { ...value, apiUrl: api.origin };
}

function commentBody(receipt, receiptHash, publication, marker) {
  const links = {};
  for (const name of ['native', 'preview', 'evidence', 'report']) {
    const entry = publication.artifacts?.[name];
    const url = new URL(entry?.url ?? 'invalid');
    if (url.protocol !== 'https:' || url.username || url.password || !publication.artifactOrigins.includes(url.origin) ||
        entry.sha256 !== receipt.artifacts[name].sha256) fail('INVALID_ARTIFACT_LINK', 'Publish only configured HTTPS artifact links with hashes matching the verified job');
    // Angle-bracket Markdown links need these characters escaped in their URL.
    links[name] = url.href.replace(/[<>]/g, char => encodeURIComponent(char));
  }
  const metadata = { schemaVersion: 1, sourceRevision: receipt.sourceRevision, jobKey: receipt.jobKey, receiptHash };
  return `${marker}\n<!-- excalidraw-toolkit-state:${JSON.stringify(metadata)} -->\n` +
    `Diagram update for \`${receipt.sourceRevision}\`.\n\n` +
    `[Editable diagram](<${links.native}>) · [PNG preview](<${links.preview}>) · ` +
    `[Source evidence](<${links.evidence}>) · [Change report](<${links.report}>)\n\n` +
    `Artifact visibility: ${publication.visibility === 'public' ? 'public' : 'repository access required'}. ` +
    `Source locations and scene structure were checked; semantic and visual acceptance remains in the linked report.\n`;
}

async function publishJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.pending`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  try { await fs.link(temporary, path); } finally { await fs.unlink(temporary); }
  const directory = await fs.open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function journal(directory) {
  let names;
  try { names = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return { generation: 0 }; throw error; }
  const generation = Math.max(0, ...names.filter(name => /^\d+\.intent.json$/.test(name)).map(name => Number(name.split('.')[0])));
  if (!generation) return { generation: 0 };
  const intent = JSON.parse(await fs.readFile(join(directory, `${generation}.intent.json`), 'utf8'));
  if (!HASH.test(intent.bodyHash ?? '') || !HASH.test(intent.receiptHash ?? '') || !HASH.test(intent.jobKey ?? '')) fail('CORRUPT_PUBLICATION', 'Invalid retained publication intent');
  let result;
  try { result = JSON.parse(await fs.readFile(join(directory, `${generation}.result.json`), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { generation, intent, result };
}

/** Publishing runs only in a trusted controller. It never invokes the generator,
 * evaluates downloaded artifacts, or forwards its token to artifact origins. */
export async function publishDiagramJob(options, { token, fetch: fetcher = globalThis.fetch } = {}) {
  // This must precede config validation, filesystem reads, and every HTTP call.
  if (options?.publication?.enabled !== true) return { status: 'disabled' };
  const publication = checkedPublication(options.publication);
  const repository = `${publication.owner}/${publication.repo}`;
  if (options.context?.trustedWorkflow !== true || options.context.sourceRepository?.toLowerCase() !== repository.toLowerCase()) {
    return { status: 'blocked', reason: 'untrusted-or-fork-context' };
  }
  if (!HASH.test(options.receiptHash ?? '') || typeof options.stateDir !== 'string' || !options.stateDir.trim()) fail('INVALID_PUBLICATION', 'Provide the retained job hash and a trusted publication state directory');
  const { receipt } = await readDiagramJob(options.receiptPath, { expectedHash: options.receiptHash });
  if (receipt.status !== 'completed') return { status: 'blocked', reason: 'job-not-completed' };
  if (options.context.sourceRevision !== receipt.sourceRevision) return { status: 'blocked', reason: 'source-context-mismatch' };
  if (typeof token !== 'string' || !token.trim()) return { status: 'blocked', reason: 'publication-credential-unavailable' };
  const identity = sha256(`${publication.apiUrl}/${repository.toLowerCase()}/${publication.pullNumber}/${receipt.configId}`);
  const marker = `<!-- excalidraw-toolkit:${identity} -->`;
  const body = commentBody(receipt, options.receiptHash, publication, marker);
  const bodyHash = sha256(body);
  const directory = join(resolve(options.stateDir), identity);
  const prefix = `/repos/${encodeURIComponent(publication.owner)}/${encodeURIComponent(publication.repo)}`;
  const pullPath = `${prefix}/pulls/${publication.pullNumber}`;
  const commentsPath = `${prefix}/issues/${publication.pullNumber}/comments`;

  async function api(path, method = 'GET', content) {
    let response;
    try {
      response = await fetcher(`${publication.apiUrl}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10', ...(content ? { 'Content-Type': 'application/json' } : {}) },
        ...(content ? { body: JSON.stringify(content) } : {}),
      });
    } catch { fail('REMOTE_UNCERTAIN', 'GitHub request did not return a definitive response'); }
    if (!response.ok) {
      const code = response.status >= 500 || response.status === 408 ? 'REMOTE_UNCERTAIN' : 'REMOTE_REJECTED';
      // Do not include response text or token-bearing request metadata in errors.
      fail(code, `GitHub returned HTTP ${response.status}`);
    }
    try { return await response.json(); }
    catch { fail('REMOTE_UNCERTAIN', 'GitHub returned an unreadable response'); }
  }

  async function currentHead() {
    const pull = await api(pullPath);
    if (pull.state !== 'open') return 'pull-request-not-open';
    if (pull.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase()) return 'destination-mismatch';
    if (pull.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase()) return 'fork-publication-disabled';
    if (typeof pull.base.repo.private !== 'boolean') return 'unknown-repository-visibility';
    if ((publication.visibility === 'repository') !== pull.base.repo.private) return 'repository-visibility-mismatch';
    if (pull.head?.sha !== receipt.sourceRevision) return 'source-head-changed';
    return null;
  }

  async function managedComment() {
    const matches = [];
    // Do not follow arbitrary Link URLs with credentials. Page only the fixed
    // issue-comment endpoint and fail closed if its bounded scan is incomplete.
    for (let page = 1; page <= 100; page++) {
      const comments = await api(`${commentsPath}?per_page=100&page=${page}`);
      if (!Array.isArray(comments)) fail('REMOTE_UNCERTAIN', 'GitHub did not return a comment list');
      for (const comment of comments) {
        if (comment.user?.login !== publication.actor || !comment.body?.split('\n').includes(marker)) continue;
        if (!Number.isSafeInteger(comment.id) || comment.id < 1) fail('REMOTE_UNCERTAIN', 'Managed comment has an invalid ID');
        matches.push(comment);
      }
      if (comments.length < 100) {
        if (matches.length > 1) fail('AMBIGUOUS_PUBLICATION', 'More than one managed comment exists; reconcile their ownership before publishing');
        return matches[0] ?? null;
      }
    }
    fail('COMMENT_SCAN_LIMIT', 'Comment pagination exceeded its bounded scan; no publication was attempted');
  }

  let blocked;
  try { blocked = await currentHead(); }
  catch (error) { return { status: 'failed', reason: error.code, message: error.message }; }
  if (blocked) return { status: 'blocked', reason: blocked };
  let previous = await journal(directory);
  let existing;
  try { existing = await managedComment(); }
  catch (error) { return { status: 'failed', reason: error.code, message: error.message }; }
  if (previous.intent && !previous.result) {
    if (!existing || sha256(existing.body) !== previous.intent.bodyHash) {
      return { status: 'uncertain', reason: 'prior-write-not-reconciled', marker };
    }
    try { await publishJSON(join(directory, `${previous.generation}.result.json`), { status: 'reconciled', commentId: existing.id }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    previous = await journal(directory);
  }
  if (existing?.body === body) return { status: 'unchanged', commentId: existing.id, marker };
  try { blocked = await currentHead(); }
  catch (error) { return { status: 'failed', reason: error.code, message: error.message }; }
  if (blocked) return { status: 'blocked', reason: blocked };

  // Serialize writes sharing a trusted state directory. With separate runner
  // copies, CI destination concurrency is still required: GitHub has no
  // conditional transaction spanning PR head and comment creation/update.
  await fs.mkdir(directory, { recursive: true });
  const generation = previous.generation + 1;
  const intent = { schemaVersion: 1, jobKey: receipt.jobKey, sourceRevision: receipt.sourceRevision,
    receiptHash: options.receiptHash, bodyHash, commentId: existing?.id ?? null };
  try { await publishJSON(join(directory, `${generation}.intent.json`), intent); }
  catch (error) { if (error.code === 'EEXIST') return { status: 'busy', reason: 'another-publication-claimed', marker }; throw error; }
  const resultPath = join(directory, `${generation}.result.json`);
  const finish = async result => {
    try { await publishJSON(resultPath, result); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  };
  const outcome = async (status, commentId) => {
    try {
      const reason = await currentHead();
      if (reason) return { status: 'superseded', reason, commentId, marker, wrote: true };
    } catch { return { status: 'uncertain', reason: 'post-write-head-unconfirmed', commentId, marker, wrote: true }; }
    return { status, commentId, marker };
  };
  let response;
  try {
    response = await api(existing ? `${prefix}/issues/comments/${existing.id}` : commentsPath,
      existing ? 'PATCH' : 'POST', { body });
    if (response.body !== body || response.user?.login !== publication.actor || !Number.isSafeInteger(response.id) || response.id < 1) fail('REMOTE_UNCERTAIN', 'GitHub response does not identify the expected managed comment');
  } catch (error) {
    if (error.code !== 'REMOTE_UNCERTAIN') {
      await finish({ status: 'rejected', reason: error.code });
      return { status: 'failed', reason: error.code, message: error.message, marker };
    }
    // The mutation might have succeeded. Lookup once; never retry it blindly.
    try { response = await managedComment(); } catch { response = null; }
    if (!response || response.body !== body) return { status: 'uncertain', reason: 'write-response-unconfirmed', marker };
    await finish({ status: 'reconciled', commentId: response.id });
    return outcome('reconciled', response.id);
  }
  await finish({ status: existing ? 'updated' : 'created', commentId: response.id });
  return outcome(existing ? 'updated' : 'created', response.id);
}
