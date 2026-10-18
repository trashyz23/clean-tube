const express = require('express');
const compression = require('compression');
const cors = require('cors');
const fetch = globalThis.fetch || require('node-fetch');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Persistent storage path for Most Watched / Music Library
const DATA_DIR = path.join(__dirname, 'data');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(LIBRARY_FILE)) {
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify({ tracks: {} }, null, 2), 'utf8');
}

app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.syncpundit.io'
];

function readLibrary() {
  try {
    const raw = fs.readFileSync(LIBRARY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.tracks === 'object' ? parsed : { tracks: {} };
  } catch (_) {
    return { tracks: {} };
  }
}

function writeLibrary(data) {
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function extractVideoId(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();

  const urlRegex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = trimmed.match(urlRegex);
  if (match && match[1]) return match[1];

  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

async function fetchWithTimeout(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'CleanTube-SelfHosted/1.0' }
    });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

/**
 * Normalizes Piped stream items (used for both search results and relatedStreams)
 */
function normalizePipedItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => (item.type === 'stream' || !item.type) && item.url)
    .map((item) => {
      const idMatch = item.url.match(/v=([^&]+)/);
      const videoId = idMatch ? idMatch[1] : extractVideoId(item.url);
      return {
        id: videoId,
        title: item.title || 'Untitled Track',
        uploader: item.uploaderName || item.uploader || 'Unknown Artist',
        duration: typeof item.duration === 'number' ? item.duration : 0,
        thumbnailUrl: item.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        views: item.views || 0
      };
    })
    .filter((item) => Boolean(item.id) && item.duration > 0);
}

async function searchWithPiped(query) {
  for (const instance of PIPED_INSTANCES) {
    try {
      const url = `${instance}/search?q=${encodeURIComponent(query)}&filter=videos`;
      const response = await fetchWithTimeout(url, 4500);
      if (!response.ok) continue;

      const data = await response.json();
      const items = normalizePipedItems(data.items);

      if (items.length > 0) {
        return { results: items, source: `piped (${instance})` };
      }
    } catch (_) {
      // Try next instance
    }
  }
  throw new Error('All Piped search instances failed');
}

function searchWithYtDlp(query, maxResults = 12) {
  return new Promise((resolve, reject) => {
    const searchArg = `ytsearch${maxResults}:${query}`;
    execFile(
      'yt-dlp',
      ['--flat-playlist', '--dump-json', '--no-warnings', searchArg],
      { maxBuffer: 1024 * 1024 * 10, timeout: 15000 },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          const lines = stdout
            .trim()
            .split('\n')
            .filter((line) => line.trim().length > 0);

          const results = lines.map((line) => {
            const item = JSON.parse(line);
            const thumbnail =
              Array.isArray(item.thumbnails) && item.thumbnails.length > 0
                ? item.thumbnails[item.thumbnails.length - 1].url
                : `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`;

            return {
              id: item.id,
              title: item.title || 'Untitled Track',
              uploader: item.uploader || item.channel || 'Unknown Artist',
              duration: item.duration || 0,
              thumbnailUrl: thumbnail,
              views: item.view_count || 0
            };
          });

          resolve({ results, source: 'yt-dlp' });
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

/**
 * Fetches YouTube Radio Mix (RD<videoId>) via yt-dlp to get similar/recommended songs
 */
function fetchRadioMixWithYtDlp(videoId, fallbackQuery = '') {
  return new Promise((resolve, reject) => {
    const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
    execFile(
      'yt-dlp',
      ['--flat-playlist', '--dump-json', '--playlist-end', '15', '--no-warnings', mixUrl],
      { maxBuffer: 1024 * 1024 * 10, timeout: 15000 },
      async (error, stdout) => {
        if (!error && stdout && stdout.trim().length > 0) {
          try {
            const lines = stdout
              .trim()
              .split('\n')
              .filter((line) => line.trim().length > 0);

            const results = lines
              .map((line) => {
                const item = JSON.parse(line);
                const thumbnail =
                  Array.isArray(item.thumbnails) && item.thumbnails.length > 0
                    ? item.thumbnails[item.thumbnails.length - 1].url
                    : `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`;

                return {
                  id: item.id,
                  title: item.title || 'Recommended Track',
                  uploader: item.uploader || item.channel || 'YouTube Mix',
                  duration: item.duration || 0,
                  thumbnailUrl: thumbnail
                };
              })
              .filter((item) => item.id && item.id !== videoId);

            if (results.length > 0) {
              return resolve({ related: results, source: 'yt-dlp (Radio Mix)' });
            }
          } catch (_) {
            // Fall through to keyword search fallback
          }
        }

        // If Radio Mix isn't available for this video, search by artist/title
        if (fallbackQuery) {
          try {
            const searchFallback = await searchWithYtDlp(fallbackQuery, 12);
            const filtered = (searchFallback.results || []).filter((item) => item.id !== videoId);
            return resolve({ related: filtered, source: 'yt-dlp (Similar Search)' });
          } catch (searchErr) {
            return reject(searchErr);
          }
        }
        return reject(error || new Error('Could not resolve similar videos'));
      }
    );
  });
}

async function resolveStreamWithPiped(videoId) {
  for (const instance of PIPED_INSTANCES) {
    try {
      const response = await fetchWithTimeout(`${instance}/streams/${encodeURIComponent(videoId)}`, 4500);
      if (!response.ok) continue;

      const data = await response.json();

      const muxedStreams = (data.videoStreams || []).filter((s) => s.videoOnly === false && s.url);
      muxedStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      const audioStreams = (data.audioStreams || []).filter((s) => s.url);
      audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      const videoUrl = muxedStreams[0]?.url || data.hls || null;
      const audioUrl = audioStreams[0]?.url || muxedStreams[0]?.url || data.hls || null;

      if (!videoUrl && !audioUrl) continue;

      // Extract similar/recommended videos directly from Piped response
      const related = normalizePipedItems(data.relatedStreams).filter((item) => item.id !== videoId);

      return {
        id: videoId,
        title: data.title || 'Untitled Track',
        uploader: data.uploader || 'Unknown Artist',
        duration: data.duration || 0,
        thumbnailUrl: data.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        videoUrl,
        audioUrl,
        hlsUrl: data.hls || null,
        related,
        source: `piped (${instance})`
      };
    } catch (_) {
      // Try next instance
    }
  }
  throw new Error('All Piped stream instances failed');
}

function resolveStreamWithYtDlp(queryOrId) {
  return new Promise((resolve, reject) => {
    const cleanId = extractVideoId(queryOrId);
    const target = cleanId ? `https://www.youtube.com/watch?v=${cleanId}` : `ytsearch1:${queryOrId}`;

    execFile(
      'yt-dlp',
      ['--dump-json', '--no-playlist', '--no-warnings', target],
      { maxBuffer: 1024 * 1024 * 15, timeout: 20000 },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          const lines = stdout.trim().split('\n');
          const data = JSON.parse(lines[0]);
          const formats = data.formats || [];

          const muxedFormats = formats.filter(
            (f) =>
              f.vcodec &&
              f.vcodec !== 'none' &&
              f.acodec &&
              f.acodec !== 'none' &&
              f.url &&
              (f.ext === 'mp4' || f.ext === 'webm')
          );
          muxedFormats.sort((a, b) => (a.height || 0) - (b.height || 0));
          const bestMuxed = muxedFormats[muxedFormats.length - 1];

          const audioFormats = formats.filter(
            (f) =>
              (!f.vcodec || f.vcodec === 'none') &&
              f.acodec &&
              f.acodec !== 'none' &&
              f.url &&
              (f.ext === 'm4a' || f.ext === 'webm' || f.ext === 'mp4')
          );
          audioFormats.sort((a, b) => (a.abr || a.tbr || 0) - (b.abr || b.tbr || 0));
          const bestAudio = audioFormats[audioFormats.length - 1];

          const resolvedVideoUrl = bestMuxed ? bestMuxed.url : data.url || null;
          const resolvedAudioUrl = bestAudio ? bestAudio.url : resolvedVideoUrl;

          if (!resolvedVideoUrl && !resolvedAudioUrl) {
            return reject(new Error('No playable media formats found by yt-dlp'));
          }

          resolve({
            id: data.id || cleanId,
            title: data.title || 'Untitled Track',
            uploader: data.uploader || data.channel || 'Unknown Artist',
            duration: data.duration || 0,
            thumbnailUrl: data.thumbnail || `https://i.ytimg.com/vi/${data.id}/hqdefault.jpg`,
            videoUrl: resolvedVideoUrl,
            audioUrl: resolvedAudioUrl,
            hlsUrl: null,
            related: [],
            source: 'yt-dlp'
          });
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    );
  });
}

// ============================================================================
// Music Library & Most Watched API Endpoints
// ============================================================================

app.get('/api/library', (_req, res) => {
  const lib = readLibrary();
  const list = Object.values(lib.tracks);

  const mostPlayed = [...list].sort((a, b) => {
    if ((b.playCount || 0) !== (a.playCount || 0)) {
      return (b.playCount || 0) - (a.playCount || 0);
    }
    return (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0);
  });

  const favorites = mostPlayed.filter((t) => Boolean(t.favorite));
  res.json({ mostPlayed, favorites });
});

app.post('/api/library/record', (req, res) => {
  const { id, title, uploader, duration, thumbnailUrl } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Missing video id' });

  const lib = readLibrary();
  const existing = lib.tracks[id] || {
    id,
    playCount: 0,
    favorite: false,
    firstPlayedAt: Date.now()
  };

  lib.tracks[id] = {
    ...existing,
    id,
    title: title || existing.title || 'Untitled Track',
    uploader: uploader || existing.uploader || 'Unknown Artist',
    duration: typeof duration === 'number' ? duration : existing.duration || 0,
    thumbnailUrl: thumbnailUrl || existing.thumbnailUrl || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    playCount: (existing.playCount || 0) + 1,
    lastPlayedAt: Date.now()
  };

  writeLibrary(lib);
  res.json({ track: lib.tracks[id] });
});

app.post('/api/library/favorite', (req, res) => {
  const { id, title, uploader, duration, thumbnailUrl } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Missing video id' });

  const lib = readLibrary();
  const existing = lib.tracks[id] || {
    id,
    title: title || 'Untitled Track',
    uploader: uploader || 'Unknown Artist',
    duration: duration || 0,
    thumbnailUrl: thumbnailUrl || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    playCount: 1,
    firstPlayedAt: Date.now(),
    lastPlayedAt: Date.now(),
    favorite: false
  };

  existing.favorite = !existing.favorite;
  lib.tracks[id] = existing;
  writeLibrary(lib);

  res.json({ track: existing });
});

app.delete('/api/library/:id', (req, res) => {
  const { id } = req.params;
  const lib = readLibrary();
  if (lib.tracks[id]) {
    delete lib.tracks[id];
    writeLibrary(lib);
  }
  res.json({ success: true });
});

// ============================================================================
// Related / Similar Videos Endpoint (For Autoplay Up Next)
// ============================================================================

app.get('/api/related/:id', async (req, res) => {
  const videoId = extractVideoId(req.params.id);
  const fallbackQuery = (req.query.q || '').trim();

  if (!videoId) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  // 1. Try Piped streams endpoint for relatedStreams
  for (const instance of PIPED_INSTANCES) {
    try {
      const response = await fetchWithTimeout(`${instance}/streams/${encodeURIComponent(videoId)}`, 4000);
      if (!response.ok) continue;
      const data = await response.json();
      const related = normalizePipedItems(data.relatedStreams).filter((item) => item.id !== videoId);
      if (related.length > 0) {
        return res.json({ related, source: `piped (${instance})` });
      }
    } catch (_) { }
  }

  // 2. Fallback to YouTube Radio Mix (RD<videoId>) via yt-dlp
  try {
    const mixData = await fetchRadioMixWithYtDlp(videoId, fallbackQuery);
    return res.json(mixData);
  } catch (err) {
    return res.status(502).json({ error: 'Failed to load similar tracks', details: err.message });
  }
});

// ============================================================================
// Search & Stream Endpoints
// ============================================================================

app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) {
    return res.status(400).json({ error: 'Missing search query parameter "q"' });
  }

  try {
    const pipedResults = await searchWithPiped(query);
    return res.json(pipedResults);
  } catch (_) {
    try {
      const ytdlpResults = await searchWithYtDlp(query);
      return res.json(ytdlpResults);
    } catch (ytdlpErr) {
      return res.status(502).json({
        error: 'Search failed across both Piped API and yt-dlp fallback.',
        details: ytdlpErr.message
      });
    }
  }
});

app.get('/api/stream/:query', async (req, res) => {
  const rawInput = (req.params.query || req.query.url || '').trim();
  if (!rawInput) {
    return res.status(400).json({ error: 'Missing video ID, URL, or search query' });
  }

  let videoId = extractVideoId(rawInput);

  if (!videoId) {
    try {
      const searchData = await searchWithPiped(rawInput);
      if (searchData.results && searchData.results.length > 0) {
        videoId = searchData.results[0].id;
      }
    } catch (_) { }
  }

  if (videoId) {
    try {
      const streamData = await resolveStreamWithPiped(videoId);
      const lib = readLibrary();
      streamData.playCount = lib.tracks[streamData.id]?.playCount || 0;
      streamData.favorite = Boolean(lib.tracks[streamData.id]?.favorite);
      return res.json(streamData);
    } catch (_) { }
  }

  try {
    const fallbackData = await resolveStreamWithYtDlp(videoId || rawInput);
    const lib = readLibrary();
    fallbackData.playCount = lib.tracks[fallbackData.id]?.playCount || 0;
    fallbackData.favorite = Boolean(lib.tracks[fallbackData.id]?.favorite);
    return res.json(fallbackData);
  } catch (ytdlpError) {
    return res.status(502).json({
      error: 'Unable to resolve media streams via Piped or yt-dlp.',
      details: ytdlpError.message
    });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get(/(.*)/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CleanTube Music & Autoplay Server running at http://0.0.0.0:${PORT}`);
});