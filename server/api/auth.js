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
      karaoke_paused_message: cfg.karaoke_paused_message || ''
    });
  });
}

function saveConfig(cfg) {
  config = cfg;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

module.exports = { loadConfig, saveConfig, checkAuth, requireAuth, authRoutes };
