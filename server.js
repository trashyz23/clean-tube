const express = require('express');
const compression = require('compression');
const cors = require('cors');
const fetch = globalThis.fetch || require('node-fetch');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Persistent storage paths
const DATA_DIR = path.join(__dirname, 'data');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
const COOKIES_FILE = path.join(DATA_DIR, 'cookies.txt');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(LIBRARY_FILE)) {
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify({ tracks: {} }, null, 2), 'utf8');
}

app.use(cors());
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PIPED_INSTANCES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.nosebs.ru'
];

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://inv.tux.pizza',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be'
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 2800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json',
        ...(options.headers || {})
      }
    });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

/**
 * Parses duration strings like "3:45" or "1:02:10" into seconds
 */
function parseDurationText(text) {
  if (!text || typeof text !== 'string') return 0;
  const parts = text.split(':').map((n) => parseInt(n, 10));
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

/**
 * Direct YouTube InnerTube Search (Works 100% on Render/AWS Datacenter IPs in ~250ms, no cookies needed)
 */
async function searchYouTubeInnerTube(query) {
  const response = await fetchWithTimeout(
    'https://www.youtube.com/youtubei/v1/search?prettyPrint=false',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20250101.00.00',
            hl: 'en',
            gl: 'US'
          }
        }
      })
    },
    4500
  );

  if (!response.ok) throw new Error(`InnerTube search HTTP ${response.status}`);
  const data = await response.json();

  const results = [];
  const sections =
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];

  for (const section of sections) {
    const items = section?.itemSectionRenderer?.contents || [];
    for (const item of items) {
      const v = item.videoRenderer;
      if (!v || !v.videoId) continue;

      const title =
        v.title?.runs?.map((r) => r.text).join('') ||
        v.title?.simpleText ||
        'Untitled Track';
      const uploader =
        v.ownerText?.runs?.[0]?.text ||
        v.longBylineText?.runs?.[0]?.text ||
        'Unknown Artist';
      const durationText = v.lengthText?.simpleText || '';
      const duration = parseDurationText(durationText);

      results.push({
        id: v.videoId,
        title,
        uploader,
        duration,
        thumbnailUrl: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`
      });

      if (results.length >= 15) break;
    }
    if (results.length >= 15) break;
  }

  if (results.length === 0) throw new Error('No InnerTube search results');
  return { results, source: 'youtube-innertube' };
}

/**
 * Fetches Video Title & Artist in ~150ms via YouTube's public oEmbed API (Never blocked on Render)
 */
async function fetchVideoMetadataFast(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`
    )}&format=json`;
    const res = await fetchWithTimeout(url, {}, 3000);
    if (res.ok) {
      const data = await res.json();
      return {
        id: videoId,
        title: data.title || 'Untitled Track',
        uploader: data.author_name || 'Unknown Artist',
        duration: 0,
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      };
    }
  } catch (_) {}

  return {
    id: videoId,
    title: 'YouTube Track',
    uploader: 'YouTube Music',
    duration: 0,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  };
}

/**
 * Fast Parallel Direct Stream Resolver (Runs all Piped & Invidious instances in parallel with 2.5s cap)
 */
async function resolveDirectStreamFast(videoId) {
  const pipedTasks = PIPED_INSTANCES.map(async (instance) => {
    const res = await fetchWithTimeout(`${instance}/streams/${encodeURIComponent(videoId)}`, {}, 2500);
    if (!res.ok) throw new Error('Piped non-200');
    const data = await res.json();

    const muxed = (data.videoStreams || []).filter((s) => !s.videoOnly && s.url);
    const audio = (data.audioStreams || []).filter((s) => s.url);
    audio.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    const videoUrl = muxed[0]?.url || data.hls || null;
    const audioUrl = audio[0]?.url || videoUrl;
    if (!videoUrl && !audioUrl) throw new Error('No Piped URLs');

    return {
      id: videoId,
      title: data.title || 'Untitled Track',
      uploader: data.uploader || 'Unknown Artist',
      duration: data.duration || 0,
      thumbnailUrl: data.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      videoUrl,
      audioUrl,
      playbackMode: 'direct',
      source: `piped (${instance})`
    };
  });

  const invidiousTasks = INVIDIOUS_INSTANCES.map(async (instance) => {
    const res = await fetchWithTimeout(
      `${instance}/api/v1/videos/${encodeURIComponent(videoId)}`,
      {},
      2500
    );
    if (!res.ok) throw new Error('Invidious non-200');
    const data = await res.json();

    const muxed = (data.formatStreams || []).filter((f) => f.url);
    const audio = (data.adaptiveFormats || []).filter(
      (f) => f.type && f.type.startsWith('audio/') && f.url
    );
    if (muxed.length === 0 && audio.length === 0) throw new Error('No Invidious URLs');

    const toProxied = (rawUrl) => {
      if (!rawUrl) return null;
      const parsed = new URL(rawUrl);
      return `${instance}/latest_version?id=${encodeURIComponent(videoId)}&itag=${parsed.searchParams.get('itag')}&local=true`;
    };

    return {
      id: videoId,
      title: data.title || 'Untitled Track',
      uploader: data.author || 'Unknown Artist',
      duration: data.lengthSeconds || 0,
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      videoUrl: toProxied(muxed[0]?.url || audio[0]?.url),
      audioUrl: toProxied(audio[0]?.url || muxed[0]?.url),
      playbackMode: 'direct',
      source: `invidious (${instance})`
    };
  });

  return Promise.any([...pipedTasks, ...invidiousTasks]);
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
// Search, Related Songs & Stream Endpoints
// ============================================================================

app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Missing search query parameter "q"' });

  try {
    const innerTubeResults = await searchYouTubeInnerTube(query);
    return res.json(innerTubeResults);
  } catch (err) {
    return res.status(502).json({ error: `Search failed: ${err.message}` });
  }
});

app.get('/api/related/:id', async (req, res) => {
  const videoId = extractVideoId(req.params.id);
  const fallbackQuery = (req.query.q || '').trim();

  if (!videoId) return res.status(400).json({ error: 'Invalid video ID' });

  // Use InnerTube search to find similar/mix songs by the same artist/track
  try {
    let searchQuery = fallbackQuery;
    if (!searchQuery) {
      const meta = await fetchVideoMetadataFast(videoId);
      searchQuery = `${meta.uploader} ${meta.title}`;
    }
    const searchData = await searchYouTubeInnerTube(`${searchQuery} mix`);
    const related = (searchData.results || []).filter((item) => item.id !== videoId);
    return res.json({ related, source: 'youtube-mix' });
  } catch (err) {
    return res.json({ related: [], source: 'none' });
  }
});

app.get('/api/stream/:query', async (req, res) => {
  const rawInput = (req.params.query || req.query.url || '').trim();
  if (!rawInput) return res.status(400).json({ error: 'Missing video ID, URL, or search query' });

  let videoId = extractVideoId(rawInput);

  if (!videoId) {
    try {
      const searchData = await searchYouTubeInnerTube(rawInput);
      if (searchData.results && searchData.results.length > 0) {
        videoId = searchData.results[0].id;
      }
    } catch (_) {}
  }

  if (!videoId) {
    return res.status(404).json({ error: 'Could not find a matching video ID' });
  }

  const attachLibraryMeta = (streamData) => {
    const lib = readLibrary();
    streamData.playCount = lib.tracks[streamData.id]?.playCount || 0;
    streamData.favorite = Boolean(lib.tracks[streamData.id]?.favorite);
    return streamData;
  };

  // 1. Try Fast Parallel Direct Stream Resolution (2.5s max wait)
  try {
    const directData = await resolveDirectStreamFast(videoId);
    return res.json(attachLibraryMeta(directData));
  } catch (_) {
    // 2. Instant Cloud Fallback: Return metadata + embed mode so playback starts immediately on Render
    const meta = await fetchVideoMetadataFast(videoId);
    const relatedQuery = `${meta.uploader} ${meta.title}`;
    let related = [];
    try {
      const relSearch = await searchYouTubeInnerTube(`${relatedQuery} song`);
      related = (relSearch.results || []).filter((item) => item.id !== videoId);
    } catch (_) {}

    return res.json(
      attachLibraryMeta({
        ...meta,
        videoUrl: null,
        audioUrl: null,
        related,
        playbackMode: 'embed',
        source: 'youtube-direct-player'
      })
    );
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Express 4 & Express 5 compatible SPA catch-all
app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CleanTube Hybrid Server running at http://0.0.0.0:${PORT}`);
});