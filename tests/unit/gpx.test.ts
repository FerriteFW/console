// src/lib/gpx.ts: waypoints to and from GPX (GPS-10, decision 396).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGpx, toGpx } from "../../src/lib/gpx.ts";

test("gpx: waypoints in, names cut to 16, nameless numbered, bad positions out, tracks ignored", () => {
  const text = `<?xml version="1.0"?><gpx version="1.1">
    <wpt lat="49.2827" lon="-123.1207"><ele>70</ele><name>Vancouver &amp; Co</name></wpt>
    <wpt lon='-122.5' lat='48.9'><name><![CDATA[A very long waypoint name here]]></name></wpt>
    <wpt lat="47.1" lon="-121.2"/>
    <wpt lat="95" lon="10"><name>Off the map</name></wpt>
    <trk><trkseg><trkpt lat="1" lon="2"><name>track</name></trkpt></trkseg></trk>
  </gpx>`;
  assert.deepEqual(parseGpx(text), [
    { name: "Vancouver & Co", lat: 49.2827, lon: -123.1207 },
    { name: "A very long wayp", lat: 48.9, lon: -122.5 },
    { name: "WP 3", lat: 47.1, lon: -121.2 },
  ]);
});

test("gpx: what goes out reads back the same", () => {
  const pts = [
    { name: "Home <base>", lat: 49.25, lon: -123.1 },
    { name: "Peak", lat: -33.8568, lon: 151.2153 },
  ];
  assert.deepEqual(parseGpx(toGpx(pts)), pts);
  assert.match(toGpx(pts), /^<\?xml[\s\S]*<gpx version="1.1"/);
});
