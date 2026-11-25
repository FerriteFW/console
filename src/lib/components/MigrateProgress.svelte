<script lang="ts">
  // Finish the update's progress and outcome (migrate.svelte.ts), shown in its own dialog and inside Update Ferrite:
  // the step in words, a bar with the time left, then what moved and the notes (zones split at 256, CHAN-35).
  import { etaText } from "../eta";
  import { migrate } from "../migrate.svelte";

  const s = $derived(migrate.summary?.summary);
  const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
</script>

<div class="mig" role="region" aria-label="Finish the update">
  {#if migrate.running}
    <p class="msg" aria-live="polite">{migrate.message || "Starting…"}</p>
    {#if migrate.total}
      <progress max={migrate.total} value={migrate.done} aria-label={migrate.stage === "reading" ? "Backed up" : "Written"}></progress>
      <p class="sub">{migrate.stage === "reading" ? "Backing up" : migrate.stage === "writing" ? "Writing" : "Restarting"}: {migrate.pct}%{etaText(migrate.left)}</p>
    {/if}
    <p class="warn">Keep the cable in. If it's cut, nothing is lost: Console has the backup and starts again from it.</p>
  {/if}
  {#if migrate.savedAs}<p class="sub" data-k="saved">{migrate.savedAs}</p>{/if}
  {#if migrate.stage === "done" && s}
    <p class="ok" data-k="moved">
      Moved {plural(s.channels, "channel")}, {plural(s.zones, "zone")}, {plural(s.contacts, "contact")}, {plural(s.waypoints, "waypoint")}, {plural(s.heard, "station heard", "stations heard")},
      {plural(s.messages, "message")} and {plural(s.events, "logged event")}, with your settings.
    </p>
    {#if migrate.summary?.notes.length}
      <ul class="notes" aria-label="Notes">
        {#each migrate.summary.notes as n, i (i)}<li>{n}</li>{/each}
      </ul>
    {/if}
  {/if}
  {#if migrate.error}<div class="err" role="alert" aria-label="Finish the update error">{migrate.error}</div>{/if}
</div>

<style>
  .mig {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  p {
    margin: 0;
  }
  progress {
    width: 100%;
  }
  .sub {
    color: var(--sub);
    font-size: 13px;
  }
  .warn {
    color: var(--amber);
    font-size: 13px;
  }
  .ok {
    color: var(--text);
  }
  .notes {
    margin: 0;
    padding-left: 18px;
    color: var(--amber);
    font-size: 13px;
  }
  .err {
    padding: 10px 12px;
    border: 1px solid var(--red);
    border-radius: 8px;
    font-size: 13px;
  }
</style>
