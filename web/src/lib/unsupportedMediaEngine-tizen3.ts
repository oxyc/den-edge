// A type-compatible dead-end for code paths the Samsung AVPlay / progressive-MP4 tier cannot enter. Keeping the
// replacement at resolution time guarantees the 641 KiB hls.js implementation is absent from the package.
const Unsupported = class {} as unknown as typeof import('hls.js').default;

export default Unsupported;
