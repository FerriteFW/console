<script lang="ts">
  // The desktop app's port and radio picker (picker.svelte.ts): inside the welcome (`inline`) when Cable or Bluetooth
  // was pressed there, else its own modal, drawn at the app's top level so nothing can cover it.
  import { picker } from "../picker.svelte";
  import { radio } from "../radio.svelte";

  let { inline = false }: { inline?: boolean } = $props();

  const title = $derived(picker.kind === "bluetooth" ? "Pick a radio" : "Pick the cable's port");
  const empty = $derived(
    picker.kind === "bluetooth"
      ? "Looking for radios… Turn the radio's Bluetooth on. Each radio shows by its ID (all are called walkie-talkie)."
      : "No serial ports. Plug the cable in, then Refresh.",
  );

  // Disconnect pressed while the picker is open: close it. Only on the change to idle: Install opens the picker with
  // Console idle (openForUpdate), and closing it then cancelled every Connect cable… at once (0.8.0, desktop app).
  let was = radio.phase;
  $effect(() => {
    const now = radio.phase;
    if (now === "idle" && was !== "idle" && picker.kind) picker.close();
    was = now;
  });

  function onkey(e: KeyboardEvent) {
    if (e.key === "Escape" && picker.kind) picker.close();
  }
</script>

<svelte:window onkeydown={onkey} />

{#snippet body()}
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
{/snippet}

{#if picker.kind}
  {#if inline}
    <div class="pick inline" role="group" aria-label={title}>{@render body()}</div>
  {:else}
    <div class="overlay">
      <div class="pick" role="dialog" aria-modal="true" aria-label={title}>{@render body()}</div>
    </div>
  {/if}
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 70;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 16px;
    background: rgb(0 0 0 / 0.6);
  }
  .pick {
    width: min(440px, 100%);
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  .pick.inline {
    width: auto;
    padding: 0;
    border: 0;
    background: none;
    box-shadow: none;
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
