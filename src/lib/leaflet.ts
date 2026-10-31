// Leaflet for Console's maps, bundled (Alex, Oct 30, 2026: works offline and in the desktop app), in its own chunk
// that loads the first time a map opens. Tiles are OpenStreetMap's standard ones, attributed on the map (a low-traffic
// use, within their tile policy).
export const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// The parts of Leaflet Console's maps use (APRS › Map, the Add channels "near me" map).
export type LatLng = [number, number];
export type LPoint = { x: number; y: number };
export type LLatLng = { lat: number; lng: number };
export type LBounds = { contains(b: LBounds | LatLng): boolean; pad(r: number): LBounds };
// Leaflet's events carry more; the handlers here read only these.
export type LEvent = { latlng?: LLatLng; originalEvent?: Event };
export type LLayer = {
  addTo(m: LMap | LGroup): LLayer;
  remove(): void;
  bindTooltip(t: string, o?: object): LLayer;
  bindPopup(h: string): LLayer;
  openPopup(): LLayer;
  on(e: string, f: (e: LEvent) => void): LLayer;
  getElement?(): HTMLElement | undefined;
};
export type LMarker = LLayer & { getLatLng(): LLatLng; setLatLng(c: LatLng): LMarker; setIcon(i: unknown): LMarker };
export type LCircle = LLayer & { setRadius(m: number): LCircle; setLatLng(c: LatLng): LCircle; getBounds(): LBounds };
export type LGroup = { addTo(m: LMap): LGroup; clearLayers(): LGroup; remove(): void };
export type LMap = {
  setView(c: LatLng, z: number): LMap;
  fitBounds(b: LatLng[] | LBounds, o?: object): LMap;
  remove(): void;
  invalidateSize(): void;
  on(e: string, f: (e: LEvent) => void): LMap;
  getZoom(): number;
  getMaxZoom(): number;
  getBounds(): LBounds;
  project(c: LatLng, z?: number): LPoint;
  latLngToContainerPoint(c: LatLng): LPoint;
  distance(a: LatLng, b: LatLng | LLatLng): number;
};
export type Leaflet = {
  map(el: HTMLElement, o?: object): LMap;
  tileLayer(url: string, o: object): LLayer;
  circleMarker(c: LatLng, o: object): LLayer;
  circle(c: LatLng, o: object): LCircle;
  marker(c: LatLng, o?: object): LMarker;
  layerGroup(): LGroup;
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
