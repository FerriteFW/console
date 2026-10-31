<script lang="ts" generics="T">
  // A list on the left and the chosen item on the right (Range presets' and Zones' layout), for the owner's lists:
  // quick messages, waypoints, DTMF memories. On a narrow window one at a time, with a way back.
  import type { Snippet } from "svelte";

  let {
    title,
    count,
    items,
    id,
    picked = $bindable(null),
    row,
    detail,
    detailLabel,
    add,
    addTitle = "",
    addDisabled = false,
    empty,
    pick = "Choose one.",
    rowClass,
    header,
  }: {
    title: string;
    /** "3/256" beside the title. */
    count?: string;
    items: T[];
    id: (x: T) => string;
    picked?: string | null;
    row: Snippet<[T]>;
    detail: Snippet<[T]>;
    /** The detail's region name and heading. */
    detailLabel: (x: T) => string;
    add?: () => void;
    addTitle?: string;
    addDisabled?: boolean;
    empty: string;
    pick?: string;
    /** Classes for a row: "changed", "added", "bad". */
    rowClass?: (x: T) => string;
    /** The detail header's own buttons (Delete). */
    header?: Snippet<[T]>;
  } = $props();

  const p = $derived(picked === null ? null : (items.find((x) => id(x) === picked) ?? null));

  function narrow() {
    return typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches;
  }
  $effect(() => {
    if (picked !== null && !items.some((x) => id(x) === picked)) picked = null;
    if (picked === null && items.length && !narrow()) picked = id(items[0]);
  });
</script>

<div class="lwork" class:picked={!!p}>
  <section class="list" aria-label={title}>
    <header>
      <h2>{title}</h2>
      {#if count}<span class="sub">{count}</span>{/if}
      {#if add}<button class="btn small-btn" disabled={addDisabled} onclick={add} title={addTitle}>+ Add</button>{/if}
    </header>
    <ul class="items" role="listbox" aria-label={title}>
      {#each items as x (id(x))}
        <li>
          <button role="option" aria-selected={picked === id(x)} class="{rowClass?.(x) ?? ''}" class:on={picked === id(x)} onclick={() => (picked = id(x))}>
            {@render row(x)}
          </button>
        </li>
      {:else}
        <li class="empty">{empty}</li>
      {/each}
    </ul>
  </section>

  <section class="detail" aria-label={p ? detailLabel(p) : title}>
    {#if p}
      <header>
        <button class="btn quiet back" onclick={() => (picked = null)} aria-label={`Back to the ${title.toLowerCase()}`}>← {title}</button>
        <h2>{detailLabel(p)}</h2>
        {@render header?.(p)}
      </header>
      <div class="body">{@render detail(p)}</div>
    {:else}
      <p class="empty pick">{items.length ? pick : empty}</p>
    {/if}
  </section>
</div>

<style>
  .lwork {
    display: grid;
    grid-template-columns: 320px minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    min-width: 0;
  }
  section {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    min-width: 0;
    font-size: 13px;
  }
  .list {
    display: flex;
    flex-direction: column;
    position: sticky;
    top: 64px;
    max-height: calc(100vh - 80px);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
  }
  h2 {
    margin: 0;
    font-size: 15px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    color: var(--sub);
  }
  .items {
    list-style: none;
    margin: 0;
    padding: 6px;
    overflow: auto;
    min-height: 0;
  }
  .items button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 8px;
    border: none;
    border-left: 3px solid transparent;
    border-radius: 6px;
    background: none;
    text-align: left;
    cursor: pointer;
    min-width: 0;
  }
  .items button:hover {
    background: var(--raised);
  }
  .items button.on {
    background: var(--focus);
    border-left-color: var(--blue);
  }
  .items button.changed :global(.num) {
    color: var(--amber);
  }
  .items button.added :global(.num) {
    color: var(--green);
  }
  .items :global(.num) {
    color: var(--sub);
    min-width: 1.8em;
    font-variant-numeric: tabular-nums;
  }
  .items :global(.nm) {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .items :global(.side) {
    color: var(--sub);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .items :global(.warn) {
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--red);
    color: var(--bg);
    font-weight: 700;
    font-size: 12px;
    flex: none;
  }
  .empty {
    color: var(--sub);
    padding: 12px;
    list-style: none;
  }
  .pick {
    padding: 36px 16px;
    text-align: center;
    margin: 0;
  }
  .detail {
    padding-bottom: 14px;
    container-type: inline-size;
  }
  .body {
    padding: 0 12px;
  }
  .back {
    display: none;
  }
  .small-btn {
    padding: 3px 10px;
    font-size: 12px;
  }
  @media (max-width: 860px) {
    .lwork {
      grid-template-columns: minmax(0, 1fr);
    }
    .list {
      position: static;
      max-height: none;
    }
    .lwork.picked .list {
      display: none;
    }
    .lwork:not(.picked) .detail {
      display: none;
    }
    .back {
      display: inline-flex;
      padding: 4px 8px;
    }
  }
</style>
