// src/lib/codeplug.ts: the .ferrite codeplug (docs/dev/codeplug-format.md). The documented example
// (core/tests/fixtures/codeplug/, which the doc shows and core's codeplug_example tests check against Console's own
// part writers) zipped and read back; files refused: not a zip, a zip that isn't a codeplug, a newer version, a
// listed part missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  buildCodeplug,
  codeplugName,
  contactsJson,
  dtmfJson,
  fingerprint,
  isZip,
  manifest,
  PARTS,
  readCodeplug,
  readContacts,
  readDtmf,
  readQuick,
  readWaypoints,
  quickJson,
  VERSION,
  waypointsJson,
  type Manifest,
  type Parts,
} from "../../src/lib/codeplug.ts";
import { createZip, readZip } from "../../src/lib/zip.ts";

const fx = (n: string) => readFileSync(new URL(`../../core/tests/fixtures/codeplug/${n}`, import.meta.url), "utf8");
const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

test("the documented example round-trips", async () => {
  const m: Manifest = JSON.parse(fx("manifest.json"));
  const parts: Parts = {};
  for (const p of m.parts) parts[p] = fx(`${p}.json`);
  const file = await bytes(await buildCodeplug(parts, m));
  assert.ok(isZip(file));
  // The zip holds exactly the manifest and the listed parts, byte for byte.
  const files = await readZip(file);
  assert.deepEqual([...files.keys()], ["manifest.json", "channels.json", "presets.json", "aprs.json", "contacts.json", "quick.json", "waypoints.json", "dtmf.json"]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(files.get("manifest.json"))), m);
  const back = await readCodeplug(file);
  assert.deepEqual(back.manifest, m);
  assert.deepEqual(back.parts, parts);
  assert.equal(back.parts.settings, undefined, "saved before Settings was read: no settings part");
  assert.equal(readContacts(back.parts.contacts!).contacts.length, 2);
});

test("the example's manifest is what Console writes", () => {
  const m: Manifest = JSON.parse(fx("manifest.json"));
  const parts: Parts = { channels: "{}", presets: "{}", aprs: "{}", contacts: "{}", quick: "{}", waypoints: "{}", dtmf: "{}" };
  const made = manifest(parts, m.radio, m.console, new Date(m.created), m.radio_fingerprint);
  assert.deepEqual(made, m);
  // Byte for byte as Console writes it (buildCodeplug: JSON.stringify(.., null, 2)), key order included.
  assert.equal(JSON.stringify(made, null, 2), fx("manifest.json"));
  assert.equal(m.version, VERSION);
  // Unknown radio facts are left out, not written empty.
  assert.deepEqual(manifest({ settings: "{}" }, { callsign: "" }, "0.1.0").radio, {});
  assert.deepEqual(manifest({ contacts: "{}", channels: "{}" }, {}, "0.1.0").parts, ["channels", "contacts"], "in PARTS order");
  assert.deepEqual([...PARTS], ["channels", "presets", "settings", "aprs", "contacts", "quick", "waypoints", "dtmf"]);
});

test("the example's contacts.json is what Console writes", () => {
  const f = readContacts(fx("contacts.json"));
  assert.equal(contactsJson(f.contacts, f.saved, f.radio), fx("contacts.json"));
});

test("the example's quick.json, waypoints.json and dtmf.json are what Console writes", () => {
  const q = readQuick(fx("quick.json"));
  assert.equal(quickJson(q.messages, q.saved, q.radio), fx("quick.json"));
  assert.deepEqual(q.messages.filter((m) => m.own).map((m) => m.text), ["At the club tonight, 146.94"]);
  const w = readWaypoints(fx("waypoints.json"));
  assert.equal(waypointsJson(w.waypoints, w.saved, w.radio), fx("waypoints.json"));
  assert.equal(w.waypoints[0].name, "Grouse summit", "newest first");
  const d = readDtmf(fx("dtmf.json"));
  assert.equal(dtmfJson(d.memories, d.saved, d.radio), fx("dtmf.json"));
  assert.deepEqual(d.memories.map((m) => m.number), [1, 2]);
});

test("the lists' parts refused: another format, a newer version, the wrong shape", () => {
  assert.throws(() => readQuick(fx("contacts.json")), /not a quick messages file/);
  assert.throws(() => readQuick(JSON.stringify({ format: "ferrite-console-quick", version: 2, messages: [] })), /newer/);
  assert.throws(() => readQuick(JSON.stringify({ format: "ferrite-console-quick", version: 1, messages: [{ own: true, text: "x" }] })), /the radio has 9/);
  assert.throws(() => readWaypoints(JSON.stringify({ format: "ferrite-console-waypoints", version: 1, waypoints: [{ name: "x", lat: "1" }] })), /\{name, lat, lon, source\}/);
  const many = Array.from({ length: 257 }, () => ({ name: "x", lat: 1, lon: 1, source: "link" }));
  assert.throws(() => readWaypoints(JSON.stringify({ format: "ferrite-console-waypoints", version: 1, waypoints: many })), /keeps 256/);
  assert.throws(() => readDtmf(JSON.stringify({ format: "ferrite-console-dtmf", version: 1, memories: [{ number: 17, symbols: "1", name: "" }] })), /1-16/);
  const twice = [{ number: 3, symbols: "1", name: "" }, { number: 3, symbols: "2", name: "" }];
  assert.throws(() => readDtmf(JSON.stringify({ format: "ferrite-console-dtmf", version: 1, memories: twice })), /twice/);
});

// docs/dev/codeplug-format.md (the docs checkout beside this one) shows the example: its blocks are the fixtures.
const doc = new URL("../../../docs/dev/codeplug-format.md", import.meta.url);
test("the format doc shows the example as it is", { skip: !existsSync(doc) && "no docs checkout beside this one" }, () => {
  const text = readFileSync(doc, "utf8");
  for (const n of ["manifest.json", "channels.json", "presets.json", "aprs.json", "contacts.json", "quick.json", "waypoints.json", "dtmf.json"]) {
    const at = text.indexOf(`\`${n}\``, text.indexOf("## Example"));
    assert.ok(at > 0, `the doc's example has ${n}`);
    const open = text.indexOf("```json\n", at) + "```json\n".length;
    const block = text.slice(open, text.indexOf("\n```", open));
    assert.equal(block, fx(n), `the doc's ${n} is the fixture`);
  }
});

test("the radio's fingerprint: SHA-256 of the UID bytes, 8 hex digits (the example's)", async () => {
  const uid = new Uint8Array([0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe, 0x01, 0x23, 0x45, 0x67]);
  assert.equal(await fingerprint(uid), "7f755785");
  assert.equal(await fingerprint(new Uint8Array(12)), "15ec7bf0");
  assert.equal(JSON.parse(fx("manifest.json")).radio_fingerprint, "7f755785");
  // No unique ID anywhere in the example.
  for (const n of ["manifest.json", "channels.json", "aprs.json", "contacts.json", "quick.json", "waypoints.json", "dtmf.json"]) assert.doesNotMatch(fx(n), /"(uid|id)"/, n);
});

// The core's WebAssembly build (npm run wasm; not in git): a whole codeplug saved from a settings record with the
// PIN lock set (fixture from core's no_pin_in_the_settings_part) has no key naming the PIN anywhere.
const wasmJs = new URL("../../src/core-wasm/core.js", import.meta.url);
test("no PIN in a saved codeplug", { skip: !existsSync(wasmJs) && "no core-wasm build (npm run wasm)" }, async () => {
  const core = await import(wasmJs.href);
  await core.default({ module_or_path: readFileSync(new URL("../../src/core-wasm/core_bg.wasm", import.meta.url)) });
  const hex = fx("settings-with-pin.hex");
  const rec = new Uint8Array(hex.match(/../g)!.map((h: string) => parseInt(h, 16)));
  const settings = core.settings_codeplug_part(rec, "{}", "2026-10-30T21:12:00.000Z", JSON.stringify({ callsign: "VA7IF" }));
  const m: Manifest = JSON.parse(fx("manifest.json"));
  const parts: Parts = { channels: fx("channels.json"), settings, aprs: fx("aprs.json"), contacts: fx("contacts.json") };
  const file = await bytes(await buildCodeplug(parts, manifest(parts, m.radio, m.console, new Date(m.created), m.radio_fingerprint)));
  const keys: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) keys.push(k), walk(x);
  };
  for (const [name, b] of await readZip(file)) walk(JSON.parse(new TextDecoder().decode(b)) ?? name);
  assert.ok(keys.length > 100);
  assert.deepEqual(keys.filter((k) => /pin/i.test(k)), []);
  assert.ok(!keys.some((k) => k.startsWith("0 9 3 ")), "the PIN lock's menu entries left out");
});

test("contacts: written and read back", () => {
  const t = contactsJson([{ call: "VE7ABC", name: "Club" }], "2026-10-30T00:00:00.000Z", { callsign: "VA7IF" });
  const f = readContacts(t);
  assert.equal(f.format, "ferrite-console-contacts");
  assert.deepEqual(f.contacts, [{ call: "VE7ABC", name: "Club" }]);
  assert.throws(() => readContacts('{"format":"ferrite-console-contacts","version":2,"contacts":[]}'), /newer/);
  assert.throws(() => readContacts('{"format":"ferrite-console-channels","version":1}'), /not a contacts file/);
});

test("names: callsign or radio, then yyyymmdd-hhmm", () => {
  const d = new Date(2026, 9, 30, 14, 12, 59);
  assert.equal(codeplugName("VA7IF", d), "VA7IF-20261030-1412.ferrite");
  assert.equal(codeplugName(undefined, d), "radio-20261030-1412.ferrite");
  assert.equal(codeplugName("a/b c", d), "abc-20261030-1412.ferrite");
});

test("refused: not a zip, not a codeplug, a newer version, a listed part missing", async () => {
  const m: Manifest = JSON.parse(fx("manifest.json"));
  const zip = async (entries: { name: string; data: string }[]) => bytes(await createZip(entries));
  await assert.rejects(readCodeplug(new TextEncoder().encode(fx("channels.json"))), /not a Ferrite codeplug/);
  await assert.rejects(readCodeplug(await zip([{ name: "readme.txt", data: "hi" }])), /not a Ferrite codeplug: a zip without manifest\.json/);
  await assert.rejects(readCodeplug(await zip([{ name: "manifest.json", data: '{"format":"neonplug"}' }])), /not a Ferrite codeplug: its manifest says format "neonplug"/);
  await assert.rejects(readCodeplug(await zip([{ name: "manifest.json", data: "{" }])), /isn't JSON/);
  await assert.rejects(
    readCodeplug(await zip([{ name: "manifest.json", data: JSON.stringify({ ...m, version: VERSION + 1 }) }])),
    /newer codeplug \(format version 2\) than this Console reads \(version 1\): update Ferrite Console/,
  );
  await assert.rejects(readCodeplug(await zip([{ name: "manifest.json", data: JSON.stringify(m) }])), /damaged codeplug: the manifest lists channels but there is no channels\.json/);
  // A damaged zip is refused by the zip reader's checks.
  const good = await bytes(await buildCodeplug({ channels: fx("channels.json") }, manifest({ channels: "x" }, {}, "0.1.0")));
  const bad = good.slice();
  bad[30 + "manifest.json".length + 8] ^= 0xff; // inside the first entry's data
  await assert.rejects(readCodeplug(bad), /not a Ferrite codeplug: Corrupt ZIP/);
});

test("a part this Console doesn't know (added later in the same version) is left alone", async () => {
  const m = { ...manifest({ contacts: "x" }, {}, "0.1.0"), parts: ["contacts", "satellites"] };
  const file = await bytes(await createZip([
    { name: "manifest.json", data: JSON.stringify(m) },
    { name: "contacts.json", data: fx("contacts.json") },
    { name: "satellites.json", data: "{}" },
  ]));
  const back = await readCodeplug(file);
  assert.deepEqual(Object.keys(back.parts), ["contacts"]);
});
