<script lang="ts">
  // The settings as the radio's menu lists them: an index of the groups beside one column of even rows, each row
  // its menu number, name and control (a choice, a level, typed text, or read only). Radio Settings and APRS
  // settings both show their records with it; the values and choices are the core's.
  import type { SettingItem } from "../core";

  type Group = { path: string; name: string; items: SettingItem[]; note: string };
  let {
    groups,
    dirty,
    refused,
    busy,
    change,
  }: { groups: Group[]; dirty: Set<string>; refused: Record<string, string>; busy: boolean; change: (id: string, value: string) => void } = $props();

  function jump(path: string) {
    document.getElementById(`g-${path}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const changedIn = (g: { items: SettingItem[] }) => g.items.filter((i) => dirty.has(i.id)).length;
  const label = (i: SettingItem) => (i.path ? `${i.path} ${i.name}` : i.name);
  const options = (i: SettingItem) => (i.choices.includes(i.value) ? i.choices : [i.value, ...i.choices]);
  const at = (i: SettingItem) => i.choices.indexOf(i.value);
  function step(i: SettingItem, d: number) {
    const k = at(i) + d;
    if (k >= 0 && k < i.choices.length) change(i.id, i.choices[k]);
  }
</script>

<div class="layout">
  <nav class="index" aria-label="Setting groups">
    {#each groups as g (g.path)}
      <button class="ix" onclick={() => jump(g.path)}>
        <span class="num">{g.path.startsWith("0") ? g.path : ""}</span>
        <span class="ixname">{g.name}</span>
        {#if changedIn(g)}<span class="badge" title="Changed, not written">{changedIn(g)}</span>{/if}
      </button>
    {/each}
  </nav>
  <div class="groups">
    {#each groups as g (g.path)}
      <section class="group" id={`g-${g.path}`} aria-label={g.name}>
        <h2><span class="num">{g.path.startsWith("0") ? g.path : ""}</span>{g.name}</h2>
        {#if g.items.length}
          <div class="rows">
            {#each g.items as i, k (i.id)}
              {#if i.sub && i.sub !== g.items[k - 1]?.sub}
                <h3><span class="num">{i.path.split(" ").slice(0, 3).join(" ")}</span>{i.sub}</h3>
              {/if}
              <div class="row" class:changed={dirty.has(i.id)} class:in-sub={!!i.sub} data-id={i.id} title={i.help}>
                <span class="num">{i.path}</span>
                <span class="name">
                  {i.name}
                  {#if i.changed}<span class="dot" title="Not the default">•</span>{/if}
                </span>
                <span class="ctl">
                  {#if i.kind === "pick"}
                    <select aria-label={label(i)} value={i.value} disabled={busy} onchange={(e) => change(i.id, e.currentTarget.value)}>
                      {#each options(i) as c (c)}<option value={c}>{c}</option>{/each}
                    </select>
                  {:else if i.kind === "level"}
                    <span class="stepper" role="group" aria-label={label(i)}>
                      <button aria-label={`${label(i)} down`} disabled={busy || at(i) <= 0} onclick={() => step(i, -1)}>−</button>
                      <span class="lv" aria-label={`${label(i)} value`}>{i.value}</span>
                      <button aria-label={`${label(i)} up`} disabled={busy || at(i) < 0 || at(i) >= i.choices.length - 1} onclick={() => step(i, 1)}>+</button>
                    </span>
                  {:else if i.kind === "text"}
                    <input
                      aria-label={label(i)}
                      value={i.value}
                      placeholder={i.hint}
                      title={i.hint}
                      disabled={busy}
                      onchange={(e) => change(i.id, e.currentTarget.value)}
                    />
                  {:else}
                    <span class="ro" aria-label={label(i)} title={i.note || "Changes only on the radio"}>{i.value || "–"}</span>
                  {/if}
                </span>
                {#if i.kind === "readonly" && i.note}<span class="note">{i.note}</span>{/if}
                {#if refused[i.id]}<span class="err">{refused[i.id]}</span>{/if}
              </div>
            {/each}
          </div>
        {/if}
        {#if g.note}<p class="gnote">{g.note}</p>{/if}
      </section>
    {/each}
  </div>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 220px minmax(0, 760px);
    gap: 28px;
    align-items: start;
  }
  .index {
    position: sticky;
    top: 12px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: calc(100vh - 24px);
    overflow-y: auto;
  }
  .ix {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--sub);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .ix:hover {
    background: var(--surface);
    color: var(--text);
  }
  .ix .num {
    min-width: 28px;
  }
  .ixname {
    flex: 1;
  }
  .badge {
    font-size: 11px;
    padding: 0 6px;
    border-radius: 8px;
    background: var(--amber);
    color: #1a1400;
  }
  .groups {
    display: flex;
    flex-direction: column;
    gap: 28px;
    min-width: 0;
  }
  .group {
    scroll-margin-top: 12px;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 15px;
    display: flex;
    gap: 10px;
    align-items: baseline;
  }
  h3 {
    margin: 0;
    padding: 12px 14px 4px;
    font-size: 12px;
    color: var(--sub);
    font-weight: 500;
    display: flex;
    gap: 10px;
    align-items: baseline;
  }
  .rows {
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
    overflow: hidden;
  }
  .num {
    font-family: var(--mono, ui-monospace, monospace);
    color: var(--dim);
    font-size: 11px;
    font-weight: 400;
    white-space: nowrap;
  }
  .row {
    display: grid;
    grid-template-columns: 64px 1fr 210px;
    align-items: center;
    gap: 2px 12px;
    min-height: 42px;
    padding: 5px 14px;
    border-top: 1px solid var(--line);
    border-left: 3px solid transparent;
    font-size: 13px;
  }
  .rows > .row:first-child,
  .rows > h3:first-child + .row {
    border-top: 0;
  }
  .row.changed {
    border-left-color: var(--amber);
    background: color-mix(in srgb, var(--amber) 7%, transparent);
  }
  .dot {
    color: var(--blue);
    margin-left: 2px;
  }
  .ctl {
    display: flex;
    justify-content: flex-end;
  }
  .ctl select,
  .ctl input,
  .ro,
  .stepper {
    width: 100%;
    height: 30px;
    box-sizing: border-box;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 13px;
  }
  .ctl select,
  .ctl input {
    padding: 0 8px;
  }
  .ctl select {
    appearance: none;
    padding-right: 26px;
    background-image: linear-gradient(45deg, transparent 50%, var(--sub) 50%), linear-gradient(135deg, var(--sub) 50%, transparent 50%);
    background-position: calc(100% - 14px) 50%, calc(100% - 9px) 50%;
    background-size: 5px 5px;
    background-repeat: no-repeat;
    cursor: pointer;
  }
  .ctl select:focus,
  .ctl input:focus {
    outline: 2px solid var(--blue);
    outline-offset: -1px;
  }
  .ctl select:disabled,
  .ctl input:disabled {
    opacity: 0.6;
  }
  .stepper {
    display: grid;
    grid-template-columns: 30px 1fr 30px;
    align-items: stretch;
    overflow: hidden;
  }
  .stepper button {
    border: 0;
    background: var(--raised);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .stepper button:disabled {
    color: var(--dim);
    cursor: default;
  }
  .stepper .lv {
    display: grid;
    place-items: center;
    font-variant-numeric: tabular-nums;
  }
  .ro {
    display: flex;
    align-items: center;
    padding: 0 8px;
    border-style: dashed;
    background: transparent;
    color: var(--sub);
    cursor: help;
  }
  .note {
    grid-column: 2 / -1;
    color: var(--dim);
    font-size: 11px;
    text-align: right;
  }
  .err {
    grid-column: 2 / -1;
    color: var(--red);
    font-size: 12px;
  }
  .gnote {
    margin: 6px 2px 0;
    color: var(--dim);
    font-size: 11px;
  }
  @media (max-width: 900px) {
    .layout {
      grid-template-columns: 1fr;
    }
    .index {
      display: none;
    }
  }
  @media (max-width: 520px) {
    .row {
      grid-template-columns: 1fr;
    }
    .row .num {
      display: none;
    }
  }
</style>
