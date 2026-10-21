<script lang="ts">
  import logo from "@ferrite/assets/logo/ferrite-logo.svg?url";
  let { size = 30 }: { size?: number } = $props();
</script>

<div class="wm">
  <img src={logo} alt="" width={size} height={size} />
  <div>
    <div class="name" style:font-size={`${size * 0.8}px`}>Ferrite</div>
    <div class="sub">Console</div>
  </div>
</div>

<style>
  .wm {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .name {
    font-family: "Barlow Semi Condensed", sans-serif;
    font-weight: 600;
    line-height: 1;
    letter-spacing: 0.01em;
  }
  .sub {
    color: var(--sub);
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
</style>
