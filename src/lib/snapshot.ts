import { saveDownload } from "./download";
// The drawn screen as a PNG at the radio's 240 x 320 (or 2x): the Live View's screen element rasterised through an
// SVG foreignObject, with the page's own stylesheets, its colour tokens and Ferrite's fonts embedded, so the image is
// what the Live View shows, not a redraw of it.

const W = 240;
const H = 320;

let fontCss: Promise<string> | null = null;

/** Reads a URL as a data: URL. */
async function dataUrl(url: string): Promise<string> {
  const b = await (await fetch(url)).blob();
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result as string);
    r.onerror = () => fail(r.error);
    r.readAsDataURL(b);
  });
}

/** The page's CSS, @font-face sources inlined (an SVG drawn as an image loads nothing from outside). */
function pageCss(): Promise<string> {
  fontCss ??= (async () => {
    const parts: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // another origin's sheet
      }
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSFontFaceRule) {
          let text = rule.cssText;
          for (const m of text.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
            try {
              text = text.replace(m[0], `url("${await dataUrl(new URL(m[1], sheet.href ?? location.href).href)}")`);
            } catch {
              /* the font falls back */
            }
          }
          parts.push(text);
        } else {
          parts.push(rule.cssText);
        }
      }
    }
    return parts.join("\n");
  })();
  fontCss.catch(() => (fontCss = null));
  return fontCss;
}

/** The custom properties (colour tokens) as the page has them now: light or dark. */
function tokens(): string {
  const cs = getComputedStyle(document.documentElement);
  const out: string[] = [];
  for (let i = 0; i < cs.length; i++) {
    const p = cs[i];
    if (p.startsWith("--")) out.push(`${p}:${cs.getPropertyValue(p)}`);
  }
  return out.join(";");
}

/** The screen element (240 x 320 before any scaling) as a PNG, `scale` 1 or 2. */
export async function screenPng(el: HTMLElement, scale = 1): Promise<Blob> {
  const css = await pageCss();
  const wrap = document.createElement("div");
  wrap.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  wrap.setAttribute("style", `${tokens()};width:${W}px;height:${H}px;overflow:hidden;margin:0`);
  const style = document.createElement("style");
  style.textContent = css;
  wrap.append(style, el.cloneNode(true));
  const xhtml = new XMLSerializer().serializeToString(wrap);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W * scale}" height="${H * scale}" viewBox="0 0 ${W} ${H}">` +
    `<foreignObject x="0" y="0" width="${W}" height="${H}">${xhtml}</foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = W * scale;
  canvas.height = H * scale;
  const g = canvas.getContext("2d")!;
  g.drawImage(img, 0, 0, W * scale, H * scale);
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("no PNG"))), "image/png"));
}

/** `ferrite-<screen id>-<yyyymmdd-hhmmss>.png`, local time. */
export function pngName(screenId: string | undefined, d = new Date()): string {
  const p = (v: number) => String(v).padStart(2, "0");
  const id = (screenId || "screen").replace(/[^A-Za-z0-9_-]+/g, "_");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `ferrite-${id}-${stamp}.png`;
}

/** The PNG to the downloads (the desktop app: its Downloads folder, download.ts). */
export function download(blob: Blob, name: string): Promise<string> {
  return saveDownload(name, blob);
}

/** Copies the PNG to the clipboard (where the browser allows it). */
export async function copyPng(make: () => Promise<Blob>) {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": make() })]);
}
