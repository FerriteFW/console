// Pages by hash: `#/page` or `#/page?key=value` (the map's station or place). A reload stays put.

function parse() {
  const h = location.hash.replace(/^#\/?/, "");
  const [id, q = ""] = h.split("?");
  return { id, params: new URLSearchParams(q) };
}

class Route {
  id = $state(parse().id);
  params = $state.raw(parse().params);

  constructor() {
    if (typeof window !== "undefined")
      window.addEventListener("hashchange", () => {
        const r = parse();
        this.id = r.id;
        this.params = r.params;
      });
  }
}

export const route = new Route();

/** The link to a page, with parameters. */
export function href(id: string, params: Record<string, string | number> = {}) {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  return `#/${id}${q ? `?${q}` : ""}`;
}

/** The map at a station or a place. */
export const mapHref = (p: { call?: string; lat?: number | null; lon?: number | null }) =>
  p.call ? href("aprs-map", { call: p.call }) : href("aprs-map", { at: `${p.lat!.toFixed(5)},${p.lon!.toFixed(5)}` });
