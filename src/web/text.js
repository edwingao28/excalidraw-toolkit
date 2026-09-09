import { convertToExcalidrawElements, exportToCanvas, FONT_FAMILY } from "@excalidraw/excalidraw";

export async function measureLabel({ text, fontSize, fontFamily, lineHeight, maxWidth }) {
  const family = Object.entries(FONT_FAMILY).find(([, id]) => id === fontFamily)?.[0];
  if (!family || fontFamily === 2) throw new Error("UNSUPPORTED_FONT: a bundled font is required");
  const specification = { text, fontSize, fontFamily, lineHeight };
  const probe = convertToExcalidrawElements([{ type: "text", x: 0, y: 0, ...specification }]);
  // Native export registers and loads the same glyph-specific font faces used
  // for the delivered diagram. The tiny canvas is only a font-loading probe.
  await exportToCanvas({ elements: probe, files: {}, appState: {}, getDimensions: () => ({ width: 1, height: 1, scale: 1 }) });
  const font = `${fontSize}px "${family}"${fontFamily === 5 ? ', "Xiaolai"' : ""}, "Segoe UI Emoji"`;
  await document.fonts.load(font, text);
  await document.fonts.ready;
  if (!document.fonts.check(font, text)) throw new Error("FONT_UNAVAILABLE: the native label font did not load");
  // The temporary rectangle reuses native bound-text wrapping with its 5px
  // padding. Only measured text fields leave this helper; IDs and geometry do not.
  const elements = convertToExcalidrawElements([{
    type: "rectangle", x: 0, y: 0, width: maxWidth + 10, height: 100,
    label: { ...specification, textAlign: "left", verticalAlign: "top" },
  }]);
  const label = elements.find((element) => element.type === "text");
  if (!label) throw new Error("INVALID_TEXT_METRICS: native wrapping did not produce a label");
  return { text: label.text, width: label.width, height: label.height };
}
