<script lang="ts">
  // One channel in the table: the core columns, edited in place (every other field is in ChannelDetails, the side
  // panel). Each change goes through the core (normalised as the radio would hold it, then ferrite's own checks for
  // the problem marker); a field that doesn't parse stays as typed, marked.
  import { channelTx, checkChannel, positionView, type Channel, type Choices, type Zone } from "../core";
  import { channels } from "../channels.svelte";

  let {
    c,
    zones,
    choices,
    state: rowState,
    selected,
    active,
    onselect,
    onopen,
  }: {
    c: Channel;
    zones: Zone[];
    choices: Choices;
    state: "same" | "changed" | "added";
    selected: boolean;
    active: boolean;
    onselect: (on: boolean, range: boolean) => void;
    onopen: () => void;
  } = $props();

  const problem = $derived(checkChannel(c, zones.length));
  // CHAN-2, LINK-53: a marker for a channel with a position, the position in its title.
  const where = $derived(c.pos ? positionView(c.pos) : null);

  const set = <K extends keyof Channel>(k: K, v: Channel[K]) => channels.edit(c.number, k, v);
  /** RX and TX typed; the shift shown when TX is a repeater shift away (and typed, it sets TX). */
  const tx = $derived.by(() => {
    try {
      return channelTx(c);
    } catch {
      return { tx: "", shift: "" };
    }
  });
  let txErr = $state<string | null>(null);
  const txEdit = (how: "tx" | "shift") => (e: Event) => (txErr = channels.editTx(c.number, how, (e.currentTarget as HTMLInputElement).value));
  const text = (k: keyof Channel) => (e: Event) => set(k, (e.currentTarget as HTMLInputElement).value as never);

  // A click on the row itself (not on a field) opens the side panel.
  function rowClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest("input, select, button, label")) return;
    onopen();
  }
</script>

<tr class={rowState} class:bad={!!problem} class:sel={selected} class:active data-n={c.number} onclick={rowClick}>
  <td class="pick sticky">
    <input
      type="checkbox"
      checked={selected}
      onclick={(e) => onselect(e.currentTarget.checked, e.shiftKey)}
      aria-label={`Select channel ${c.number}`}
    />
  </td>
  <td class="num sticky2">
    <button class="open" onclick={onopen} aria-label={`Details for channel ${c.number}`} title="All of this channel's fields">{c.number}</button>
  </td>
  <td class="namecell">
    <input class="name" value={c.name} maxlength="16" onchange={text("name")} aria-label="Name" />
    {#if where}<span class="pin" role="img" title={`Position ${where.text} (${where.grid})`} aria-label={`Position ${where.text}`}>📍</span>{/if}
  </td>
  <td><input class="freq" value={c.rx} onchange={text("rx")} aria-label="RX MHz" /></td>
  <td><input class="freq" class:err={!!txErr} value={tx.tx} onchange={txEdit("tx")} aria-label="TX MHz" title={txErr ?? "TX MHz"} /></td>
  <td><input class="shift" class:err={!!txErr} value={tx.shift} onchange={txEdit("shift")} aria-label="Shift" placeholder="–" title={txErr ?? "Repeater shift: +600k, -5M; sets TX"} /></td>
  <td class="pair">
    <input class="tone" list="tone-words" value={c.tx_tone} onchange={text("tx_tone")} aria-label="TX tone" title="TX tone" />
    <input class="tone" list="tone-words" value={c.rx_tone} onchange={text("rx_tone")} aria-label="RX tone" title="RX tone" />
  </td>
  <td>
    <select value={c.power} onchange={text("power")} aria-label="Power">
      {#each choices.powers as p (p)}<option>{p}</option>{/each}
    </select>
  </td>
  <td>
    <select
      class="zone"
      value={c.zone === null ? "" : String(c.zone)}
      onchange={(e) => set("zone", e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}
      aria-label="Zone"
    >
      <option value="">none</option>
      {#each zones as z (z.number)}<option value={String(z.number - 1)}>{z.number} {z.name}</option>{/each}
      {#if c.zone !== null && c.zone >= zones.length}<option value={String(c.zone)}>{c.zone + 1} (missing)</option>{/if}
    </select>
  </td>
  <td class="ck"><input type="checkbox" checked={c.skip} onchange={(e) => set("skip", e.currentTarget.checked)} aria-label="Scan skip" /></td>
  <td class="act">
    {#if problem}<span class="warn" title={problem} aria-label={`Problem: ${problem}`}>!</span>{/if}
  </td>
</tr>
{#if problem}
  <tr class="problem-row"><td colspan="10"><span class="sticky-note">Channel {c.number}: {problem}</span></td></tr>
{/if}
