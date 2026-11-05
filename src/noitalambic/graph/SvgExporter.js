// ============================================================================
// SVG EXPORTER - Builds a standalone, self-contained copy of the live graph SVG
// ============================================================================
// The exported file must look like the screen without this page around it: no stylesheet, no
// CSS variables, no page background and, ideally, no network. So the copy:
//   - frames the whole graph (not the zoom/pan viewport), ignoring clipped textures' raw size,
//   - carries every rendered fill/stroke as an inline style (CSS rules don't travel),
//   - gets an explicit background (labels are white: invisible on a transparent background),
//   - embeds images as data: URIs when an embedImage() resolver can read them.

import { toSrgb } from "../ui/cssColor.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

// Options:
//   background  CSS color painted behind the graph, or null for transparent.
//   padding     margin around the graph's bounding box, in graph units.
//   embedImage  async (href) => data: URI | null.
// Returns {text, width, height, embeddedImages, externalImages}.
export async function buildStandaloneSvg(liveSvg, { background = null, padding = 20, embedImage = async () => null } = {}) {
  const liveContent = liveSvg.querySelector(":scope > g");
  const frame = contentFrame(liveSvg, liveContent, padding);

  const clone = liveSvg.cloneNode(true);
  // Must run before any change to the clone: elements are paired by document order.
  inlineComputedColors(liveSvg, clone);

  clone.setAttributeNS(XMLNS_NS, "xmlns", SVG_NS);
  clone.setAttributeNS(XMLNS_NS, "xmlns:xlink", XLINK_NS);
  clone.removeAttribute("style"); // on-page positioning (position:absolute...)
  clone.removeAttribute("preserveAspectRatio");
  clone.setAttribute("viewBox", frame.join(" "));
  clone.setAttribute("width", round(frame[2]));
  clone.setAttribute("height", round(frame[3]));
  if (frame.contentSpace) clone.querySelector(":scope > g")?.removeAttribute("transform");

  const style = document.createElementNS(SVG_NS, "style");
  style.textContent = ".node-label { font-family: Arial, sans-serif; } .material-image { image-rendering: optimizeQuality; }";
  clone.insertBefore(style, clone.firstChild);

  if (background) {
    const rect = document.createElementNS(SVG_NS, "rect");
    const [x, y, width, height] = frame;
    Object.entries({ x, y, width, height, fill: background }).forEach(([key, value]) => rect.setAttribute(key, value));
    style.after(rect);
  }

  const { embeddedImages, externalImages } = await embedImages(clone, embedImage);

  const text = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' + new XMLSerializer().serializeToString(clone);
  return { text, width: frame[2], height: frame[3], embeddedImages, externalImages };
}

// [x, y, width, height] to frame, in the content group's own space (zoom/pan removed): the
// whole graph plus padding. Falls back to the current viewBox (transform kept) when the browser
// can't measure (jsdom, graph not rendered).
function contentFrame(liveSvg, liveContent, padding) {
  const box = measureIgnoringClippedContent(liveContent);
  if (box) {
    const frame = [box.x - padding, box.y - padding, box.width + 2 * padding, box.height + 2 * padding].map(round);
    frame.contentSpace = true;
    return frame;
  }
  const viewBox = (liveSvg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  if (viewBox.length === 4 && viewBox.every(Number.isFinite)) return viewBox;
  return [0, 0, Number(liveSvg.getAttribute("width")) || 800, Number(liveSvg.getAttribute("height")) || 600];
}

// getBBox() ignores clip-path: each material texture (a 252px image scaled x2, clipped to its
// node circle) would count as ~500px and leave large blank areas. Clipped content always sits
// inside its node, so it is hidden while measuring (display:none content doesn't count) and
// shown again right after. Synchronous: the hidden state is never painted.
function measureIgnoringClippedContent(content) {
  if (typeof content?.getBBox !== "function") return null;
  const clipped = [...content.querySelectorAll("[clip-path]")];
  const previous = clipped.map((el) => el.style.display);
  clipped.forEach((el) => (el.style.display = "none"));
  try {
    const box = content.getBBox();
    return box && (box.width > 0 || box.height > 0) ? box : null;
  } catch {
    return null; // not rendered
  } finally {
    clipped.forEach((el, i) => (el.style.display = previous[i]));
  }
}

const round = (value) => Math.round(value * 100) / 100;

// Copies the live computed fill/stroke onto the clone. Presentation attributes lose to CSS rules,
// and no CSS travels with the file, so the computed value is the only one sure to match the
// screen. It also resolves currentColor and var(--...), and converts to sRGB.
function inlineComputedColors(liveRoot, cloneRoot) {
  const liveElements = liveRoot.querySelectorAll("*");
  const cloneElements = cloneRoot.querySelectorAll("*");
  liveElements.forEach((liveEl, index) => {
    const cloneEl = cloneElements[index];
    if (!cloneEl) return;
    const computed = window.getComputedStyle(liveEl);
    // toSrgb: computed values keep oklch()/color-mix() from the theme, unknown to many renderers.
    if (computed.fill && computed.fill !== "none" && !computed.fill.startsWith("url(")) cloneEl.style.fill = toSrgb(computed.fill);
    if (computed.stroke && computed.stroke !== "none" && !computed.stroke.startsWith("url(")) cloneEl.style.stroke = toSrgb(computed.stroke);
    if (cloneEl.style.color?.startsWith("var(")) cloneEl.style.color = toSrgb(computed.color);
  });
}

async function embedImages(clone, embedImage) {
  const cache = new Map(); // href -> Promise<data URI | null>, each distinct image read once
  let embeddedImages = 0;
  let externalImages = 0;

  await Promise.all(
    [...clone.querySelectorAll("image")].map(async (image) => {
      // Images that failed to load on screen are hidden: drop them rather than ship a broken link.
      if (image.style.display === "none") {
        image.remove();
        return;
      }
      const href = image.getAttribute("href") || image.getAttributeNS(XLINK_NS, "href");
      if (!href) return;
      if (href.startsWith("data:")) {
        embeddedImages++;
        return;
      }

      if (!cache.has(href)) cache.set(href, Promise.resolve(embedImage(href)).catch(() => null));
      const dataUri = await cache.get(href);
      const finalHref = dataUri || href;
      if (dataUri) embeddedImages++;
      else externalImages++;
      // Both forms: href is SVG 2, xlink:href is what older viewers/converters understand.
      image.setAttribute("href", finalHref);
      image.setAttributeNS(XLINK_NS, "xlink:href", finalHref);
    }),
  );

  return { embeddedImages, externalImages };
}
