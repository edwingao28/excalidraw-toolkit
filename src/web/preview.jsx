import {measureLabel} from "./text.js";
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, exportToCanvas, exportToSvg, restoreElements, getCommonBounds, convertToExcalidrawElements, newElementWith, CaptureUpdateAction, FONT_FAMILY } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import './preview.css';
import { elementLabel, summarizeEdits, formatTechnicalChanges, displayValue } from './edit-summary.js';
import { ReceiptDetails } from './ReceiptDetails.jsx';
import { WorkingCanvas } from './WorkingCanvas.jsx';
import { mergeProposal, deriveChanges } from './workspace.js';
import { draftStore } from './drafts.js';

window.EXCALIDRAW_ASSET_PATH = new URL('./assets/', window.location.href).href;
let activeScene;
async function png(scene = activeScene) {
  if (!scene) throw new Error('Open a diagram before exporting.');
  await document.fonts.ready;
  const canvas = await exportToCanvas({ elements: structuredClone(scene.elements.filter(e => !e.isDeleted)), files: structuredClone(scene.files || {}), appState: { ...scene.appState, exportBackground: true, exportWithDarkMode: false }, exportPadding: 30 });
  await document.fonts.ready;
  return canvas.toDataURL('image/png');
}
window.renderPng = png;
window.measureLabel = measureLabel;
window.sceneForPreview = () => structuredClone(activeScene);

// PR targets operate on render copies. Native SVG supplies the same baseline,
// alignment and rotation as canvas export; CanvasTextMetrics supplies glyph ink.
function targetElements(scene) {
  validate(scene);
  const elements = restoreElements(structuredClone(scene.elements), null).filter(element => !element.isDeleted);
  if (elements.some(element => ['frame', 'magicframe', 'embeddable', 'iframe'].includes(element.type))) {
    throw new Error('UNSUPPORTED_TARGET_SCENE: frames and live embeds need a separately qualified output view');
  }
  for (const element of elements.filter(element => element.type === 'text')) {
    if (![1, 3, 5, 6, 7, 8, 9].includes(element.fontFamily)) throw new Error('UNSUPPORTED_FONT: target export requires a bundled font');
    if (/[\p{Script=Hebrew}\p{Script=Arabic}]/u.test(element.text)) throw new Error('UNSUPPORTED_FONT_TEXT: RTL target text has not been qualified');
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(element.text) && element.fontFamily !== 5) {
      throw new Error('UNSUPPORTED_FONT_TEXT: CJK target labels require bundled Excalifont with Xiaolai fallback');
    }
  }
  return elements;
}
function targetAppState(scene) {
  return { ...scene.appState, exportWithDarkMode: false, exportScale: 1,
    frameRendering: { enabled: false, outline: false, name: false, clip: false } };
}
async function loadTargetFonts(elements, scene) {
  await exportToCanvas({ elements, files: structuredClone(scene.files || {}), appState: targetAppState(scene), exportPadding: 0,
    getDimensions: () => ({ width: 1, height: 1, scale: 1 }) });
  for (const element of elements.filter(element => element.type === 'text' && element.text.trim())) {
    const family = Object.entries(FONT_FAMILY).find(([, id]) => id === element.fontFamily)[0];
    const font = `${element.fontSize}px "${family}"${element.fontFamily === 5 ? ', "Xiaolai"' : ''}, "Segoe UI Emoji"`;
    const faces = await document.fonts.load(font, element.text);
    if (!faces.length || faces.some(face => face.status !== 'loaded') || !document.fonts.check(font, element.text)) throw new Error('FONT_UNAVAILABLE: a requested native font did not load');
  }
  await document.fonts.ready;
}
window.measureScene = async scene => {
  const elements = targetElements(scene);
  if (!elements.length) throw new Error('INVALID_RENDER_METRICS: a target scene must contain visible content');
  await loadTargetFonts(elements, scene);
  const [minX, minY, maxX, maxY] = getCommonBounds(elements);
  const marker = 'https://toolkit.invalid/native-element/';
  const tagged = elements.map(element => ({ ...element, link: `${marker}${encodeURIComponent(element.id)}` }));
  const svg = await exportToSvg({ elements: tagged, files: structuredClone(scene.files || {}), appState: targetAppState(scene),
    exportPadding: 0, skipInliningFonts: true });
  svg.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;';
  document.body.appendChild(svg);
  try {
    const inverse = svg.getScreenCTM().inverse();
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
    const index = new Map(elements.map(element => [element.id, element]));
    const visibleElementIds = [], text = [];
    for (const anchor of svg.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href');
      if (!href.startsWith(marker)) continue;
      const id = decodeURIComponent(href.slice(marker.length)), element = index.get(id);
      if (!element || element.opacity === 0) continue;
      visibleElementIds.push(id);
      if (element.type !== 'text' || !element.text.trim()) continue;
      const points = [];
      for (const line of anchor.querySelectorAll('text')) {
        const fontSize = Number.parseFloat(line.getAttribute('font-size'));
        context.font = `${fontSize}px ${line.getAttribute('font-family')}`;
        context.textAlign = ({ middle: 'center', end: 'right', start: 'left' })[line.getAttribute('text-anchor')] || 'left';
        context.textBaseline = 'alphabetic';
        context.direction = 'ltr';
        const metrics = context.measureText(line.textContent);
        if (![metrics.actualBoundingBoxLeft, metrics.actualBoundingBoxRight, metrics.actualBoundingBoxAscent, metrics.actualBoundingBoxDescent].every(Number.isFinite)) {
          throw new Error('INVALID_RENDER_METRICS: this browser does not expose actual glyph bounds');
        }
        const x = Number(line.getAttribute('x')), y = Number(line.getAttribute('y'));
        const matrix = inverse.multiply(line.getScreenCTM());
        for (const [px, py] of [[x - metrics.actualBoundingBoxLeft, y - metrics.actualBoundingBoxAscent], [x + metrics.actualBoundingBoxRight, y - metrics.actualBoundingBoxAscent],
          [x - metrics.actualBoundingBoxLeft, y + metrics.actualBoundingBoxDescent], [x + metrics.actualBoundingBoxRight, y + metrics.actualBoundingBoxDescent]]) {
          const point = new DOMPoint(px, py).matrixTransform(matrix);
          points.push({ x: point.x + minX, y: point.y + minY });
        }
      }
      if (!points.length) throw new Error('INVALID_RENDER_METRICS: native SVG omitted a visible label');
      const x = Math.min(...points.map(point => point.x)), y = Math.min(...points.map(point => point.y));
      text.push({ id, fontSize: element.fontSize, x, y, width: Math.max(...points.map(point => point.x)) - x, height: Math.max(...points.map(point => point.y)) - y });
    }
    return { renderer: '@excalidraw/excalidraw@0.18.1', fontsLoaded: true,
      bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY }, visibleElementIds, text };
  } finally { svg.remove(); }
};
window.renderTargetPng = async (scene, viewport) => {
  const elements = targetElements(scene);
  await loadTargetFonts(elements, scene);
  const { width, height, scale, offsetX, offsetY } = viewport;
  // The invisible anchor sets native export's scene origin. It exists only in
  // this copy and avoids rendering twice or resampling an intermediate bitmap.
  const anchor = convertToExcalidrawElements([{ type: 'rectangle', id: crypto.randomUUID(), x: -offsetX / scale, y: -offsetY / scale,
    width: width / scale, height: height / scale, angle: 0, opacity: 0, strokeColor: 'transparent', backgroundColor: 'transparent' }]);
  const canvas = await exportToCanvas({ elements: [...elements, ...anchor], files: structuredClone(scene.files || {}),
    appState: { ...targetAppState(scene), exportBackground: true }, exportPadding: 0,
    getDimensions: (nativeWidth, nativeHeight) => {
      if (Math.abs(nativeWidth * scale - width) > 0.01 || Math.abs(nativeHeight * scale - height) > 0.01) throw new Error('TARGET_CLIPPING: the target viewport does not contain the native scene');
      return { width, height, scale };
    } });
  return canvas.toDataURL('image/png');
};

function Icon({ name, size = 18 }) {
  const paths = {
    open: <><path d="M3 7h6l2 2h10l-3 10H3z" /><path d="M3 7V5h6l2 2h7v2" /></>,
    download: <path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4" />,
    file: <path d="M6 3h8l4 4v14H6zM14 3v5h4M9 13h6m-6 4h6" />,
    fit: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /><rect x="7" y="7" width="10" height="10" rx="1" /></>,
    layers: <path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5" />,
    arrow: <path d="M4 12h16m-5-5 5 5-5 5" />,
    check: <path d="m5 12 4 4L19 6" />,
    text: <path d="M4 5h16M12 5v15M8 20h8M4 5v3m16-3v3" />,
    shape: <rect x="4" y="4" width="16" height="16" rx="3" />,
    image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 6-6 4 4 3-3 5 5" /></>,
    frame: <path d="M6 2v20M18 2v20M2 6h20M2 18h20" />,
    pen: <path d="m5 15-2 6 6-2L21 7l-4-4zM14 6l4 4" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.1" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.shape}</svg>;
}

function validate(value) {
  if (!value || value.type !== 'excalidraw' || !Array.isArray(value.elements) || value.elements.some(e => !e || typeof e.id !== 'string' || typeof e.type !== 'string')) throw new Error('This is not a valid Excalidraw diagram. Choose a .excalidraw file and try again.');
  return value;
}
function download(href, name) { const anchor = document.createElement('a'); anchor.href = href; anchor.download = name; anchor.click(); }
class CanvasBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { this.props.onError(error.message); }
  render() { return this.state.failed ? <div className="canvas-state"><Icon name="info" size={28} /><h2>Unable to display this diagram</h2><p>Open another file to continue.</p></div> : this.props.children; }
}

function focusElements(elements, id) {
  const target = elements.find(element => element.id === id && !element.isDeleted);
  if (!target) return [];
  return elements.filter(element => !element.isDeleted && (element.id === id || element.id === target.containerId || element.containerId === id));
}

// A view-only outline follows the native viewport without changing the scene
// or adding selection decorations to exported files.
function ElementFocus({ api, elementId }) {
  const [style, setStyle] = useState(null);
  useEffect(() => {
    const update = () => {
      const targets = focusElements(api.getSceneElements(), elementId);
      if (!targets.length) { setStyle(null); return; }
      const [x, y, right, bottom] = getCommonBounds(targets);
      const { scrollX, scrollY, zoom } = api.getAppState();
      setStyle({ left: (x + scrollX) * zoom.value - 8, top: (y + scrollY) * zoom.value - 8,
        width: (right - x) * zoom.value + 16, height: (bottom - y) * zoom.value + 16 });
    };
    update();
    return api.onScrollChange(update);
  }, [api, elementId]);
  return style && <div className="element-focus" data-element-id={elementId} style={style} aria-hidden="true" />;
}

function Review() {
  const [scene, setScene] = useState(null);
  const [context, setContext] = useState({});
  const [view, setView] = useState('after');
  const [revision, setRevision] = useState(0);
  const [reviewApi, setReviewApi] = useState(null);
  const [workingApi, setWorkingApi] = useState(null);
  const [working, setWorking] = useState(null);
  const workingRef = useRef(null);
  const [baseline, setBaseline] = useState(null);
  const [proposal, setProposal] = useState(null);
  const [agentBase, setAgentBase] = useState(null);
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentInstructions, setAgentInstructions] = useState('');
  const [selection, setSelection] = useState([]);
  const [documentId, setDocumentId] = useState(0);
  const [saveStatus, setSaveStatus] = useState('');
  const [loaded, setLoaded] = useState(false);
  const storage = useRef(null);
  const draftSequence = useRef(0);
  const proposalInput = useRef(null);
  const lastDownload = useRef(null);
  const [pendingFile, setPendingFile] = useState(null);
  const api = view === 'working' ? workingApi : reviewApi;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [objectsExpanded, setObjectsExpanded] = useState(false);
  const [focusedItem, setFocusedItem] = useState(null);
  const focusRef = useRef(null);
  focusRef.current = focusedItem;
  const fileInput = useRef(null);
  const canvasPanel = useRef(null);
  const tabs = useRef([]);
  const snapshot = useRef(null);
  const pendingView = useRef(null);
  const isReceipt = Boolean(context.review);
  const beforeScene = isReceipt ? context.beforeScene : proposal?.base || agentBase || baseline;
  const displayed = view === 'working' ? working : view === 'before' ? beforeScene : view === 'proposal' ? context.proposalScene : proposal?.scene || scene;
  const viewKeys = isReceipt ? Object.keys(context.review.viewLabels || { before: 'Before', after: 'After' }) : ['working', 'before', ...(proposal ? ['after'] : [])];
  const viewLabel = key => isReceipt ? context.review.viewLabels?.[key] || (key === 'before' ? 'Before' : 'After') : ({ working: 'Working', before: 'Before', after: 'Agent proposal' })[key];
  activeScene = displayed;
  const elements = useMemo(() => displayed?.elements.filter(e => !e.isDeleted) || [], [displayed]);
  const title = context.title?.trim() || (typeof working?.appState?.name === 'string' && working.appState.name) || 'Untitled diagram';
  const filename = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim() || 'diagram';
  const changes = useMemo(() => isReceipt ? context.changes : beforeScene && (proposal?.scene || working) ? deriveChanges(beforeScene, proposal?.scene || working) : null, [isReceipt, context.changes, beforeScene, proposal, working]);
  const summary = useMemo(() => summarizeEdits(beforeScene, proposal?.scene || working || scene, changes), [beforeScene, proposal, working, scene, changes]);
  function reconcile(base, current, proposed) {
    const result = mergeProposal(base, current, proposed);
    if (result.conflicts.length) return result;
    try {
      const restored = new Set(restoreElements(structuredClone(result.scene.elements), null).map(element => element.id));
      const changed = new Set(deriveChanges(current, result.scene).map(change => change.id));
      for (const element of result.scene.elements) {
        if (changed.has(element.id) && !element.isDeleted && !restored.has(element.id)) throw new Error(`The native editor cannot display proposed element ${element.id}. Use a supported shape with a visible size.`);
      }
    } catch (error) { return { scene: null, conflicts: [{ field: 'elements', message: error.message }] }; }
    return result;
  }
  const reconciliation = useMemo(() => proposal && working ? reconcile(proposal.base, working, proposal.scene) : null, [proposal, working]);
  function updateWorking(value) { workingRef.current = value; setWorking(value); }
  function updateSelection(ids) { setSelection(current => current.join('\0') === ids.join('\0') ? current : ids); }
  const objects = elements.filter(e => e.type !== 'text' && !['arrow', 'line'].includes(e.type));
  const categories = [['shape', 'Shapes', ['rectangle', 'ellipse', 'diamond']], ['arrow', 'Connections', ['arrow', 'line']], ['text', 'Labels', ['text']], ['frame', 'Frames', ['frame', 'magicframe']], ['image', 'Images', ['image']], ['pen', 'Freehand', ['freedraw']]].map(([icon, label, types]) => ({ icon, label, count: elements.filter(e => types.includes(e.type)).length })).filter(item => item.count);
  const otherCount = elements.length - categories.reduce((count, item) => count + item.count, 0);
  if (otherCount) categories.push({ icon: 'layers', label: 'Other elements', count: otherCount });
  function cancelTransition() {
    const pending = pendingView.current;
    pendingView.current = null;
    pending?.animation?.cancel();
    if (snapshot.current) snapshot.current.hidden = true;
  }
  function reportError(message) { cancelTransition(); setReady(false); window.previewReady = false; setError(message); window.previewError = message; }
  function resetReadiness() { setReviewApi(null); setReady(false); window.previewReady = false; window.previewError = undefined; }
  function fitDiagram(animate = false) {
    if (!api) return;
    const all = api.getSceneElements();
    const targets = focusElements(all, focusRef.current?.elementId);
    if (all.length) api.scrollToContent(targets.length ? targets : all, { fitToViewport: true,
      viewportZoomFactor: targets.length ? 0.65 : 0.82, maxZoom: 1,
      animate: animate && !matchMedia('(prefers-reduced-motion: reduce)').matches, duration: 280 });
  }
  function backToOverview() {
    focusRef.current = null; setFocusedItem(null);
    workingApi?.updateScene({ appState: { selectedElementIds: {}, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
    setNotice('Showing the full diagram.'); fitDiagram(true);
  }
  function focusItem(item) {
    if (focusRef.current?.elementId === item.elementId) { backToOverview(); return; }
    const versions = [[view, displayed], ['after', proposal?.scene || (isReceipt ? scene : null)], ['before', beforeScene], ['working', working]];
    const target = versions.find(([, value]) => value && focusElements(value.elements, item.elementId).length);
    if (!target) return;
    focusRef.current = item; setFocusedItem({ ...item });
    selectView(target[0]);
    setNotice(`${item.text}. Highlighted in the ${viewLabel(target[0]).toLowerCase()} view.`);
    if (matchMedia('(max-width: 820px)').matches) {
      setDetailsOpen(false);
      document.getElementById('diagram-workspace').focus({ preventScroll: true });
    }
  }

  function initialize(value, metadata = {}) {
    validate(value);
    if (metadata.beforeScene) validate(metadata.beforeScene);
    if (metadata.proposalScene) validate(metadata.proposalScene);
    cancelTransition(); resetReadiness(); setWorkingApi(null); setFocusedItem(null); focusRef.current = null;
    setScene(value); setContext(metadata); setAgentBase(null); setAgentInstructions(''); setAgentPrompt(''); setSelection([]); setObjectsExpanded(false);
    const base = metadata.beforeScene || value;
    lastDownload.current = JSON.stringify(base);
    updateWorking(metadata.review ? null : structuredClone(base)); setBaseline(structuredClone(base));
    setProposal(metadata.beforeScene && !metadata.review ? { base: structuredClone(base), scene: structuredClone(value) } : null);
    setView(metadata.beforeScene || metadata.review ? 'after' : 'working');
    setDocumentId(id => id + 1); setRevision(id => id + 1); setError(''); setNotice('');
  }
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [value, metadata] = await Promise.all(['scene', 'context'].map(async resource => {
        const response = await fetch(`./${resource}`);
        if (!response.ok) throw new Error('The diagram could not be loaded. Reopen the preview and try again.');
        return response.json();
      }));
      let draft;
      try { storage.current = await draftStore(); draft = await storage.current.read(); }
      catch { setSaveStatus('Browser storage unavailable. Download your diagram to keep changes.'); }
      if (cancelled) return;
      initialize(value, metadata);
      if (draft) {
        try {
          validate(draft.working); validate(draft.baseline);
          if (draft.proposal) { validate(draft.proposal.base); validate(draft.proposal.scene); }
          if (draft.agentBase) validate(draft.agentBase);
          updateWorking(draft.working); setBaseline(draft.baseline); setProposal(draft.proposal); setAgentBase(draft.agentBase);
          setContext(draft.context); setAgentPrompt(draft.agentPrompt || ''); setAgentInstructions(draft.agentInstructions || '');
          setView('working'); setNotice('Restored your working diagram from this browser.');
        } catch { setSaveStatus('The saved draft could not be read. Your original diagram is open.'); }
      }
      setLoaded(true);
    })().catch(error => reportError(error.message));
    return () => { cancelled = true; storage.current?.close(); };
  }, []);
  useEffect(() => {
    if (!loaded || !working || !storage.current) return;
    const sequence = ++draftSequence.current;
    setSaveStatus('Saving in this browser…');
    const timeout = setTimeout(() => {
      storage.current.write({ working, baseline, proposal, agentBase, agentPrompt, agentInstructions, context }).then(() => {
        if (draftSequence.current === sequence) setSaveStatus('Saved in this browser');
      }).catch(() => {
        if (draftSequence.current === sequence) setSaveStatus('Draft could not be saved. Download your diagram to keep changes.');
      });
    }, 250);
    return () => clearTimeout(timeout);
  }, [loaded, working, baseline, proposal, agentBase, agentPrompt, agentInstructions, context]);
  useEffect(() => {
    const warn = event => { if (working && saveStatus !== 'Saved in this browser') { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [working, saveStatus]);
  useEffect(() => { document.title = `${title} · Excalidraw Toolkit`; }, [title]);
  useEffect(() => {
    if (!api || !ready || !focusedItem) return;
    if (!focusElements(api.getSceneElements(), focusedItem.elementId).length) {
      setFocusedItem(null); setNotice('This element is not present in this view.'); return;
    }
    if (view === 'working') api.updateScene({ appState: { selectedElementIds: { [focusedItem.elementId]: true } }, captureUpdate: CaptureUpdateAction.NEVER });
    fitDiagram(true);
  }, [api, ready, focusedItem]);
  useEffect(() => {
    if (!api || !displayed) return;
    let cancelled = false;
    const pending = pendingView.current;
    let frame;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { if (!cancelled) { if (view === 'working') api.refresh(); else fitDiagram(); } }); });
    });
    resize.observe(canvasPanel.current);
    (async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await document.fonts.ready;
      if (cancelled || pendingView.current !== pending) return;
      fitDiagram();
      // Capture the fitted canvas, never the new instance's empty first frame.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (cancelled || pendingView.current !== pending) return;
      if (pending && !snapshot.current.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        pending.animation = snapshot.current.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-in-out', fill: 'forwards' });
        await pending.animation.finished.catch(() => {}); // A newer selection can cancel this dissolve.
      }
      if (cancelled || window.previewError || pendingView.current !== pending) return;
      cancelTransition();
      setReady(true); window.previewReady = true;
    })().catch(error => reportError(error.message));
    return () => { cancelled = true; resize.disconnect(); cancelAnimationFrame(frame); };
  }, [api, revision, view]);

  async function openFile(event) {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const value = validate(JSON.parse(await file.text()));
      const metadata = { title: file.name.replace(/\.(excalidraw|json)$/i, '') };
      if (workingRef.current && JSON.stringify(workingRef.current) !== lastDownload.current && JSON.stringify(value) !== JSON.stringify(workingRef.current)) {
        setPendingFile({ value, metadata });
      } else { initialize(value, metadata); setLoaded(true); setNotice('Opened as a working diagram.'); }
    } catch (error) { setError(error instanceof SyntaxError ? 'This file contains invalid JSON. Choose a valid .excalidraw file.' : error.message); }
    event.target.value = '';
  }
  function selectView(next) {
    if ((pendingView.current?.view ?? view) === next) return;
    const dissolve = snapshot.current && typeof snapshot.current.animate === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches && (ready || !snapshot.current.hidden);
    // Snapshot the rendered layers (including a dissolve already in progress).
    // An unfinished next view keeps the previous snapshot instead of a blank frame.
    if (dissolve && (ready || pendingView.current?.animation)) {
      const bounds = canvasPanel.current.getBoundingClientRect();
      const copy = document.createElement('canvas');
      copy.width = Math.ceil(bounds.width * devicePixelRatio); copy.height = Math.ceil(bounds.height * devicePixelRatio);
      const context = copy.getContext('2d');
      context.scale(devicePixelRatio, devicePixelRatio);
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, bounds.width, bounds.height);
      for (const layer of canvasPanel.current.querySelectorAll('canvas')) {
        if (layer.hidden || layer.closest('.layer-hidden') || !layer.width || !layer.height) continue;
        const rect = layer.getBoundingClientRect();
        context.globalAlpha = Number(getComputedStyle(layer).opacity);
        context.drawImage(layer, rect.left - bounds.left, rect.top - bounds.top, rect.width, rect.height);
      }
      snapshot.current.width = copy.width; snapshot.current.height = copy.height;
      snapshot.current.getContext('2d').drawImage(copy, 0, 0);
    }
    cancelTransition();
    snapshot.current.hidden = !dissolve;
    pendingView.current = { view: next };
    resetReadiness(); setError(''); setNotice('');
    setView(next); setRevision(value => value + 1);
  }
  async function exportPng() {
    setExporting(true); setError('');
    try {
      let url;
      if (isReceipt && context.retainedPngViews?.includes(view)) {
        const response = await fetch(`./exports/${view}.png`);
        if (!response.ok) throw new Error('The retained PNG is unavailable. Reopen the receipt and try again.');
        url = URL.createObjectURL(await response.blob());
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else url = await png();
      download(url, `${filename}${view !== 'working' ? `-${view}` : ''}.png`);
      setNotice('PNG download started.');
    }
    catch (error) { setError(`PNG export failed: ${error.message}`); }
    finally { setExporting(false); }
  }
  function saveNative() {
    if (view === 'working') lastDownload.current = JSON.stringify(displayed);
    const url = URL.createObjectURL(new Blob([JSON.stringify(displayed, null, 2)], { type: 'application/json' }));
    download(url, `${filename}${view !== 'working' ? `-${view}` : ''}.excalidraw`);
    setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice(view === 'working' ? 'Working diagram download started.' : 'Snapshot download started.');
  }

  function downloadScene(value, name) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    download(url, name); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function prepareAgentEdit() {
    const base = structuredClone(workingRef.current);
    setAgentBase(base); setProposal(null); setError('');
    const inputName = `${filename}-agent-input.excalidraw`;
    const scope = selection.length ? `Limit changes to selected element IDs and required bound labels/connectors: ${selection.join(', ')}.` : 'No elements were selected. Preserve unrelated content and existing native IDs.';
    setAgentInstructions(`Edit the attached ${inputName} with Excalidraw Toolkit.\n\n${agentPrompt.trim()}\n\n${scope}\nReturn the full edited .excalidraw file as a proposal. Keep the input unchanged. I will review and accept the proposal in the workspace.`);
    downloadScene(base, inputName);
    setNotice('Agent input downloaded. Use it with the instructions below, then load the returned diagram. You can keep drawing.');
  }
  async function loadProposal(event) {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const value = validate(JSON.parse(await file.text()));
      if (!agentBase) throw new Error('Prepare an agent edit first so the proposal has an exact starting point.');
      setProposal({ base: structuredClone(agentBase), scene: value }); setError(''); selectView('after');
    } catch (error) { setError(`Proposal could not be loaded: ${error.message}`); }
    event.target.value = '';
  }
  function acceptProposal() {
    const result = reconcile(proposal.base, workingRef.current, proposal.scene);
    if (result.conflicts.length) { setError('This proposal conflicts with your drawing. Keep your work and prepare a new edit from Working.'); return; }
    const previous = workingApi.getSceneElementsIncludingDeleted();
    const index = new Map(previous.map(element => [element.id, element]));
    const changed = new Map(deriveChanges(workingRef.current, result.scene).map(change => [change.id, Object.keys(change.properties)]));
    const restored = restoreElements(structuredClone(result.scene.elements), previous);
    const next = restored.map(element => {
      const old = index.get(element.id);
      if (!old) return element;
      if (!changed.has(element.id)) return old;
      const updates = Object.fromEntries(changed.get(element.id).map(field => [field, element[field]]));
      return newElementWith(old, updates);
    });
    // Native history records the entire proposal as one update. Image bytes
    // remain available when undo removes their elements and redo restores them.
    workingApi.addFiles(Object.values(result.scene.files || {}));
    updateWorking(result.scene);
    workingApi.updateScene({ elements: next, appState: { viewBackgroundColor: result.scene.appState?.viewBackgroundColor }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setProposal(null); setAgentBase(null); setAgentInstructions(''); setError(''); selectView('working');
    setNotice('Proposal accepted. Undo once to return to your previous working diagram.');
  }
  function discardProposal() {
    setProposal(null); setAgentBase(null); setAgentInstructions(''); setError(''); selectView('working');
    setNotice('Proposal discarded. Your working diagram is unchanged.');
  }

  return <div className="review-app" onKeyDown={event => { if (event.key === 'Escape' && focusedItem) { event.preventDefault(); backToOverview(); } }}>
    {pendingFile && <dialog className="replace-dialog" ref={element => { if (element && !element.open) element.showModal(); }} onCancel={() => setPendingFile(null)} aria-labelledby="replace-title"><h2 id="replace-title">Keep your working diagram</h2><p>Opening another file replaces this browser draft. Save a native copy to keep your current drawing.</p><div><button className="button button-quiet" onClick={() => setPendingFile(null)}>Cancel</button><button className="button button-outline" onClick={() => { initialize(pendingFile.value, pendingFile.metadata); setPendingFile(null); }}>Open without saving</button><button autoFocus className="button button-primary" onClick={() => { downloadScene(workingRef.current, `${filename}.excalidraw`); initialize(pendingFile.value, pendingFile.metadata); setPendingFile(null); }}>Save &amp; open</button></div></dialog>}
    <a className="skip-link" href="#diagram-workspace">Skip to diagram</a>
    <header className="review-header">
      <div className="brand"><span className="brand-mark"><Icon name="layers" size={25} /></span><span>Excalidraw <strong>Toolkit</strong></span></div>
      <span className="header-divider" /><span className="header-label">Diagram workspace</span>
      <div className="header-actions">
        <input ref={fileInput} id="open" type="file" accept=".excalidraw,application/json" onChange={openFile} hidden />
        <button className="button button-quiet" onClick={() => fileInput.current.click()}><Icon name="open" /><span>Open file</span></button>
        <span className="action-divider" />
        <button id="native" className="button button-outline" aria-label="Download editable .excalidraw copy" title="Download the current view as an editable .excalidraw copy" disabled={!ready} onClick={saveNative}><Icon name="file" /><span>{view === 'working' ? 'Save diagram' : 'Download copy'}</span></button>
        <button id="png" className="button button-primary" disabled={!ready || exporting} onClick={exportPng}><Icon name="download" /><span>{exporting ? 'Exporting…' : 'Export PNG'}</span></button>
      </div>
    </header>
    <div className="review-body">
      <button className="sidebar-toggle" aria-expanded={detailsOpen} aria-controls="scene-details" onClick={() => setDetailsOpen(value => !value)}><Icon name="layers" size={16} /><span>Diagram details</span><span aria-hidden="true">{detailsOpen ? '−' : '+'}</span></button>
      <aside id="scene-details" className="review-sidebar" data-open={detailsOpen} aria-label="Diagram details">
        <div className="sidebar-heading"><span className="eyebrow">Workspace</span><span className="file-badge">.excalidraw</span></div>
        <div className="document-card"><span className="document-icon"><Icon name="file" size={23} /></span><div><h2>{title}</h2><p>{context.review?.kind === 'source-refresh' ? 'Staged refresh review' : proposal ? 'Proposal ready to review' : 'Editable working diagram'}</p></div></div>
        {isReceipt ? <ReceiptDetails review={context.review} view={view} /> : <>
        <section className="sidebar-section agent-section" aria-labelledby="agent-title">
          <div className="section-heading"><h2 id="agent-title">Work with an agent</h2><Icon name="pen" size={15} /></div>
          <p className="sidebar-note">Use your own agent with a saved copy. Keep drawing while it works.</p>
          <label className="agent-label" htmlFor="agent-prompt">Describe the edit</label>
          <textarea id="agent-prompt" aria-label="Describe the edit" placeholder="Connect this service to the queue…" value={agentPrompt} onChange={event => setAgentPrompt(event.target.value)} />
          <p className="selection-note">{selection.length ? `${selection.length} selected ${selection.length === 1 ? 'element' : 'elements'}` : 'Select an area on Working to scope the edit.'}</p>
          {!agentBase && !proposal && <button className="button button-outline" disabled={!ready || view !== 'working' || !agentPrompt.trim()} onClick={prepareAgentEdit}>Prepare agent edit</button>}
          {agentBase && <><details className="agent-instructions" open={!proposal}><summary>Agent instructions</summary><p className="sidebar-note">Attach the downloaded input file to your agent.</p><textarea aria-label="Agent instructions" readOnly value={agentInstructions} /><button className="button button-quiet" onClick={async () => { try { await navigator.clipboard.writeText(agentInstructions); setNotice('Agent instructions copied.'); } catch { setError('Copy is unavailable. Select and copy the instructions above.'); } }}>Copy instructions</button></details>
            <input ref={proposalInput} type="file" accept=".excalidraw,application/json" hidden onChange={loadProposal} />
            <button className="button button-outline" onClick={() => proposalInput.current.click()}>Load proposal</button>
            {!proposal && <button className="button button-quiet" onClick={discardProposal}>Cancel agent edit</button>}</>}
          {proposal && <p className="sidebar-note proposal-note">Review the proposal beside your current work. Acceptance preserves independent manual edits.</p>}
        </section>
        <EditSummary changes={changes} summary={summary} focusedId={focusedItem?.id} onFocus={focusItem} disabled={!scene || !!error} />
        <section className="sidebar-section" aria-labelledby="overview-title"><div className="section-heading"><h2 id="overview-title">Scene overview</h2><span>{elements.length}</span></div>
          {categories.length ? <dl className="scene-stats">{categories.map(item => <div key={item.label}><dt><Icon name={item.icon} size={16} />{item.label}</dt><dd>{item.count}</dd></div>)}</dl> : <p className="sidebar-note">{scene ? 'This scene has no visible elements.' : 'Waiting for the diagram…'}</p>}
        </section>
        {objects.length > 0 && <section className="sidebar-section object-section" aria-labelledby="objects-title"><div className="section-heading"><h2 id="objects-title">In this diagram</h2></div><ul id="object-list" className="object-list">{(objectsExpanded ? objects : objects.slice(0, 6)).map(element => <li key={element.id}><button className="object-link" disabled={!scene || !!error} aria-label={`Show ${elementLabel(element, elements)}`} aria-pressed={focusedItem?.elementId === element.id} onClick={() => focusItem({ id: `object:${element.id}`, elementId: element.id, text: elementLabel(element, elements) })}><span className="object-dot" /><span title={elementLabel(element, elements)}>{elementLabel(element, elements)}</span></button></li>)}</ul>{objects.length > 6 && <button className="sidebar-note more-objects" aria-expanded={objectsExpanded} aria-controls="object-list" onClick={() => setObjectsExpanded(expanded => !expanded)}>{objectsExpanded ? 'Show fewer objects' : `+${objects.length - 6} more ${objects.length === 7 ? 'object' : 'objects'}`}</button>}</section>}
        </>}
        <div className="sidebar-footer"><Icon name="check" size={15} /><span>{isReceipt ? 'Review a copy. Keep your original.' : 'Native files. Your drawing stays yours.'}</span></div>
      </aside>
      <main id="diagram-workspace" className="diagram-workspace" tabIndex={-1}>
        <div className="workspace-heading"><div><p className="eyebrow">{isReceipt ? 'Compare & review' : 'Draw · refine · make it yours'}</p><h1>{title}</h1><p className="workspace-description">{isReceipt ? 'Inspect the preserved source review, or open an editable copy.' : 'Sketch freely. Review agent changes. Keep everything in one diagram.'}</p></div><span className="review-badge"><span />{view === 'working' ? 'Editable canvas' : 'Read-only snapshot'}</span>{isReceipt && <button className="button button-outline" onClick={() => initialize(structuredClone(displayed), { title })}>Edit copy</button>}</div>
        {error && <div className="feedback feedback-error" role="alert"><Icon name="info" /><span>{error}</span>{scene && <button aria-label="Dismiss error" onClick={() => setError('')}>×</button>}</div>}
        <div className="canvas-card">
          <div className="canvas-toolbar"><div className="canvas-caption"><Icon name="layers" size={16} /><span>{viewLabel(view)}</span></div>
            {beforeScene && <div className="view-tabs" role="tablist" aria-label="Diagram version">{viewKeys.map((item, index) => <button key={item} ref={element => { tabs.current[index] = element; }} id={`${item}-tab`} role="tab" aria-selected={view === item} aria-controls="canvas-panel" tabIndex={view === item ? 0 : -1} onClick={() => selectView(item)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? viewKeys.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : viewKeys.length - 1)) % viewKeys.length; selectView(viewKeys[next]); tabs.current[next]?.focus(); } }}>{viewLabel(item)}</button>)}</div>}
            <button aria-label={focusedItem ? 'Back to overview' : 'Fit diagram'} className={`fit-button ${focusedItem ? 'is-focused' : ''}`} disabled={!ready || !elements.length} onClick={backToOverview}><Icon name="fit" size={15} /><span>{focusedItem ? 'Back to overview' : 'Fit diagram'}</span></button>
          </div>
          <div ref={canvasPanel} id="canvas-panel" className="canvas-panel" role={beforeScene ? 'tabpanel' : 'region'} aria-labelledby={beforeScene ? `${view}-tab` : undefined} aria-label={beforeScene ? undefined : 'Diagram canvas'} aria-busy={!ready && !error}>
            {working && <div className={`native-layer working-layer ${view !== 'working' ? 'layer-hidden' : ''}`} aria-hidden={view !== 'working'} {...(view !== 'working' ? { inert: '' } : {})}>
              <CanvasBoundary key={documentId} onError={reportError}><WorkingCanvas key={documentId} scene={working} onScene={updateWorking} onApi={setWorkingApi} onSelection={updateSelection} /></CanvasBoundary>
            </div>}
            {view !== 'working' && displayed && <div className="native-layer snapshot-layer"><CanvasBoundary key={`${revision}-${view}`} onError={reportError}><Excalidraw key={`${revision}-${view}`} initialData={{ elements: structuredClone(displayed.elements), files: structuredClone(displayed.files || {}), appState: { ...displayed.appState, viewModeEnabled: true } }} excalidrawAPI={setReviewApi} viewModeEnabled={true} zenModeEnabled={true} theme="light" handleKeyboardGlobally={false} /></CanvasBoundary></div>}
            {!displayed && <div className="canvas-state"><span className={error ? '' : 'loading-symbol'}><Icon name={error ? 'info' : 'layers'} size={30} /></span><h2>{error ? 'Your diagram is waiting' : 'Opening your diagram'}</h2><p>{error ? 'Choose a file to start a new workspace.' : 'Preparing the native canvas…'}</p></div>}
            {view !== 'working' && api && ready && focusedItem && <ElementFocus api={api} elementId={focusedItem.elementId} />}
            <canvas ref={snapshot} className="view-snapshot" aria-hidden="true" hidden />
          </div>
          <div className="canvas-footer"><span id="status" role="status"><span className={`status-dot ${ready ? 'is-ready' : ''}`} />{ready ? `${elements.length} ${elements.length === 1 ? 'element' : 'elements'} · ${view === 'working' ? 'Draw and edit freely' : 'Viewing a read-only copy'}` : error ? 'Preview unavailable' : 'Preparing canvas…'}</span><span className="canvas-hint">{view === 'working' ? 'Space to pan · ⌘/Ctrl Z to undo' : 'Scroll to pan · Pinch to zoom'}</span></div>
        </div>
        {proposal && <div className="proposal-bar"><div><strong>{reconciliation?.conflicts.length ? 'Your work needs a fresh proposal' : 'Ready when you are'}</strong><p>{reconciliation?.conflicts.length ? reconciliation.conflicts.map(conflict => conflict.message).join(' ') : 'Accept these changes into Working, or keep your drawing as it is.'}</p></div><button className="button button-quiet" onClick={discardProposal}>Discard proposal</button><button className="button button-primary" disabled={!ready || !workingApi || !!reconciliation?.conflicts.length} onClick={acceptProposal}>Accept proposal</button></div>}
        <div className="workspace-footer"><span>{isReceipt ? 'Made to stay editable.' : saveStatus || 'Download your diagram to keep a portable copy.'}</span><span role="status" aria-live="polite">{notice || (beforeScene ? `Exports use the ${viewLabel(view).toLowerCase()} view.` : 'PNG for sharing. Excalidraw for what comes next.')}</span></div>
      </main>
    </div>
  </div>;
}
function EditSummary({ changes, summary, focusedId, onFocus, disabled }) {
  const fieldCount = changes?.reduce((count, change) => count + Object.keys(change.properties || {}).length, 0) || 0;
  return <section className="sidebar-section changes-section" aria-labelledby="changes-title">
    <div className="section-heading"><h2 id="changes-title">Edit summary</h2>{summary && <span className="change-count" aria-label={`${summary.length} summarized edits`}>{summary.length}</span>}</div>
    {summary?.length ? <><p className="sidebar-note change-hint">Select an edit to find it on the canvas.</p><ul className="change-list">{summary.map(item => <li key={item.id}><button className="change-link" disabled={disabled} aria-label={`Show ${item.text}`} aria-describedby={item.details.length ? item.details.map((_, index) => `change-${encodeURIComponent(item.id)}-${index}`).join(' ') : undefined} aria-pressed={focusedId === item.id} onClick={() => onFocus(item)}>
      <span className={`change-mark change-mark--${item.kind}`} aria-hidden="true">{item.kind === 'added' ? '+' : item.kind === 'removed' ? '−' : '↗'}</span>
      <span className="change-description"><span className="change-title">{item.text}</span>{item.details.map((detail, index) => <span className="property-change" id={`change-${encodeURIComponent(item.id)}-${index}`} key={index}>
        <span>{detail.label}</span>{'value' in detail ? <span>{detail.value}</span> : <span className="change-values"><StyleValue value={detail.before} label={detail.label} /><span aria-label="to">→</span><StyleValue value={detail.after} label={detail.label} /></span>}
      </span>)}</span>
    </button></li>)}</ul></> : <p className="sidebar-note">{changes ? (changes.length ? 'Element metadata updated. See the technical changes below.' : 'No changes recorded in this review.') : 'No edit receipt is attached to this diagram.'}</p>}
    {!!changes?.length && <details className="technical-changes">
      <summary>Technical changes<span>{fieldCount} fields · {changes.length} elements</span></summary>
      <p className="sidebar-note">Display values are rounded to two decimals. The editable copy keeps the original values.</p>
      <pre tabIndex={0} aria-label="Full element field changes">{formatTechnicalChanges(changes)}</pre>
    </details>}
  </section>;
}
function StyleValue({ value, label }) {
  const color = typeof value === 'string' && /^(#[\da-f]{3,8}|transparent)$/i.test(value);
  const names = { '#1e1e1e': 'Charcoal', '#ffffff': 'White', '#000000': 'Black', '#a5d8ff': 'Light blue', '#e7f5ff': 'Pale blue', '#b2f2bb': 'Light green', '#d3f9d8': 'Pale green', '#ffc9c9': 'Light red', '#ffec99': 'Light yellow', transparent: 'None' };
  const text = label === 'Corners' ? (value ? 'Rounded' : 'Square') : color ? names[value.toLowerCase()] || value : displayValue(value);
  return <span className="color-value" title={color ? value : undefined}>{color && <span className="color-swatch" style={{ backgroundColor: value }} />}<span>{text}</span></span>;
}
createRoot(document.getElementById('app')).render(<Review />);
