// The browser-side outside edges of the stack e2e: Google's Cast sender and TMDB.

/**
 * Google's Cast sender, with one receiver on the network (as `cast-one-tap.spec.mjs` stubs it). The receiver keeps
 * every LOAD on `window.loads` and every session end on `window.calls` (`stop` or `leave`), and plays a load on, a
 * quarter second at a time, as the real one reports. With `refuse`, it refuses every LOAD.
 */
export const castSdk = ({ refuse = false } = {}) => `
  window.loads = [];
  window.calls = [];
  window.chrome = window.chrome || {};
  window.chrome.cast = {
    AutoJoinPolicy: { PAGE_SCOPED: 'page_scoped' },
    media: {
      DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845',
      HlsSegmentFormat: { FMP4: 'fmp4', TS: 'ts' },
      HlsVideoSegmentFormat: { FMP4: 'fmp4', MPEG2_TS: 'mpeg2_ts' },
      MetadataType: { GENERIC: 0 },
      StreamType: { BUFFERED: 'BUFFERED' },
      TrackType: { TEXT: 'TEXT' },
      TextTrackType: { SUBTITLES: 'SUBTITLES' },
      GenericMediaMetadata: function () {},
      MediaInfo: function (url, contentType) { this.contentId = url; this.contentType = contentType; },
      Track: function (id, type) { this.trackId = id; this.type = type; },
      LoadRequest: function (media) { this.media = media; },
      EditTracksInfoRequest: function (ids) { this.activeTrackIds = ids; },
    },
  };
  const listeners = {};
  const fire = (type, event) => (listeners[type] || []).forEach((fn) => fn(event));
  let state = 'NO_DEVICES_AVAILABLE';
  let session = null;
  let loaded = false;
  const setState = (next) => { state = next; fire('caststatechanged', { castState: next }); };
  const player = { currentTime: 0, duration: 30, isPaused: true, isConnected: false, volumeLevel: 1, isMuted: false, playerState: 'IDLE' };
  const changes = [];
  setInterval(() => {
    if (!session || !loaded) return;
    if (!player.isPaused) player.currentTime = Math.min(player.duration, player.currentTime + 0.25);
    player.playerState = player.isPaused ? 'PAUSED' : 'PLAYING';
    changes.forEach((fn) => fn());
  }, 250);
  const context = {
    setOptions() { setTimeout(() => setState('NOT_CONNECTED'), 50); },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    getCurrentSession() { return session; },
    getCastState() { return state; },
    endCurrentSession(stop) {
      window.calls.push(stop ? 'stop' : 'leave');
      session = null; loaded = false; player.isConnected = false;
      fire('sessionstatechanged', { sessionState: 'SESSION_ENDED' });
      setState('NOT_CONNECTED');
    },
    requestSession() {
      if (!navigator.userActivation.isActive) return Promise.reject('no user activation');
      setState('CONNECTING');
      return new Promise((resolve) => setTimeout(() => {
        session = {
          loadMedia(request) {
            window.loads.push({ url: request.media.contentId, currentTime: request.currentTime });
            if (${refuse}) return Promise.reject('load_failed');
            loaded = true;
            player.currentTime = request.currentTime || 0;
            player.isPaused = false;
            return Promise.resolve();
          },
          getMediaSession() { return loaded ? { idleReason: null, media: { tracks: [] }, editTracksInfo() {} } : null; },
          getCastDevice() { return { friendlyName: 'Living Room TV' }; },
        };
        player.isConnected = true;
        setState('CONNECTED');
        fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
        resolve();
      }, 200));
    },
  };
  window.cast = { framework: {
    CastContext: { getInstance: () => context },
    CastContextEventType: { SESSION_STATE_CHANGED: 'sessionstatechanged', CAST_STATE_CHANGED: 'caststatechanged' },
    RemotePlayer: function () { return player; },
    RemotePlayerController: function () {
      this.addEventListener = (_type, fn) => changes.push(fn);
      this.seek = () => {};
      this.playOrPause = () => { player.isPaused = !player.isPaused; };
      this.setVolumeLevel = () => {};
      this.muteOrUnmute = () => { player.isMuted = !player.isMuted; };
    },
    RemotePlayerEventType: { ANY_CHANGE: 'anyChanged' },
  } };
  const announce = setInterval(() => {
    if (!window.__onGCastApiAvailable) return;
    clearInterval(announce);
    window.__onGCastApiAvailable(true);
  }, 10);
`;

/** TMDB's answer for `url`: a film, or a one-season series of three episodes, named by its id. */
export function tmdb(url) {
  const path = new URL(url).pathname;
  const [, type, id, , season] = path.match(/\/3\/(movie|tv)\/(\d+)(\/season\/(\d+))?/) ?? [];
  const base = {
    overview: 'A title, for the detail page to show.',
    poster_path: '/poster.jpg',
    backdrop_path: '/backdrop.jpg',
    original_language: 'en',
    vote_average: 7.5,
    vote_count: 500,
    genres: [{ id: 18, name: 'Drama' }],
    credits: { cast: [], crew: [] },
    recommendations: { results: [] },
  };
  if (path.endsWith('/external_ids')) return { imdb_id: `tt000${id}` };
  if (type === 'tv' && season)
    return {
      id: Number(season),
      season_number: Number(season),
      episodes: [1, 2, 3].map((n) => ({
        id: Number(id) * 100 + Number(season) * 10 + n,
        season_number: Number(season),
        episode_number: n,
        name: `Episode ${n}`,
        air_date: '2020-01-01',
        runtime: 1,
      })),
    };
  if (type === 'tv')
    return {
      ...base,
      id: Number(id),
      name: `Series ${id}`,
      first_air_date: '2020-01-01',
      number_of_seasons: 1,
      seasons: [{ season_number: 1, episode_count: 3, air_date: '2020-01-01' }],
      last_episode_to_air: { season_number: 1, episode_number: 3, air_date: '2020-01-15' },
      external_ids: { imdb_id: `tt000${id}` },
    };
  if (type === 'movie')
    return {
      ...base,
      id: Number(id),
      title: `Movie ${id}`,
      release_date: '2026-01-01',
      runtime: 1,
      imdb_id: `tt000${id}`,
      external_ids: { imdb_id: `tt000${id}` },
    };
  return { page: 1, total_pages: 1, results: [] };
}
