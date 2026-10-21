// Leaflet for the APRS map, loaded once from a pinned CDN version with its integrity hashes (not bundled: only the
// map page needs it). Tiles are OpenStreetMap's standard ones, attributed on the map (a low-traffic use, within
// their tile policy).
const VERSION = "1.9.4";
const JS = `https://unpkg.com/leaflet@${VERSION}/dist/leaflet.js`;
const CSS = `https://unpkg.com/leaflet@${VERSION}/dist/leaflet.css`;
const JS_SRI = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=";
const CSS_SRI = "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=";

export const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// The parts of Leaflet the map page uses.
export type LatLng = [number, number];
export type LLayer = { addTo(m: LMap): LLayer; remove(): void; bindTooltip(t: string, o?: object): LLayer; bindPopup(h: string): LLayer; openPopup(): LLayer; on(e: string, f: () => void): LLayer };
export type LMap = {
  setView(c: LatLng, z: number): LMap;
  fitBounds(b: LatLng[], o?: object): LMap;
  remove(): void;
  invalidateSize(): void;
};
export type Leaflet = {
  map(el: HTMLElement, o?: object): LMap;
  tileLayer(url: string, o: object): LLayer;
  circleMarker(c: LatLng, o: object): LLayer;
  marker(c: LatLng, o?: object): LLayer;
  divIcon(o: object): unknown;
};

let loading: Promise<Leaflet> | null = null;

export function loadLeaflet(): Promise<Leaflet> {
  const w = window as unknown as { L?: Leaflet };
  if (w.L) return Promise.resolve(w.L);
  loading ??= new Promise<Leaflet>((ok, fail) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = CSS;
    css.integrity = CSS_SRI;
    css.crossOrigin = "";
    document.head.append(css);
    const s = document.createElement("script");
    s.src = JS;
    s.integrity = JS_SRI;
    s.crossOrigin = "";
    s.onload = () => (w.L ? ok(w.L) : fail(new Error("Leaflet loaded without L")));
    s.onerror = () => {
      loading = null;
      s.remove();
      fail(new Error(`The map library didn't load (${JS}): offline?`));
    };
    document.head.append(s);
  });
  return loading;
}
