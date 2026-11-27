<script lang="ts">
  // The reduced Tizen 3 build exposes the exact-title supported-browser handoff in Detail. Keep this
  // prop-compatible replacement intentionally empty so the PIN writer and its recovery copy cannot enter it.
  let {
    request: _request,
    onconfirm: _onconfirm,
    onclose: _onclose,
  }: {
    request: unknown;
    onconfirm: unknown;
    onclose: unknown;
  } = $props();
</script>
