<script lang="ts">
  let { title, text }: { title: string; text: string } = $props();
</script>

<div class="card soon">
  <h1>{title}</h1>
  <p>{text}</p>
  <p class="sub">Not in this version yet.</p>
</div>

<style>
  .soon {
    max-width: 560px;
  }
  h1 {
    margin: 0 0 8px;
    font-size: 18px;
  }
  p {
    margin: 0 0 6px;
  }
  .sub {
    color: var(--sub);
  }
</style>
