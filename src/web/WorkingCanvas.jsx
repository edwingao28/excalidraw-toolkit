import React, { useRef } from 'react';
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw';
import { captureWorkingScene } from './workspace.js';

// This instance lives for the document, not the selected review tab. Excalidraw
// owns the drawing tools, selection, and undo history throughout the session.
export function WorkingCanvas({ scene, onScene, onApi }) {
  const native = useRef(null);
  const current = useRef(scene);
  current.current = scene;
  return <Excalidraw initialData={{ elements: structuredClone(scene.elements), files: structuredClone(scene.files || {}),
    appState: { ...scene.appState, viewModeEnabled: false, zenModeEnabled: false } }}
    excalidrawAPI={onApi} viewModeEnabled={false} zenModeEnabled={false} theme="light" handleKeyboardGlobally={false}
    onChange={(elements, appState, files) => {
      if (appState.isLoading) return;
      const snapshot = { elements, files, appState: JSON.parse(serializeAsJSON([], appState, {}, 'local')).appState };
      const next = captureWorkingScene(current.current, elements, snapshot.appState, files, native.current);
      native.current = structuredClone(snapshot);
      if (next !== current.current) { current.current = next; onScene(next); }
    }} />;
}
