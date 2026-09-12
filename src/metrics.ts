/**
 * Font measurement shared by the renderer and fit(). The element fallback is
 * needed by browsers which omit the canvas font bounding box, and by custom
 * fonts whose metrics are not available until they have loaded.
 */
export function measureCell(document: Document, family: string, size: number, weight: string): { width: number; height: number } {
  const context = document.createElement("canvas").getContext("2d");
  if (context) {
    context.font = `${weight} ${size}px ${family}`;
    const metrics = context.measureText("W");
    const height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
    if (metrics.width > 0 && Number.isFinite(height) && height > 0) return { width: metrics.width, height };
  }
  const span = document.createElement("span");
  Object.assign(span.style, {
    position: "absolute", top: "-9999px", visibility: "hidden", whiteSpace: "pre",
    fontKerning: "none", fontVariantLigatures: "none", fontFamily: family,
    fontSize: `${size}px`, fontWeight: weight, lineHeight: "normal", letterSpacing: "0px",
  });
  span.textContent = "W".repeat(32);
  (document.body ?? document.documentElement).append(span);
  const width = span.offsetWidth / 32;
  const height = span.offsetHeight;
  span.remove();
  return { width: width || size * 0.6, height: height || size * 1.2 };
}
