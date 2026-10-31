// Leaflet for Console's maps, bundled (Alex, Oct 30, 2026: works offline and in the desktop app), in its own chunk
// that loads the first time a map opens. Tiles are OpenStreetMap's standard ones, attributed on the map (a low-traffic
// use, within their tile policy).
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
  loading ??= Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]).then(
    ([m]) => ((m as { default?: unknown }).default ?? m) as unknown as Leaflet,
    (e) => {
      loading = null;
      throw new Error(`The map library didn't load: ${e instanceof Error ? e.message : e}`);
    },
  );
  return loading;
}
