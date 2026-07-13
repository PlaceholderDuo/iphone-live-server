const path = require('path');
const fs = require('fs');
const songsApi = require('./songs');
const authApi = require('./auth');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const QUEUE_PATH = path.join(DATA_DIR, 'queue.json');

function defaultQueue() {
  return {
    main_queue: [],
    singer_queue: [],
    band_queue: [],
    current_index: -1,
    status: 'stopped',
    current_song: null,
    round: 1,
    promote_count: 0,
    banned_singers: []
  };
}

function loadQueue() {
  if (!fs.existsSync(QUEUE_PATH)) return defaultQueue();
  try {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf-8'));
  } catch {
    return defaultQueue();
  }
}

function saveQueue(q) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(q, null, 2) + '\n', 'utf-8');
}

function promoteBandSong(q) {
  if (!q.band_queue || q.band_queue.length === 0) return null;
  const bandSong = q.band_queue.shift();
  const entry = {
    slug: bandSong.slug,
    title: bandSong.title,
    artist: bandSong.artist,
    key: bandSong.key || '',
    bpm: bandSong.bpm || 0,
    singer: 'Placeholder Duo',
    band_song: true,
    timestamp: Date.now()
  };
  q.main_queue.push(entry);
  q.promote_count = 0;
  return entry;
}

function queueRoutes(app) {
  app.get('/api/queue', (req, res) => {
    const q = loadQueue();
    const MINUTES_PER_SONG = 5; // ~4 min song + 1 min transition
    const remaining = q.main_queue.length - Math.max(0, q.current_index);
    res.json({
      main_queue: q.main_queue,
      band_queue: q.band_queue || [],
      current_index: q.current_index,
      status: q.status,
      current_song: q.current_song,
      has_next: q.current_index < q.main_queue.length - 1,
      has_prev: q.current_index > 0,
      is_at_end: q.main_queue.length > 0 && q.current_index >= q.main_queue.length - 1,
      eta_minutes: Math.max(0, remaining * MINUTES_PER_SONG),
      singer_eta_minutes: (q.singer_queue || []).length * MINUTES_PER_SONG
    });
  });

  app.post('/api/queue/add', (req, res) => {
    const { slug } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const info = songsApi.getSong(slug);
    if (!info || !info.meta) return res.status(400).json({ error: 'Song not found' });
    const q = loadQueue();
    const title = info.meta.title || slug;
    const exists = q.main_queue.find(e => e.slug === slug);
    q.main_queue.push({
      slug,
      title,
      artist: info.meta.artist || 'Unknown',
      key: info.meta.key || '',
      bpm: info.meta.bpm || 0,
      timestamp: Date.now(),
      duplicate: !!exists
    });
    saveQueue(q);
    res.json({ ok: true, queue: q.main_queue, duplicate: !!exists, title });
  });

  app.post('/api/queue/add-multiple', (req, res) => {
    const { slugs } = req.body || {};
    if (!Array.isArray(slugs) || slugs.length === 0) return res.status(400).json({ error: 'slugs array required' });
    const q = loadQueue();
    const added = [];
    for (const slug of slugs) {
      const info = songsApi.getSong(slug);
      if (info && info.meta) {
        const entry = {
          slug,
          title: info.meta.title || slug,
          artist: info.meta.artist || 'Unknown',
          key: info.meta.key || '',
          bpm: info.meta.bpm || 0,
          timestamp: Date.now() + added.length
        };
        q.main_queue.push(entry);
        added.push(entry);
      }
    }
    saveQueue(q);
    res.json({ ok: true, added: added.length, queue: q.main_queue });
  });

  app.delete('/api/queue/item/:index', (req, res) => {
    const idx = parseInt(req.params.index);
    const q = loadQueue();
    if (idx < 0 || idx >= q.main_queue.length) return res.status(400).json({ error: 'Invalid index' });
    q.main_queue.splice(idx, 1);
    if (q.current_index >= q.main_queue.length) {
      q.current_index = q.main_queue.length - 1;
    }
    if (q.main_queue.length === 0) {
      q.current_index = -1;
      q.current_song = null;
      q.status = 'stopped';
    }
    saveQueue(q);
    res.json({ ok: true, queue: q.main_queue });
  });

  app.post('/api/queue/clear', (req, res) => {
    const q = loadQueue();
    q.main_queue = [];
    q.current_index = -1;
    q.current_song = null;
    q.status = 'stopped';
    saveQueue(q);
    res.json({ ok: true });
  });

  app.post('/api/queue/remove-multiple', (req, res) => {
    const { indexes } = req.body || {};
    if (!Array.isArray(indexes)) return res.status(400).json({ error: 'indexes array required' });
    const q = loadQueue();
    const sorted = [...indexes].sort((a, b) => b - a);
    for (const idx of sorted) {
      if (idx >= 0 && idx < q.main_queue.length) {
        q.main_queue.splice(idx, 1);
      }
    }
    if (q.current_index >= q.main_queue.length) {
      q.current_index = q.main_queue.length - 1;
    }
    if (q.main_queue.length === 0) {
      q.current_index = -1;
      q.current_song = null;
      q.status = 'stopped';
    }
    saveQueue(q);
    res.json({ ok: true, queue: q.main_queue });
  });

  app.post('/api/queue/load-next', (req, res) => {
    const q = loadQueue();
    if (q.main_queue.length === 0) return res.status(400).json({ error: 'Queue is empty' });
    let nextIndex;
    if (q.current_index < 0) {
      nextIndex = 0;
    } else if (q.current_index < q.main_queue.length - 1) {
      nextIndex = q.current_index + 1;
    } else {
      return res.status(400).json({ error: 'At end of queue' });
    }
    const song = q.main_queue[nextIndex];
    q.current_index = nextIndex;
    q.current_song = song;
    q.status = 'loaded';
    saveQueue(q);
    triggerLoad(song.slug);
    res.json({ ok: true, song, index: nextIndex, status: q.status });
  });

  app.post('/api/queue/load-prev', (req, res) => {
    const q = loadQueue();
    if (q.current_index <= 0) return res.status(400).json({ error: 'At beginning of queue' });
    const prevIndex = q.current_index - 1;
    const song = q.main_queue[prevIndex];
    q.current_index = prevIndex;
    q.current_song = song;
    q.status = 'loaded';
    saveQueue(q);
    triggerLoad(song.slug);
    res.json({ ok: true, song, index: prevIndex, status: q.status });
  });

  app.post('/api/queue/play', (req, res) => {
    const q = loadQueue();
    if (!q.current_song) return res.status(400).json({ error: 'No song loaded' });
    q.status = 'playing';
    saveQueue(q);
    res.json({ ok: true, song: q.current_song, status: q.status });
  });

  app.post('/api/queue/stop', (req, res) => {
    const q = loadQueue();
    q.status = 'loaded';
    saveQueue(q);
    res.json({ ok: true, status: q.status });
  });

  app.post('/api/queue/start-setlist', (req, res) => {
    const q = loadQueue();
    if (q.main_queue.length === 0) return res.status(400).json({ error: 'Queue is empty' });
    const firstSong = q.main_queue[0];
    q.current_index = 0;
    q.current_song = firstSong;
    q.status = 'loaded';
    saveQueue(q);
    triggerLoad(firstSong.slug);
    res.json({ ok: true, song: firstSong, index: 0 });
  });

  // Singer queue endpoints
  app.get('/api/singer/queue', (req, res) => {
    const q = loadQueue();
    const MINUTES_PER_SONG = 5;
    res.json({
      queue: q.singer_queue,
      round: q.round,
      promote_count: q.promote_count || 0,
      eta_minutes: q.singer_queue.length * MINUTES_PER_SONG,
      band_playing: q.current_song?.band_song || false
    });
  });

  app.get('/api/singer/status', (req, res) => {
    const cfg = authApi.loadConfig();
    res.json({
      karaoke_enabled: cfg.karaoke_enabled !== false,
      karaoke_paused_message: cfg.karaoke_paused_message || ''
    });
  });

  app.post('/api/singer/toggle', (req, res) => {
    const cfg = authApi.loadConfig();
    cfg.karaoke_enabled = cfg.karaoke_enabled === false;
    authApi.saveConfig(cfg);
    res.json({ karaoke_enabled: cfg.karaoke_enabled });
  });

  app.post('/api/singer/add', (req, res) => {
    const { singer, song_slug } = req.body || {};
    if (!singer || !singer.trim()) return res.status(400).json({ error: 'Singer name required' });
    if (!song_slug) return res.status(400).json({ error: 'Song slug required' });
    const cfg = authApi.loadConfig();
    if (cfg.karaoke_enabled === false) {
      return res.status(403).json({ error: cfg.karaoke_paused_message || 'Karaoke is paused' });
    }
    const trimmedSinger = singer.trim();
    const profanity = require('./profanity');
    if (profanity.hasProfanity(trimmedSinger)) {
      return res.status(400).json({ error: 'Please choose a different name' });
    }
    const info = songsApi.getSong(song_slug);
    if (!info || !info.meta) return res.status(400).json({ error: 'Song not found' });
    const q = loadQueue();
    if (q.banned_singers && q.banned_singers.includes(trimmedSinger)) {
      return res.status(403).json({ error: 'Thanks for singing! Have a great night!' });
    }
    const mySongs = q.singer_queue.filter(e => e.singer === trimmedSinger && e.round === q.round);
    if (mySongs.length >= 2) {
      return res.status(400).json({ error: 'You already have 2 songs in the queue' });
    }
    q.singer_queue.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      singer: trimmedSinger,
      song_slug,
      song_title: info.meta.title || song_slug,
      song_artist: info.meta.artist || 'Unknown',
      timestamp: Date.now(),
      round: q.round,
      ip: req.ip || req.socket?.remoteAddress || 'unknown'
    });
    saveQueue(q);
    const position = q.singer_queue.filter(e => e.singer === trimmedSinger && e.round === q.round).length - 1;
    res.json({ ok: true, position: q.singer_queue.length - 1 });
  });

  app.post('/api/singer/change', (req, res) => {
    const { id, song_slug } = req.body || {};
    if (!id || !song_slug) return res.status(400).json({ error: 'id and song_slug required' });
    const info = songsApi.getSong(song_slug);
    if (!info || !info.meta) return res.status(400).json({ error: 'Song not found' });
    const q = loadQueue();
    const entry = q.singer_queue.find(e => e.id === id);
    if (!entry) return res.status(400).json({ error: 'Entry not found' });
    const position = q.singer_queue.indexOf(entry);
    if (position < 3) {
      return res.status(400).json({ locked: true, error: 'Sorry, your song cannot be changed at this time. Songs are locked-in once you are 3rd in the queue.' });
    }
    entry.song_slug = song_slug;
    entry.song_title = info.meta.title || song_slug;
    entry.song_artist = info.meta.artist || 'Unknown';
    saveQueue(q);
    res.json({ ok: true, entry });
  });

  app.post('/api/singer/leave', (req, res) => {
    const { singer } = req.body || {};
    if (!singer || !singer.trim()) return res.status(400).json({ error: 'Singer name required' });
    const trimmedSinger = singer.trim();
    const q = loadQueue();
    const removed = q.singer_queue.filter(e => e.singer === trimmedSinger && e.round === q.round);
    q.singer_queue = q.singer_queue.filter(e => e.singer !== trimmedSinger || e.round !== q.round);
    saveQueue(q);
    res.json({ ok: true, removed: removed.length });
  });

  app.delete('/api/singer/queue/:id', (req, res) => {
    const q = loadQueue();
    const idx = q.singer_queue.findIndex(e => e.id === req.params.id);
    if (idx < 0) return res.status(400).json({ error: 'Entry not found' });
    q.singer_queue.splice(idx, 1);
    saveQueue(q);
    res.json({ ok: true });
  });

  app.post('/api/singer/clear-round', (req, res) => {
    const q = loadQueue();
    q.singer_queue = q.singer_queue.filter(e => e.round !== q.round);
    q.promote_count = 0;
    if (!q.band_queue) q.band_queue = [];
    let promotedBand = null;
    if (q.band_queue.length > 0) {
      promotedBand = promoteBandSong(q);
    }
    q.round++;
    saveQueue(q);
    res.json({ ok: true, round: q.round, band_promoted: promotedBand });
  });

  app.post('/api/singer/kick', (req, res) => {
    const { singer } = req.body || {};
    if (!singer || !singer.trim()) return res.status(400).json({ error: 'Singer name required' });
    const trimmedSinger = singer.trim();
    const q = loadQueue();
    if (!q.banned_singers) q.banned_singers = [];
    // Already banned?
    if (q.banned_singers.includes(trimmedSinger)) {
      // Remove any remaining songs
      const remaining = q.singer_queue.filter(e => e.singer === trimmedSinger);
      q.singer_queue = q.singer_queue.filter(e => e.singer !== trimmedSinger);
      saveQueue(q);
      return res.json({ ok: true, removed: remaining.length, already_banned: true });
    }
    const entries = q.singer_queue.filter(e => e.singer === trimmedSinger);
    if (entries.length === 0) return res.status(404).json({ error: 'Singer not found in queue' });
    q.banned_singers.push(trimmedSinger);
    q.singer_queue = q.singer_queue.filter(e => e.singer !== trimmedSinger);
    saveQueue(q);
    // Log to persistent banned log
    logBanned(trimmedSinger, entries);
    res.json({ ok: true, removed: entries.length, singer: trimmedSinger });
  });

  app.get('/api/singer/banned', (req, res) => {
    const q = loadQueue();
    res.json({ banned: q.banned_singers || [] });
  });
  app.get('/api/singer/banned', (req, res) => {
    const q = loadQueue();
    res.json({ banned: q.banned_singers || [] });
  });

  app.post('/api/singer/promote', (req, res) => {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const q = loadQueue();
    const idx = q.singer_queue.findIndex(e => e.id === id);
    if (idx < 0) return res.status(400).json({ error: 'Entry not found' });
    const item = q.singer_queue.splice(idx, 1)[0];
    q.main_queue.push({
      slug: item.song_slug,
      title: item.song_title,
      artist: item.song_artist,
      singer: item.singer,
      timestamp: Date.now()
    });
    if (q.promote_count === undefined) q.promote_count = 0;
    q.promote_count++;
    const cfg = authApi.loadConfig();
    const maxBetween = cfg.max_songs_between_band || 999;
    const remainingSingers = q.singer_queue.filter(e => e.round === q.round).length;
    let bandPromoted = null;
    if (q.promote_count >= maxBetween && remainingSingers > 0 && q.band_queue && q.band_queue.length > 0) {
      bandPromoted = promoteBandSong(q);
    }
    saveQueue(q);
    res.json({ ok: true, promoted: item, band_promoted: bandPromoted, promote_count: q.promote_count });
  });

  app.get('/api/queue/current', (req, res) => {
    const q = loadQueue();
    res.json({
      current_song: q.current_song,
      status: q.status,
      current_index: q.current_index
    });
  });

  app.post('/api/queue/reorder', (req, res) => {
    const { from_index, to_index } = req.body || {};
    if (from_index === undefined || to_index === undefined) {
      return res.status(400).json({ error: 'from_index and to_index required' });
    }
    const q = loadQueue();
    if (from_index < 0 || from_index >= q.main_queue.length || to_index < 0 || to_index >= q.main_queue.length) {
      return res.status(400).json({ error: 'Invalid index' });
    }
    const [item] = q.main_queue.splice(from_index, 1);
    q.main_queue.splice(to_index, 0, item);
    if (q.current_index === from_index) {
      q.current_index = to_index;
    } else if (q.current_index > from_index && q.current_index <= to_index) {
      q.current_index--;
    } else if (q.current_index < from_index && q.current_index >= to_index) {
      q.current_index++;
    }
    saveQueue(q);
    res.json({ ok: true, queue: q.main_queue });
  });

  // ─── Band queue (auto-rotated into main_queue each singer round) ───

  app.get('/api/band-queue', (req, res) => {
    const q = loadQueue();
    res.json({ band_queue: q.band_queue || [] });
  });

  app.post('/api/band-queue/add', (req, res) => {
    const { slug } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const info = songsApi.getSong(slug);
    if (!info || !info.meta) return res.status(400).json({ error: 'Song not found' });
    const q = loadQueue();
    if (!q.band_queue) q.band_queue = [];
    q.band_queue.push({
      slug,
      title: info.meta.title || slug,
      artist: info.meta.artist || 'Unknown',
      key: info.meta.key || '',
      bpm: info.meta.bpm || 0,
      timestamp: Date.now()
    });
    saveQueue(q);
    res.json({ ok: true, band_queue: q.band_queue });
  });

  app.delete('/api/band-queue/item/:index', (req, res) => {
    const idx = parseInt(req.params.index);
    const q = loadQueue();
    if (!q.band_queue) q.band_queue = [];
    if (idx < 0 || idx >= q.band_queue.length) return res.status(400).json({ error: 'Invalid index' });
    q.band_queue.splice(idx, 1);
    saveQueue(q);
    res.json({ ok: true, band_queue: q.band_queue });
  });

  app.post('/api/band-queue/promote', (req, res) => {
    const { index } = req.body || {};
    const idx = parseInt(index);
    const q = loadQueue();
    if (!q.band_queue) q.band_queue = [];
    if (isNaN(idx) || idx < 0 || idx >= q.band_queue.length) return res.status(400).json({ error: 'Invalid index' });
    const song = q.band_queue.splice(idx, 1)[0];
    const entry = {
      slug: song.slug,
      title: song.title,
      artist: song.artist,
      key: song.key || '',
      bpm: song.bpm || 0,
      singer: 'Placeholder Duo',
      band_song: true,
      timestamp: Date.now()
    };
    // Insert after current song, or at end
    const insertAt = q.current_index >= 0 && q.current_index < q.main_queue.length - 1
      ? q.current_index + 1
      : q.main_queue.length;
    q.main_queue.splice(insertAt, 0, entry);
    saveQueue(q);
    res.json({ ok: true, promoted: song, queue: q.main_queue });
  });

  app.post('/api/band-queue/clear', (req, res) => {
    const q = loadQueue();
    q.band_queue = [];
    saveQueue(q);
    res.json({ ok: true });
  });

  // ─── External request sync (github pages → jsonblob → singer queue) ───
  const https = require('https');
  const EXTERNAL_BLOB_URL = 'https://jsonblob.com/api/jsonBlob/019f5394-f14c-7b1b-ba94-c35546262ffa';
  let lastExternalSync = 0;
  let lastExternalFetch = 0;
  let externalEnabled = false; // DEFAULT OFF — offline-first
  let onlineDetected = false;
  let autoSyncTimer = null;

  function checkOnline() {
    return new Promise((resolve) => {
      const req = https.get('https://jsonblob.com/api/jsonBlob', { headers: { 'Accept': 'application/json' }, timeout: 5000 }, () => {
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  async function autoDetectOnline() {
    const online = await checkOnline();
    onlineDetected = online;
    if (online && !externalEnabled) {
      externalEnabled = true;
      startAutoSync();
    }
  }

  function startAutoSync() {
    if (autoSyncTimer) clearInterval(autoSyncTimer);
    autoSyncTimer = setInterval(() => {
      if (externalEnabled && onlineDetected) syncBlobToQueue(undefined);
    }, 30000);
  }

  // Wait 5s after startup then detect connectivity
  setTimeout(autoDetectOnline, 5000);

  function syncBlobToQueue(callback) {
    const blobUrl = new URL(EXTERNAL_BLOB_URL);
    https.get(blobUrl.href, { headers: { 'Accept': 'application/json' } }, (extRes) => {
      let data = '';
      extRes.on('data', c => data += c);
      extRes.on('end', () => {
        try {
          const blobData = JSON.parse(data);
          const subs = blobData.submissions || [];
          const newItems = subs.filter(s => !s.done && s.time > lastExternalFetch);
          if (newItems.length === 0) { lastExternalFetch = Date.now(); if (callback) callback(0); return; }
          const q = loadQueue();
          let added = 0;
          for (const item of newItems) {
            const name = (item.name || 'Guest').trim();
            if (name.length > 30) continue;
            const songTitle = (item.song || '').trim();
            if (!songTitle) continue;
            q.singer_queue.push({
              id: 'ext-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5),
              singer: name, song_slug: '', song_title: songTitle,
              song_artist: (item.artist || '').trim(), timestamp: item.time || Date.now(),
              round: q.round, external: true, ext_id: item.time + '-' + name, ip: 'remote'
            });
            added++;
          }
          if (added > 0) {
            const doneIds = new Set(newItems.map(s => s.time + '-' + (s.name || 'Guest')));
            const updatedSubs = subs.map(s => {
              const key = s.time + '-' + (s.name || 'Guest');
              return doneIds.has(key) ? { ...s, done: true } : s;
            });
            const body = JSON.stringify({ submissions: updatedSubs });
            const putReq = https.request(blobUrl.href, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (putRes) => { putRes.resume(); });
            putReq.on('error', () => {});
            putReq.write(body); putReq.end();
            saveQueue(q);
          }
          lastExternalFetch = Date.now();
          lastExternalSync = Date.now();
          if (callback) callback(added);
        } catch (e) { if (callback) callback(0); }
      });
    }).on('error', () => { if (callback) callback(0); });
  }

  app.post('/api/singer/external-sync', (req, res) => {
    syncBlobToQueue(function(added) {
      res.json({ ok: true, added: added, total: loadQueue().singer_queue.length, last_sync: lastExternalSync });
    });
  });

  app.get('/api/singer/external-status', (req, res) => {
    const q = loadQueue();
    res.json({
      external_pending: q.singer_queue.filter(e => e.external && e.round === q.round).length,
      total_pending: q.singer_queue.filter(e => e.round === q.round).length,
      last_sync: lastExternalSync, sync_enabled: externalEnabled,
      online_detected: onlineDetected,
      blob_url: EXTERNAL_BLOB_URL
    });
  });

  app.post('/api/singer/external-toggle', (req, res) => {
    externalEnabled = !externalEnabled;
    if (externalEnabled && onlineDetected) startAutoSync();
    if (!externalEnabled && autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
    res.json({ sync_enabled: externalEnabled, online_detected: onlineDetected });
  });

  app.post('/api/singer/retry-online', async (req, res) => {
    await autoDetectOnline();
    res.json({ online_detected: onlineDetected, sync_enabled: externalEnabled });
  });

  app.post('/api/singer/external-add', (req, res) => {
    const { singer, song_title, song_artist } = req.body || {};
    if (!singer || !singer.trim()) return res.status(400).json({ error: 'Name required' });
    if (!song_title || !song_title.trim()) return res.status(400).json({ error: 'Song required' });
    const cfg = authApi.loadConfig();
    if (cfg.karaoke_enabled === false) {
      return res.status(403).json({ error: cfg.karaoke_paused_message || 'Karaoke is paused' });
    }
    const trimmedSinger = singer.trim().substring(0, 50);
    const profanity = require('./profanity');
    if (profanity.hasProfanity(trimmedSinger)) {
      return res.status(400).json({ error: 'Please choose a different name' });
    }
    const trimmedTitle = song_title.trim().substring(0, 100);
    const trimmedArtist = (song_artist || '').trim().substring(0, 100);
    const q = loadQueue();
    if (q.banned_singers && q.banned_singers.includes(trimmedSinger)) {
      return res.status(403).json({ error: 'Thanks for singing! Have a great night!' });
    }
    q.singer_queue.push({
      id: 'ext-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5),
      singer: trimmedSinger, song_slug: '', song_title: trimmedTitle,
      song_artist: trimmedArtist, timestamp: Date.now(), round: q.round, external: true,
      ip: req.ip || req.socket?.remoteAddress || 'unknown'
    });
    saveQueue(q);
    res.json({ ok: true, position: q.singer_queue.length });
  });

  // Auto-sync will be started if online detected
}

function triggerLoad(slug) {
  const http = require('http');
  const cfg = require('./auth').loadConfig();
  const reaperUrl = cfg.reaper_api_url || 'http://localhost:3300';
  try {
    const url = new URL(`/api/songs/${encodeURIComponent(slug)}/load`, reaperUrl);
    const req = http.request(url.href, { method: 'POST', timeout: 5000 }, () => {});
    req.on('error', () => {});
    req.end();
  } catch (e) {
    // silently fail - reaper might not be running
  }
}

const BANNED_LOG = path.join(DATA_DIR, 'banned-log.json');

function logBanned(singer, entries) {
  const ips = [...new Set(entries.map(e => e.ip || 'unknown').filter(Boolean))];
  const songs = entries.map(e => e.song_title || e.song_slug).filter(Boolean);
  const record = {
    singer,
    songs,
    ips,
    time: new Date().toISOString(),
    round: entries[0]?.round || '?'
  };
  let log = [];
  try {
    if (fs.existsSync(BANNED_LOG)) {
      log = JSON.parse(fs.readFileSync(BANNED_LOG, 'utf-8'));
    }
  } catch {}
  log.push(record);
  fs.writeFileSync(BANNED_LOG, JSON.stringify(log, null, 2) + '\n', 'utf-8');
}

module.exports = { queueRoutes, loadQueue, saveQueue };
