<script lang="ts">
  // Radio Settings › DTMF memories (DTMF-12, LINK-56): the sixteen sequences the dialer keeps, each with a name of up
  // to 10. Symbols 0-9, A-D, * and # (lower case taken as capitals), 1 to 16; checked as the radio's editor checks
  // them (ferrite's own link session says why not). Beside the settings: the dialer's speed and delays are there
  // (MENU 0 8 5), and the radio keeps the memories with them.
  import ListPage from "../components/ListPage.svelte";
  import ListDetail from "../components/ListDetail.svelte";
  import { dtmf } from "../lists.svelte";
  import { loadCore, type DtmfMemory } from "../core";

  // Rows show the core's checks and words: drawn once it has loaded (a reload straight to this tab).
  let coreUp = $state(false);
  void loadCore().then(() => (coreUp = true));

  type Row = { i: number; m: DtmfMemory | null };
  const rows = $derived<Row[]>(dtmf.items.map((m, i) => ({ i, m })));
  const changed = $derived(new Set(dtmf.changes.map((c) => Number(c.label.replace("Memory ", "")) - 1)));
  let picked = $state<string | null>(null);
  let notice = $state<{ text: string; undo: boolean } | null>(null);
  const problem = (r: Row) => (r.m ? dtmf.problem(r.m) : undefined);
  const used = $derived(rows.filter((r) => r.m).length);

  function clear(r: Row) {
    dtmf.clear(r.i);
    notice = { text: `Cleared memory ${r.i + 1}${r.m?.name ? ` "${r.m.name}"` : ""}.`, undo: true };
  }
</script>

<ListPage store={dtmf} label="DTMF memories" bind:notice>
  {#if coreUp}
  <ListDetail
    title="DTMF memories"
    count={`${used}/16`}
    items={rows}
    id={(r) => String(r.i)}
    bind:picked
    detailLabel={(r) => `Memory ${r.i + 1}`}
    rowClass={(r) => (changed.has(r.i) ? (dtmf.base?.[r.i] ? "changed" : "added") : "")}
    empty="Read the radio to see its DTMF memories, or open a file."
    pick="Choose a memory."
  >
    {#snippet row(r)}
      <span class="num">{r.i + 1}</span>
      <span class="nm">{r.m ? r.m.name || "(no name)" : ""}{#if !r.m}<span class="free">empty</span>{/if}</span>
      {#if problem(r)}<span class="warn" title={problem(r)}>!</span>{/if}
      <span class="side mono">{r.m?.symbols ?? ""}</span>
    {/snippet}
    {#snippet header(r)}
      <button class="btn danger" disabled={!r.m} aria-label={`Clear memory ${r.i + 1}`} title="Clear the symbols and the name (undoable)" onclick={() => clear(r)}
        >Clear</button
      >
    {/snippet}
    {#snippet detail(r)}
      {#if problem(r)}<p class="problem" role="alert">{problem(r)}</p>{/if}
      {#key r.i}
        <div class="form">
          <label>
            <span>Symbols</span>
            <input
              class="mono"
              value={r.m?.symbols ?? ""}
              maxlength="16"
              autocomplete="off"
              spellcheck="false"
              placeholder="e.g. *79#"
              onchange={(e) => dtmf.edit(r.i, { symbols: e.currentTarget.value })}
              aria-label="DTMF symbols"
            />
          </label>
          <label>
            <span>Name</span>
            <input value={r.m?.name ?? ""} maxlength="10" placeholder="e.g. Link on" onchange={(e) => dtmf.edit(r.i, { name: e.currentTarget.value })} aria-label="Memory name" />
          </label>
        </div>
      {/key}
      <p class="sub small">Symbols: 1 to 16 of 0–9, A–D, * and # (lower case becomes capitals). Name: up to 10 characters. Clearing the symbols clears the name too.</p>
      <p class="sub small">On the radio: the DTMF dialer's memories (Tools › DTMF). Its speed and delays are settings: MENU 0 8 5.</p>
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
  .form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 10px;
    margin-top: 12px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  label > span {
    color: var(--sub);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  input {
    height: 32px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
    min-width: 0;
  }
  .mono {
    font-family: "JetBrains Mono", monospace;
  }
  .free {
    color: var(--dim);
  }
  .small {
    font-size: 12px;
    margin: 6px 0 0;
  }
  .btn.danger {
    color: var(--red);
  }
  .btn.danger:hover:not(:disabled) {
    border-color: var(--red);
  }
</style>
