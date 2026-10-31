<script lang="ts">
  // APRS › Quick messages (TEXT-7, LINK-54): the nine texts compose offers on the radio, each the owner's own or the
  // factory one. Edited here, checked as compose checks a message (MSG_SEND's rules: up to 67 printable characters,
  // no | ~ {; ferrite's own link session says why not), written with Write. Its own tab beside Messages: Messages is
  // the radio's conversations, live; these are settings the radio keeps, read and written as a list.
  import ListPage from "../components/ListPage.svelte";
  import ListDetail from "../components/ListDetail.svelte";
  import { quick } from "../lists.svelte";
  import { loadCore, type QuickMessage } from "../core";

  // Rows show the core's checks and words: drawn once it has loaded (a reload straight to this tab).
  let coreUp = $state(false);
  void loadCore().then(() => (coreUp = true));

  type Row = QuickMessage & { i: number };
  const rows = $derived<Row[]>(quick.items.map((q, i) => ({ ...q, i })));
  const changed = $derived(new Set(quick.changes.map((c) => Number(c.label.replace("Quick ", "")) - 1)));
  let picked = $state<string | null>(null);
  let notice = $state<{ text: string; undo: boolean } | null>(null);

  const MAX = 67;
  const text = (r: Row) => quick.shown(r, r.i);
  const problem = (r: Row) => quick.problem({ own: r.own, text: r.text });
</script>

<ListPage store={quick} label="Quick messages" bind:notice>
  {#if coreUp}
  <ListDetail
    title="Quick messages"
    count={rows.length ? `${rows.filter((r) => r.own).length} your own` : ""}
    items={rows}
    id={(r) => String(r.i)}
    bind:picked
    detailLabel={(r) => `Quick message ${r.i + 1}`}
    rowClass={(r) => (changed.has(r.i) ? "changed" : "")}
    empty="Read the radio to see its quick messages, or open a file."
    pick="Choose a quick message."
  >
    {#snippet row(r)}
      <span class="num">{r.i + 1}</span>
      <span class="nm">{text(r) || "(empty)"}</span>
      {#if problem(r)}<span class="warn" title={problem(r)}>!</span>{/if}
      <span class="side">{r.own ? "yours" : "factory"}</span>
    {/snippet}
    {#snippet detail(r)}
      {#if problem(r)}<p class="problem" role="alert">{problem(r)}</p>{/if}
      <label class="field">
        <span>Text</span>
        <textarea
          rows="3"
          maxlength={MAX + 10}
          value={text(r)}
          onchange={(e) => quick.setText(r.i, e.currentTarget.value)}
          aria-label="Quick message text"
          spellcheck="true"></textarea>
      </label>
      <p class="sub small">
        {text(r).length}/{MAX} characters. Sent as typed in an APRS message: printable characters, none of | ~ {"{"} (APRS keeps them for itself).
      </p>
      <div class="row">
        {#if r.own}
          <span class="tag blue">Your own text</span>
          <button class="btn" onclick={() => ((notice = { text: `Quick message ${r.i + 1} back to the factory text.`, undo: true }), quick.factoryText(r.i))}
            >Back to the factory text</button
          >
        {:else}
          <span class="tag">The factory text</span>
          <span class="sub small">Edit it to make it yours; the radio keeps the factory one to go back to.</span>
        {/if}
      </div>
      {#if r.own && quick.factory[r.i]}<p class="sub small">Factory: “{quick.factory[r.i]}”</p>{/if}
      <p class="sub small">On the radio: compose a message, then the quick list (TEXT-7) puts one of these in.</p>
    {/snippet}
  </ListDetail>
  {/if}
</ListPage>

<style>
  .problem {
    margin: 10px 0 0;
    padding: 6px 10px;
    border: 1px solid var(--red);
    border-radius: 6px;
    color: var(--red);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 12px;
  }
  .field > span {
    color: var(--sub);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  textarea {
    padding: 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font: 13px/1.4 "JetBrains Mono", monospace;
    resize: vertical;
  }
  .small {
    font-size: 12px;
    margin: 6px 0 0;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    align-items: center;
    margin-top: 12px;
  }
</style>
