(function () {
  var INBOX_KEY = 'den.inboxKey';
  var CONFIG_KEY = 'den.config';
  var searchTimer, lastQuery = '';

  function $(id) { return document.getElementById(id); }

  // Linked TVs — a phone can drive several (living room, bedroom…). Each link is { inboxKey, name },
  // and anything pushed broadcasts to all of them. Migrates the old single den.inboxKey.
  var LINKS_KEY = 'den.links';
  function links() {
    var list; try { list = JSON.parse(localStorage.getItem(LINKS_KEY)); } catch (e) { list = null; }
    if (!Array.isArray(list)) list = [];
    var legacy = localStorage.getItem(INBOX_KEY);
    if (legacy && !list.some(function (l) { return l.inboxKey === legacy; })) {
      list.push({ inboxKey: legacy, name: 'Apple TV' });
      localStorage.removeItem(INBOX_KEY);
      saveLinks(list);
    }
    return list;
  }
  function saveLinks(list) { localStorage.setItem(LINKS_KEY, JSON.stringify(list)); }
  function inboxKeys() { return links().map(function (l) { return l.inboxKey; }); }
  function isLinked() { return links().length > 0; }
  // Primary (first) TV — used for single-target reads (library download, plugin metadata) that all TVs
  // converge on anyway (iCloud TV↔TV / identical pushes). Broadcasts use inboxKeys().
  function inboxKey() { var list = links(); return list.length ? list[0].inboxKey : null; }
  function addLink(inboxKey, name) {
    var list = links();
    if (list.some(function (l) { return l.inboxKey === inboxKey; })) return;
    list.push({ inboxKey: inboxKey, name: name || ('Apple TV ' + (list.length + 1)) });
    saveLinks(list);
  }
  function removeLink(inboxKey) { saveLinks(links().filter(function (l) { return l.inboxKey !== inboxKey; })); }
  function renameLink(inboxKey, name) {
    var list = links();
    list.forEach(function (l) { if (l.inboxKey === inboxKey) l.name = name; });
    saveLinks(list);
  }

  // The config this phone authors + syncs to the TV. { tmdbKey, addons[], settings{} }.
  // 'settings' is the slot for a later release; v1 syncs tmdbKey + addons.
  function config() {
    var c;
    try { c = JSON.parse(localStorage.getItem(CONFIG_KEY)); } catch (e) { c = null; }  // corrupt -> reset
    if (typeof c !== 'object' || c === null) c = {};
    if (!c.tmdbKey) {                                       // migrate + retire the old standalone key
      var legacy = localStorage.getItem('den.tmdbKey');
      if (legacy) { c.tmdbKey = legacy; localStorage.removeItem('den.tmdbKey'); saveConfig(c); }
      else c.tmdbKey = '';
    }
    if (!Array.isArray(c.addons)) c.addons = [];
    if (typeof c.settings !== 'object' || c.settings === null) c.settings = {};
    if (typeof c.omdbKey !== 'string') c.omdbKey = '';   // OMDb ratings (optional)
    if (typeof c.dddKey !== 'string') c.dddKey = '';     // DoesTheDogDie content warnings (optional)
    return c;
  }
  function saveConfig(c) { localStorage.setItem(CONFIG_KEY, JSON.stringify(c)); }
  function tmdbKey() { return config().tmdbKey || ''; }

  var toastTimer;
  function toast(message) {
    var t = $('toast');
    t.textContent = message;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  function render() {
    var linked = isLinked();
    $('link').classList.toggle('hidden', linked);
    $('home').classList.toggle('hidden', !linked);
    if (linked) renderTVs();
  }

  function tvAction(label, onClick) {
    var a = document.createElement('a');
    a.href = '#'; a.textContent = label; a.className = 'tvaction';
    a.addEventListener('click', function (e) { e.preventDefault(); onClick(); });
    return a;
  }
  function renderTVs() {
    var el = $('tvList'); el.textContent = '';
    links().forEach(function (tv) {
      var row = document.createElement('div'); row.className = 'row';
      var meta = document.createElement('div'); meta.className = 'meta';
      var name = document.createElement('div'); name.className = 't'; name.textContent = tv.name;
      var actions = document.createElement('div'); actions.className = 'tvactions';
      actions.appendChild(tvAction('Sync', function () { syncToTVs([tv.inboxKey], tv.name); }));
      actions.appendChild(tvAction('Rename', function () {
        var n = prompt('Name this TV:', tv.name);
        if (n && n.trim()) { renameLink(tv.inboxKey, n.trim()); renderTVs(); }
      }));
      actions.appendChild(tvAction('Unlink', function () {
        if (!confirm('Unlink “' + tv.name + '”? You’ll need a fresh code from that TV to link it again.')) return;
        removeLink(tv.inboxKey); render(); toast('Unlinked ' + tv.name);
      }));
      meta.appendChild(name); meta.appendChild(actions); row.appendChild(meta);
      el.appendChild(row);
    });
  }

  // --- Linking (a phone can link several TVs; each claim ADDS one) ---
  var codeInput = $('codeInput'), linkBtn = $('linkBtn');
  var addCodeInput = $('addCodeInput'), addLinkBtn = $('addLinkBtn');
  function wireCodeInput(input, btn) {
    input.addEventListener('input', function () {
      input.value = input.value.toUpperCase();
      btn.disabled = input.value.trim().length !== 6;
    });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !btn.disabled) btn.click(); });
  }
  wireCodeInput(codeInput, linkBtn); wireCodeInput(addCodeInput, addLinkBtn);
  linkBtn.addEventListener('click', function () { claim(codeInput.value.trim(), linkBtn, codeInput, $('linkErr')); });
  addLinkBtn.addEventListener('click', function () { claim(addCodeInput.value.trim(), addLinkBtn, addCodeInput, $('addLinkErr')); });
  $('addTvBtn').addEventListener('click', function () {
    var form = $('addTvForm'); var hidden = form.classList.toggle('hidden');
    $('addTvBtn').textContent = hidden ? '+ Link another TV' : 'Cancel';
    if (!hidden) addCodeInput.focus();
  });

  function claim(code, btn, input, err) {
    btn.disabled = true; err.textContent = '';
    fetch('/link/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code })
    }).then(function (r) {
      if (r.status === 200) {
        return r.json().then(function (d) {
          addLink(d.inboxKey);              // ADD, don't overwrite — so the phone can drive several TVs
          input.value = ''; btn.disabled = true;
          $('addTvForm').classList.add('hidden'); $('addTvBtn').textContent = '+ Link another TV';
          render();
          toast(links().length === 1 ? 'Linked — you’re all set' : 'Linked — ' + links().length + ' TVs connected');
        });
      }
      err.textContent = r.status === 410 ? 'That code expired - get a fresh one on your TV.'
              : r.status === 409 ? 'That code was already used - get a fresh one on your TV.'
              : 'Could not link - check the code and try again.';
      btn.disabled = false;
    }).catch(function () {
      err.textContent = 'Network error - try again.';
      btn.disabled = false;
    });
  }

  // Prefill the code from ?code= (the TV's QR deep-links here).
  var codeParam = new URLSearchParams(location.search).get('code');
  if (codeParam) {
    codeInput.value = codeParam.toUpperCase().slice(0, 6);
    linkBtn.disabled = codeInput.value.length !== 6;
  }

  // Broadcast a message to EVERY linked TV's inbox (watchlist / TMDB key). Ok if all succeed.
  function push(message) {
    var keys = inboxKeys();
    if (!keys.length) return Promise.resolve(false);
    return Promise.all(keys.map(function (key) { return pushTo(key, message); }))
      .then(function (oks) { return oks.every(function (x) { return x; }); });
  }
  // Push to ONE specific TV (play-on-TV picks a target).
  function pushTo(key, message) {
    return fetch('/inbox/append', {
      method: 'POST',
      headers: linkHeaders(key, { 'content-type': 'application/json' }),
      body: JSON.stringify({ message: message })
    }).then(function (r) { return r.ok; });
  }

  // --- Search: BYOK, straight to TMDB (the key never touches den-edge) ---
  var searchInput = $('searchInput'), results = $('results');
  searchInput.addEventListener('input', function () {
    var q = searchInput.value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) { results.textContent = ''; lastQuery = ''; return; }
    searchTimer = setTimeout(function () { search(q); }, 280);
  });

  function search(q) {
    if (q === lastQuery) return;
    lastQuery = q;
    var key = tmdbKey();
    if (!key) {
      results.textContent = '';
      var hint = document.createElement('p');
      hint.className = 'sub';
      hint.textContent = 'Set your TMDB key below to search.';
      results.appendChild(hint);
      return;
    }
    var url = 'https://api.themoviedb.org/3/search/multi?include_adult=false&language=en-US&page=1'
            + '&query=' + encodeURIComponent(q) + '&api_key=' + encodeURIComponent(key);
    fetch(url)
      .then(function (r) { return r.ok ? r.json() : { results: [] }; })
      .then(function (d) {
        if (searchInput.value.trim() !== q) return;
        renderResults(mapTmdb(d.results || []));
      })
      .catch(function () {});
  }

  // TMDB's raw /search/multi -> the fields the companion needs (movie/tv only, drop people/adult).
  function mapTmdb(items) {
    return items.filter(function (x) {
      return (x.media_type === 'movie' || x.media_type === 'tv') && !x.adult;
    }).map(function (x) {
      var date = x.release_date || x.first_air_date || '';
      return {
        tmdbId: x.id,
        mediaType: x.media_type,
        title: x.title || x.name,
        year: date.length >= 4 ? Number(date.slice(0, 4)) : null,
        posterPath: x.poster_path || null
      };
    });
  }

  function renderResults(items) {
    results.textContent = '';
    items.slice(0, 12).forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'row';

      var img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      if (item.posterPath) img.src = 'https://image.tmdb.org/t/p/w92' + item.posterPath;
      row.appendChild(img);

      var meta = document.createElement('div');
      meta.className = 'meta';
      var title = document.createElement('div');
      title.className = 't';
      title.textContent = item.title;
      meta.appendChild(title);
      var sub = document.createElement('div');
      sub.className = 'y';
      sub.textContent = (item.mediaType === 'tv' ? 'TV' : 'Movie') + (item.year ? ' - ' + item.year : '');
      meta.appendChild(sub);
      row.appendChild(meta);

      var addBtn = document.createElement('button');
      addBtn.textContent = 'Add';
      addBtn.addEventListener('click', function () { addTitle(item, addBtn); });
      row.appendChild(addBtn);

      var playBtn = document.createElement('button');
      playBtn.textContent = 'Play on TV';
      playBtn.title = 'Play on your Apple TV (needs the Den app open)';
      playBtn.addEventListener('click', function () { playOnTv(item, playBtn); });
      row.appendChild(playBtn);

      results.appendChild(row);
    });
  }

  function addTitle(item, btn) {
    btn.disabled = true;
    btn.textContent = 'Sent';
    push({
      type: 'watchlist',
      tmdbId: item.tmdbId, mediaType: item.mediaType, title: item.title,
      posterPath: item.posterPath || undefined, year: item.year || undefined
    }).then(function (ok) {
      toast(ok ? 'Sent "' + item.title + '" to your TV' : 'Could not send - try again.');
      if (!ok) { btn.disabled = false; btn.textContent = 'Add'; }
    });
  }

  function playOnTv(item, btn) {
    var list = links();
    if (!list.length) { toast('Link a TV first.'); return; }
    var target = list[0];
    if (list.length > 1) {   // choose which TV to play on (broadcasting would start it on all of them)
      var choice = prompt('Play “' + item.title + '” on which TV?\n\n'
        + list.map(function (l, i) { return (i + 1) + '. ' + l.name; }).join('\n') + '\n\nEnter a number:', '1');
      if (choice === null) return;
      var idx = parseInt(choice, 10) - 1;
      if (!(idx >= 0 && idx < list.length)) { toast('No TV #' + choice + '.'); return; }
      target = list[idx];
    }
    btn.disabled = true;
    pushTo(target.inboxKey, { type: 'play', tmdbId: item.tmdbId, mediaType: item.mediaType, title: item.title })
      .then(function (ok) {
        toast(ok ? 'Playing “' + item.title + '” on ' + target.name + ' — make sure Den is open'
                 : 'Could not send — try again.');
        btn.disabled = false;
      });
  }

  // --- Your setup: TMDB key + a list of plugin URLs, authored here and synced to the TV ---
  var tmdbInput = $('tmdbInput'), addonInput = $('addonInput'), addonAddBtn = $('addonAddBtn'),
      addonList = $('addonList'), saveBtn = $('saveBtn'), discardBtn = $('discardBtn'), refreshBtn = $('refreshBtn');

  // Whether a key WORKS, not whether one is set. A stored key proves nothing: it can be mistyped, revoked,
  // or rate-limited, and the first you'd hear of it is an empty screen on the TV. Probed straight from the
  // phone against the real service — never via this worker, so the keys keep their promise of staying here.
  function keyStatus(el, state, unknownText) {
    var text = { checking: 'Checking\u2026', ok: 'Working', bad: 'Not accepted',
                 unknown: unknownText || "Couldn't check from here" };
    el.textContent = state ? text[state] : '';
    el.style.color = state === 'bad' ? '#e0a34e' : '';
  }

  // A probe resolves 'ok' | 'bad' | 'unknown'. 'unknown' is its own answer: a browser that can't reach a
  // service (CORS, offline) has learned nothing about the key, and saying "Not accepted" there would send
  // you off replacing a key that was fine.
  function probeTmdb(key) {
    return fetch('https://api.themoviedb.org/3/configuration?api_key=' + encodeURIComponent(key))
      .then(function (r) { return r.ok ? 'ok' : (r.status === 401 ? 'bad' : 'unknown'); })
      .catch(function () { return 'unknown'; });
  }
  function probeOmdb(key) {
    // A rejected key is a 401; a wrong-but-authorized lookup is a 200 carrying {"Response":"False"}.
    return fetch('https://www.omdbapi.com/?i=tt0111161&apikey=' + encodeURIComponent(key))
      .then(function (r) {
        if (r.status === 401) return 'bad';
        if (!r.ok) return 'unknown';
        return r.json().then(function (d) { return d && d.Response === 'True' ? 'ok' : 'bad'; });
      })
      .catch(function () { return 'unknown'; });
  }
  // doesthedogdie sends no CORS header, so a browser cannot read its answer at all — the request fails
  // before any status is visible. Rather than pretend, this field says where the key IS checked: the TV
  // verifies it at launch, and Settings there reports the result.
  function probeDdd() { return Promise.resolve('unknown'); }

  // Debounced per field so typing a key doesn't fire a request per keystroke.
  function watchKey(input, statusEl, probe, store, unknownText) {
    var timer = null, run = 0;
    function check() {
      var key = input.value.trim();
      if (!key) { keyStatus(statusEl, ''); return; }
      var mine = ++run;
      keyStatus(statusEl, 'checking');
      probe(key).then(function (state) {
        if (mine === run) keyStatus(statusEl, state, unknownText);   // ignore a slow answer for a replaced key
      });
    }
    input.addEventListener('input', function () {
      store(input.value.trim());
      clearTimeout(timer);
      timer = setTimeout(check, 600);
    });
    check();
  }

  tmdbInput.value = tmdbKey();
  tmdbInput.addEventListener('input', function () {
    lastQuery = '';                                          // let the search pick up the new key
    var q = searchInput.value.trim(); if (q.length >= 2) search(q);
  });
  watchKey(tmdbInput, $('tmdbStatus'), probeTmdb, function (v) {
    var c = config(); c.tmdbKey = v; saveConfig(c);          // the key stays live (search uses it)
  });
  // OMDb + DoesTheDogDie keys — kept on this phone, pushed to your TVs on Sync (one-way, like TMDB).
  var omdbInput = $('omdbInput'), dddInput = $('dddInput');
  omdbInput.value = config().omdbKey;
  watchKey(omdbInput, $('omdbStatus'), probeOmdb, function (v) { var c = config(); c.omdbKey = v; saveConfig(c); });
  dddInput.value = config().dddKey;
  watchKey(dddInput, $('dddStatus'), probeDdd, function (v) { var c = config(); c.dddKey = v; saveConfig(c); },
           'Checked on your TV \u2014 see Settings \u203a Content warnings');

  // The plugin list is edited as a STAGED working copy — add/remove touch workingAddons only; nothing
  // persists or syncs until "Save & sync to TV" (so a mis-tapped Remove is undoable via Discard).
  // savedAddons is what's committed to localStorage; pluginMeta holds each addon's name + what it
  // provides, from the shared /plugins list (TV-resolved) and from https probes done here.
  var savedAddons = [], workingAddons = [], pluginMeta = {};
  function loadAddons() { savedAddons = config().addons.slice(); workingAddons = savedAddons.slice(); }
  function addonsDirty() { return JSON.stringify(workingAddons) !== JSON.stringify(savedAddons); }
  function commitAddons() { var c = config(); c.addons = workingAddons.slice(); saveConfig(c); savedAddons = workingAddons.slice(); }

  // A host is LAN/local (mirrors DenKit AddonClient.isLocalHost): localhost, *.local, or an
  // RFC-1918 private range. http is fine for these — the TV reaches them on your network — but a
  // public addon must be https (plaintext/SSRF). Keeping the rule identical means the phone never
  // lets you add something the TV would then reject at runtime.
  function isLocalHost(host) {
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || /\.local$/.test(host)) return true;
    var o = host.split('.');
    if (o.length !== 4 || !o.every(function (p) { return /^\d+$/.test(p); })) return false;
    var a = +o[0], b = +o[1];
    return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  // https anywhere, or http only to a LAN/local host.
  function acceptableAddonURL(url) {
    var m; try { m = new URL(url); } catch (e) { return false; }
    if (m.protocol === 'https:') return true;
    return m.protocol === 'http:' && isLocalHost(m.hostname);
  }

  addonInput.addEventListener('input', function () {
    addonAddBtn.disabled = !acceptableAddonURL(addonInput.value.trim());
    $('addonErr').textContent = '';
  });
  addonAddBtn.addEventListener('click', function () {
    var url = addonInput.value.trim().replace(/\/+$/, '');   // normalize so a trailing slash isn't a dup
    if (!acceptableAddonURL(url)) {
      $('addonErr').textContent = 'Use https://, or http:// for a LAN address (localhost, *.local, 10/172.16–31/192.168).';
      return;
    }
    if (workingAddons.indexOf(url) === -1) workingAddons.push(url);   // staged — Save persists + syncs it
    addonInput.value = ''; addonAddBtn.disabled = true;
    renderAddons();
  });

  // Stremio resource ids → the same human labels the TV's Plugins screen shows.
  var RESOURCE_LABELS = { stream: 'Streams', catalog: 'Catalog', subtitles: 'Subtitles', meta: 'Trailers', dataset: 'Dataset' };
  function providedLabel(resources) {
    var named = (resources || []).map(function (r) {
      var id = typeof r === 'string' ? r : (r && r.name) || '';   // resources may be strings or {name,...}
      return RESOURCE_LABELS[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : '');
    }).filter(Boolean);
    return named.length ? named.join(' · ') : 'No resources';
  }

  // The addon's configure page. Addons that bake their config into the URL path
  // (http://host/<config>/manifest.json) can't be reconfigured at /<config>/configure — you rebuild
  // from scratch — so link to the origin's /configure. A plain link opens even for a LAN http addon
  // (mixed content blocks sub-resource fetches, not top-level navigations).
  function configureURL(u) {
    try { return new URL(u).origin + '/configure'; } catch (e) { return u; }
  }

  // Read a manifest from the phone — ONLY possible for an https addon that sends CORS. A LAN http addon
  // can't be fetched from an https page at all (mixed content), so we don't even try (it would just spam
  // console errors); its name + what it provides come from the TV via the shared /plugins list instead.
  function probeAddon(url) {
    return fetch(url, { headers: { accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (m) { return { name: m && m.name, resources: m && m.resources }; });
  }

  function updateEditState() {
    var dirty = addonsDirty();
    $('pluginDirty').style.display = dirty ? 'block' : 'none';
    discardBtn.style.display = dirty ? 'inline-block' : 'none';
    saveBtn.disabled = !dirty;   // Save only lights up when there are staged edits
  }

  function renderAddons() {
    addonList.textContent = '';
    workingAddons.forEach(function (url) {
      var row = document.createElement('div'); row.className = 'row';
      var label = document.createElement('div'); label.className = 'meta';
      // Name (or host until it resolves), linked to the addon's /configure page in a new tab.
      var title = document.createElement('a'); title.className = 't';
      title.href = configureURL(url); title.target = '_blank'; title.rel = 'noopener';
      var meta = pluginMeta[url] || {};
      try { title.textContent = meta.name || new URL(url).host; } catch (e) { title.textContent = url; }
      label.appendChild(title);
      // What it provides (green), when known — from the TV's resolution or an https probe.
      var provides = document.createElement('div'); provides.className = 'y ok';
      if (meta.resources) { provides.textContent = providedLabel(meta.resources); label.appendChild(provides); }
      // The URL, always — so you can see at a glance which are https vs http on your LAN.
      var urlLine = document.createElement('div'); urlLine.className = 'y'; urlLine.textContent = url;
      label.appendChild(urlLine);
      row.appendChild(label);
      var rm = document.createElement('button'); rm.textContent = 'Remove';
      rm.addEventListener('click', function () {
        workingAddons = workingAddons.filter(function (u) { return u !== url; });   // staged — Save persists
        renderAddons();
      });
      row.appendChild(rm);
      addonList.appendChild(row);

      // Fill name + provides live for https addons we still lack a name/resources for — a URL-only
      // shared entry (TV hasn't resolved it yet) still counts as unknown, so try from here. http is
      // skipped (mixed content / CORS make it impossible from a browser); the TV supplies those.
      if (!meta.name && !meta.resources && /^https:/i.test(url)) {
        probeAddon(url).then(function (info) {
          pluginMeta[url] = { name: info.name, resources: info.resources };
          if (info.name) title.textContent = info.name;
          if (info.resources) {
            provides.textContent = providedLabel(info.resources);
            if (!provides.parentNode) label.insertBefore(provides, urlLine);
          }
        }).catch(function () { /* CORS/unreachable — the TV resolves + shares it via /plugins */ });
      }
    });
    updateEditState();
  }

  // The link key travels in a header, never in a URL — URLs end up in logs, proxies and history.
  function linkHeaders(key, extra) {
    var h = { 'x-den-link': key };
    for (var name in extra || {}) h[name] = extra[name];
    return h;
  }
  // --- Shared plugin list on den-edge: the phone and the TV converge here (per the linked inboxKey) ---
  function pluginsGet() {
    var k = inboxKey(); if (!k) return Promise.resolve(null);
    return fetch('/plugins', { headers: linkHeaders(k) })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  // Push the SAVED plugin list to the given TVs (each has its own /plugins list keyed by inboxKey).
  function pluginsPut(keys) {
    if (!keys || !keys.length) return Promise.resolve(true);
    var entries = savedAddons.map(function (url) {
      var m = pluginMeta[url] || {}, e = { url: url };
      if (m.name) e.name = m.name;                 // preserve TV-resolved / probed metadata across a re-sync
      if (m.resources) e.resources = m.resources;
      return e;
    });
    return Promise.all(keys.map(function (k) {
      return fetch('/plugins', { method: 'PUT', headers: linkHeaders(k, { 'content-type': 'application/json' }),
        body: JSON.stringify({ addons: entries }) })
        .then(function (r) { return r.ok; }).catch(function () { return false; });
    })).then(function (oks) { return oks.every(function (x) { return x; }); });
  }
  // --- Shared settings blob on den-edge (/settings): the content-warnings selection, hidden genres/
  // languages, subtitle prefs, etc. A device publishes them on "Back up"; this phone relays them across
  // your devices (den-edge sees them in cleartext — same trust model as the plugin list + keys). ---
  function settingsGet(k) {
    return fetch('/settings', { headers: linkHeaders(k) })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function settingsPut(keys, settings) {
    if (!keys || !keys.length || !settings || !Object.keys(settings).length) return Promise.resolve(true);
    return Promise.all(keys.map(function (k) {
      return fetch('/settings', { method: 'PUT', headers: linkHeaders(k, { 'content-type': 'application/json' }),
        body: JSON.stringify({ settings: settings }) })
        .then(function (r) { return r.ok; }).catch(function () { return false; });
    })).then(function (oks) { return oks.every(function (x) { return x; }); });
  }
  // Adopt the newest settings any linked device published, so "Sync to TVs" relays them to the others.
  function pullSettings() {
    var keys = inboxKeys(); if (!keys.length) return Promise.resolve(false);
    return Promise.all(keys.map(settingsGet)).then(function (results) {
      var best = null;
      results.forEach(function (r) {
        if (r && r.settings && Object.keys(r.settings).length && (!best || r.version > best.version)) best = r;
      });
      if (!best) return false;
      var c = config(); c.settings = best.settings; saveConfig(c);
      return true;
    });
  }
  // Push the saved plugin list + settings + keys to the given TVs (all, or one from the "Your TVs" list).
  function syncToTVs(keys, label) {
    if (!keys.length) { toast('Link a TV first.'); return; }
    if (addonsDirty()) { toast('Save your plugin changes first (or Discard).'); return; }
    var c = config();
    var pushes = [pluginsPut(keys), settingsPut(keys, c.settings || {})];
    keys.forEach(function (k) {
      if (c.tmdbKey) pushes.push(pushTo(k, { type: 'tmdbKey', key: c.tmdbKey }));
      if (c.omdbKey) pushes.push(pushTo(k, { type: 'apiKey', service: 'omdb', key: c.omdbKey }));
      if (c.dddKey) pushes.push(pushTo(k, { type: 'apiKey', service: 'doesthedogdie', key: c.dddKey }));
    });
    $('syncMsg').textContent = '';
    Promise.all(pushes).then(function (oks) {
      var ok = oks.every(function (x) { return x; });
      toast(ok ? 'Synced to ' + label : 'Sync to ' + label + ' failed — is it on?');
    });
  }
  // Adopt the shared list (the TV's edits + resolved names). force overrides even when clean; a phone
  // with unsaved edits is left alone so a pull never clobbers what you're mid-editing.
  function pullPlugins(force) {
    return pluginsGet().then(function (data) {
      if (!data || !Array.isArray(data.addons)) return false;
      data.addons.forEach(function (e) { pluginMeta[e.url] = { name: e.name, resources: e.resources }; });
      if (force || !addonsDirty()) {
        var urls = data.addons.map(function (e) { return e.url; });
        var c = config(); c.addons = urls; saveConfig(c);
        savedAddons = urls.slice(); workingAddons = urls.slice();
      }
      renderAddons();
      return true;
    });
  }

  // Save = commit the staged edits to this phone (no network). Sync = push the saved list to the TVs.
  saveBtn.addEventListener('click', function () {
    commitAddons(); renderAddons(); toast('Saved on this phone.');
  });
  $('syncBtn').addEventListener('click', function () {
    syncToTVs(inboxKeys(), links().length > 1 ? 'all your TVs' : 'your TV');
  });
  discardBtn.addEventListener('click', function () {
    if (!confirm('Discard your unsaved plugin changes?')) return;
    workingAddons = savedAddons.slice(); renderAddons();
  });
  refreshBtn.addEventListener('click', function () {
    if (addonsDirty()) { toast('Save or discard your changes first.'); return; }
    Promise.all([pullPlugins(true), pullSettings()]).then(function (r) { toast(r[0] || r[1] ? 'Refreshed from den-edge' : 'Nothing shared yet.'); });
  });

  // --- Library backup (VX-09): encrypted at rest, key derived from the shared inboxKey so only your
  // phone + TVs can read it. The TV pushes its library to /sync/<libraryId>; here we decrypt it into a
  // downloadable file, and encrypt an uploaded file back for the TV to merge. Mirrors DenKit ConfigCrypto:
  // libraryKey = HKDF(inboxKey), libraryId = HKDF(libraryKey) — verified to match CryptoKit. ---
  var B64 = {
    enc: function (bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); },
    dec: function (str) { return Uint8Array.from(atob(str), function (c) { return c.charCodeAt(0); }); }
  };
  function libraryKeyBytes() {
    var ik = inboxKey(); if (!ik) return Promise.resolve(null);
    return crypto.subtle.importKey('raw', new TextEncoder().encode(ik), { name: 'HKDF' }, false, ['deriveBits'])
      .then(function (hk) {
        return crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('den/library/key/v1'), info: new Uint8Array() }, hk, 256);
      }).then(function (bits) { return new Uint8Array(bits); });
  }
  function libraryLocator(keyBytes) {
    return crypto.subtle.importKey('raw', keyBytes, { name: 'HKDF' }, false, ['deriveBits'])
      .then(function (hk) {
        return crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('den/library/salt/v1'), info: new TextEncoder().encode('den/library/id/v1') }, hk, 128);
      }).then(function (bits) {
        return [].map.call(new Uint8Array(bits), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      });
  }
  function libMsg(text) { $('libMsg').textContent = text; }

  $('libDownloadBtn').addEventListener('click', function () {
    libMsg('');
    libraryKeyBytes().then(function (keyBytes) {
      if (!keyBytes) { toast('Link your phone first.'); return; }
      return libraryLocator(keyBytes).then(function (id) {
        return fetch('/sync/' + id).then(function (r) {
          if (r.status === 404) { toast('No library backup yet — tap "Back up" on your TV first.'); return; }
          if (!r.ok) { toast('Couldn’t fetch the backup.'); return; }
          return r.json().then(function (blob) {
            return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt'])
              .then(function (aesKey) {
                return crypto.subtle.decrypt({ name: 'AES-GCM', iv: B64.dec(blob.nonce), tagLength: 128 }, aesKey, B64.dec(blob.ciphertext));
              }).then(function (buf) {
                var pretty = JSON.stringify(JSON.parse(new TextDecoder().decode(buf)), null, 2);
                var a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([pretty], { type: 'application/json' }));
                a.download = 'den-library-' + new Date().toISOString().slice(0, 10) + '.json';
                a.click(); URL.revokeObjectURL(a.href);
                toast('Downloaded your library backup.');
              }).catch(function () { toast('Couldn’t decrypt the backup.'); });
          });
        });
      });
    }).catch(function () { toast('Backup failed.'); });
  });

  $('libRestoreBtn').addEventListener('click', function () { $('libRestoreInput').click(); });
  $('libRestoreInput').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0]; e.target.value = '';   // allow re-picking the same file
    if (!file) return;
    libMsg('');
    libraryKeyBytes().then(function (keyBytes) {
      if (!keyBytes) { toast('Link your phone first.'); return; }
      return file.text().then(function (text) {
        var snapshot; try { snapshot = JSON.parse(text); } catch (err) { toast('That file isn’t valid JSON.'); return; }
        if (!snapshot || !Array.isArray(snapshot.records)) { toast('That doesn’t look like a Den library backup.'); return; }
        var iv = crypto.getRandomValues(new Uint8Array(12));
        return Promise.all([
          libraryLocator(keyBytes),
          crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt'])
            .then(function (aesKey) { return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, tagLength: 128 }, aesKey, new TextEncoder().encode(text)); })
        ]).then(function (res) {
          var id = res[0], ctTag = new Uint8Array(res[1]);
          return fetch('/sync/' + id).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
            .then(function (cur) {
              return fetch('/sync/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ciphertext: B64.enc(ctTag), nonce: B64.enc(iv), baseVersion: cur ? cur.version : 0 }) });
            }).then(function (put) {
              toast(put.ok ? 'Uploaded — your TV will merge it next time it’s open.' : 'Upload failed. Try again.');
            });
        });
      });
    }).catch(function () { toast('Restore failed.'); });
  });

  // Unlinking is now per-TV in the "Your TVs" list (renderTVs).

  // --- Boot ---
  render();
  loadAddons();
  renderAddons();
  if (inboxKey()) { pullPlugins(false); pullSettings(); }   // adopt the TV's shared plugins + settings on open
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js').catch(function () {});
})();
