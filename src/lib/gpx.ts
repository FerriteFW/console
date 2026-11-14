// GPS-10's waypoints to and from GPX 1.1 (decision 396): the waypoints (`wpt`) of a GPX file in, each with its name
// (cut to the radio's 16 characters; "WP n" when it has none), and the radio's out. Routes' and tracks' points aren't
// waypoints and stay out. Pure, for the tests.

export const NAME_MAX = 16;

export type GpxPoint = { name: string; lat: number; lon: number };

const unescape = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m ? Number(m[2] ?? m[3]) : NaN;
};

/** The waypoints in a GPX file, in its order; positions outside ±90/±180 or unreadable are left out. */
export function parseGpx(text: string): GpxPoint[] {
  const out: GpxPoint[] = [];
  const re = /<wpt\b([^>]*?)(\/>|>([\s\S]*?)<\/wpt>)/g;
  for (let m; (m = re.exec(text)); ) {
    const lat = attr(m[1], "lat");
    const lon = attr(m[1], "lon");
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const n = /<name>([\s\S]*?)<\/name>/.exec(m[3] ?? "");
    const name = (n ? unescape(n[1]).trim().replace(/\s+/g, " ") : "") || `WP ${out.length + 1}`;
    out.push({ name: [...name].slice(0, NAME_MAX).join(""), lat, lon });
  }
  return out;
}

/** The waypoints as a GPX 1.1 file. */
export function toGpx(points: GpxPoint[], creator = "Ferrite Console"): string {
  const wpts = points.map((p) => `  <wpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><name>${escape(p.name)}</name></wpt>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="${escape(creator)}" xmlns="http://www.topografix.com/GPX/1/1">\n${wpts.join("\n")}\n</gpx>\n`;
}
