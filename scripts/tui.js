#!/usr/bin/env node
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SERVER_PORT = 3300;
const PROJECT_DIR = path.resolve(__dirname, '..');
const LOG_FILE = '/tmp/liveshow-server.log';
let authToken = '';

const ESC = '\x1b[';
const CLS = ESC + '2J' + ESC + 'H';
const HIDE = ESC + '?25l';
const SHOW = ESC + '?25h';
const BOLD = ESC + '1m';
const DIM = ESC + '2m';
const INV = ESC + '7m';
const RESET = ESC + '0m';
const RED = ESC + '31m';
const GREEN = ESC + '32m';
const YELLOW = ESC + '33m';
const CYAN = ESC + '36m';
const WHITE = ESC + '37m';
const ORANGE = ESC + '38;2;255;136;0m';
const BG_ORANGE = ESC + '48;2;255;136;0m';

let serverProcess = null;
let serverRunning = false;
let queueState = { main_queue: [], band_queue: [], current_index: -1, current_song: null, status: 'stopped' };
let singerQueue = { queue: [], round: 1 };
let reaperState = { currentSong: null, position: 0, bpm: 0, nextSong: null, playing: false };
let externalStatus = { external_pending: 0, total_pending: 0, sync_enabled: true };
let logs = [];
let songCache = [];
let karaokeEnabled = true;
let karaokePausedMsg = '';

let focus = 'main';
let queueView = 'singers';
let mainQueueCursor = 0;
let singerCursor = 0;
let bandCursor = 0;
let inputMode = false;
let inputPrompt = '';
let confirmMode = false;
let confirmItem = null;
let confirmRemoveIndex = -1;
let confirmAction = null;
let inputBuffer = '';
let searchResults = [];
let searchCursor = 0;
let searchDebounce = null;
let searchTarget = 'add';
let nameInputMode = false;
let nameInputBuffer = '';
let nameInputFor = null;
let showWifiInfo = false;
let setlistMode = false;
let setlistList = [];
let setlistCursor = 0;
let settingsMode = false;
let settingsField = null;
let settingsCursor = 'max_songs';
let settingsValue = '';
let exportMode = false;
let exportBuffer = '';
let maxSongsBetweenBand = 8;
let promoteCount = 0;
let bumperPlaying = false;
let bumperTrack = '';
let bumperVolume = 20;
let wifiSSID = '';
let wifiPassword = '';
let lanIP = '127.0.0.1';
let connectedClients = [];
let showMode = 'live';

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  logs.push(`[${ts}] ${msg}`);
  if (logs.length > 200) logs.splice(0, 50);
}

function apiGet(path) {
  return new Promise((resolve) => {
    const opts = { hostname: 'localhost', port: SERVER_PORT, path, method: 'GET', headers: {} };
    if (authToken) opts.headers['x-auth-token'] = authToken;
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function apiPost(path, body, method) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const opts = {
      hostname: 'localhost', port: SERVER_PORT, path,
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    if (authToken) opts.headers['x-auth-token'] = authToken;
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(data);
    req.end();
  });
}

function startServer() {
  if (serverRunning) { log('Server already running'); return; }
  log('Starting server...');
  const out = fs.openSync(LOG_FILE, 'a');
  serverProcess = spawn('node', ['server/index.js'], {
    cwd: PROJECT_DIR,
    stdio: ['ignore', out, out],
    detached: false
  });
  serverProcess.on('exit', (code) => {
    serverRunning = false; serverProcess = null;
    log(`Server exited (code ${code})`);
  });
  setTimeout(() => checkServer(), 2000);
}

function stopServer() {
  if (!serverRunning && !serverProcess) { log('Server not running'); return; }
  log('Stopping server...');
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    setTimeout(() => { if (serverProcess) serverProcess.kill('SIGKILL'); }, 3000);
  } else {
    spawn('kill', ['$(lsof -t -i:' + SERVER_PORT + ')']);
  }
  serverRunning = false;
}

async function loadSongCache() {
  if (songCache.length > 0) return;
  const r = await apiGet('/api/songs/search?per_page=500');
  if (r && r.songs) songCache = r.songs;
}

function getSongInfo(slug) {
  return songCache.find(s => s.slug === slug);
}

async function checkServer() {
  const health = await apiGet('/api/health');
  const wasRunning = serverRunning;
  serverRunning = !!health;
  if (serverRunning && !wasRunning && !serverProcess) log('Found existing server process');
  return serverRunning;
}

async function refreshState() {
  if (!serverRunning) return;
  const q = await apiGet('/api/queue');
  if (q) {
    queueState = q;
    if (!q.band_queue) queueState.band_queue = [];
    if (singerCursor >= (singerQueue.queue || []).length) singerCursor = Math.max(0, (singerQueue.queue || []).length - 1);
    if (bandCursor >= (queueState.band_queue || []).length) bandCursor = Math.max(0, (queueState.band_queue || []).length - 1);
    if (mainQueueCursor >= (queueState.main_queue || []).length) mainQueueCursor = Math.max(0, (queueState.main_queue || []).length - 1);
  }
  const sq = await apiGet('/api/singer/queue');
  if (sq) {
    singerQueue = sq;
    promoteCount = sq.promote_count || 0;
  }
  const es = await apiGet('/api/singer/external-status');
  if (es) externalStatus = es;
  const ks = await apiGet('/api/singer/status');
  if (ks) { karaokeEnabled = ks.karaoke_enabled; karaokePausedMsg = ks.karaoke_paused_message || ''; }
  const cfg = await apiGet('/api/config');
  if (cfg && cfg.max_songs_between_band !== undefined) maxSongsBetweenBand = cfg.max_songs_between_band || 0;
  // Poll REAPER state from port 3000
  await refreshReaperState();
  // Poll connected clients
  await refreshClients();
  await refreshBumper();
}

async function refreshReaperState() {
  return new Promise((resolve) => {
    const req = http.request({ hostname: 'localhost', port: 3000, path: '/api/state', method: 'GET', timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { const s = JSON.parse(data); reaperState = s; } catch {}
        resolve();
      });
    });
    req.on('error', () => resolve());
    req.end();
  });
}

async function refreshClients() {
  return new Promise((resolve) => {
    const req = http.request({ hostname: 'localhost', port: 3000, path: '/api/clients', method: 'GET', timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { const c = JSON.parse(data); connectedClients = c.clients || []; } catch {}
        resolve();
      });
    });
    req.on('error', () => resolve());
    req.end();
  });
}

async function refreshBumper() {
  return new Promise((resolve) => {
    const req = http.request({ hostname: 'localhost', port: 3000, path: '/bumper/api/status', method: 'GET', timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { const s = JSON.parse(data); bumperPlaying = s.playing || false; bumperTrack = s.current || ''; bumperVolume = s.volume || 20; } catch {}
        resolve();
      });
    });
    req.on('error', () => resolve());
    req.end();
  });
}

function bumperPost(action) {
  return new Promise((resolve) => {
    const path = action === 'stop' ? '/bumper/api/stop' : action === 'stop-graceful' ? '/bumper/api/stop-graceful' : action === 'vol-up' ? '/bumper/api/volume/up' : action === 'vol-down' ? '/bumper/api/volume/down' : '/bumper/api/play';
    const data = JSON.stringify({});
    const opts = {
      hostname: 'localhost', port: 3000, path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(data);
    req.end();
  });
}

function adjustBumperVolume(target) {
  const step = target > bumperVolume ? 'vol-up' : 'vol-down';
  const steps = Math.abs(target - bumperVolume) / 5;
  function next(i) {
    if (i >= steps) { refreshBumper(); return; }
    bumperPost(step).then(() => { refreshBumper(); setTimeout(() => next(i + 1), 150); });
  }
  next(0);
}

async function doAction(action, arg) {
  if (!serverRunning) { log('Server not running'); return; }
  let result = null;
  switch (action) {
    case 'next': result = await apiPost('/api/queue/load-next'); break;
    case 'prev': result = await apiPost('/api/queue/load-prev'); break;
    case 'play': result = await apiPost('/api/queue/play'); break;
    case 'stop': result = await apiPost('/api/queue/stop'); break;
    case 'start': result = await apiPost('/api/queue/start-setlist'); break;
    case 'clear': result = await apiPost('/api/queue/clear'); break;
    case 'clear-round': result = await apiPost('/api/singer/clear-round'); break;
    case 'add':
      if (arg) result = await apiPost('/api/queue/add', { slug: arg });
      break;
    case 'add-singer':
      if (arg) result = await apiPost('/api/singer/add', { singer: 'Band', song_slug: arg });
      break;
    case 'add-singer-name':
      if (arg && arg.name && arg.slug) result = await apiPost('/api/singer/add', { singer: arg.name, song_slug: arg.slug });
      break;
    case 'add-band':
      if (arg) result = await apiPost('/api/band-queue/add', { slug: arg });
      break;
    case 'promote':
      if (arg) result = await apiPost('/api/singer/promote', { id: arg });
      break;
    case 'remove':
      if (arg !== undefined) result = await apiPost('/api/queue/remove-multiple', { indexes: [arg] });
      break;
    case 'remove-band':
      if (arg !== undefined) result = await apiPost('/api/band-queue/item/' + arg, {}, 'DELETE');
      break;
    case 'play-now':
      if (arg !== undefined) result = await apiPost('/api/band-queue/promote', { index: arg });
      break;
    case 'clear-round-confirm':
      result = await apiPost('/api/singer/clear-round');
      break;
    case 'export-setlist':
      if (arg) result = await apiPost('/api/setlists/export', { name: arg, songs: (queueState.band_queue || []).map(s => ({ slug: s.slug })) });
      break;
    case 'import-setlist':
      if (arg) result = await apiPost('/api/setlists/import', { name: arg, mode: 'replace' });
      break;
    case 'append-setlist':
      if (arg) result = await apiPost('/api/setlists/import', { name: arg, mode: 'append' });
      break;
    case 'update-settings':
      if (arg) result = await apiPost('/api/config/update', arg);
      break;
    case 'restart':
      stopServer();
      setTimeout(() => startServer(), 2000);
      return;
      case 'toggle-karaoke':
        result = await apiPost('/api/singer/toggle');
        break;
      case 'sync-external':
        result = await apiPost('/api/singer/external-sync');
        break;
      case 'toggle-external':
        result = await apiPost('/api/singer/external-toggle');
        break;
      case 'retry-online':
        result = await apiPost('/api/singer/retry-online');
        break;
  }
  if (result) {
    if (result.ok) {
      if (action === 'next') log(`Next: ${result.song?.title || '?'}`);
      else if (action === 'prev') log(`Prev: ${result.song?.title || '?'}`);
      else if (action === 'play') log('Play');
      else if (action === 'stop') log('Stop');
      else if (action === 'start') log(`Started: ${result.song?.title || '?'}`);
      else if (action === 'clear') log('Queue cleared');
      else if (action === 'clear-round-confirm') log(`Round ${result?.round || '?'} cleared`);
      else if (action === 'add') {
        const song = songCache.find(s => s.slug === arg);
        const warn = result?.duplicate ? ' (DUPLICATE!)' : '';
        log(`Added: ${song?.title || arg}${warn}`);
        if (result?.duplicate) log(`  Warning: "${result.title}" is already in the queue`);
      }
      else if (action === 'add-singer') {
        const song = songCache.find(s => s.slug === arg);
        log(`Singer add: ${song?.title || arg}`);
      }
      else if (action === 'add-singer-name') {
        const song = songCache.find(s => s.slug === arg.slug);
        log(`Added singer: ${arg.name} — ${song?.title || arg.slug}`);
      }
      else if (action === 'add-band') {
        const song = songCache.find(s => s.slug === arg);
        log(`Band queue: ${song?.title || arg}`);
      }
      else if (action === 'promote') {
        log(`Promoted: ${result.promoted?.singer || '?'} — ${result.promoted?.song_title || '?'}`);
      }
      else if (action === 'toggle-karaoke') log(`Karaoke: ${result.karaoke_enabled ? 'ON' : 'OFF'}`);
      else if (action === 'sync-external') log(`External sync: ${result.added || 0} imported`);
      else if (action === 'toggle-external') log(`External sync: ${result.sync_enabled ? 'ON' : 'OFF'}`);
      else if (action === 'retry-online') log(result.online_detected ? 'Internet detected — sync enabled' : 'Still offline');
      else if (action === 'remove') log(`Removed index ${arg}`);
      else if (action === 'remove-singer') log(`Removed singer`);
      else if (action === 'kick-singer') log(`KICKED: ${result?.singer || '?'} (${result?.removed || '?'} songs)`);
      else if (action === 'remove-band') log(`Removed band song`);
      else if (action === 'export-setlist') log(`Setlist exported: ${arg}`);
      else if (action === 'import-setlist') {
        const failCount = result?.failed?.length || 0;
        log(`Setlist loaded: ${arg} (${result?.added || 0} songs${failCount > 0 ? ', ' + failCount + ' not found' : ''})`);
        if (failCount > 0) log(`  Missing: ${result.failed.join(', ')}`);
      }
      else if (action === 'append-setlist') log(`Setlist appended: ${arg} (+${result?.added || 0} songs)`);
      else if (action === 'update-settings') log(`Settings updated`);
    } else if (result.error) {
      log(`Error: ${result.error}`);
    }
  }
  await refreshState();
}

function drawBox(top, left, w, h, title, highlight) {
  const hc = '-', v = '|';
  const titleStr = title ? ` ${title} ` : '';
  const pad = w - 2 - titleStr.length;
  const lp = Math.floor(pad / 2), rp = pad - lp;
  const borderColor = highlight ? CYAN : ORANGE;
  let out = '';
  out += ESC + top + ';' + left + 'H' + borderColor + '+' + hc.repeat(lp) + RESET + (title ? ' ' + BOLD + title + ' ' + RESET : '') + borderColor + hc.repeat(rp) + '+' + RESET;
  for (let r = 1; r <= h - 2; r++) {
    out += ESC + (top + r) + ';' + left + 'H' + borderColor + v + RESET;
    out += ESC + (top + r) + ';' + (left + w - 1) + 'H' + borderColor + v + RESET;
  }
  out += ESC + (top + h - 1) + ';' + left + 'H' + borderColor + '+' + hc.repeat(w - 2) + '+' + RESET;
  return out;
}

function drawText(top, left, text) {
  return ESC + top + ';' + left + 'H' + text + ESC + '0K';
}

function render() {
  if (inputMode || nameInputMode) { renderSearch(); return; }
  if (confirmMode) { renderConfirm(); return; }
  if (showWifiInfo) { renderWiFiInfo(); return; }
  if (setlistMode) { renderSetlistPicker(); return; }
  if (settingsMode || exportMode) { renderSettings(); return; }

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 30;
  const w = cols;

  let out = HIDE;

  // Title bar
  const icon = serverRunning ? (GREEN + '●' + RESET) : (RED + '●' + RESET);
  out += ESC + '1;1H' + BG_ORANGE + ' '.repeat(w) + RESET;
  out += ESC + '1;2H' + WHITE + BOLD + ' ♪ LIVE SHOW SERVER  ' + RESET + DIM + WHITE + 'v1.0' + RESET;
  const modeBadge = showMode === 'live' ? (GREEN + 'LIVE' + RESET) : (YELLOW + 'SETUP' + RESET);
  const focusLabel = focus === 'queue' ? (queueView === 'singers' ? 'SINGERS' : 'SETLIST') : 'REAPER';
  const focusTag = ' [' + CYAN + focusLabel + RESET + ']';
  const onlineTag = externalStatus.online_detected ? (GREEN + ' ONLINE' + RESET) : (YELLOW + ' OFFLINE' + RESET);
  out += ESC + '1;' + (w - 50) + 'H' + '[' + modeBadge + ']' + focusTag + '  ' + onlineTag + '  ' + icon + ' ' + (serverRunning ? 'RUNNING' : 'STOPPED') + ' :' + SERVER_PORT + RESET;
  if (showMode !== 'live') {
    out += ESC + '2;' + Math.floor((w - 30) / 2) + 'H' + YELLOW + BOLD + '  [Shift+S] Start Show to go LIVE  ' + RESET + ESC + '0K';
  }

  const lw = Math.floor((w - 3) / 2);
  const rw = w - 3 - lw;
  const ct = showMode === 'live' ? 3 : 4, ch = 7;

  // Now Playing — from REAPER bridge state
  const npHighlight = focus === 'main';
  out += drawBox(ct, 1, lw, ch, 'NOW PLAYING', npHighlight);
  if (reaperState.currentSong) {
    const s = reaperState;
    const bar = s.bpm > 0 ? Math.floor((s.position || 0) * s.bpm / (4 * 60)) + 1 : 1;
    out += drawText(ct + 1, 3, BOLD + (s.currentSong || '?').substring(0, lw - 6) + RESET);
    out += drawText(ct + 2, 3, DIM + (s.currentArtist || '') + '  ' + (s.currentKey || '') + RESET);
    out += drawText(ct + 3, 3, `${DIM}Bar${RESET} ${bar}  ${DIM}BPM${RESET} ${s.bpm || '-'}  ${DIM}Pos${RESET} ${Math.floor(s.position || 0)}s`);
    const nextLabel = s.nextSong ? 'Next: ' + s.nextSong : '';
    out += drawText(ct + 4, 3, s.playing ? (GREEN + '● PLAYING' + RESET) : (YELLOW + '● PAUSED' + RESET) + '  ' + DIM + nextLabel + RESET);
    if (npHighlight) out += drawText(ct + 5, 3, DIM + '(← → switch panels, Tab toggles queue view)' + RESET);
  } else {
    out += drawText(ct + 2, 3, DIM + 'REAPER not connected' + RESET);
    out += drawText(ct + 3, 3, DIM + 'Start REAPER + load show project' + RESET);
    if (npHighlight) out += drawText(ct + 5, 3, DIM + '(→ to queue panel)' + RESET);
  }

  // Queue panel — dynamic: singers or band queue
  const qr = lw + 2;
  const qHighlight = focus === 'queue';
  const isSingers = queueView === 'singers';
  const panelQueue = isSingers ? (singerQueue.queue || []) : (queueState.band_queue || []);
  const panelTitle = isSingers ? `SINGERS (${singerQueue.queue?.length || 0})` : `SETLIST (${(queueState.band_queue || []).length})`;
  out += drawBox(ct, qr, rw, ch, panelTitle, qHighlight);
  const mv = ch - 2;
  const cursorIdx = isSingers ? singerCursor : bandCursor;
  let scrollStart = qHighlight ? Math.max(0, Math.min(cursorIdx - Math.floor(mv / 2), Math.max(0, panelQueue.length - mv))) : 0;
  scrollStart = Math.max(0, Math.min(scrollStart, Math.max(0, panelQueue.length - mv)));

  const currentSlug = queueState.current_song?.slug;
  for (let i = 0; i < mv; i++) {
    const idx = scrollStart + i;
    if (idx >= panelQueue.length) { out += drawText(ct + 1 + i, qr + 2, ' '.repeat(rw - 4)); continue; }
    const item = panelQueue[idx];
    const isCursor = qHighlight && idx === cursorIdx;
    const isNowPlaying = !isSingers && currentSlug && item.slug === currentSlug;
    const n = (idx + 1 + '').padStart(2);
    const cursorMark = isCursor ? (INV + ' ' + RESET) : isNowPlaying ? (GREEN + ' ▶' + RESET) : ' ';
    const style = isCursor ? (INV + BOLD) : isNowPlaying ? (GREEN + BOLD) : DIM;
    if (isSingers) {
      const name = (item.singer || '?').substring(0, rw - 20);
      const song = ((item.song_title || '?') + ' — ' + (item.song_artist || '')).substring(0, rw - 10);
      out += drawText(ct + 1 + i, qr + 1, style + cursorMark + ' ' + n + '. ' + name + '  ' + DIM + song + RESET);
    } else {
      const title = (item.title || '?').substring(0, rw - 6);
      const artist = (item.artist || '').substring(0, rw - 8);
      const keyInfo = item.key ? ' [' + GREEN + item.key + RESET + ']' : '';
      let notes = '';
      if (isCursor) {
        const info = getSongInfo(item.slug);
        if (info) {
          const parts = [];
          if (info.tuning) parts.push(info.tuning);
          if (info.capo) parts.push('capo ' + info.capo);
          if (info.difficulty) parts.push(info.difficulty);
          if (parts.length) notes = '  ' + DIM + parts.join(' · ') + RESET;
        }
      }
      out += drawText(ct + 1 + i, qr + 1, style + cursorMark + ' ' + n + '. ' + title + '  ' + DIM + artist + keyInfo + RESET + notes);
    }
  }
  if (panelQueue.length === 0) {
    const msg = isSingers ? 'No singers waiting' : 'No songs in setlist';
    out += drawText(ct + 3, qr + 2, DIM + msg + RESET);
  }

  // Stats bar
  const st = ct + ch;
  out += ESC + st + ';1H' + BG_ORANGE + ' '.repeat(w) + RESET;
  const sc = singerQueue.queue?.length || 0;
  const bc = (queueState.band_queue || []).length;
  const extPend = externalStatus.external_pending || 0;
  const modeLabel = externalStatus.online_detected ? (GREEN + 'ONLINE' + RESET) : (YELLOW + 'OFFLINE' + RESET);
  const syncLabel = externalStatus.sync_enabled ? (GREEN + 'sync' + RESET) : (DIM + 'off' + RESET);
  const karaokeIcon = karaokeEnabled ? (GREEN + 'ON' + RESET) : (RED + 'OFF' + RESET);
  const dellClient = connectedClients.find(c => (c.ip || '').startsWith('192.') && (c.userAgent || '').toLowerCase().includes('linux'));
  const dellStr = dellClient
    ? (showMode === 'live' ? GREEN + 'DELL @' + dellClient.ip + RESET : YELLOW + 'Dell @' + dellClient.ip + ' (standby)' + RESET)
    : (DIM + 'Dell not connected' + RESET);
  const phoneClients = connectedClients.filter(c => (c.ip || '').startsWith('192.')).length;
  out += drawText(st + 1, 3, WHITE +
    `Singers ${WHITE}${BOLD}${sc}${RESET}${WHITE}  Setlist ${WHITE}${BOLD}${bc}${RESET}${WHITE}  Round ${singerQueue.round || 1} (${promoteCount}/${maxSongsBetweenBand})  ETA ${WHITE}${BOLD}${queueState.eta_minutes || 0}m${RESET}${WHITE} ${DIM}·${WHITE} ` +
    `Ext ${WHITE}${BOLD}${extPend}${RESET}${WHITE} ${syncLabel} ${DIM}·${WHITE} Karaoke ${karaokeIcon}${WHITE} ${DIM}·${WHITE} ${modeLabel}${WHITE} ${DIM}·${WHITE} ${dellStr}` +
    (reaperState.currentSong ? ` ${DIM}·${WHITE} ${GREEN + reaperState.currentSong.substring(0,20) + RESET}` : '') +
    (bumperPlaying ? ` ${DIM}·${WHITE} ${YELLOW + '♫ Bumper ' + bumperVolume + '%' + RESET}` : '') + RESET);
  const boxHost = lanIP || process.env.SHOW_IP || 'localhost';

  // URLs box
  const ut = st + 2;
  const uh = 3;
  out += drawBox(ut, 1, w - 1, uh, 'SERVER URLs');
  out += drawText(ut + 1, 3,
    DIM + 'iPhone:' + RESET + ` ${CYAN}http://${boxHost}:3000${RESET}  ` +
    DIM + '\xb7 Stage HUD:' + RESET + ` ${CYAN}http://${boxHost}:3000/hud.html${RESET}  ` +
    DIM + '\xb7 Teleprompter:' + RESET + ` ${CYAN}http://${boxHost}:3000/hud.html${RESET}`);
  out += drawText(ut + 2, 3,
    DIM + 'Singer Queue:' + RESET + ` ${YELLOW}http://${boxHost}:3300/singer${RESET}  ` +
    DIM + '\xb7 Band View:' + RESET + ` ${YELLOW}http://${boxHost}:3300/band${RESET}  ` +
    DIM + '\xb7 Pass:' + RESET + ` ${GREEN}showtime${RESET}`);

  // Actions
  const at = ut + uh;
  const ah = 2;
  out += drawBox(at, 1, w - 1, ah, 'ACTIONS');
  const karaokeLabel = karaokeEnabled ? (RED + '[shift+k]' + RESET + ' Pause') : (GREEN + '[shift+k]' + RESET + ' Karaoke ON');
  const netLabel = externalStatus.online_detected ? (CYAN + '[o]' + RESET + ' Offline') : (YELLOW + '[o]' + RESET + ' Online');
  const navKeys = `${BOLD}[←→]${RESET} Panel  ${focus === 'queue' ? BOLD + '[Tab] ' + (queueView === 'singers' ? 'Setlist' : 'Singers') + RESET : ''}`;
  const queueKeys = focus === 'queue'
    ? (queueView === 'singers'
        ? `${BOLD}[p]${RESET} Promote  ${BOLD}[x]${RESET} Remove  ${BOLD}[B]${RESET} Kick  ${BOLD}[c]${RESET} Round  ${BOLD}[a]${RESET} Add Singer`
        : `${BOLD}[Enter]${RESET} Play Now  ${BOLD}[x]${RESET} Remove  ${BOLD}[a]${RESET} Add Song`)
    : `  ${BOLD}[n]${RESET} Next  ${BOLD}[b]${RESET} Prev  ${BOLD}[Space]${RESET} Play  ${BOLD}[a]${RESET} Add`;
  const row1 = `${navKeys}  ${queueKeys}  ${BOLD}[E]${RESET} Export  ${BOLD}[I]${RESET} Import  ${BOLD}[?]${RESET} Settings  ${BOLD}[q]${RESET} Quit${showMode === 'connected' ? `  ${BOLD}[Shift+S]${RESET} Start Show` : ''}`;
  const row2 = `${karaokeLabel}  ${netLabel}  ${BOLD}[m]${RESET} Bumper  ${BOLD}[e]${RESET} Sync  ${BOLD}[w]${RESET} WiFi  ${BOLD}[r]${RESET} Restart`;
  out += drawText(at + 1, 3, row1);
  out += drawText(at + 2, 3, row2);

  // Log
  const lt = at + ah;
  const lh = Math.max(2, rows - lt - 1);
  out += drawBox(lt, 1, w - 1, lh, 'LOG');
  const vl = logs.slice(-(lh - 2));
  for (let i = 0; i < Math.min(vl.length, lh - 2); i++) {
    out += drawText(lt + 1 + i, 3, DIM + vl[i].substring(0, w - 4) + RESET);
  }

  process.stdout.write(out);
}

function renderSearch() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 30;
  const w = cols;

  let out = HIDE;

  if (nameInputMode) {
    const boxW = Math.min(50, w - 4);
    const boxH = 5;
    const bx = Math.floor((w - boxW) / 2);
    const by = Math.floor(rows / 2) - 2;
    out += drawBox(by, bx, boxW, boxH, '');
    out += drawText(by + 1, bx + 2, BOLD + `Adding "${(nameInputFor?.title || 'song').substring(0, boxW - 18)}"` + RESET);
    out += drawText(by + 2, bx + 2, `${BOLD}Singer name:${RESET} ` + CYAN + nameInputBuffer + (nameInputBuffer.length < boxW - 18 ? '█' : '') + RESET);
    out += drawText(by + 3, bx + 2, DIM + 'Enter submit  Esc cancel' + RESET);
    process.stdout.write(out);
    return;
  }

  const boxH = Math.min(rows - 2, 22);
  const boxTop = Math.max(1, Math.floor((rows - boxH) / 2));

  out += drawBox(boxTop, 2, w - 3, boxH, inputPrompt.toUpperCase());
  out += drawText(boxTop + 1, 4, `${BOLD}Search songs by title or artist:${RESET}`);

  const inputLine = boxTop + 2;
  out += drawText(inputLine, 4, CYAN + '> ' + inputBuffer + (inputBuffer.length < w - 12 ? '█' : '') + RESET);
  out += drawText(inputLine, 4 + Math.min(inputBuffer.length, w - 20) + 3, ' '.repeat(Math.max(0, w - 14 - inputBuffer.length)) + '  ' + DIM + `${searchResults.length} results` + RESET);

  const resTop = boxTop + 4;
  const resH = boxH - 7;
  const page = searchResults.slice(0, resH);
  for (let i = 0; i < resH; i++) {
    const l = boxTop + 4 + i;
    if (i < page.length) {
      const s = page[i];
      const name = (s.title + '  ' + DIM + s.artist + RESET + '  ' + (s.key || '')).substring(0, w - 14);
      const cur = searchCursor === i ? (INV + ' ' + RESET) : ' ';
      out += drawText(l, 4, cur + ' ' + (searchCursor === i ? BOLD : '') + name + (searchCursor === i ? RESET : ''));
    } else {
      out += drawText(l, 4, ' '.repeat(w - 8));
    }
  }

  const foot = boxTop + boxH - 2;
  out += drawText(foot, 4, DIM + '↑↓ navigate  Enter add  Esc cancel  type to search' + RESET);
  process.stdout.write(out);
}

function renderConfirm() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 30;
  const w = cols;

  let out = HIDE + CLS;

  const isKick = confirmAction === 'kick-singer';
  const boxW = Math.min(isKick ? 55 : 50, w - 4);
  const boxH = isKick ? 6 : 5;
  const bx = Math.floor((w - boxW) / 2);
  const by = Math.floor(rows / 2) - 2;

  out += drawBox(by, bx, boxW, boxH, isKick ? RED + ' KICK SINGER ' + RESET : '');
  if (isKick) {
    out += drawText(by + 1, bx + 2, RED + BOLD + `Kick & ban "${(confirmItem?.title || 'this singer').replace('KICK ', '').substring(0, boxW - 20)}"?` + RESET);
    out += drawText(by + 2, bx + 3, DIM + 'Removes all their songs. Banned for rest of show.' + RESET);
    out += drawText(by + 4, bx + 2, RED + '  y  Yes, kick them out    n  No (Esc)' + RESET);
  } else {
    out += drawText(by + 1, bx + 2, BOLD + `Remove "${(confirmItem?.title || 'this song').substring(0, boxW - 14)}"?` + RESET);
    out += drawText(by + 3, bx + 2, DIM + '  y  Yes    n  No (Esc)' + RESET);
  }

  process.stdout.write(out);
}

function renderWiFiInfo() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 30;
  const w = Math.min(cols, 50);
  const h = 7;
  const bx = Math.floor((cols - w) / 2);
  const by = Math.floor(rows / 2) - 3;

  let out = HIDE + CLS;
  out += drawBox(by, bx, w, h, '');
  out += drawText(by + 1, bx + 2, `${BOLD}WiFi:${RESET}  ${CYAN}${wifiSSID || '(not set)'}${RESET}`);
  out += drawText(by + 2, bx + 2, `${BOLD}Pass:${RESET}  ${YELLOW}${wifiPassword || '(not set)'}${RESET}`);
  out += drawText(by + 4, bx + 2, `${DIM}Band login:${RESET} ${YELLOW}showtime${RESET}`);
  out += drawText(by + 5, bx + 2, `${BOLD}Press any key to close${RESET}`);
  process.stdout.write(out);
}

function renderSetlistPicker() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 30;
  const w = cols;

  let out = HIDE + CLS;
  const boxH = Math.min(rows - 4, 18);
  const boxTop = Math.max(1, Math.floor((rows - boxH) / 2));

  out += drawBox(boxTop, 2, w - 3, boxH, 'IMPORT SETLIST');
  out += drawText(boxTop + 1, 4, `${BOLD}Select a setlist to load (${setlistList.length} found):${RESET}`);

  const resH = boxH - 4;
  for (let i = 0; i < resH; i++) {
    const l = boxTop + 3 + i;
    if (i < setlistList.length) {
      const s = setlistList[i];
      const cur = setlistCursor === i ? (INV + ' ' + RESET) : ' ';
      out += drawText(l, 4, cur + ' ' + (setlistCursor === i ? BOLD : '') +
        s.label.substring(0, w - 28) + (setlistCursor === i ? RESET : '') +
        '  ' + DIM + s.songs + ' songs  ' + s.modified.substring(0, 10) + RESET);
    } else {
      out += drawText(l, 4, ' '.repeat(w - 8));
    }
  }
  if (setlistList.length === 0) {
    out += drawText(boxTop + 3, 4, DIM + 'No setlists found. Export some first with E.' + RESET);
  }

  const foot = boxTop + boxH - 2;
  out += drawText(foot, 4, DIM + 'Enter load (then r=replace a=append)  Esc cancel' + RESET);
  process.stdout.write(out);
}

function renderSettings() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 30;
  const w = cols;

  let out = HIDE + CLS;

  if (exportMode) {
    const boxW = Math.min(45, w - 4);
    const boxH = 5;
    const bx = Math.floor((w - boxW) / 2);
    const by = Math.floor(rows / 2) - 2;
    out += drawBox(by, bx, boxW, boxH, 'EXPORT SETLIST');
    out += drawText(by + 1, bx + 2, `${BOLD}Setlist name:${RESET} ` + CYAN + exportBuffer + (exportBuffer.length < boxW - 18 ? '█' : '') + RESET);
    out += drawText(by + 2, bx + 3, DIM + `Saving ${(queueState.main_queue || []).length} songs` + RESET);
    out += drawText(by + 3, bx + 2, DIM + 'Enter save  Esc cancel' + RESET);
    process.stdout.write(out);
    return;
  }

  const boxW = Math.min(55, w - 4);
  const boxH = 9;
  const bx = Math.floor((w - boxW) / 2);
  const by = Math.floor(rows / 2) - 3;

  out += drawBox(by, bx, boxW, boxH, 'SETTINGS');
  const selMark = (f) => settingsCursor === f ? (CYAN + '▶' + RESET + ' ') : '  ';
  const hi = (f) => (!settingsField && settingsCursor === f) ? INV + BOLD : RESET;

  out += drawText(by + 1, bx + 2, selMark('max_songs') + hi('max_songs') + `Max songs between band:${RESET} ${CYAN}${maxSongsBetweenBand}${RESET}  ${DIM}(0=every round)${RESET}`);
  out += drawText(by + 2, bx + 2, selMark('bumper_vol') + hi('bumper_vol') + `Bumper volume:${RESET}            ${CYAN}${bumperVolume}%${RESET}`);
  out += drawText(by + 3, bx + 2, selMark('karaoke') + hi('karaoke') + `Karaoke mode:${RESET}              ${karaokeEnabled ? GREEN + 'ON' + RESET : RED + 'OFF' + RESET}  ${DIM}(Enter=toggle)${RESET}`);

  if (settingsField === 'max_songs') {
    out += drawText(by + 5, bx + 2, `${BOLD}New value:${RESET} ` + CYAN + settingsValue + '█' + RESET);
    out += drawText(by + 6, bx + 2, DIM + 'Enter save  Esc cancel  0=every round' + RESET);
  } else if (settingsField === 'bumper_vol') {
    out += drawText(by + 5, bx + 2, `${BOLD}New volume:${RESET} ` + CYAN + settingsValue + '% █' + RESET);
    out += drawText(by + 6, bx + 2, DIM + 'Enter save  Esc cancel  (5-100)' + RESET);
  } else {
    out += drawText(by + 5, bx + 2, DIM + '↑↓ select  Enter edit/toggle  Esc close' + RESET);
  }

  out += drawText(by + 7, bx + 2, `Round ${singerQueue.round || 1}  ${DIM}ETA ${queueState.eta_minutes || 0}m${RESET}`);

  process.stdout.write(out);
}

function doSearch(query) {
  const q = query.toLowerCase().trim();
  if (!q) { searchResults = []; searchCursor = 0; return; }
  searchResults = songCache.filter(s =>
    s.title.toLowerCase().includes(q) ||
    s.artist.toLowerCase().includes(q)
  ).slice(0, 50);
  if (searchCursor >= searchResults.length) searchCursor = Math.max(0, searchResults.length - 1);
}

function enterSearchMode(target) {
  inputMode = true;
  inputPrompt = target === 'add-singer' ? 'Add singer — search song' : 'Search & add song';
  searchTarget = target || 'add';
  inputBuffer = '';
  searchResults = [];
  searchCursor = 0;
  nameInputMode = false;
  nameInputBuffer = '';
  nameInputFor = null;
  renderSearch();
}

async function enterSetlistMode() {
  setlistMode = true;
  setlistCursor = 0;
  const r = await apiGet('/api/setlists');
  setlistList = (r && r.setlists) ? r.setlists : [];
  renderSetlistPicker();
}

function enterSettingsMode() {
  settingsMode = true;
  settingsField = null;
  settingsValue = '';
  renderSettings();
}

function handleInput(chunk) {
  // Escape sequences (arrows etc.)
  if (chunk[0] === 0x1b && chunk.length >= 3 && chunk[1] === 0x5b) {
    if (inputMode) {
      const dir = chunk[2];
      if (dir === 0x41) { searchCursor = Math.max(0, searchCursor - 1); renderSearch(); }
      else if (dir === 0x42) { searchCursor = Math.min(searchResults.length - 1, searchCursor + 1); renderSearch(); }
      return;
    }
  }

  // In search mode (or name input)
  if (inputMode || nameInputMode) {
    // Name input mode — type singer name
    if (nameInputMode) {
      for (const ch of chunk) {
        if (ch === 27) { nameInputMode = false; inputMode = false; nameInputFor = null; render(); return; }
        else if (ch === 13) {
          const name = nameInputBuffer.trim();
          if (name && nameInputFor) {
            nameInputMode = false;
            inputMode = false;
            const song = nameInputFor;
            nameInputFor = null;
            render();
            doAction('add-singer-name', { name, slug: song.slug }).then(() => render());
            return;
          }
        } else if (ch === 127 || ch === 8) {
          nameInputBuffer = nameInputBuffer.slice(0, -1);
          renderSearch();
        } else if (ch >= 32 && ch <= 126) {
          nameInputBuffer += String.fromCharCode(ch);
          renderSearch();
        }
      }
      return;
    }

    // Song search mode
    for (const ch of chunk) {
      if (ch === 27) { inputMode = false; render(); return; }
      else if (ch === 13) {
        doSearch(inputBuffer);
        if (searchResults.length > 0 && searchCursor < searchResults.length) {
          const song = searchResults[searchCursor];
          if (searchTarget === 'add-singer') {
            // Switch to name input after picking song
            nameInputFor = song;
            nameInputMode = true;
            nameInputBuffer = '';
            renderSearch();
            return;
          }
          inputMode = false;
          render();
          if (searchTarget === 'add-band') {
            doAction('add-band', song.slug).then(() => render());
          } else {
            doAction('add', song.slug).then(() => render());
          }
          return;
        }
        searchCursor = 0;
        renderSearch();
      } else if (ch === 127 || ch === 8) {
        inputBuffer = inputBuffer.slice(0, -1);
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => { doSearch(inputBuffer); renderSearch(); }, 80);
        renderSearch();
      } else if (ch >= 32 && ch <= 126) {
        inputBuffer += String.fromCharCode(ch);
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => { doSearch(inputBuffer); renderSearch(); }, 80);
        renderSearch();
      }
    }
    return;
  }

  // In confirm mode
  if (confirmMode) {
    for (const ch of chunk) {
      if (ch === 0x79 || ch === 0x59) { // y/Y
        const action = confirmAction;
        if (action === 'remove-singer') {
          const q = singerQueue.queue || [];
          if (confirmRemoveIndex >= 0 && confirmRemoveIndex < q.length) {
            const id = q[confirmRemoveIndex].id;
            apiPost('/api/singer/queue/' + encodeURIComponent(id), {}, 'DELETE');
          }
        } else if (action === 'remove-band') {
          apiPost('/api/band-queue/item/' + confirmRemoveIndex, {}, 'DELETE');
        } else if (action === 'kick-singer') {
          const q = singerQueue.queue || [];
          if (confirmRemoveIndex >= 0 && confirmRemoveIndex < q.length) {
            const name = q[confirmRemoveIndex].singer;
            apiPost('/api/singer/kick', { singer: name });
          }
        } else if (action === 'clear-round') {
          doAction('clear-round-confirm');
        }
        confirmMode = false;
        confirmItem = null;
        confirmRemoveIndex = -1;
        confirmAction = null;
        refreshState();
        render();
      } else { // anything else = cancel
        confirmMode = false;
        confirmItem = null;
        confirmRemoveIndex = -1;
        confirmAction = null;
        render();
      }
    }
    return;
  }

  // In wifi info mode
  if (showWifiInfo) {
    showWifiInfo = false;
    render();
    return;
  }

  // In setlist picker mode
  if (setlistMode) {
    if (chunk[0] === 0x1b && chunk.length >= 3 && chunk[1] === 0x5b) {
      const dir = chunk[2];
      if (dir === 0x41) { setlistCursor = Math.max(0, setlistCursor - 1); renderSetlistPicker(); }
      else if (dir === 0x42) { setlistCursor = Math.min(setlistList.length - 1, setlistCursor + 1); renderSetlistPicker(); }
      return;
    }
    for (const ch of chunk) {
      if (ch === 27) { setlistMode = false; render(); return; }
      if (ch === 13 && setlistList.length > 0 && setlistCursor < setlistList.length) {
        const selected = setlistList[setlistCursor];
        setlistMode = false;
        render();
        doAction('import-setlist', selected.name).then(() => render());
        return;
      }
    }
    return;
  }

  // In settings or export mode
  if (settingsMode || exportMode) {
    // Handle escape sequences (arrows) as a unit BEFORE byte-by-byte loop
    if (chunk[0] === 0x1b && chunk.length >= 3 && chunk[1] === 0x5b) {
      if (exportMode) { renderSettings(); return; }
      const dir = chunk[2];
      if (!settingsField) {
        if (dir === 0x41 || dir === 0x42) { // up/down — select setting
          if (!settingsCursor) settingsCursor = 'max_songs';
          else settingsCursor = settingsCursor === 'max_songs' ? 'bumper_vol' : 'max_songs';
          renderSettings();
        }
      }
      return;
    }
    // Export mode — type name
    if (exportMode) {
      for (const ch of chunk) {
        if (ch === 27) { exportMode = false; exportBuffer = ''; render(); return; }
        if (ch === 13) {
          const name = exportBuffer.trim();
          if (name) {
            exportMode = false;
            exportBuffer = '';
            render();
            doAction('export-setlist', name).then(() => render());
          }
          return;
        }
        if (ch === 127 || ch === 8) { exportBuffer = exportBuffer.slice(0, -1); renderSettings(); return; }
        if (ch >= 32 && ch <= 126) { exportBuffer += String.fromCharCode(ch); renderSettings(); }
      }
      return;
    }
    // Settings mode
    for (const ch of chunk) {
      if (ch === 27) {
        if (settingsField) { settingsField = null; settingsValue = ''; renderSettings(); }
        else { settingsMode = false; render(); }
        return;
      }
      if (ch === 13) {
        if (!settingsField) {
          // Enter on a setting — start editing it
          settingsField = settingsCursor;
          if (settingsCursor === 'max_songs') settingsValue = String(maxSongsBetweenBand);
          else if (settingsCursor === 'bumper_vol') settingsValue = String(bumperVolume);
          else if (settingsCursor === 'karaoke') {
            // Toggle karaoke immediately
            doAction('toggle-karaoke');
            renderSettings();
            return;
          }
          renderSettings();
        } else {
          // Save edited value
          if (settingsField === 'max_songs') {
            const val = parseInt(settingsValue);
            if (!isNaN(val) && val >= 0) {
              settingsMode = false;
              settingsField = null; settingsValue = ''; settingsCursor = 'max_songs';
              render();
              doAction('update-settings', { max_songs_between_band: val }).then(() => render());
            }
          } else if (settingsField === 'bumper_vol') {
            const val = parseInt(settingsValue);
            if (!isNaN(val) && val >= 5 && val <= 100) {
              adjustBumperVolume(val);
              settingsField = null; settingsValue = '';
              renderSettings();
            }
          }
        }
        return;
      }
      if (settingsField && ch === 127 || settingsField && ch === 8) {
        settingsValue = settingsValue.slice(0, -1);
        renderSettings();
        return;
      }
      if (settingsField && ch >= 0x30 && ch <= 0x39) {
        settingsValue += String.fromCharCode(ch);
        renderSettings();
      }
    }
    return;
  }

  // Normal mode key handling
  // Handle arrow keys in normal mode
  if (chunk[0] === 0x1b && chunk.length >= 3 && chunk[1] === 0x5b) {
    const dir = chunk[2];
    // → right = switch to queue panel
    if (dir === 0x43) { focus = 'queue'; render(); return; }
    // ← left = switch to now playing
    if (dir === 0x44) { focus = 'main'; render(); return; }
    // ↑ / ↓ in queue focus — navigate the displayed queue
    if (focus === 'queue' && (dir === 0x41 || dir === 0x42)) {
      const isSingers = queueView === 'singers';
      const q = isSingers ? (singerQueue.queue || []) : (queueState.band_queue || []);
      if (q.length === 0) return;
      if (isSingers) {
        if (dir === 0x41) singerCursor = Math.max(0, singerCursor - 1);
        else singerCursor = Math.min(q.length - 1, singerCursor + 1);
      } else {
        if (dir === 0x41) bandCursor = Math.max(0, bandCursor - 1);
        else bandCursor = Math.min(q.length - 1, bandCursor + 1);
      }
      render();
      return;
    }
    return;
  }

  for (const ch of chunk) {
    switch (ch) {
      case 0x71: case 0x51: bumperPost('stop'); stopServer(); process.stdout.write(SHOW); process.exit(0);
      case 0x4B: doAction('toggle-karaoke'); break; // Shift+K only
      case 0x4D: // Shift+M — stop bumper immediately
        if (!inputMode && !confirmMode && !setlistMode && !settingsMode && !exportMode) {
          bumperPost('stop').then(() => refreshBumper());
          log('Bumper: stopped immediately');
        }
        break;
      case 0x6D: // m — toggle bumper (play / graceful stop)
        if (!inputMode && !confirmMode && !setlistMode && !settingsMode && !exportMode) {
          if (bumperPlaying) {
            bumperPost('stop-graceful').then(() => refreshBumper());
            log('Bumper: stopping after current track');
          } else {
            bumperPost('play').then(() => refreshBumper());
            log(`Bumper: started (${bumperVolume}%)`);
          }
        }
        break;
      case 0x6F: doAction('toggle-external'); break; // o = toggle online/offline
      case 0x4F: doAction('retry-online'); break;    // O = retry internet detection
      case 0x65: doAction('sync-external'); break;    // e = sync now
      case 0x45: // E — export setlist (prompt for name)
        if (!setlistMode && !settingsMode && !exportMode) {
          exportMode = true;
          exportBuffer = '';
          renderSettings();
        }
        break;
      case 0x49: // I — import setlist
        if (!inputMode && !confirmMode && !showWifiInfo) {
          enterSetlistMode();
        }
        break;
      case 0x3F: // ? — settings
        if (!inputMode && !confirmMode && !showWifiInfo && !setlistMode) {
          enterSettingsMode();
        }
        break;
      case 0x09: // Tab — toggle queue view (singers ↔ setlist)
        if (focus === 'queue') {
          queueView = queueView === 'singers' ? 'setlist' : 'singers';
          render();
        }
        break;
      case 0x49: // I — import setlist
        if (inputMode || confirmMode || showWifiInfo) break;
        enterSetlistMode();
        break;
      case 0x42: // B — kick/ban singer (singers view only)
        if (focus === 'queue' && queueView === 'singers') {
          const q = singerQueue.queue || [];
          if (q.length > 0 && singerCursor >= 0 && singerCursor < q.length) {
            confirmMode = true;
            confirmRemoveIndex = singerCursor;
            confirmItem = { title: 'KICK ' + q[singerCursor].singer + ' (ban for this show)' };
            confirmAction = 'kick-singer';
            renderConfirm();
          }
        }
        break;
      case 0x70: case 0x50: // p/P — promote singer (only in singers mode)
        if (focus === 'queue' && queueView === 'singers') {
          const q = singerQueue.queue || [];
          if (q.length > 0 && singerCursor >= 0 && singerCursor < q.length) {
            doAction('promote', q[singerCursor].id);
          }
        }
        break;
      case 0x78: case 0x58: // x/X — remove from current queue
        if (focus === 'queue') {
          if (queueView === 'singers') {
            const q = singerQueue.queue || [];
            if (q.length > 0 && singerCursor >= 0 && singerCursor < q.length) {
              confirmMode = true;
              confirmRemoveIndex = singerCursor;
              confirmItem = { title: q[singerCursor].singer + ' — ' + q[singerCursor].song_title };
              confirmAction = 'remove-singer';
              renderConfirm();
            }
          } else {
            const sl = queueState.band_queue || [];
            if (sl.length > 0 && bandCursor >= 0 && bandCursor < sl.length) {
              doAction('remove-band', bandCursor);
              if (bandCursor >= sl.length - 1 && sl.length > 1) bandCursor = sl.length - 2;
            }
          }
        }
        break;
      case 0x6E: // n — load next
        if (!inputMode && !confirmMode && !setlistMode && !settingsMode && !exportMode)
          doAction('next');
        break;
      case 0x62: // b — load prev (lowercase b; B is kick in singers)
        if (!inputMode && !confirmMode && !setlistMode && !settingsMode && !exportMode)
          doAction('prev');
        break;
      case 0x20: // Space — play/stop
        if (!inputMode && !confirmMode && !setlistMode && !settingsMode && !exportMode) {
          if (queueState.status === 'playing') doAction('stop');
          else if (queueState.current_song) doAction('play');
          else doAction('start');
        }
        break;
      case 0x0D: // Enter — play on the fly (setlist view only)
        if (focus === 'queue' && queueView !== 'singers' && !inputMode && !confirmMode && !setlistMode && !settingsMode) {
          const sl = queueState.band_queue || [];
          if (sl.length > 0 && bandCursor >= 0 && bandCursor < sl.length) {
            doAction('play-now', bandCursor);
          }
        }
        break;
      case 0x63: case 0x43: // c/C — clear round (singers only, with confirm)
        if (focus === 'queue' && queueView === 'singers') {
          confirmMode = true;
          confirmItem = { title: `Clear Round ${singerQueue.round} (${(singerQueue.queue || []).length} singers)` };
          confirmAction = 'clear-round';
          renderConfirm();
        }
        break;
      case 0x61: case 0x41: // a/A — search + add
        if (focus === 'queue' && queueView === 'singers') {
          enterSearchMode('add-singer');
        } else if (focus === 'queue') {
          enterSearchMode('add-band');
        } else {
          enterSearchMode('add');
        }
        break;
      case 0x72: case 0x52: doAction('restart'); break;
      case 0x77: case 0x57: showWifiInfo = true; render(); break; // w/W = WiFi info
      case 0x53: // Shift+S — Start Show
        if (showMode === 'connected') {
          showMode = 'live';
          apiPost('/api/show-mode', { mode: 'live' }).catch(() => {});
          log('Show started — Dell HUD will activate');
          render();
        }
        break;
    }
  }
}

function detectLanIP() {
  try {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
    }
  } catch (e) {}
  return process.env.SHOW_IP || '127.0.0.1';
}

async function init() {
  // Parse CLI flags
  showMode = process.argv.includes('--live') ? 'live' : 'connected';

  if (!process.stdin.isTTY) {
    console.log('This TUI requires a terminal. Run: node scripts/tui.js');
    process.exit(1);
  }
  lanIP = detectLanIP();
  process.stdout.write(HIDE);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleInput);
  process.stdout.on('resize', () => { if (!inputMode && !nameInputMode && !confirmMode && !showWifiInfo && !setlistMode && !settingsMode && !exportMode) render(); else if (inputMode || nameInputMode) renderSearch(); else if (setlistMode) renderSetlistPicker(); else if (settingsMode || exportMode) renderSettings(); });
  process.on('exit', () => { process.stdout.write(SHOW); });
  process.on('SIGINT', () => { process.stdout.write(SHOW); process.exit(0); });
  process.on('SIGTERM', () => { process.stdout.write(SHOW); process.exit(0); });

  log('TUI started. Checking server...');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'data', 'config.json'), 'utf-8'));
    if (cfg.password) authToken = crypto.createHash('sha256').update(cfg.password).digest('hex');
    wifiSSID = cfg.wifi_ssid || '';
    wifiPassword = cfg.wifi_password || '';
  } catch (e) { log('Could not read config for auth'); }
  const alreadyRunning = await checkServer();
  if (!alreadyRunning) {
    log('Server not found. Starting...');
    startServer();
    await new Promise(r => setTimeout(r, 3000));
  }
  await loadSongCache();
  await refreshState();
  // Sync show mode to server
  apiPost('/api/show-mode', { mode: showMode }).catch(() => {});
  render();

  setInterval(async () => {
    await checkServer();
    await refreshState();
    if (!inputMode && !nameInputMode && !confirmMode && !showWifiInfo && !setlistMode && !settingsMode && !exportMode) render();
  }, 2000);
}

init();
