<script lang="ts">
  // Fixed sets (NeonPlug's): pick a set, pick its channels, add them into a zone.
  import { library, type FixedSet } from "../../library.svelte";
  import { channels } from "../../channels.svelte";
  import { libraryFixedItems } from "../../core";
  import ZoneTarget, { zoneName, type Target } from "./ZoneTarget.svelte";

  let { onadded }: { onadded: () => void } = $props();

  library.loadFixed();
  let setName = $state("");
  let picked = $state<Set<number>>(new Set());
  let target = $state<Target>({ kind: "new", name: "", existing: 0 });

  const sets = $derived(library.fixed ?? []);
  const set = $derived<FixedSet | undefined>(sets.find((s) => s.name === setName));
  const mhz = (f: number) => f.toFixed(4).replace(/0{1,2}$/, "");

  function choose(s: FixedSet) {
    setName = s.name;
    picked = new Set(s.frequencies.map((_, i) => i));
    target = { ...target, kind: target.kind === "each" ? "new" : target.kind, name: (s.displayName ?? s.name).slice(0, 16) };
  }
  $effect(() => {
    if (!setName && sets.length) choose(sets[0]);
  });

  function toggle(i: number) {
    const n = new Set(picked);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    picked = n;
  }

  function add() {
    if (!set) return;
    const zone = zoneName(target, set.name, channels.table.zones);
    const items = libraryFixedItems($state.snapshot(set), [...picked].sort((a, b) => a - b), zone);
    library.add(items, set.displayName ?? set.name);
    onadded();
  }
</script>

{#if !library.fixed}
  <p class="sub">Loading the sets…</p>
{:else}
  <div class="cols">
    <ul class="sets" role="listbox" aria-label="Channel sets">
      {#each sets as s (s.name)}
        <li>
          <button role="option" aria-selected={s.name === setName} class:on={s.name === setName} onclick={() => choose(s)}>
            <b>{s.displayName ?? s.name}</b>
            <span class="count">{s.frequencies.length}</span>
            <span class="desc">{s.description}</span>
          </button>
        </li>
      {/each}
    </ul>
    {#if set}
      <div class="chans">
        <div class="head">
          <span>{picked.size} of {set.frequencies.length} channels · {set.defaultBandwidth.startsWith("12.5") ? "NFM" : "FM"}, {set.defaultPower} power{set.rxOnly ? ", RX only" : ""}</span>
          <span class="spacer"></span>
          <button class="btn quiet sm" onclick={() => (picked = new Set(set.frequencies.map((_, i) => i)))}>All</button>
          <button class="btn quiet sm" onclick={() => (picked = new Set())}>None</button>
        </div>
        <div class="list">
          {#each set.frequencies as f, i (i)}
            <label class="ch" class:off={!picked.has(i)}>
              <input type="checkbox" checked={picked.has(i)} onchange={() => toggle(i)} />
              <span class="nm">{f.name}</span>
              <span class="f">{mhz(f.rx)}</span>
              <span class="tx">{f.tx !== f.rx ? `TX ${mhz(f.tx)}` : ""}</span>
              <span class="nt">{f.notes ?? ""}</span>
            </label>
          {/each}
        </div>
      </div>
    {/if}
  </div>
  <div class="foot">
    <ZoneTarget bind:value={target} />
    <span class="spacer"></span>
    <button class="btn primary" disabled={!picked.size} onclick={add}>Add {picked.size} {picked.size === 1 ? "channel" : "channels"}</button>
  </div>
{/if}

<style>
  .cols {
    display: grid;
    grid-template-columns: minmax(220px, 300px) 1fr;
    gap: 14px;
    min-height: 0;
    flex: 1;
  }
  .sets {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sets button {
    width: 100%;
    text-align: left;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 10px;
    cursor: pointer;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2px 8px;
  }
  .sets button.on {
    border-color: var(--blue);
    background: var(--focus);
  }
  .count {
    color: var(--sub);
    font-size: 12px;
  }
  .desc {
    grid-column: 1 / -1;
    color: var(--sub);
    font-size: 11px;
    line-height: 1.35;
  }
  .chans {
    display: flex;
    flex-direction: column;
    min-height: 0;
    gap: 6px;
  }
  .head {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
    color: var(--sub);
  }
  .sm {
    padding: 3px 10px;
    font-size: 12px;
  }
  .list {
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 4px;
  }
  .ch {
    display: grid;
    grid-template-columns: auto minmax(110px, 160px) 90px 110px 1fr;
    gap: 10px;
    align-items: center;
    padding: 3px 6px;
    border-radius: 5px;
    font-size: 13px;
    cursor: pointer;
  }
  .ch:hover {
    background: var(--raised);
  }
  .ch.off {
    color: var(--dim);
  }
  .f {
    font-variant-numeric: tabular-nums;
  }
  .tx,
  .nt {
    color: var(--sub);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
  .spacer {
    flex: 1;
  }
  .sub {
    color: var(--sub);
  }
  @media (max-width: 760px) {
    .cols {
      grid-template-columns: 1fr;
    }
    .ch {
      grid-template-columns: auto 1fr auto;
    }
    .tx,
    .nt {
      display: none;
    }
  }
</style>
