const fs = require('fs');
const path = require('path');

const SONGS_DIR = path.resolve(process.env.HOME, 'ReaperSongs');
const GENRE_MAP_PATH = path.resolve(__dirname, '..', '..', 'data', 'genre-map.json');

function loadGenreMap() {
  try {
    return JSON.parse(fs.readFileSync(GENRE_MAP_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function listSongs() {
  if (!fs.existsSync(SONGS_DIR)) return [];
  return fs.readdirSync(SONGS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => ({ slug: e.name, path: path.join(SONGS_DIR, e.name) }));
}

function getSong(slug) {
  const songPath = path.join(SONGS_DIR, slug);
  if (!fs.existsSync(songPath)) return null;
  const metaPath = path.join(songPath, 'meta.json');
  const meta = fs.existsSync(metaPath)
    ? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    : null;
  return { slug, meta };
}

function buildSongIndex() {
  const entries = listSongs();
  const genreMap = loadGenreMap();
  return entries.map(entry => {
    const info = getSong(entry.slug);
    const m = info?.meta || {};
    const slug = slugify(m.title || entry.slug);
    return {
      slug: entry.slug,
      title: m.title || entry.slug,
      artist: m.artist || 'Unknown',
      bpm: m.bpm || 0,
      key: m.key || '',
      genres: genreMap[slug] || genreMap[entry.slug] || [],
      tuning: m.tuning || '',
      capo: m.capo || '',
      difficulty: m.difficulty || '',
      duration_bars: m.duration_bars || 0
    };
  });
}

function songsRoutes(app) {
  app.get('/api/songs', (req, res) => {
    try {
      const index = buildSongIndex();
      res.json({ songs: index, count: index.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/songs/search', (req, res) => {
    try {
      const { q, sort, genre, artist, key, page, per_page } = req.query;
      let results = buildSongIndex();

      if (q) {
        const lower = q.toLowerCase();
        results = results.filter(s =>
          s.title.toLowerCase().includes(lower) ||
          s.artist.toLowerCase().includes(lower) ||
          s.key.toLowerCase().includes(lower)
        );
      }

      if (genre) {
        const genres = genre.split(',').map(g => g.trim().toLowerCase());
        results = results.filter(s =>
          s.genres.some(g => genres.includes(g.toLowerCase()))
        );
      }

      if (artist) {
        const lower = artist.toLowerCase();
        results = results.filter(s => s.artist.toLowerCase().includes(lower));
      }

      if (key) {
        const lower = key.toLowerCase();
        results = results.filter(s => s.key.toLowerCase() === lower);
      }

      if (sort === 'title') {
        results.sort((a, b) => a.title.localeCompare(b.title));
      } else if (sort === 'artist') {
        results.sort((a, b) => a.artist.localeCompare(b.artist));
      } else if (sort === 'key') {
        results.sort((a, b) => a.key.localeCompare(b.key));
      } else if (sort === 'bpm') {
        results.sort((a, b) => a.bpm - b.bpm);
      } else {
        results.sort((a, b) => a.title.localeCompare(b.title));
      }

      const pageNum = Math.max(1, parseInt(page) || 1);
      const perPage = Math.min(200, Math.max(1, parseInt(per_page) || 100));
      const total = results.length;
      const start = (pageNum - 1) * perPage;
      const paged = results.slice(start, start + perPage);

      res.json({
        songs: paged,
        count: paged.length,
        total,
        page: pageNum,
        per_page: perPage,
        pages: Math.ceil(total / perPage)
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/songs/genres', (req, res) => {
    try {
      const genreMap = loadGenreMap();
      const allGenres = new Set();
      Object.values(genreMap).forEach(gs => gs.forEach(g => allGenres.add(g)));
      res.json({ genres: [...allGenres].sort() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/songs/:slug', (req, res) => {
    try {
      const info = getSong(req.params.slug);
      if (!info) return res.status(404).json({ error: 'Song not found' });
      const genreMap = loadGenreMap();
      const slug = slugify(info.meta?.title || req.params.slug);
      const genres = genreMap[slug] || genreMap[req.params.slug] || [];
      res.json({ ...info, genres });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { songsRoutes, getSong, listSongs, buildSongIndex, slugify };
