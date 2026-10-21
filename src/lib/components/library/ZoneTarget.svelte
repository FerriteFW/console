<script lang="ts" module>
  /** Where added channels go: one zone per group (airport, TAFL name), a new zone, an existing one, or none. */
  export type Target = { kind: "each" | "new" | "existing" | "none"; name: string; existing: number };
  /** The zone's name for a channel of `group`, by the target. */
  export function zoneName(t: Target, group: string, zones: { name: string }[]): string {
    if (t.kind === "each") return group;
    if (t.kind === "new") return t.name.trim() || group;
    if (t.kind === "existing") return zones[t.existing]?.name ?? "";
    return "";
  }
</script>

<script lang="ts">
  import { channels } from "../../channels.svelte";

  let { value = $bindable(), each = "" }: { value: Target; each?: string } = $props();
  const zones = $derived(channels.table.zones);
  const full = $derived(zones.length >= 254);
</script>

<fieldset class="zt">
  <legend class="label">Into zone</legend>
  {#if each}
    <label><input type="radio" bind:group={value.kind} value="each" disabled={full} /> {each}</label>
  {/if}
  <label class="row">
    <input type="radio" bind:group={value.kind} value="new" disabled={full} /> New zone
    <input class="zname" maxlength="16" bind:value={value.name} disabled={value.kind !== "new"} aria-label="New zone name" />
  </label>
  <label class="row">
    <input type="radio" bind:group={value.kind} value="existing" disabled={!zones.length} /> Existing
    <select bind:value={value.existing} disabled={value.kind !== "existing"} aria-label="Existing zone">
      {#each zones as z, i (z.number)}<option value={i}>{z.number} {z.name}</option>{/each}
    </select>
  </label>
  <label><input type="radio" bind:group={value.kind} value="none" /> No zone</label>
</fieldset>

<style>
  .zt {
    border: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
    align-items: center;
    font-size: 13px;
  }
  legend {
    float: left;
    margin-right: 6px;
  }
  label {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  .zname,
  select {
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 3px 6px;
  }
  .zname {
    width: 150px;
  }
  .zname:disabled,
  select:disabled {
    opacity: 0.45;
  }
</style>
