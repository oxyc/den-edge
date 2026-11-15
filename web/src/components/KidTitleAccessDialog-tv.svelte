<script lang="ts">
  // TV builds expose the exact-title supported-browser handoff in Detail. Keep this prop-compatible replacement
  // intentionally empty so the Browser PIN writer and its recovery copy cannot enter any TV package.
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
