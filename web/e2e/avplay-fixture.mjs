/** A strict workstation implementation of Samsung's documented AVPlay states and callbacks. */
export function installAvplayFixture() {
  let state = 'NONE';
  let currentTime = 0;
  let duration = 60_000;
  let listener;
  let timer;
  let delaySeeks = false;
  let seekPending = false;
  const pendingSeeks = [];
  const calls = [];
  const listeners = [];
  const record = (name, ...args) => calls.push([name, ...args]);
  const requireState = (name, valid) => {
    if (!valid.includes(state)) throw new Error(`${name} is invalid in ${state}`);
  };
  const stopClock = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const startClock = () => {
    stopClock();
    timer = setInterval(() => {
      if (state !== 'PLAYING' || !listener) return;
      currentTime = Math.min(duration, currentTime + 1000);
      listener.oncurrentplaytime(currentTime);
    }, 40);
  };
  const tracks = [
    { type: 'VIDEO', index: 1, extra_info: '{}' },
    { type: 'AUDIO', index: 11, extra_info: JSON.stringify({ language: 'en' }) },
    { type: 'AUDIO', index: 12, extra_info: JSON.stringify({ language: 'es' }) },
    // Real Samsung AVPlay metadata uses `track_lang` and commonly reports ISO 639-2 codes.
    { type: 'TEXT', index: 21, extra_info: JSON.stringify({ track_lang: 'eng' }) },
    { type: 'TEXT', index: 22, extra_info: JSON.stringify({ track_lang: 'spa' }) },
  ];
  const avplay = {
    open(url) {
      requireState('open', ['NONE', 'IDLE']);
      record('open', url);
      currentTime = 0;
      duration = 60_000;
      state = 'IDLE';
    },
    close() {
      record('close', state);
      stopClock();
      seekPending = false;
      pendingSeeks.length = 0;
      state = 'NONE';
    },
    prepareAsync(success) {
      requireState('prepareAsync', ['IDLE', 'READY']);
      record('prepareAsync');
      state = 'READY';
      queueMicrotask(() => {
        if (state === 'READY') {
          listener?.onbufferingstart();
          listener?.onbufferingprogress(25);
          listener?.onbufferingcomplete();
          success?.();
        }
      });
    },
    setDisplayRect(...rect) {
      requireState('setDisplayRect', ['IDLE', 'READY', 'PLAYING', 'PAUSED']);
      record('setDisplayRect', ...rect);
    },
    setDisplayMethod(method) {
      requireState('setDisplayMethod', ['IDLE', 'READY', 'PLAYING', 'PAUSED']);
      record('setDisplayMethod', method);
    },
    play() {
      requireState('play', ['READY', 'PLAYING', 'PAUSED']);
      record('play', state);
      state = 'PLAYING';
      startClock();
    },
    pause() {
      requireState('pause', ['PLAYING', 'PAUSED']);
      record('pause', state);
      state = 'PAUSED';
      stopClock();
    },
    stop() {
      record('stop', state);
      stopClock();
      state = 'IDLE';
    },
    seekTo(milliseconds, success, error) {
      requireState('seekTo', ['READY', 'PLAYING', 'PAUSED']);
      if (seekPending) throw new Error('overlapping AVPlay seek');
      seekPending = true;
      record('seekTo', milliseconds, state);
      const complete = () => {
        currentTime = milliseconds;
        seekPending = false;
        success?.();
      };
      if (delaySeeks) pendingSeeks.push({ complete, error });
      else queueMicrotask(complete);
    },
    getState: () => state,
    getDuration: () => duration,
    getCurrentTime: () => currentTime,
    setListener(next) {
      record('setListener');
      listener = next;
      listeners.push(next);
    },
    setSilentSubtitle(silent) {
      requireState('setSilentSubtitle', ['IDLE', 'READY', 'PLAYING', 'PAUSED']);
      record('setSilentSubtitle', silent, state);
    },
    setSelectTrack(type, index) {
      // Samsung documents HLS track changes for PLAYING and PAUSED, not READY.
      requireState('setSelectTrack', ['PLAYING', 'PAUSED']);
      record('setSelectTrack', type, index, state);
    },
    getTotalTrackInfo() {
      requireState('getTotalTrackInfo', ['READY', 'PLAYING', 'PAUSED']);
      record('getTotalTrackInfo', state);
      return tracks;
    },
  };
  Object.defineProperty(window, 'webapis', {
    configurable: true,
    value: { avplay },
  });
  window.__avplayFixture = {
    installedBeforeApp: !document.documentElement?.dataset.denTv,
    calls,
    listeners,
    state: () => state,
    current: () => currentTime,
    latest: () => listener,
    end: () => listener?.onstreamcompleted(),
    error: (message = 'PLAYER_ERROR_CONNECTION_FAILED') => listener?.onerror(message),
    delaySeeks: (delay = true) => {
      delaySeeks = delay;
    },
    pendingSeekCount: () => pendingSeeks.length,
    releaseSeek: () => pendingSeeks.shift()?.complete(),
    staleEnd: (index) => listeners[index]?.onstreamcompleted(),
    staleError: (index) => listeners[index]?.onerror('STALE_PLAYER_ERROR'),
  };
}

export const AVPLAY_FIXTURE_SCRIPT = `(${installAvplayFixture.toString()})();`;

export const installAvplayInitScript = (page) => page.addInitScript(installAvplayFixture);

export const callsNamed = (page, name) =>
  page.evaluate((wanted) => window.__avplayFixture.calls.filter(([call]) => call === wanted), name);

/** Choose the same contextual subtitle menu a Samsung remote opens; `label` is a visible track name or Off. */
export async function chooseSubtitle(page, label) {
  await page.getByRole('button', { name: /^Subtitles:/ }).click();
  await page.getByRole('menuitemradio', { name: label, exact: true }).click();
}

export async function remoteKey(page, key, keyCode) {
  return page.evaluate(
    ({ key, keyCode }) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      Object.defineProperty(event, 'keyCode', { value: keyCode });
      (document.activeElement ?? document.body).dispatchEvent(event);
      return event.defaultPrevented;
    },
    { key, keyCode },
  );
}
