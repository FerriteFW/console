<script lang="ts">
  // What the radio said about itself: HELLO and INFO (firmware, build, callsign, the unique ID: LINK-35, LINK-35.1).
  import { radio } from "../radio.svelte";

  let copied = $state(false);
  async function copyId() {
    if (!radio.info?.uid_text) return;
    try {
      await navigator.clipboard.writeText(radio.info.uid_text);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      /* no clipboard */
    }
  }

  const build = $derived(radio.info?.build ?? radio.hello?.build ?? null);
  const link = $derived(
    radio.kind === "cable" && radio.baud ? `${radio.label}, ${radio.baud} baud` : radio.label,
  );
</script>

<div class="card">
  <div class="label">Radio</div>
  {#if radio.info}
    <dl>
      <dt>Firmware</dt>
      <dd>{radio.info.firmware}</dd>
      <dt>Build</dt>
      <dd>
        {build ? build.name : "not given"}{#if build?.unofficial}<span
            class="tag dry"
            title="Not an official Ferrite release (SELF-5.1)">Unofficial firmware</span
          >{/if}{#if build?.bench}<span class="tag">bench</span>{/if}{#if build?.dry}<span
            class="tag dry"
            title="Dry TX on: the PA drive held at 0 (TX-48)">dry TX</span
          >{/if}
      </dd>
      <dt>Callsign</dt>
      <dd>{radio.info.callsign || "–"}</dd>
      <dt>Unique ID</dt>
      <dd>
        {#if radio.info.uid_text}
          <button class="uid" onclick={copyId} title="Copy">{radio.info.uid_text}</button>
          {#if copied}<span class="ok">copied</span>{/if}
        {:else}
          not given
        {/if}
      </dd>
      <dt>Holds</dt>
      <dd>{radio.info.channels} channels, {radio.info.zones} zones, {radio.info.presets} presets</dd>
      <dt>Link</dt>
      <dd>{link} · protocol {radio.hello?.protocol ?? "?"}</dd>
    </dl>
  {:else}
    <p class="none">Not connected.</p>
  {/if}
</div>

<style>
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 14px;
    margin: 10px 0 0;
  }
  dt {
    color: var(--sub);
  }
  dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .uid {
    background: none;
    border: 0;
    padding: 0;
    cursor: copy;
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .uid:hover {
    color: var(--blue);
  }
  .tag {
    margin-left: 8px;
    font-size: 11px;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0 5px;
    color: var(--sub);
  }
  .tag.dry {
    color: var(--amber);
    border-color: var(--amber);
  }
  .ok {
    margin-left: 8px;
    color: var(--green);
    font-size: 12px;
  }
  .none {
    margin: 8px 0 0;
    color: var(--sub);
  }
</style>
