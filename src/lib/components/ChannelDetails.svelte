<script lang="ts">
  // The side panel: every field of one channel, edited through the same core checks as the table's row (normalised
  // as the radio would hold it; a value that doesn't parse stays as typed and the problem shows here).
  import { checkChannel, parsePosition, positionView, type Channel, type Choices, type Zone } from "../core";
  import { channels } from "../channels.svelte";

  let {
    c,
    zones,
    choices,
    onclose,
    ondelete,
    onmoved,
  }: { c: Channel; zones: Zone[]; choices: Choices; onclose: () => void; ondelete: () => void; onmoved: (to: number) => void } = $props();

  const problem = $derived(checkChannel(c, zones.length));
  let numberNote = $state("");

  const set = <K extends keyof Channel>(k: K, v: Channel[K]) => channels.edit(c.number, k, v);
  const text = (k: keyof Channel) => (e: Event) => set(k, (e.currentTarget as HTMLInputElement).value as never);
  const flag = (k: keyof Channel) => (e: Event) => set(k, (e.currentTarget as HTMLInputElement).checked as never);

  // CHAN-2, LINK-53: the position as degrees to five decimals and its grid square; typed as degrees or a grid
  // square (the core parses both, with ferrite's own grid code). One that doesn't parse stays as typed, with why.
  const where = $derived(positionView(c.pos));
  let posNote = $state("");
  function setPos(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    try {
      const p = parsePosition(el.value);
      posNote = "";
      set("pos", p.pos ?? undefined);
      el.value = p.text; // as stored, even when the position didn't change
    } catch (err) {
      posNote = (err as Error).message;
    }
  }
  function clearPos() {
    posNote = "";
    set("pos", undefined);
  }

  function renumber(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const from = c.number;
    numberNote = channels.renumber(from, Number(el.value));
    if (numberNote) el.value = String(from);
    else onmoved(Number(el.value));
  }

  const flags: { k: keyof Channel; label: string; hint: string }[] = [
    { k: "skip", label: "Scan skip", hint: "Left out of scans" },
    { k: "priority", label: "Priority", hint: "Checked often while scanning" },
    { k: "aprs", label: "APRS", hint: "APRS packets on this channel" },
    { k: "rx_only", label: "RX only", hint: "Never transmits" },
    { k: "hidden", label: "Hidden", hint: "Not shown on the radio" },
    { k: "busy", label: "Busy lockout", hint: "No transmit while the channel is busy" },
    { k: "reverse", label: "Reverse", hint: "RX and TX swapped" },
  ];
</script>

<aside class="details" aria-label={`Channel ${c.number}`}>
  <header>
    <h2>Channel {c.number}</h2>
    <button class="x" onclick={onclose} aria-label="Close the channel panel" title="Close (Esc)">✕</button>
  </header>
  {#if problem}<p class="problem" role="alert">{problem}</p>{/if}

  <div class="fields">
    <label>
      <span>Number</span>
      <input value={c.number} onchange={renumber} aria-label="Channel number" inputmode="numeric" />
      {#if numberNote}<small class="err">{numberNote}</small>{/if}
    </label>
    <label>
      <span>Name</span>
      <input value={c.name} maxlength="16" onchange={text("name")} aria-label="Channel name" />
    </label>
    <label>
      <span>RX MHz</span>
      <input class="mono" value={c.rx} onchange={text("rx")} aria-label="Channel RX MHz" />
    </label>
    <div class="two">
      <label>
        <span>Duplex</span>
        <select value={c.duplex} onchange={text("duplex")} aria-label="Channel duplex">
          {#each choices.duplex as d (d)}<option value={d}>{d || "none"}</option>{/each}
        </select>
      </label>
      <label>
        <span>{c.duplex === "split" ? "TX MHz" : "Offset MHz"}</span>
        <input class="mono" value={c.offset} disabled={!c.duplex} onchange={text("offset")} aria-label="Channel offset or TX MHz" placeholder="–" />
      </label>
    </div>
    <div class="two">
      <label>
        <span>TX tone</span>
        <input list="tone-words" value={c.tx_tone} onchange={text("tx_tone")} aria-label="Channel TX tone" />
      </label>
      <label>
        <span>RX tone</span>
        <input list="tone-words" value={c.rx_tone} onchange={text("rx_tone")} aria-label="Channel RX tone" />
      </label>
    </div>
    <div class="two">
      <label>
        <span>Mode</span>
        <select value={c.mode} onchange={text("mode")} aria-label="Channel mode">
          {#each choices.modes as m (m)}<option>{m}</option>{/each}
        </select>
      </label>
      <label>
        <span>Power</span>
        <select value={c.power} onchange={text("power")} aria-label="Channel power">
          {#each choices.powers as p (p)}<option>{p}</option>{/each}
        </select>
      </label>
    </div>
    <div class="two">
      <label>
        <span>Step</span>
        <select value={c.step} onchange={text("step")} aria-label="Channel step">
          {#each choices.steps as s (s)}<option>{s}</option>{/each}
        </select>
      </label>
      <label>
        <span>Squelch</span>
        <select value={c.squelch} onchange={text("squelch")} aria-label="Channel squelch">
          {#each choices.squelch as s (s)}<option>{s}</option>{/each}
        </select>
      </label>
    </div>
    <label>
      <span>Zone</span>
      <select
        value={c.zone === null ? "" : String(c.zone)}
        onchange={(e) => set("zone", e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}
        aria-label="Channel zone"
      >
        <option value="">none</option>
        {#each zones as z (z.number)}<option value={String(z.number - 1)}>{z.number} {z.name}</option>{/each}
        {#if c.zone !== null && c.zone >= zones.length}<option value={String(c.zone)}>{c.zone + 1} (missing)</option>{/if}
      </select>
    </label>
    {#key c.number}
      <div class="pos">
        <label>
          <span>Position</span>
          <span class="row">
            <input
              class="mono"
              value={where.text}
              onchange={setPos}
              aria-label="Channel position"
              aria-invalid={!!posNote}
              placeholder="lat, lon or grid square"
              title="Degrees, north and east positive (45.4215, -75.6972), or a grid square (FN25dk)"
            />
            <button class="btn sm" onclick={clearPos} disabled={!c.pos} aria-label="Clear the position">Clear</button>
          </span>
        </label>
        {#if posNote}
          <small class="err" role="alert">{posNote}</small>
        {:else if c.pos}
          <small class="sub" data-testid="position-grid">📍 Grid square {where.grid}</small>
        {:else}
          <small class="sub">None: for Nearby and distance on the radio</small>
        {/if}
      </div>
    {/key}
    <div class="two">
      <label>
        <span>End tone</span>
        <select value={c.end_tone} onchange={text("end_tone")} aria-label="Channel end tone">
          {#each choices.endTones as t (t)}<option>{t}</option>{/each}
        </select>
      </label>
      <label>
        <span>Tail elimination</span>
        <select value={c.tail} onchange={text("tail")} aria-label="Channel tail elimination">
          {#each choices.tails as t (t)}<option>{t}</option>{/each}
        </select>
      </label>
    </div>
    <fieldset>
      <legend>Options</legend>
      {#each flags as f (f.k)}
        <label class="flag" title={f.hint}>
          <input type="checkbox" checked={c[f.k] as boolean} onchange={flag(f.k)} />
          <span>{f.label}</span>
        </label>
      {/each}
    </fieldset>
  </div>

  <footer>
    <button class="btn danger" onclick={ondelete}>Delete channel</button>
  </footer>
</aside>

<style>
  .details {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    font-size: 13px;
    min-width: 0;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h2 {
    margin: 0;
    font-size: 15px;
    flex: 1;
  }
  .x {
    background: none;
    border: none;
    color: var(--sub);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
  }
  .x:hover {
    background: var(--raised);
    color: var(--text);
  }
  .problem {
    margin: 0;
    padding: 6px 10px;
    border: 1px solid var(--red);
    border-radius: 6px;
    color: var(--red);
  }
  .fields {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  label > span,
  legend {
    color: var(--sub);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  input:not([type="checkbox"]),
  select {
    height: 32px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
    min-width: 0;
  }
  input:disabled {
    opacity: 0.45;
  }
  .mono {
    font-family: "JetBrains Mono", monospace;
  }
  .err {
    color: var(--red);
  }
  .sub {
    color: var(--sub);
  }
  .pos {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  /* A span in the label (phrasing content), so not the label's caption style. */
  .pos .row {
    display: flex;
    gap: 6px;
    color: var(--text);
    font-size: 13px;
    letter-spacing: 0;
    text-transform: none;
  }
  .pos .row input {
    flex: 1;
  }
  .pos .btn {
    height: 32px;
  }
  fieldset {
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 8px 10px;
    margin: 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 10px;
  }
  label.flag {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }
  label.flag span {
    color: var(--text);
    font-size: 13px;
    text-transform: none;
    letter-spacing: 0;
  }
  footer {
    display: flex;
    justify-content: flex-end;
  }
  .btn.danger {
    color: var(--red);
  }
  .btn.danger:hover {
    border-color: var(--red);
  }
</style>
