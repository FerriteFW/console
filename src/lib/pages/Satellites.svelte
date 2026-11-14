<script lang="ts">
  // Satellites (manual chapter 28a; SAT-2, SAT-9, SAT-13, SAT-15, SAT-18, SAT-21): the satellites an FM handheld can
  // work, from data.ferritefw.dev (CelesTrak's elements, SatNOGS DB's transponders), picked up to 32, and what the
  // radio holds. Write puts the picks on the radio with its clock and the magnetic declination at its position.
  import { satellites, ageDays, ageLevel, declText } from "../satellites.svelte";
  import { radio } from "../radio.svelte";
  import { loadCore, P, type SatRow, type SatTp } from "../core";
  import SatMap from "../components/SatMap.svelte";

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
  const picked = $derived(new Set(satellites.picks));
  // SAT-23: the satellite shown on the map (a row's name clicked; the first picked, else the first, to start)
  let shown = $state(0);
  const onMap = $derived(file?.sats.find((s) => s.id === shown) ?? file?.sats.find((s) => picked.has(s.id)) ?? file?.sats[0] ?? null);

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
        disabled={!supported || busy || !file || !satellites.picks.length}
        onclick={() => satellites.write()}
        title="Write the picked satellites to the radio, with its clock and the magnetic declination at its position">Write to radio</button
      >
    </div>
    <div class="grp">
      <span class="label">Pick</span>
      <button class="btn quiet" disabled={!file} onclick={() => satellites.pickAll(true)}>Active</button>
      <button class="btn quiet" disabled={!file} onclick={() => satellites.pickAll(false)}>None</button>
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
        >List of {file.built_text}{satellites.fileKept ? " (the copy kept on this computer: the server couldn't be reached)" : ""}: {file.sats.length} satellites an FM handheld can work · {satellites.picks
          .length} of {max} picked.</span
      >
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
            <thead><tr><th>#</th><th>Name</th><th>NORAD</th><th>Elements</th><th>Transponders</th></tr></thead>
            <tbody>
              {#each satellites.held as s, i (s.id)}
                <tr>
                  <td class="num">{i + 1}</td>
                  <td class="nm">{s.short}</td>
                  <td class="num">{s.id}</td>
                  <td class="nowrap"><span class={`tag ${ageTag(s)}`}>{ageDays(s.epoch, now)} d</span></td>
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
      <SatMap sat={onMap} />
    </section>
  {/if}

  <section aria-label="Satellite list">
    <h2>Satellite list</h2>
    {#if file}
      <div class="pg-scroll">
        <table class="tbl" aria-label="Satellites to write">
          <thead><tr><th></th><th>Name</th><th>NORAD</th><th>Status</th><th>Elements</th><th>Transponders</th></tr></thead>
          <tbody>
            {#each file.sats as s (s.id)}
              <tr class:off={!picked.has(s.id)}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Pick ${s.short}`}
                    checked={picked.has(s.id)}
                    disabled={!picked.has(s.id) && satellites.picks.length >= max}
                    onchange={() => satellites.toggle(s.id)}
                  />
                </td>
                <td><button class="link nm" class:on={onMap?.id === s.id} title="Show on the map" onclick={() => (shown = s.id)}>{s.short}</button>{#if s.name !== s.short}<span class="full sub small">{s.name}</span>{/if}</td>
                <td class="num">{s.id}</td>
                <td>{s.status}</td>
                <td class="nowrap"><span class={`tag ${ageTag(s)}`} title="The elements' age: amber past 7 days (3 for the ISS), red past 30">{ageDays(s.epoch, now)} d</span></td>
                <td>{s.tps.map(tpText).join(" · ")}{#if s.dropped}<span class="sub small"> (+{s.dropped} the radio can't use)</span>{/if}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="sub small">
        Only 2 m and 70 cm FM and APRS transponders are listed: the radio works nothing else. Elements age: amber past 7 days (3 for the ISS), red past 30.
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
  button.nm {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    text-align: left;
  }
  button.nm:hover,
  button.nm.on {
    color: var(--blue);
    text-decoration: underline;
  }
  .full {
    display: block;
  }
  tr.off td {
    color: var(--sub);
  }
  .pg-banner.ok {
    border-color: var(--green);
    color: var(--text);
  }
</style>
