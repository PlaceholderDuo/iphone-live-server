const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { authRoutes, requireAuth, checkAuth } = require('./api/auth');
const { songsRoutes } = require('./api/songs');
const { queueRoutes } = require('./api/queue');
const { setlistRoutes } = require('./api/setlists');

const app = express();
const PORT = process.env.PORT || 3300;
const PUBLIC = path.resolve(__dirname, 'public');

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Crash prevention — log and keep running
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Device-Id, X-Auth-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Auth routes (no auth required)
authRoutes(app);

// Public pages (no auth)
app.get('/singer', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'singer.html'));
});

// Teleprompter — redirect to Stage HUD (synced with REAPER)
app.get('/teleprompter', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'teleprompter.html'));
});

// Dell kiosk page — redirect to Stage HUD
app.get('/dell.html', (req, res) => {
  const host = req.hostname || req.get('host')?.split(':')[0] || 'localhost';
  res.redirect(302, `http://${host}:3000/hud.html`);
});

// Auth-required pages
app.get(['/', '/band'], (req, res, next) => {
  const auth = checkAuth(req);
  if (auth.ok) {
    const page = req.path === '/' ? 'index.html' : req.path.slice(1) + '.html';
    res.sendFile(path.join(PUBLIC, page));
  } else {
    res.redirect('/login.html');
  }
});

app.use(express.static(PUBLIC));

// Health (no auth)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', port: PORT });
});

// Show mode — Dell TUI polls this before launching HUD
let showMode = 'connected';
app.get('/api/show-mode', (req, res) => {
  res.json({ mode: showMode });
});
app.post('/api/show-mode', (req, res) => {
  const { mode } = req.body;
  if (mode === 'connected' || mode === 'live') {
    showMode = mode;
    console.log(`Show mode: ${mode}`);
    res.json({ ok: true, mode });
  } else {
    res.status(400).json({ error: `Invalid mode: ${mode}` });
  }
});

// Require auth for most API routes (singer, song GETs, and auth bypass)
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/singer') || req.path.startsWith('/auth') || req.path.startsWith('/config') || req.path.startsWith('/health')) {
    return next();
  }
  // Song search/list GET is public (read-only metadata, needed by TUI)
  if (req.method === 'GET' && (req.path.startsWith('/songs'))) {
    return next();
  }
  // Queue read-only is public (needed by teleprompter kiosk + singer page + TUI)
  if (req.method === 'GET' && (req.path === '/queue' || req.path === '/queue/current' || req.path === '/band-queue' || req.path === '/setlists')) {
    return next();
  }
  requireAuth(req, res, next);
});

// Song routes
songsRoutes(app);

// Queue routes
queueRoutes(app);

// Setlist routes
setlistRoutes(app);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`iPhoneLiveServer running on http://0.0.0.0:${PORT}`);
  console.log(`  Main Show Control: http://localhost:${PORT}/`);
  console.log(`  Band View:         http://localhost:${PORT}/band`);
  console.log(`  Singer Queue:      http://localhost:${PORT}/singer`);
  console.log(`  Teleprompter:      http://localhost:${PORT}/teleprompter`);
});
