const path = require('path');
const fs = require('fs');

const SETLISTS_DIR = path.resolve(__dirname, '..', '..', 'data', 'setlists');

function getSetlistFile(name) {
  if (path.extname(name)) return path.join(SETLISTS_DIR, name);
  return path.join(SETLISTS_DIR, name + '.txt');
}

function listSetlists() {
  if (!fs.existsSync(SETLISTS_DIR)) return [];
  return fs.readdirSync(SETLISTS_DIR)
    .filter(f => (f.endsWith('.txt') || f.endsWith('.md')) && f !== '.gitkeep')
    .map(f => {
      const stat = fs.statSync(path.join(SETLISTS_DIR, f));
      const slugCount = countSongs(f);
      return { name: f, label: f.replace(/\.(txt|md)$/, ''), songs: slugCount, size: stat.size, modified: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

function countSongs(filename) {
  try {
    const content = fs.readFileSync(path.join(SETLISTS_DIR, filename), 'utf-8');
    return content.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .length;
  } catch { return 0; }
}

function exportSetlist(name, songs) {
  const filePath = getSetlistFile(name);
  const lines = [`# ${name} — exported ${new Date().toISOString().split('T')[0]}`, ''];
  for (const s of songs) {
    lines.push(s.slug);
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  return { file: path.basename(filePath), songs: songs.length };
}

function importSetlist(name) {
  const filePath = getSetlistFile(name);
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf-8');
  const slugs = content.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
  return { file: path.basename(filePath), slugs };
}

function deleteSetlist(name) {
  const filePath = getSetlistFile(name);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

function setlistRoutes(app) {
  app.get('/api/setlists', (req, res) => {
    res.json({ setlists: listSetlists() });
  });

  app.post('/api/setlists/export', (req, res) => {
    const { name, songs } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
    if (!Array.isArray(songs) || songs.length === 0) return res.status(400).json({ error: 'songs array required' });
    const result = exportSetlist(name.trim(), songs);
    res.json({ ok: true, ...result });
  });

  app.post('/api/setlists/import', (req, res) => {
    const { name, mode } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const result = importSetlist(name);
    if (!result) return res.status(404).json({ error: 'Setlist not found' });
    const songsApi = require('./songs');
    const { loadQueue, saveQueue } = require('./queue');
    const q = loadQueue();
    const added = [];
    const failed = [];
    for (const slug of result.slugs) {
      const info = songsApi.getSong(slug);
      if (info && info.meta) {
        added.push({
          slug,
          title: info.meta.title || slug,
          artist: info.meta.artist || 'Unknown',
          key: info.meta.key || '',
          bpm: info.meta.bpm || 0,
          timestamp: Date.now() + added.length
        });
      } else {
        failed.push(slug);
      }
    }
    if (mode === 'replace') {
      q.band_queue = added;
    } else {
      if (!q.band_queue) q.band_queue = [];
      q.band_queue.push(...added);
    }
    saveQueue(q);
    res.json({ ok: true, file: result.file, added: added.length, total: result.slugs.length, failed, band_queue: q.band_queue });
  });

  app.delete('/api/setlists/:name', (req, res) => {
    const name = req.params.name;
    const ok = deleteSetlist(name);
    if (!ok) return res.status(404).json({ error: 'Setlist not found' });
    res.json({ ok: true });
  });
}

module.exports = { setlistRoutes, listSetlists };
