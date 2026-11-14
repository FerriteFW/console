<script lang="ts">
  // Satellites (manual chapter 28a; SAT-2, SAT-9, SAT-13, SAT-15, SAT-18, SAT-21): the satellites an FM handheld can
  // work, from data.ferritefw.dev (CelesTrak's elements, SatNOGS DB's transponders), and what the radio holds. Write
  // puts the whole list on the radio (up to 32, the active first) with its clock and the magnetic declination.
  import { satellites, ageDays, ageLevel, declText } from "../satellites.svelte";
  import { radio } from "../radio.svelte";
  import { loadCore, P, satNextPasses, type SatPass, type SatRow, type SatTp } from "../core";
  import SatMap from "../components/SatMap.svelte";
  import { library } from "../library.svelte";
  import { canLocate, here } from "../here";
  import { passShort } from "../satpass";

  let coreUp = $state(false);
  void loadCore().then(() => {
    coreUp = true;
    void satellites.loadFile();
  });
  let now = $state(Date.now() / 1000);
  $effect(() => {
    const t = setInterval(() => (now = Date.now() / 1000), 60_000);
    return () => clearInterval(t);
  });

  const connected = $derived(radio.phase === "connected");
  const supported = $derived(connected && coreUp && satellites.supported);
  $effect(() => {
    if (supported) satellites.ensure();
  });
  const busy = $derived(!!satellites.busy);
  const max = $derived(coreUp ? P.limits.sats : 32);
  const file = $derived(satellites.file);
  // SAT-23: the satellite shown on the map: picked in the map's menu or by a click on its row in either table; to
  // start, the radio's first, else the list's first
  let shown = $state(0);
  const choices = $derived.by(() => {
    const seen = new Set<number>();
    const out: SatRow[] = [];
    for (const s of [...(satellites.held ?? []), ...(file?.sats ?? [])]) if (!seen.has(s.id) && seen.add(s.id)) out.push(s);
    return out;
  });
  const onMap = $derived(
    choices.find((s) => s.id === shown) ?? satellites.held?.[0] ?? file?.sats[0] ?? null,
  );
  // SAT-23: passes over the Near me place, else over this computer (decision 398)
  let mine = $state<{ lat: number; lon: number } | null>(null);
  let locNote = $state("");
  $effect(() => {
    if (!library.place && !mine && !locNote && canLocate)
      here().then(
        (p) => (mine = p),
        (e) => (locNote = (e as Error).message),
      );
  });
  const place = $derived(library.place ?? mine);
  const placeNote = $derived(!place && canLocate && !locNote ? "Finding where you are…" : locNote);
  // each satellite's next pass (the tables' column), again each minute
  const next = $derived.by(() => {
    const m = new Map<number, SatPass | null>();
    if (!coreUp || !place || !choices.length) return m;
    const t = Math.floor(now);
    satNextPasses(choices.map((c) => c.record), t, place).forEach((p, i) => m.set(choices[i].id, p));
    return m;
  });
  const passCell = (id: number) => (next.has(id) ? passShort(next.get(id) ?? null, Math.floor(now)) : "–");
  // the orbit data's age, in words (the TLE epoch): passes drift as it ages
  const age = (s: SatRow) => {
    const d = ageDays(s.epoch, now);
    return d === 0 ? "today" : d === 1 ? "1 day" : `${d} days`;
  };
  const retryPlace = () => {
    locNote = "";
  };
  const show = (id: number) => {
    shown = id;
    document.querySelector('[aria-label="On the map"]')?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const mhz = (hz: number) => (hz / 1e6).toFixed(3);
  const tpText = (t: SatTp) =>
    `${t.kind} ↓${mhz(t.down)}${t.up ? ` ↑${mhz(t.up)}` : " (receive only)"}${t.tone ? ` tone ${t.tone}` : ""}${t.arm ? ` (arm ${t.arm})` : ""}`;
  const ageTag = (s: SatRow) => ["green", "amber", "red"][ageLevel(s.id, s.epoch, now)];
  const date = (t: number) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never");
</script>

<div class="pg">
  <div class="pg-bar" role="toolbar" aria-label="Satellites">
    <div class="grp">
      <button class="btn" disabled={!supported || busy} onclick={() => satellites.readRadio().catch(() => {})} title="Read the radio's satellites">Read from radio</button>
      <button
        class="btn primary"
        disabled={!supported || busy || !file || !satellites.toWrite.length}
        onclick={() => satellites.write()}
        title="Write the satellite list to the radio, with its clock and the magnetic declination at its position">Write to radio</button
      >
    </div>
    <div class="grp">
      <button class="btn quiet" disabled={satellites.loadingFile} onclick={() => satellites.loadFile(true)} title="Fetch the satellite list again">Reload list</button>
    </div>
    <div class="grp">
      <label class="check" title="On each connect, a radio holding satellites gets fresh elements when the list is newer (at most once a day)">
        <input type="checkbox" checked={satellites.auto} onchange={(e) => (satellites.auto = e.currentTarget.checked)} />
        Keep satellites up to date
      </label>
      <label class="check" title="On each connect, the radio's clock is set from this computer (a radio loses its clock when switched off), unless it already has GPS time">
        <input type="checkbox" checked={satellites.setClock} onchange={(e) => (satellites.setClock = e.currentTarget.checked)} />
        Set the radio's clock on connect
      </label>
    </div>
  </div>

  <div class="pg-status" aria-live="polite" data-status>
    {#if satellites.busy}
      <span>{satellites.busy}…</span>
    {:else if satellites.loadingFile}
      <span>Loading the satellite list…</span>
    {:else if file}
      <span
        >List of {file.built_text}{satellites.fileKept ? " (the copy kept on this computer: the server couldn't be reached)" : ""}: {file.sats.length} satellites an FM handheld can work{file.sats.length > max ? ` · the first ${max} go to the radio (active first)` : ", all of them go to the radio"}.</span
      >
    {/if}
  </div>

  <div class="pg-status" data-k="pass-place">
    {#if place}
      <span>Passes over {library.place ? "the Near me place" : "this computer's location"} ({place.lat.toFixed(2)}, {place.lon.toFixed(2)}).</span>
    {:else if placeNote && placeNote !== "Finding where you are…"}
      <span>No passes: {placeNote}</span>
      {#if canLocate}<button class="btn quiet" onclick={retryPlace}>Try again</button>{/if}
    {:else if canLocate}
      <span>Finding where you are, for the passes…</span>
    {:else}
      <span>No passes: set a place in Channels › Add channels › Near me.</span>
    {/if}
  </div>
  {#if satellites.fileError}<div class="pg-banner">{satellites.fileError}</div>{/if}
  {#if satellites.error}<div class="pg-banner">{satellites.error}</div>{/if}
  {#if satellites.notice}<div class="pg-banner ok" aria-live="polite">{satellites.notice}</div>{/if}

  <section aria-label="On the radio">
    <h2>On the radio</h2>
    {#if !connected}
      <p class="sub">Connect a radio to see its satellites and write them.</p>
    {:else if satellites.held}
      <p class="sub small" data-radio-info>
        {satellites.held.length} of {max} satellites · declination {declText(satellites.info?.decl ?? null)} · list of {satellites.info?.stamp
          ? new Date(satellites.info.stamp * 1000).toISOString().slice(0, 10)
          : "unknown"} · written {date(satellites.info?.written ?? 0)} · radio clock {satellites.clock?.now ? `${date(satellites.clock.now)} (${satellites.clock.source === "GPS" ? "GPS" : "set"})` : "not set"}
      </p>
      {#if satellites.held.length}
        <div class="pg-scroll short">
          <table class="tbl" aria-label="Satellites on the radio">
            <thead><tr><th>#</th><th>Name</th><th>Next pass</th><th>NORAD</th><th title="How old its orbit data is: passes drift as it ages">Data age</th><th>Transponders</th></tr></thead>
            <tbody>
              {#each satellites.held as s, i (s.id)}
                <tr class="pickable" class:shown={onMap?.id === s.id} title="Show on the map" onclick={() => show(s.id)}>
                  <td class="num">{i + 1}</td>
                  <td class="nm">{s.short}</td>
                  <td class="nowrap pass" class:up={next.get(s.id)?.aos !== undefined && next.get(s.id)!.aos <= now}>{passCell(s.id)}</td>
                  <td class="num">{s.id}</td>
                  <td class="nowrap"><span class={`tag ${ageTag(s)}`} title="Orbit data from {date(s.epoch)}">{age(s)}</span></td>
                  <td>{s.tps.map(tpText).join(" · ")}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="sub">The radio holds no satellites yet: pick them below and write.</p>
      {/if}
    {/if}
  </section>

  {#if onMap && coreUp}
    <section aria-label="On the map">
      <h2>On the map</h2>
      <SatMap sat={onMap} {choices} onpick={(id) => (shown = id)} {place} {placeNote} />
    </section>
  {/if}

  <section aria-label="Satellite list">
    <h2>Satellite list</h2>
    {#if file}
      <div class="pg-scroll">
        <table class="tbl" aria-label="Satellites to write">
          <thead><tr><th>Name</th><th>Next pass</th><th>NORAD</th><th>Status</th><th title="How old its orbit data is: passes drift as it ages">Data age</th><th>Transponders</th></tr></thead>
          <tbody>
            {#each file.sats as s (s.id)}
              <tr class="pickable" class:shown={onMap?.id === s.id} title="Show on the map" onclick={() => show(s.id)}>
                <td><span class="nm">{s.short}</span>{#if s.name !== s.short}<span class="full sub small">{s.name}</span>{/if}</td>
                <td class="nowrap pass" class:up={next.get(s.id)?.aos !== undefined && next.get(s.id)!.aos <= now}>{passCell(s.id)}</td>
                <td class="num">{s.id}</td>
                <td>{s.status}</td>
                <td class="nowrap"><span class={`tag ${ageTag(s)}`} title="Orbit data from {date(s.epoch)}: amber past 7 days (3 for the ISS), red past 30">{age(s)}</span></td>
                <td>{s.tps.map(tpText).join(" · ")}{#if s.dropped}<span class="sub small"> (+{s.dropped} the radio can't use)</span>{/if}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="sub small">
        Only 2 m and 70 cm FM and APRS transponders are listed: the radio works nothing else. Data age: how old each satellite's orbit data is (amber past 7 days, 3 for the ISS; red past 30): its passes drift as it ages, and Reload list fetches fresh data.
        Writing replaces the radio's whole list; it keeps each satellite's own settings (trim, FD/HD, transponder, power) by its NORAD number.
      </p>
      <p class="dim small">{file.attribution} {file.licence}.</p>
    {:else if !satellites.fileError}
      <p class="sub">Loading…</p>
    {/if}
  </section>
</div>

<style>
  h2 {
    font-size: 15px;
    margin: 4px 0 8px;
  }
  .small {
    font-size: 12px;
  }
  .check {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    font-size: 13px;
    cursor: pointer;
  }
  .pg-scroll.short {
    max-height: 320px;
  }
  .nm {
    white-space: nowrap;
  }
  td.pass.up {
    color: var(--green);
  }
  tr.pickable {
    cursor: pointer;
  }
  tr.pickable:hover td {
    background: var(--raised);
  }
  tr.shown td {
    box-shadow: inset 0 -1px 0 var(--blue);
  }
  tr.shown .nm {
    color: var(--blue);
  }
  .full {
    display: block;
  }
  .pg-banner.ok {
    border-color: var(--green);
    color: var(--text);
  }
</style>
