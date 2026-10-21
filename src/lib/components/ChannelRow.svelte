<script lang="ts">
  // One channel in the table, edited in place. Each change goes through the core (normalised as the radio would
  // hold it, then ferrite's own checks for the problem marker); a field that doesn't parse stays as typed, marked.
  import { checkChannel, normalizeChannel, type Channel, type Choices, type Zone } from "../core";
  import { channels } from "../channels.svelte";

  let {
    c,
    zones,
    choices,
    state: rowState,
  }: { c: Channel; zones: Zone[]; choices: Choices; state: "same" | "changed" | "added" } = $props();

  const problem = $derived(checkChannel(c, zones.length));
  let numberNote = $state("");

  function set<K extends keyof Channel>(k: K, v: Channel[K]) {
    const next = { ...$state.snapshot(c), [k]: v } as Channel;
    let out = next;
    try {
      out = normalizeChannel(next);
    } catch {
      /* kept as typed: the marker says what is wrong */
    }
    channels.setChannel(c.number, out);
  }
  const text = (k: keyof Channel) => (e: Event) => set(k, (e.currentTarget as HTMLInputElement).value as never);
  const flag = (k: keyof Channel) => (e: Event) => set(k, (e.currentTarget as HTMLInputElement).checked as never);
  function renumber(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    numberNote = channels.renumber(c.number, Number(el.value));
    if (numberNote) el.value = String(c.number);
  }
</script>

<tr class={rowState} class:bad={!!problem} data-n={c.number}>
  <td class="num sticky">
    <input class="n" value={c.number} onchange={renumber} aria-label="Number" title={numberNote || "Channel number (1-1000)"} />
  </td>
  <td class="sticky2"><input class="name" value={c.name} maxlength="16" onchange={text("name")} aria-label="Name" /></td>
  <td><input class="freq" value={c.rx} onchange={text("rx")} aria-label="RX MHz" /></td>
  <td>
    <select value={c.duplex} onchange={text("duplex")} aria-label="Duplex">
      {#each choices.duplex as d (d)}<option value={d}>{d || "none"}</option>{/each}
    </select>
  </td>
  <td><input class="freq" value={c.offset} disabled={!c.duplex} onchange={text("offset")} aria-label="Offset or TX MHz" placeholder="–" /></td>
  <td>
    <select value={c.mode} onchange={text("mode")} aria-label="Mode">
      {#each choices.modes as m (m)}<option>{m}</option>{/each}
    </select>
  </td>
  <td><input class="tone" list="tone-words" value={c.tx_tone} onchange={text("tx_tone")} aria-label="TX tone" /></td>
  <td><input class="tone" list="tone-words" value={c.rx_tone} onchange={text("rx_tone")} aria-label="RX tone" /></td>
  <td>
    <select value={c.power} onchange={text("power")} aria-label="Power">
      {#each choices.powers as p (p)}<option>{p}</option>{/each}
    </select>
  </td>
  <td>
    <select value={c.step} onchange={text("step")} aria-label="Step">
      {#each choices.steps as s (s)}<option>{s}</option>{/each}
    </select>
  </td>
  <td>
    <select value={c.squelch} onchange={text("squelch")} aria-label="Squelch">
      {#each choices.squelch as s (s)}<option>{s}</option>{/each}
    </select>
  </td>
  <td>
    <select
      value={c.zone === null ? "" : String(c.zone)}
      onchange={(e) => set("zone", (e.currentTarget.value === "" ? null : Number(e.currentTarget.value)) as never)}
      aria-label="Zone"
    >
      <option value="">none</option>
      {#each zones as z (z.number)}<option value={String(z.number - 1)}>{z.number} {z.name}</option>{/each}
      {#if c.zone !== null && c.zone >= zones.length}<option value={String(c.zone)}>{c.zone + 1} (missing)</option>{/if}
    </select>
  </td>
  <td class="ck"><input type="checkbox" checked={c.skip} onchange={flag("skip")} aria-label="Scan skip" /></td>
  <td class="ck"><input type="checkbox" checked={c.priority} onchange={flag("priority")} aria-label="Priority" /></td>
  <td class="ck"><input type="checkbox" checked={c.aprs} onchange={flag("aprs")} aria-label="APRS" /></td>
  <td class="ck"><input type="checkbox" checked={c.rx_only} onchange={flag("rx_only")} aria-label="RX only" /></td>
  <td class="ck"><input type="checkbox" checked={c.hidden} onchange={flag("hidden")} aria-label="Hidden" /></td>
  <td class="ck"><input type="checkbox" checked={c.busy} onchange={flag("busy")} aria-label="Busy lockout" /></td>
  <td class="ck"><input type="checkbox" checked={c.reverse} onchange={flag("reverse")} aria-label="Reverse" /></td>
  <td>
    <select value={c.end_tone} onchange={text("end_tone")} aria-label="End tone">
      {#each choices.endTones as t (t)}<option>{t}</option>{/each}
    </select>
  </td>
  <td>
    <select value={c.tail} onchange={text("tail")} aria-label="Tail elimination">
      {#each choices.tails as t (t)}<option>{t}</option>{/each}
    </select>
  </td>
  <td class="act">
    {#if problem}<span class="warn" title={problem} aria-label={`Problem: ${problem}`}>!</span>{/if}
    <button class="del" title="Delete this channel" aria-label={`Delete channel ${c.number}`} onclick={() => channels.deleteChannel(c.number)}>✕</button>
  </td>
</tr>
{#if problem}
  <tr class="problem-row"><td colspan="22"><span class="sticky-note">Channel {c.number}: {problem}</span></td></tr>
{/if}
