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

// Persistent storage path for Most Watched / Music Library
const DATA_DIR = path.join(__dirname, 'data');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');

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

// Fallback Piped & Invidious instances (also dynamically updated at runtime)
let PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.private.coffee',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.nosebs.ru',
  'https://pipedapi.drgns.space'
];

let INVIDIOUS_INSTANCES = [
  'https://inv.tux.pizza',
  'https://invidious.nerdvpn.de',
  'https://inv.nadeko.net',
  'https://invidious.jing.rocks',
  'https://yewtu.be'
];

// Path to yt-dlp binary (system PATH or auto-downloaded to /tmp/yt-dlp)
let YTDLP_BIN = 'yt-dlp';

/**
 * Automatically downloads standalone yt-dlp binary to /tmp/yt-dlp
 * if the cloud deployment environment (e.g. Render/Railway Node buildpack) doesn't have it.
 */
async function ensureYtDlpBinary() {
  const checkCmd = (bin) =>
    new Promise((resolve) => {
      execFile(bin, ['--version'], { timeout: 5000 }, (err) => resolve(!err));
    });

  if (await checkCmd('yt-dlp')) {
    YTDLP_BIN = 'yt-dlp';
    console.log('[Startup] Found system yt-dlp binary.');
    return;
  }

  const tmpBin = path.join(os.tmpdir(), os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.existsSync(tmpBin) && (await checkCmd(tmpBin))) {
    YTDLP_BIN = tmpBin;
    console.log(`[Startup] Using cached yt-dlp binary at ${tmpBin}`);
    return;
  }

  console.log('[Startup] System yt-dlp not found. Downloading standalone binary to /tmp...');
  const downloadUrl =
    os.platform() === 'win32'
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : os.platform() === 'darwin'
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'
      : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

  try {
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmpBin, buffer, { mode: 0o755 });
    fs.chmodSync(tmpBin, 0o755);
    YTDLP_BIN = tmpBin;
    console.log(`[Startup] Successfully installed yt-dlp to ${tmpBin}`);
  } catch (err) {
    console.error('[Startup] Failed to auto-download yt-dlp:', err.message);
  }
}

/**
 * Dynamically refreshes healthy Piped & Invidious instances on startup
 */
async function refreshPublicInstances() {
  try {
    const res = await fetchWithTimeout('https://piped-instances.kavin.rocks/', 5000);
    if (res.ok) {
      const list = await res.json();
      const discovered = list
        .filter((i) => i.api_url && i.up_to_date !== false)
        .map((i) => i.api_url.replace(/\/$/, ''));
      if (discovered.length > 0) {
        PIPED_INSTANCES = [...new Set([...discovered.slice(0, 8), ...PIPED_INSTANCES])];
        console.log(`[Startup] Loaded ${PIPED_INSTANCES.length} Piped instances.`);
      }
    }
  } catch (_) {}
}

ensureYtDlpBinary();
refreshPublicInstances();

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
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json'
      }
    });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

function buildYtDlpArgs(extraArgs) {
  const baseArgs = [
    '--no-warnings',
    '--geo-bypass',
    '--extractor-args',
    'youtube:player_client=ios,mweb,tv_embedded,web'
  ];
  if (fs.existsSync(COOKIES_FILE)) {
    baseArgs.push('--cookies', COOKIES_FILE);
  }
  return [...baseArgs, ...extraArgs];
}

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

/**
 * Search via Piped -> Invidious -> yt-dlp
 */
async function searchWithPipedOrInvidious(query) {
  // 1. Try Piped
  for (const instance of PIPED_INSTANCES) {
    try {
      const url = `${instance}/search?q=${encodeURIComponent(query)}&filter=videos`;
      const response = await fetchWithTimeout(url, 4000);
      if (!response.ok) continue;
      const data = await response.json();
      const items = normalizePipedItems(data.items);
      if (items.length > 0) {
        return { results: items, source: `piped (${instance})` };
      }
    } catch (_) {}
  }

  // 2. Try Invidious API
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const url = `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video`;
      const response = await fetchWithTimeout(url, 4000);
      if (!response.ok) continue;
      const data = await response.json();
      if (!Array.isArray(data)) continue;

      const items = data
        .filter((item) => item.videoId)
        .map((item) => ({
          id: item.videoId,
          title: item.title || 'Untitled Track',
          uploader: item.author || 'Unknown Artist',
          duration: item.lengthSeconds || 0,
          thumbnailUrl: `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
          views: item.viewCount || 0
        }));

      if (items.length > 0) {
        return { results: items, source: `invidious (${instance})` };
      }
    } catch (_) {}
  }

  throw new Error('All Piped and Invidious search instances failed');
}

function searchWithYtDlp(query, maxResults = 12) {
  return new Promise((resolve, reject) => {
    const searchArg = `ytsearch${maxResults}:${query}`;
    execFile(
      YTDLP_BIN,
      buildYtDlpArgs(['--flat-playlist', '--dump-json', searchArg]),
      { maxBuffer: 1024 * 1024 * 10, timeout: 20000 },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          const lines = stdout
            .trim()
            .split('\n')
            .filter((line) => line.trim().length > 0);

          const results = lines.map((line) => {
            const item = JSON.parse(line);
            return {
              id: item.id,
              title: item.title || 'Untitled Track',
              uploader: item.uploader || item.channel || 'Unknown Artist',
              duration: item.duration || 0,
              thumbnailUrl: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
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
 * 1. Resolve streams via Piped API
 */
async function resolveStreamWithPiped(videoId) {
  for (const instance of PIPED_INSTANCES) {
    try {
      const response = await fetchWithTimeout(`${instance}/streams/${encodeURIComponent(videoId)}`, 4200);
      if (!response.ok) continue;

      const data = await response.json();
      if (data.error) continue;

      const muxedStreams = (data.videoStreams || []).filter((s) => s.videoOnly === false && s.url);
      muxedStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      const audioStreams = (data.audioStreams || []).filter((s) => s.url);
      audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      const videoUrl = muxedStreams[0]?.url || data.hls || null;
      const audioUrl = audioStreams[0]?.url || muxedStreams[0]?.url || data.hls || null;

      if (!videoUrl && !audioUrl) continue;

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
    } catch (_) {}
  }
  throw new Error('All Piped stream instances failed');
}

/**
 * 2. Resolve streams via Invidious API (with ?local=true stream proxying)
 */
async function resolveStreamWithInvidious(videoId) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const response = await fetchWithTimeout(
        `${instance}/api/v1/videos/${encodeURIComponent(videoId)}`,
        4200
      );
      if (!response.ok) continue;

      const data = await response.json();
      if (!data.formatStreams && !data.adaptiveFormats) continue;

      // Invidious supports ?local=true to proxy the stream through the Invidious server (bypasses IP lock)
      const toLocalProxyUrl = (rawUrl) => {
        if (!rawUrl) return null;
        try {
          const parsed = new URL(rawUrl);
          if (parsed.hostname.includes('googlevideo.com')) {
            return `${instance}/latest_version?id=${encodeURIComponent(videoId)}&itag=${parsed.searchParams.get('itag')}&local=true`;
          }
          return rawUrl;
        } catch (_) {
          return rawUrl;
        }
      };

      const muxed = (data.formatStreams || []).filter((f) => f.url);
      const audio = (data.adaptiveFormats || []).filter(
        (f) => f.type && f.type.startsWith('audio/') && f.url
      );
      audio.sort((a, b) => ( parseInt(b.bitrate, 10) || 0 ) - ( parseInt(a.bitrate, 10) || 0 ));

      const rawVideo = muxed[muxed.length - 1]?.url || null;
      const rawAudio = audio[0]?.url || rawVideo;

      if (!rawVideo && !rawAudio) continue;

      const related = (data.recommendedVideos || [])
        .filter((v) => v.videoId && v.videoId !== videoId)
        .map((v) => ({
          id: v.videoId,
          title: v.title || 'Recommended Track',
          uploader: v.author || 'Unknown Artist',
          duration: v.lengthSeconds || 0,
          thumbnailUrl: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`
        }));

      return {
        id: videoId,
        title: data.title || 'Untitled Track',
        uploader: data.author || 'Unknown Artist',
        duration: data.lengthSeconds || 0,
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        videoUrl: toLocalProxyUrl(rawVideo || rawAudio),
        audioUrl: toLocalProxyUrl(rawAudio || rawVideo),
        hlsUrl: data.hlsUrl || null,
        related,
        source: `invidious (${instance})`
      };
    } catch (_) {}
  }
  throw new Error('All Invidious instances failed');
}

/**
 * 3. Resolve streams via local yt-dlp binary (wraps URLs in /api/proxy to bypass IP-binding)
 */
function resolveStreamWithYtDlp(queryOrId) {
  return new Promise((resolve, reject) => {
    const cleanId = extractVideoId(queryOrId);
    const target = cleanId ? `https://www.youtube.com/watch?v=${cleanId}` : `ytsearch1:${queryOrId}`;

    execFile(
      YTDLP_BIN,
      buildYtDlpArgs(['--dump-json', '--no-playlist', target]),
      { maxBuffer: 1024 * 1024 * 15, timeout: 25000 },
      (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(stderr || error.message));
        }
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

          const rawVideoUrl = bestMuxed ? bestMuxed.url : data.url || null;
          const rawAudioUrl = bestAudio ? bestAudio.url : rawVideoUrl;

          if (!rawVideoUrl && !rawAudioUrl) {
            return reject(new Error('No playable media formats found by yt-dlp'));
          }

          // Proxy googlevideo URLs through our server so cloud IP-locked URLs work on client browsers
          const wrapProxy = (u) => (u ? `/api/proxy?url=${encodeURIComponent(u)}` : null);

          resolve({
            id: data.id || cleanId,
            title: data.title || 'Untitled Track',
            uploader: data.uploader || data.channel || 'Unknown Artist',
            duration: data.duration || 0,
            thumbnailUrl: data.thumbnail || `https://i.ytimg.com/vi/${data.id}/hqdefault.jpg`,
            videoUrl: wrapProxy(rawVideoUrl),
            audioUrl: wrapProxy(rawAudioUrl),
            hlsUrl: null,
            related: [],
            source: 'yt-dlp (proxied)'
          });
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    );
  });
}

/**
 * Byte-Range Media Stream Proxy (/api/proxy?url=...)
 * Ensures streams extracted by the cloud server's IP play without 403 Forbidden on user devices.
 */
app.get('/api/proxy', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url parameter');

  try {
    const parsed = new URL(targetUrl);
    if (!parsed.hostname.endsWith('googlevideo.com') && !parsed.hostname.endsWith('youtube.com')) {
      return res.status(403).send('Proxy only permits media stream domains');
    }

    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    };
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const proxyReq = https.get(targetUrl, { headers }, (proxyRes) => {
      res.status(proxyRes.statusCode || 200);
      const forwardHeaders = [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'cache-control'
      ];
      forwardHeaders.forEach((h) => {
        if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]);
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.status(502).send(err.message);
    });

    req.on('close', () => proxyReq.destroy());
  } catch (err) {
    res.status(400).send('Invalid stream URL');
  }
});

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
// Related / Similar Videos Endpoint
// ============================================================================

app.get('/api/related/:id', async (req, res) => {
  const videoId = extractVideoId(req.params.id);
  const fallbackQuery = (req.query.q || '').trim();

  if (!videoId) return res.status(400).json({ error: 'Invalid video ID' });

  // 1. Try Piped
  for (const instance of PIPED_INSTANCES) {
    try {
      const response = await fetchWithTimeout(`${instance}/streams/${encodeURIComponent(videoId)}`, 3800);
      if (!response.ok) continue;
      const data = await response.json();
      const related = normalizePipedItems(data.relatedStreams).filter((item) => item.id !== videoId);
      if (related.length > 0) return res.json({ related, source: `piped (${instance})` });
    } catch (_) {}
  }

  // 2. Try Invidious recommendedVideos
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const response = await fetchWithTimeout(
        `${instance}/api/v1/videos/${encodeURIComponent(videoId)}`,
        3800
      );
      if (!response.ok) continue;
      const data = await response.json();
      const related = (data.recommendedVideos || [])
        .filter((v) => v.videoId && v.videoId !== videoId)
        .map((v) => ({
          id: v.videoId,
          title: v.title || 'Recommended Track',
          uploader: v.author || 'Unknown Artist',
          duration: v.lengthSeconds || 0,
          thumbnailUrl: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`
        }));
      if (related.length > 0) return res.json({ related, source: `invidious (${instance})` });
    } catch (_) {}
  }

  // 3. Fallback to keyword search for similar artist/tracks
  if (fallbackQuery) {
    try {
      const searchFallback = await searchWithPipedOrInvidious(fallbackQuery);
      const filtered = (searchFallback.results || []).filter((item) => item.id !== videoId);
      return res.json({ related: filtered, source: searchFallback.source });
    } catch (_) {}
  }

  res.json({ related: [], source: 'none' });
});

// ============================================================================
// Search & Stream Resolution Endpoints
// ============================================================================

app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Missing search query parameter "q"' });

  try {
    const apiResults = await searchWithPipedOrInvidious(query);
    return res.json(apiResults);
  } catch (_) {
    try {
      const ytdlpResults = await searchWithYtDlp(query);
      return res.json(ytdlpResults);
    } catch (ytdlpErr) {
      return res.status(502).json({
        error: `Search failed: ${ytdlpErr.message}`
      });
    }
  }
});

app.get('/api/stream/:query', async (req, res) => {
  const rawInput = (req.params.query || req.query.url || '').trim();
  if (!rawInput) return res.status(400).json({ error: 'Missing video ID, URL, or search query' });

  let videoId = extractVideoId(rawInput);

  if (!videoId) {
    try {
      const searchData = await searchWithPipedOrInvidious(rawInput);
      if (searchData.results && searchData.results.length > 0) {
        videoId = searchData.results[0].id;
      }
    } catch (_) {}
  }

  const attachLibraryMeta = (streamData) => {
    const lib = readLibrary();
    streamData.playCount = lib.tracks[streamData.id]?.playCount || 0;
    streamData.favorite = Boolean(lib.tracks[streamData.id]?.favorite);
    return streamData;
  };

  // 1. Try Piped Instances
  if (videoId) {
    try {
      const pipedData = await resolveStreamWithPiped(videoId);
      return res.json(attachLibraryMeta(pipedData));
    } catch (_) {}

    // 2. Try Invidious Instances
    try {
      const invData = await resolveStreamWithInvidious(videoId);
      return res.json(attachLibraryMeta(invData));
    } catch (_) {}
  }

  // 3. Try Local / Auto-Downloaded yt-dlp with Stream Proxy
  try {
    const fallbackData = await resolveStreamWithYtDlp(videoId || rawInput);
    return res.json(attachLibraryMeta(fallbackData));
  } catch (ytdlpError) {
    return res.status(502).json({
      error: `Stream resolution failed (${ytdlpError.message.slice(0, 140)})`,
      details: ytdlpError.message
    });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', ytdlpBin: YTDLP_BIN, timestamp: new Date().toISOString() });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CleanTube Cloud-Ready Server running at http://0.0.0.0:${PORT}`);
});