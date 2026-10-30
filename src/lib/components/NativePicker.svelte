<script lang="ts">
  // The desktop app's port and radio picker: a popover under the connection bar (picker.svelte.ts).
  import { picker } from "../picker.svelte";
  import { radio } from "../radio.svelte";

  const title = $derived(picker.kind === "bluetooth" ? "Pick a radio" : "Pick the cable's port");
  const empty = $derived(
    picker.kind === "bluetooth"
      ? "Looking for radios… Turn the radio's Bluetooth on. Each radio shows by its ID (all are called walkie-talkie)."
      : "No serial ports. Plug the cable in, then Refresh.",
  );

  // Disconnect pressed while the picker is open: close it.
  $effect(() => {
    if (radio.phase === "idle" && picker.kind) picker.close();
  });

  function onkey(e: KeyboardEvent) {
    if (e.key === "Escape" && picker.kind) picker.close();
  }
</script>

<svelte:window onkeydown={onkey} />

{#if picker.kind}
  <div class="pick" role="dialog" aria-label={title}>
    <div class="head">
      <strong>{title}</strong>
      {#if picker.scanning}<span class="scan">Scanning…</span>{/if}
    </div>
    {#if picker.error}<div class="err">{picker.error}</div>{/if}
    {#if picker.items.length}
      <ul>
        {#each picker.items as item (item.id)}
          <li>
            <button class="row" class:likely={item.likely} onclick={() => picker.choose(item.id)}>
              <span class="name">{item.name}</span>
              {#if item.detail}<span class="detail">{item.detail}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {:else if !picker.error}
      <p class="empty">{empty}</p>
    {/if}
    <div class="foot">
      {#if picker.kind === "cable"}<button class="btn" onclick={() => picker.refresh()}>Refresh</button>{/if}
      <button class="btn" onclick={() => picker.close()}>Cancel</button>
    </div>
  </div>
{/if}

<style>
  /* Fixed and above the welcome (ConnectModal, z-index 50): Cable or Bluetooth pressed there opens this. */
  .pick {
    position: fixed;
    top: 64px;
    right: 20px;
    z-index: 60;
    margin-top: 6px;
    width: min(420px, calc(100vw - 40px));
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 8px;
  }
  .scan,
  .empty,
  .detail {
    color: var(--sub);
  }
  .empty {
    margin: 8px 0;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 260px;
    overflow: auto;
  }
  .row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    width: 100%;
    margin-bottom: 4px;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row:hover,
  .row:focus-visible {
    border-color: var(--blue);
  }
  .row:not(.likely) {
    opacity: 0.7;
  }
  .name {
    font-weight: 600;
  }
  .detail {
    font-size: 12px;
    word-break: break-all;
  }
  .err {
    margin-bottom: 8px;
    color: var(--red);
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }
</style>
