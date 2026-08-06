const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

let config = null;
const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'data', 'config.json');

function loadConfig() {
  if (!config) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  }
  return config;
}

function checkAuth(req) {
  const cfg = loadConfig();
  const deviceId = req.headers['x-device-id'] || req.cookies?.device_id;
  if (deviceId && cfg.devices && cfg.devices[deviceId] && !cfg.devices[deviceId].requires_auth) {
    return { ok: true, device: deviceId, whitelisted: true };
  }
  if (deviceId && cfg.whitelist && cfg.whitelist.includes(deviceId)) {
    return { ok: true, device: deviceId, whitelisted: true };
  }
  const token = req.cookies?.auth_token || req.headers['x-auth-token'];
  if (token) {
    const hash = crypto.createHash('sha256').update(cfg.password).digest('hex');
    if (token === hash) {
      return { ok: true, token: true };
    }
  }
  return { ok: false };
}

function requireAuth(req, res, next) {
  const auth = checkAuth(req);
  if (auth.ok) {
    req.auth = auth;
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized', needsAuth: true });
  }
  if (req.path.startsWith('/singer')) {
    return next();
  }
  res.redirect('/login.html');
}

function authRoutes(app) {
  app.post('/api/auth/login', (req, res) => {
    const cfg = loadConfig();
    const { password } = req.body || {};
    if (password === cfg.password) {
      const hash = crypto.createHash('sha256').update(cfg.password).digest('hex');
      res.cookie('auth_token', hash, { maxAge: 86400000 * 7, httpOnly: true });
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'Invalid password' });
  });

  app.get('/api/auth/status', (req, res) => {
    res.json(checkAuth(req));
  });

  app.get('/api/config', (req, res) => {
    const cfg = loadConfig();
    res.json({
      tip_url: cfg.tip_url,
      device_id: cfg.device_id,
      has_password: !!cfg.password,
      karaoke_enabled: cfg.karaoke_enabled !== false,
      karaoke_paused_message: cfg.karaoke_paused_message || '',
      max_songs_between_band: cfg.max_songs_between_band || 8
    });
  });

  app.post('/api/config/update', (req, res) => {
    const cfg = loadConfig();
    const { max_songs_between_band } = req.body || {};
    if (max_songs_between_band !== undefined) {
      cfg.max_songs_between_band = Math.max(0, parseInt(max_songs_between_band) || 0);
    }
    saveConfig(cfg);
    res.json({ ok: true, max_songs_between_band: cfg.max_songs_between_band });
  });

  app.get('/api/config/teleprompter', (req, res) => {
    const cfg = loadConfig();
    const defaults = {
      scroll_device: 'none',
      left_button_mode: 'rewind_5s',
      right_button_mode: 'skip_5s',
      third_button_mode: 'pause',
      chord_color_mode: 'circle'
    };
    res.json(Object.assign({}, defaults, cfg.teleprompter || {}));
  });

  app.post('/api/config/teleprompter', (req, res) => {
    const cfg = loadConfig();
    const { scroll_device, left_button_mode, right_button_mode, third_button_mode, chord_color_mode } = req.body || {};
    if (!cfg.teleprompter) cfg.teleprompter = {};
    if (scroll_device !== undefined) cfg.teleprompter.scroll_device = scroll_device;
    if (left_button_mode !== undefined) cfg.teleprompter.left_button_mode = left_button_mode;
    if (right_button_mode !== undefined) cfg.teleprompter.right_button_mode = right_button_mode;
    if (third_button_mode !== undefined) cfg.teleprompter.third_button_mode = third_button_mode;
    if (chord_color_mode !== undefined && (chord_color_mode === 'circle' || chord_color_mode === 'flavor')) {
      cfg.teleprompter.chord_color_mode = chord_color_mode;
    }
    saveConfig(cfg);
    res.json({ ok: true, teleprompter: cfg.teleprompter });
  });

  app.get('/api/config/tempo-sync', (req, res) => {
    const cfg = loadConfig();
    const defaults = {
      beat1_behavior: 'no_distinction',
      beat_color: 'green'
    };
    res.json(Object.assign({}, defaults, cfg.tempo_sync || {}));
  });

  app.post('/api/config/tempo-sync', (req, res) => {
    const cfg = loadConfig();
    const { beat1_behavior, beat_color } = req.body || {};
    if (!cfg.tempo_sync) cfg.tempo_sync = {};
    if (beat1_behavior !== undefined) cfg.tempo_sync.beat1_behavior = beat1_behavior;
    if (beat_color !== undefined) cfg.tempo_sync.beat_color = beat_color;
    saveConfig(cfg);
    res.json({ ok: true, tempo_sync: cfg.tempo_sync });
  });
}

function saveConfig(cfg) {
  config = cfg;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

module.exports = { loadConfig, saveConfig, checkAuth, requireAuth, authRoutes };
