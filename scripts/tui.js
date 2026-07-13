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
let queueState = { main_queue: [], current_index: -1, current_song: null, status: 'stopped' };
let singerQueue = { queue: [], round: 1 };
let reaperState = { currentSong: null, position: 0, bpm: 0, nextSong: null, playing: false };
let externalStatus = { external_pending: 0, total_pending: 0, sync_enabled: true };
let logs = [];
let songCache = [];
let karaokeEnabled = true;
let karaokePausedMsg = '';

// UI state
let focus = 'main';
let queueCursor = 0;
let inputMode = false;
let confirmMode = false;
let confirmItem = null;
let confirmRemoveIndex = -1;
let confirmAction = null;
let inputBuffer = '';
let searchResults = [];
let searchCursor = 0;
let searchDebounce = null;
let showWifiInfo = false;
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

function apiPost(path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const opts = {
      hostname: 'localhost', port: SERVER_PORT, path,
      method: 'POST',
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
    if (queueCursor >= (q.main_queue || []).length) queueCursor = Math.max(0, q.main_queue.length - 1);
  }
  const sq = await apiGet('/api/singer/queue');
  if (sq) singerQueue = sq;
  const es = await apiGet('/api/singer/external-status');
  if (es) externalStatus = es;
  const ks = await apiGet('/api/singer/status');
  if (ks) { karaokeEnabled = ks.karaoke_enabled; karaokePausedMsg = ks.karaoke_paused_message || ''; }
  // Poll REAPER state from port 3000
  await refreshReaperState();
  // Poll connected clients
  await refreshClients();
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
    case 'promote':
      if (arg) result = await apiPost('/api/singer/promote', { id: arg });
      break;
    case 'remove':
      if (arg !== undefined) result = await apiPost('/api/queue/remove-multiple', { indexes: [arg] });
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
      else if (action === 'clear-round') log(`Round ${result.round || '?'} cleared`);
      else if (action === 'add') {
        const song = songCache.find(s => s.slug === arg);
        log(`Added: ${song?.title || arg}`);
        focus = 'queue';
        queueCursor = singerQueue.queue.length - 1;
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
  if (inputMode) { renderSearch(); return; }
  if (confirmMode) { renderConfirm(); return; }
  if (showWifiInfo) { renderWiFiInfo(); return; }

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 30;
  const w = cols;

  let out = HIDE;

  // Title bar
  const icon = serverRunning ? (GREEN + '●' + RESET) : (RED + '●' + RESET);
  out += ESC + '1;1H' + BG_ORANGE + ' '.repeat(w) + RESET;
  out += ESC + '1;2H' + WHITE + BOLD + ' ♪ LIVE SHOW SERVER  ' + RESET + DIM + WHITE + 'v1.0' + RESET;
  const modeBadge = showMode === 'live' ? (GREEN + 'LIVE' + RESET) : (ORANGE + 'CONNECTED' + RESET);
  const focusTag = focus === 'queue' ? ' [' + CYAN + 'QUEUE' + RESET + ']' : '';
  const onlineTag = externalStatus.online_detected ? (GREEN + ' ONLINE' + RESET) : (YELLOW + ' OFFLINE' + RESET);
  out += ESC + '1;' + (w - 40) + 'H' + '[' + modeBadge + ']' + focusTag + '  ' + onlineTag + '  ' + icon + ' ' + (serverRunning ? 'RUNNING' : 'STOPPED') + ' :' + SERVER_PORT + RESET;

  const lw = Math.floor((w - 3) / 2);
  const rw = w - 3 - lw;
  const ct = 3, ch = 7;

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
    if (npHighlight) out += drawText(ct + 5, 3, DIM + '(← → to switch panels)' + RESET);
  } else {
    out += drawText(ct + 2, 3, DIM + 'REAPER not connected' + RESET);
    out += drawText(ct + 3, 3, DIM + 'Start REAPER + load show project' + RESET);
    if (npHighlight) out += drawText(ct + 5, 3, DIM + '(→ to singer queue)' + RESET);
  }

  // Singer Queue panel
  const qr = lw + 2;
  const qHighlight = focus === 'queue';
  out += drawBox(ct, qr, rw, ch, `SINGERS (${singerQueue.queue?.length || 0})`, qHighlight);
  const q = singerQueue.queue || [];
  const mv = ch - 2;
  let scrollStart = qHighlight ? Math.max(0, Math.min(queueCursor - Math.floor(mv / 2), Math.max(0, q.length - mv))) : 0;
  scrollStart = Math.max(0, Math.min(scrollStart, Math.max(0, q.length - mv)));

  for (let i = 0; i < mv; i++) {
    const idx = scrollStart + i;
    if (idx >= q.length) { out += drawText(ct + 1 + i, qr + 2, ' '.repeat(rw - 4)); continue; }
    const item = q[idx];
    const isCursor = qHighlight && idx === queueCursor;
    const n = (idx + 1 + '').padStart(2);
    const cursorMark = isCursor ? (INV + ' ' + RESET) : ' ';
    const style = isCursor ? (INV + BOLD) : DIM;
    const name = (item.singer || '?').substring(0, rw - 20);
    const song = ((item.song_title || '?') + ' — ' + (item.song_artist || '')).substring(0, rw - 10);
    out += drawText(ct + 1 + i, qr + 1, style + cursorMark + ' ' + n + '. ' + name + '  ' + DIM + song + RESET);
  }
  if (q.length === 0) out += drawText(ct + 3, qr + 2, DIM + 'No singers waiting' + RESET);

  // Stats bar
  const st = ct + ch;
  out += ESC + st + ';1H' + BG_ORANGE + ' '.repeat(w) + RESET;
  const sc = singerQueue.queue?.length || 0;
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
    `Singers ${WHITE}${BOLD}${sc}${RESET}${WHITE}  Round ${singerQueue.round || 1} ${DIM}·${WHITE} ` +
    `Ext ${WHITE}${BOLD}${extPend}${RESET}${WHITE} ${syncLabel} ${DIM}·${WHITE} Karaoke ${karaokeIcon}${WHITE} ${DIM}·${WHITE} ${modeLabel}${WHITE} ${DIM}·${WHITE} ${dellStr}` +
    (reaperState.currentSong ? ` ${DIM}·${WHITE} ${GREEN + reaperState.currentSong.substring(0,20) + RESET}` : '') + RESET);
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
  const navKeys = focus === 'queue'
    ? `${BOLD}[↑↓]${RESET} Navigate  ${BOLD}[→]${RESET} REAPER`
    : `${BOLD}[→]${RESET} Singers`;
  const queueKeys = focus === 'queue'
    ? `${BOLD}[p]${RESET} Promote  ${BOLD}[x]${RESET} Remove  ${BOLD}[c]${RESET} Round  ${BOLD}[a]${RESET} Add`
    : `${BOLD}[p]${RESET} Promote  ${BOLD}[a]${RESET} Search+Add`;
  const row1 = `${navKeys}  ${queueKeys}  ${BOLD}[w]${RESET} WiFi  ${BOLD}[r]${RESET} Restart  ${BOLD}[q]${RESET} Quit${showMode === 'connected' ? `  ${BOLD}[s]${RESET} Start Show` : ''}`;
  const row2 = `${karaokeLabel}  ${netLabel}  ${BOLD}[e]${RESET} Sync`;
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
  const boxH = Math.min(rows - 2, 22);
  const boxTop = Math.max(1, Math.floor((rows - boxH) / 2));

  out += drawBox(boxTop, 2, w - 3, boxH, 'SEARCH & ADD');
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

  let out = HIDE;

  // Draw normal screen dimmed
  const origFocus = focus;
  focus = 'queue';
  inputMode = false;
  // Just draw a simple confirm overlay
  const boxW = Math.min(50, w - 4);
  const boxH = 5;
  const bx = Math.floor((w - boxW) / 2);
  const by = Math.floor(rows / 2) - 2;

  // Semi-transparent overlay effect by redrawing content first
  out += HIDE;

  // Overlay box
  out += drawBox(by, bx, boxW, boxH, '');
  out += drawText(by + 1, bx + 2, BOLD + `Remove "${(confirmItem?.title || 'this song').substring(0, boxW - 14)}"?` + RESET);
  out += drawText(by + 3, bx + 2, DIM + '  y  Yes    n  No (Esc)' + RESET);

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

function doSearch(query) {
  const q = query.toLowerCase().trim();
  if (!q) { searchResults = []; searchCursor = 0; return; }
  searchResults = songCache.filter(s =>
    s.title.toLowerCase().includes(q) ||
    s.artist.toLowerCase().includes(q)
  ).slice(0, 50);
  if (searchCursor >= searchResults.length) searchCursor = Math.max(0, searchResults.length - 1);
}

function enterSearchMode() {
  inputMode = true;
  inputBuffer = '';
  searchResults = [];
  searchCursor = 0;
  renderSearch();
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

  // In search mode
  if (inputMode) {
    for (const ch of chunk) {
      if (ch === 27) { inputMode = false; render(); return; }
      else if (ch === 13) {
        doSearch(inputBuffer);
        if (searchResults.length > 0 && searchCursor < searchResults.length) {
          const song = searchResults[searchCursor];
          inputMode = false;
          render();
          doAction('add', song.slug).then(() => render());
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

  // Normal mode key handling
  // Handle arrow keys in normal mode
  if (chunk[0] === 0x1b && chunk.length >= 3 && chunk[1] === 0x5b) {
    const dir = chunk[2];
    // → right = switch to queue
    if (dir === 0x43) { focus = 'queue'; render(); return; }
    // ← left = switch to now playing
    if (dir === 0x44) { focus = 'main'; render(); return; }
    // ↑ / ↓ in queue focus
    if (focus === 'queue' && (dir === 0x41 || dir === 0x42)) {
      const q = queueState.main_queue || [];
      if (q.length === 0) return;
      if (dir === 0x41) queueCursor = Math.max(0, queueCursor - 1); // Up
      else queueCursor = Math.min(q.length - 1, queueCursor + 1);   // Down
      render();
      return;
    }
    return;
  }

  for (const ch of chunk) {
    switch (ch) {
      case 0x71: case 0x51: stopServer(); process.stdout.write(SHOW); process.exit(0);
      case 0x4B: doAction('toggle-karaoke'); break; // Shift+K only
      case 0x6F: doAction('toggle-external'); break; // o = toggle online/offline
      case 0x4F: doAction('retry-online'); break;    // O = retry internet detection
      case 0x65: doAction('sync-external'); break;    // e = sync now
      case 0x70: case 0x50: // p/P — promote singer
        if (focus === 'queue') {
          const q = singerQueue.queue || [];
          if (q.length > 0 && queueCursor >= 0 && queueCursor < q.length) {
            doAction('promote', q[queueCursor].id);
          }
        }
        break;
      case 0x78: case 0x58: // x/X — remove singer
        if (focus === 'queue') {
          const q = singerQueue.queue || [];
          if (q.length > 0 && queueCursor >= 0 && queueCursor < q.length) {
            confirmMode = true;
            confirmItem = { title: q[queueCursor].singer + ' — ' + q[queueCursor].song_title };
            confirmRemoveIndex = queueCursor;
            confirmAction = 'remove-singer';
            renderConfirm();
          }
        }
        break;
      case 0x63: case 0x43: // c/C — clear round
        if (focus === 'queue') doAction('clear-round');
        break;
      case 0x61: case 0x41: enterSearchMode(); break;
      case 0x72: case 0x52: doAction('restart'); break;
      case 0x77: case 0x57: showWifiInfo = true; render(); break; // w/W = WiFi info
      case 0x73: case 0x53: // s/S — Start Show
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
  process.stdout.on('resize', () => { if (!inputMode && !confirmMode && !showWifiInfo) render(); else if (inputMode) renderSearch(); });
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
    if (!inputMode && !confirmMode && !showWifiInfo) render();
  }, 2000);
}

init();
