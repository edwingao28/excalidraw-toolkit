import { pathToFileURL } from 'node:url';
import { prepareBackendServer } from './backend-server.js';
const home = process.env.EXCALIDRAW_TOOLKIT_HOME;
const launchId = process.env.EXCALIDRAW_TOOLKIT_LAUNCH_ID;
if (!home || !launchId) throw new Error('Canvas must be started through excalidraw-toolkit start');
const { default: app, startServer } = await import(pathToFileURL(prepareBackendServer(home)).href);
app.get('/toolkit/identity', (_req, res) => res.json({ service: 'excalidraw-toolkit', pid: process.pid, launchId }));
await startServer();
