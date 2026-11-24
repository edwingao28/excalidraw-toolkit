// excalidraw-toolkit: revision-checked live edits. Inserted into the pinned
// mcp-excalidraw-server 2.0.0 by scripts/build-runtime.mjs, in scope of its
// app, clients, broadcast, generateId and logger. The canvas page holds the
// current drawing, so the snapshot and the compare-and-apply run in the page;
// these routes relay one request to it and return its answer. With more than
// one open canvas there is no single current drawing, so they refuse.
const toolkitPendingScene = new Map();
// The upstream server allows any origin (cors()) and does not check Host.
// These routes accept only a loopback Host (no DNS rebinding) and either no
// Origin (the toolkit CLI) or the canvas page's own origin; a call from any
// other web page carries its own Origin and is refused.
function toolkitAllowed(req, res) {
    const host = req.headers.host ?? '';
    const origin = req.headers.origin;
    if (/^(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(host) && (origin === undefined || origin === `http://${host}`)) return true;
    res.status(403).json({ success: false, code: 'FORBIDDEN_ORIGIN', error: 'Live edits accept only the local canvas page and local tools' });
    return false;
}
function toolkitSceneRequest(type, payload, req, res) {
    if (!toolkitAllowed(req, res)) return;
    if (clients.size !== 1) {
        return res.status(409).json({ success: false, code: clients.size ? 'MULTIPLE_CANVASES' : 'NO_CANVAS',
            error: clients.size ? 'Live edits need exactly one open canvas; close the other canvas tabs' : 'No canvas is open. Open the canvas in a browser first.' });
    }
    const requestId = generateId();
    const timer = setTimeout(() => {
        const pending = toolkitPendingScene.get(requestId);
        toolkitPendingScene.delete(requestId);
        pending?.res.status(504).json({ success: false, code: 'CANVAS_TIMEOUT', error: 'The canvas did not answer within 30 seconds' });
    }, 30000);
    toolkitPendingScene.set(requestId, { res, timer });
    broadcast({ type, requestId, ...payload });
}
app.post('/api/toolkit/scene/snapshot', (req, res) => toolkitSceneRequest('toolkit_scene_snapshot_request', {}, req, res));
app.post('/api/toolkit/scene/apply', (req, res) => {
    if (!toolkitAllowed(req, res)) return;
    const { baseVersion, elements: candidate, files: candidateFiles = {} } = req.body ?? {};
    if (typeof baseVersion !== 'string' || !Array.isArray(candidate) || !candidateFiles || typeof candidateFiles !== 'object' || Array.isArray(candidateFiles)) {
        return res.status(400).json({ success: false, code: 'INVALID_REQUEST', error: 'baseVersion, elements and optional files are required' });
    }
    toolkitSceneRequest('toolkit_scene_apply_request', { baseVersion, elements: candidate, files: candidateFiles }, req, res);
});
app.post('/api/toolkit/scene/result', (req, res) => {
    if (!toolkitAllowed(req, res)) return;
    const { requestId, ...result } = req.body ?? {};
    const pending = toolkitPendingScene.get(requestId);
    if (pending) {
        clearTimeout(pending.timer);
        toolkitPendingScene.delete(requestId);
        pending.res.json({ success: result.status !== 'error', ...result });
    }
    else logger.warn(`Ignoring a late or unknown live-edit answer (requestId=${requestId})`);
    res.json({ success: true });
});
