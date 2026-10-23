/** Tizen 3 always selects Reel's progressive MP4 and never bundles or initializes hls.js. */
export function loadHls(): Promise<typeof import('hls.js')> {
  return Promise.reject(new Error('hls.js is unavailable on Tizen 3'));
}

export function warmHls(): void {}
