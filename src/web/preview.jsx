import {measureLabel} from "./text.js";
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, exportToCanvas } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import './preview.css';
import { elementLabel, summarizeEdits, formatTechnicalChanges, displayValue } from './edit-summary.js';

window.EXCALIDRAW_ASSET_PATH = new URL('./assets/', window.location.href).href;
let activeScene;
async function png() {
  if (!activeScene) throw new Error('Open a diagram before exporting.');
  await document.fonts.ready;
  const canvas = await exportToCanvas({ elements: structuredClone(activeScene.elements.filter(e => !e.isDeleted)), files: structuredClone(activeScene.files || {}), appState: { ...activeScene.appState, exportBackground: true, exportWithDarkMode: false }, exportPadding: 30 });
  await document.fonts.ready;
  return canvas.toDataURL('image/png');
}
window.renderPng = png;
window.measureLabel = measureLabel;
window.sceneForPreview = () => structuredClone(activeScene);

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

function Review() {
  const [scene, setScene] = useState(null);
  const [context, setContext] = useState({});
  const [view, setView] = useState('after');
  const [revision, setRevision] = useState(0);
  const [api, setApi] = useState(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const fileInput = useRef(null);
  const canvasPanel = useRef(null);
  const tabs = useRef([]);
  const displayed = view === 'before' ? context.beforeScene : scene;
  activeScene = displayed;
  const elements = useMemo(() => displayed?.elements.filter(e => !e.isDeleted) || [], [displayed]);
  const title = context.title?.trim() || (typeof scene?.appState?.name === 'string' && scene.appState.name) || 'Diagram review';
  const filename = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim() || 'diagram';
  const changes = Array.isArray(context.changes) ? context.changes : null;
  const summary = useMemo(() => summarizeEdits(context.beforeScene, scene, changes), [context.beforeScene, scene, changes]);
  const objects = elements.filter(e => e.type !== 'text' && !['arrow', 'line'].includes(e.type));
  const categories = [['shape', 'Shapes', ['rectangle', 'ellipse', 'diamond']], ['arrow', 'Connections', ['arrow', 'line']], ['text', 'Labels', ['text']], ['frame', 'Frames', ['frame', 'magicframe']], ['image', 'Images', ['image']], ['pen', 'Freehand', ['freedraw']]].map(([icon, label, types]) => ({ icon, label, count: elements.filter(e => types.includes(e.type)).length })).filter(item => item.count);
  const otherCount = elements.length - categories.reduce((count, item) => count + item.count, 0);
  if (otherCount) categories.push({ icon: 'layers', label: 'Other elements', count: otherCount });
  function reportError(message) { setError(message); window.previewError = message; }
  function resetReadiness() { setApi(null); setReady(false); window.previewReady = false; window.previewError = undefined; }
  function fitDiagram() {
    if (api) api.scrollToContent(api.getSceneElements(), { fitToViewport: true, viewportZoomFactor: 0.82, maxZoom: 1, animate: false });
  }

  useEffect(() => {
    Promise.all(['scene', 'context'].map(async resource => {
      const response = await fetch(`./${resource}`);
      if (!response.ok) throw new Error('The diagram could not be loaded. Reopen the preview and try again.');
      return response.json();
    })).then(([value, metadata]) => { validate(value); if (metadata.beforeScene) validate(metadata.beforeScene); setScene(value); setContext(metadata); }).catch(error => reportError(error.message));
  }, []);
  useEffect(() => { document.title = `${title} · Excalidraw Toolkit`; }, [title]);
  useEffect(() => {
    if (!api || !displayed) return;
    let cancelled = false;
    let frame;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { if (!cancelled) fitDiagram(); }); });
    });
    resize.observe(canvasPanel.current);
    (async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await document.fonts.ready;
      if (cancelled) return;
      fitDiagram();
      setReady(true); window.previewReady = true;
    })().catch(error => reportError(error.message));
    return () => { cancelled = true; resize.disconnect(); cancelAnimationFrame(frame); };
  }, [api, displayed]);

  async function openFile(event) {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const value = validate(JSON.parse(await file.text()));
      resetReadiness(); setError(''); setNotice(''); setView('after');
      setScene(value); setContext({ title: file.name.replace(/\.(excalidraw|json)$/i, '') }); setRevision(value => value + 1);
    } catch (error) { setError(error instanceof SyntaxError ? 'This file contains invalid JSON. Choose a valid .excalidraw file.' : error.message); }
    event.target.value = '';
  }
  function selectView(next) { if (view !== next) { resetReadiness(); setError(''); setNotice(''); setView(next); } }
  async function exportPng() {
    setExporting(true); setError('');
    try { download(await png(), `${filename}${context.beforeScene ? `-${view}` : ''}.png`); setNotice('PNG download started.'); }
    catch (error) { setError(`PNG export failed: ${error.message}`); }
    finally { setExporting(false); }
  }
  function saveNative() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(displayed, null, 2)], { type: 'application/json' }));
    download(url, `${filename}${context.beforeScene ? `-${view}` : ''}.excalidraw`);
    setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('Editable copy download started.');
  }

  return <div className="review-app">
    <a className="skip-link" href="#diagram-workspace">Skip to diagram</a>
    <header className="review-header">
      <div className="brand"><span className="brand-mark"><Icon name="layers" size={25} /></span><span>Excalidraw <strong>Toolkit</strong></span></div>
      <span className="header-divider" /><span className="header-label">Diagram review</span>
      <div className="header-actions">
        <input ref={fileInput} id="open" type="file" accept=".excalidraw,application/json" onChange={openFile} hidden />
        <button className="button button-quiet" onClick={() => fileInput.current.click()}><Icon name="open" /><span>Open file</span></button>
        <span className="action-divider" />
        <button id="native" className="button button-outline" aria-label="Download editable .excalidraw copy" title="Download the current view as an editable .excalidraw copy" disabled={!ready} onClick={saveNative}><Icon name="file" /><span>Download copy</span></button>
        <button id="png" className="button button-primary" disabled={!ready || exporting} onClick={exportPng}><Icon name="download" /><span>{exporting ? 'Exporting…' : 'Export PNG'}</span></button>
      </div>
    </header>
    <div className="review-body">
      <button className="sidebar-toggle" aria-expanded={detailsOpen} aria-controls="scene-details" onClick={() => setDetailsOpen(value => !value)}><Icon name="layers" size={16} /><span>Diagram details</span><span aria-hidden="true">{detailsOpen ? '−' : '+'}</span></button>
      <aside id="scene-details" className="review-sidebar" data-open={detailsOpen} aria-label="Diagram details">
        <div className="sidebar-heading"><span className="eyebrow">Workspace</span><span className="file-badge">.excalidraw</span></div>
        <div className="document-card"><span className="document-icon"><Icon name="file" size={23} /></span><div><h2>{title}</h2><p>{context.beforeScene ? 'Before & after review' : 'Native diagram'}</p></div></div>
        <EditSummary changes={changes} summary={summary} key={revision} />
        <section className="sidebar-section" aria-labelledby="overview-title"><div className="section-heading"><h2 id="overview-title">Scene overview</h2><span>{elements.length}</span></div>
          {categories.length ? <dl className="scene-stats">{categories.map(item => <div key={item.label}><dt><Icon name={item.icon} size={16} />{item.label}</dt><dd>{item.count}</dd></div>)}</dl> : <p className="sidebar-note">{scene ? 'This scene has no visible elements.' : 'Waiting for the diagram…'}</p>}
        </section>
        {objects.length > 0 && <section className="sidebar-section object-section" aria-labelledby="objects-title"><div className="section-heading"><h2 id="objects-title">In this diagram</h2></div><ul className="object-list">{objects.slice(0, 6).map(element => <li key={element.id}><span className="object-dot" /><span title={elementLabel(element, elements)}>{elementLabel(element, elements)}</span></li>)}</ul>{objects.length > 6 && <p className="sidebar-note more-objects">+{objects.length - 6} more objects</p>}</section>}
        <div className="sidebar-footer"><Icon name="check" size={15} /><span>Review a copy. Keep your original.</span></div>
      </aside>
      <main id="diagram-workspace" className="diagram-workspace" tabIndex={-1}>
        <div className="workspace-heading"><div><p className="eyebrow">{context.beforeScene ? 'Compare & review' : 'Your diagram'}</p><h1>{title}</h1><p className="workspace-description">{context.beforeScene ? 'A clear view of what changed, with the original close at hand.' : 'Explore the details. Take the editable file with you.'}</p></div><span className="review-badge"><span />Read-only preview</span></div>
        {error && <div className="feedback feedback-error" role="alert"><Icon name="info" /><span>{error}</span>{scene && <button aria-label="Dismiss error" onClick={() => setError('')}>×</button>}</div>}
        <div className="canvas-card">
          <div className="canvas-toolbar"><div className="canvas-caption"><Icon name="layers" size={16} /><span>{context.beforeScene ? (view === 'after' ? 'Updated diagram' : 'Original diagram') : 'Canvas'}</span></div>
            {context.beforeScene && <div className="view-tabs" role="tablist" aria-label="Diagram version">{['before', 'after'].map((item, index) => <button key={item} ref={element => { tabs.current[index] = element; }} id={`${item}-tab`} role="tab" aria-selected={view === item} aria-controls="canvas-panel" tabIndex={view === item ? 0 : -1} onClick={() => selectView(item)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index; selectView(['before', 'after'][next]); tabs.current[next]?.focus(); } }}>{item === 'before' ? 'Before' : 'After'}</button>)}</div>}
            <button aria-label="Fit diagram" className="fit-button" disabled={!ready || !elements.length} onClick={fitDiagram}><Icon name="fit" size={15} /><span>Fit diagram</span></button>
          </div>
          <div ref={canvasPanel} id="canvas-panel" className="canvas-panel" role={context.beforeScene ? 'tabpanel' : 'region'} aria-labelledby={context.beforeScene ? `${view}-tab` : undefined} aria-label={context.beforeScene ? undefined : 'Diagram canvas'} aria-busy={!ready && !error}>
            {displayed ? <CanvasBoundary key={`${revision}-${view}`} onError={reportError}><Excalidraw key={`${revision}-${view}`} initialData={{ elements: structuredClone(displayed.elements), files: structuredClone(displayed.files || {}), appState: { ...displayed.appState, viewModeEnabled: true } }} excalidrawAPI={setApi} viewModeEnabled={true} zenModeEnabled={true} theme="light" /></CanvasBoundary> : <div className="canvas-state"><span className={error ? '' : 'loading-symbol'}><Icon name={error ? 'info' : 'layers'} size={30} /></span><h2>{error ? 'Your diagram is waiting' : 'Opening your diagram'}</h2><p>{error ? 'Choose a file to start a new review.' : 'Preparing the native canvas…'}</p></div>}
          </div>
          <div className="canvas-footer"><span id="status" role="status"><span className={`status-dot ${ready ? 'is-ready' : ''}`} />{ready ? `${elements.length} ${elements.length === 1 ? 'element' : 'elements'} · Viewing a read-only copy` : error ? 'Preview unavailable' : 'Preparing canvas…'}</span><span className="canvas-hint">Scroll to pan · Pinch to zoom</span></div>
        </div>
        <div className="workspace-footer"><span>Made to stay editable.</span><span role="status" aria-live="polite">{notice || (context.beforeScene ? `Exports use the ${view} view.` : 'PNG for sharing. Excalidraw for what comes next.')}</span></div>
      </main>
    </div>
  </div>;
}
function EditSummary({ changes, summary }) {
  const fieldCount = changes?.reduce((count, change) => count + Object.keys(change.properties || {}).length, 0) || 0;
  return <section className="sidebar-section changes-section" aria-labelledby="changes-title">
    <div className="section-heading"><h2 id="changes-title">Edit summary</h2>{summary && <span className="change-count" aria-label={`${summary.length} summarized edits`}>{summary.length}</span>}</div>
    {summary?.length ? <ul className="change-list">{summary.map(item => <li key={item.id}>
      <span className={`change-mark change-mark--${item.kind}`} aria-hidden="true">{item.kind === 'added' ? '+' : item.kind === 'removed' ? '−' : '↗'}</span>
      <div className="change-description"><p>{item.text}</p>{item.details.map((detail, index) => <div className="property-change" key={index}>
        <span>{detail.label}</span>{'value' in detail ? <span>{detail.value}</span> : <span className="change-values"><StyleValue value={detail.before} label={detail.label} /><span aria-label="to">→</span><StyleValue value={detail.after} label={detail.label} /></span>}
      </div>)}</div>
    </li>)}</ul> : <p className="sidebar-note">{changes ? (changes.length ? 'Element metadata updated. See the technical changes below.' : 'No changes recorded in this review.') : 'No edit receipt is attached to this diagram.'}</p>}
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
