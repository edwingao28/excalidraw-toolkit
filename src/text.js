export const LABEL_CAPABILITIES = {
  elementTypes: ["rectangle"],
  geometry: "unrotated container and bound text",
  fontFamilies: [1, 3, 5, 6, 7, 8, 9],
  multilingual: "bundled Excalifont with Xiaolai fallback for CJK",
  fit: "preserve font size, container geometry, alignment, and existing text anchor; overflow fails",
};

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export async function measureLabel(specification) {
  const [{ servePreview, rendererStatus }, { chromium }] = await Promise.all([import("./render.js"), import("playwright")]);
  if (!rendererStatus().ready) fail("PREVIEW_BROWSER_MISSING", "Run excalidraw-toolkit setup-preview to install the pinned Chromium renderer before measuring labels");
  const preview = await servePreview({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const origin = new URL(preview.url).origin;
    await page.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort());
    const failedAssets = new Set();
    page.on("requestfailed", request => { if (!request.url().endsWith("/favicon.ico")) failedAssets.add(request.url()); });
    page.on("response", response => { if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) failedAssets.add(response.url()); });
    await page.goto(preview.url);
    await page.waitForFunction(() => window.measureLabel);
    const result = await page.evaluate((value) => window.measureLabel(value), specification);
    if (failedAssets.size) throw new Error(`FONT_UNAVAILABLE: ${[...failedAssets].join(", ")}`);
    return result;
  } finally {
    if (browser) await browser.close();
    await preview.close();
  }
}

export async function labelUpdate(scene, targetId, text, measure = measureLabel) {
  const container = scene.elements.find((element) => element.id === targetId && !element.isDeleted);
  if (!container) fail("UNKNOWN_TARGET", `No live element with ID: ${targetId}`);
  if (container.type !== "rectangle" || container.angle !== 0) fail("UNSUPPORTED_TARGET", "Label editing supports unrotated rectangles");
  const bindings = container.boundElements?.filter((binding) => binding.type === "text") ?? [];
  if (bindings.length !== 1) fail("INVALID_BINDING", "Label editing requires exactly one existing bound text element");
  const label = scene.elements.find((element) => element.id === bindings[0].id && !element.isDeleted);
  if (!label || label.type !== "text" || label.containerId !== targetId) fail("INVALID_BINDING", "The bound label must reference its container");
  if (label.angle !== 0 || !LABEL_CAPABILITIES.fontFamilies.includes(label.fontFamily)) fail("UNSUPPORTED_TARGET", "The bound label requires an unrotated, bundled font");
  if (typeof text !== "string" || !text.length || /[\u0000-\u0009\u000b-\u001f]/u.test(text)) fail("INVALID_REQUEST", "Label text must be nonempty; use newlines and spaces instead of control characters");
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text) && label.fontFamily !== 5) {
    fail("UNSUPPORTED_FONT_TEXT", "CJK labels require bundled Excalifont (fontFamily 5)");
  }
  if (![container.x, container.y, container.width, container.height, label.x, label.y, label.width, label.height, label.fontSize, label.lineHeight].every(Number.isFinite)
    || container.width <= 10 || container.height <= 10 || label.width <= 0 || label.height <= 0 || label.fontSize <= 0 || label.lineHeight <= 0) {
    fail("UNSUPPORTED_TARGET", "The label and container need finite, positive layout metrics");
  }
  const horizontal = { left: 0, center: 0.5, right: 1 }[label.textAlign];
  const vertical = { top: 0, middle: 0.5, bottom: 1 }[label.verticalAlign];
  if (horizontal === undefined || vertical === undefined) fail("UNSUPPORTED_TARGET", "Unsupported text alignment");
  const left = container.x + 5;
  const right = container.x + container.width - 5;
  const top = container.y + 5;
  const bottom = container.y + container.height - 5;
  const anchorX = label.x + label.width * horizontal;
  const anchorY = label.y + label.height * vertical;
  const maxWidth = label.autoResize === false ? label.width : horizontal === 0 ? right - anchorX : horizontal === 1 ? anchorX - left : 2 * Math.min(anchorX - left, right - anchorX);
  if (maxWidth <= 0) fail("TEXT_OVERFLOW", "The existing label anchor lies outside its container");
  const metrics = await measure({ text, fontSize: label.fontSize, fontFamily: label.fontFamily, lineHeight: label.lineHeight, maxWidth });
  if (!metrics || typeof metrics.text !== "string" || ![metrics.width, metrics.height].every(Number.isFinite) || metrics.width < 0 || metrics.height <= 0) {
    fail("INVALID_TEXT_METRICS", "Native text measurement returned invalid metrics");
  }
  // Wrapping may insert line breaks, but must retain all requested content.
  if (metrics.text.replaceAll("\n", "").replaceAll(" ", "") !== text.replaceAll("\n", "").replaceAll(" ", "")) fail("INVALID_TEXT_METRICS", "Native wrapping lost requested label content");
  const width = label.autoResize === false ? label.width : metrics.width;
  const height = metrics.height;
  const x = anchorX - width * horizontal;
  const y = anchorY - height * vertical;
  if (metrics.width > maxWidth + 0.001 || x < left - 0.001 || x + width > right + 0.001 || y < top - 0.001 || y + height > bottom + 0.001) {
    fail("TEXT_OVERFLOW", "The requested label does not fit while preserving its container, font size, and alignment");
  }
  return { targetId: label.id, properties: { text: metrics.text, originalText: text, width, height, x, y } };
}
