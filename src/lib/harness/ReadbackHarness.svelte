<script lang="ts">
  // LINK-19.4 (decision 289): the Live View screen alone, for the completeness test (tests/e2e/liveview-complete):
  // `?readback-harness` mounts this instead of the app; `window.__readback(text)` draws one readback and resolves
  // once it is on screen. Nothing else of Console loads.
  import { tick } from "svelte";
  import ReadbackScreen from "../components/ReadbackScreen.svelte";
  import { loadCore, parseUi, type Ui } from "../core";

  let ui = $state<Ui | null>(null);
  (window as unknown as { __readback: (t: string) => Promise<void> }).__readback = async (text: string) => {
    await loadCore();
    ui = parseUi(text);
    await tick();
  };
</script>

{#if ui}<ReadbackScreen {ui} />{/if}
