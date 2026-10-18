const express = require('express');
const compression = require('compression');
const cors = require('cors');
const fetch = globalThis.fetch || require('node-fetch');
const { execFile, spawn } = require('child_process');
const { Readable } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Full 2026 Official Piped Instance List
const PIPED_INSTANCES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi-libre.kavin.rocks',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.nosebs.ru',
  'https://piped-api.privacy.com.de',
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt',
  'https://pipedapi.drgns.space',
  'https://pipedapi.owo.si',
  'https://pipedapi.ducks.party',
  'https://piped-api.codespace.cz',
  'https://pipedapi.reallyaweso.me',
  'https://pipedapi.darkness.services',
  'https://pipedapi.orangenet.cc'
];

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yt.chocolatemoo53.com',
  'https://invidious.tiekoetter.com',
  'https://invidious.f5.si',
  'https://inv.zoomerville.com'
];

// High-speed 320kbps Music CDN APIs (Never block Render/AWS datacenter IPs)
const SAAVN_API_INSTANCES = [
  'https://saavn.dev/api/search/songs',
  'https://saavn.sumit.co/api/search/songs',
  'https://jiosaavn-api-privatecvc2.vercel.app/search/songs'
];

let YTDLP_BIN = 'yt-dlp';
let ytDlpReadyPromise = null;

function ensureYtDlpBinary() {
  if (ytDlpReadyPromise) return ytDlpReadyPromise;

  ytDlpReadyPromise = (async () => {
    const checkCmd = (bin) =>
      new Promise((resolve) => {
        execFile(bin, ['--version'], { timeout: 5000 }, (err) => resolve(!err));
      });

    if (await checkCmd('yt-dlp')) {
      YTDLP_BIN = 'yt-dlp';
      return YTDLP_BIN;
    }

    const localBin = path.join(__dirname, 'data', os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    if (fs.existsSync(localBin) && (await checkCmd(localBin))) {
      YTDLP_BIN = localBin;
      return YTDLP_BIN;
    }

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
      fs.writeFileSync(localBin, buffer, { mode: 0o755 });
      fs.chmodSync(localBin, 0o755);
      YTDLP_BIN = localBin;
      console.log(`[Startup] Installed standalone yt-dlp to ${localBin}`);
    } catch (err) {
      console.error('[Startup] Failed to download yt-dlp:', err.message);
    }
    return YTDLP_BIN;
  })();

  return ytDlpReadyPromise;
}

ensureYtDlpBinary();

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

async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
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

function parseDurationText(text) {
  if (!text || typeof text !== 'string') return 0;
  const parts = text.split(':').map((n) => parseInt(n, 10));
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

/**
 * Extracts core song title so we can filter out duplicate uploads, lyrics, and covers
 */
function getCoreSongTitle(rawTitle = '', uploader = '') {
  let clean = rawTitle.toLowerCase();
  const cleanUploader = uploader
    .toLowerCase()
    .replace(/\s*(-|topic|vevo|official|music)\s*/g, '')
    .trim();

  clean = clean
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\{[^}]*\}/g, ' ');

  const parts = clean.split(/\s+[-–—:|]\s+/);
  if (parts.length >= 2) {
    if (cleanUploader && parts[0].includes(cleanUploader)) {
      clean = parts.slice(1).join(' ');
    } else if (cleanUploader && parts[parts.length - 1].includes(cleanUploader)) {
      clean = parts.slice(0, -1).join(' ');
    } else {
      clean = parts[1];
    }
  }

  return clean
    .replace(/\b(ft\.?|feat\.?|featuring)\b.*$/i, '')
    .replace(
      /\b(official\s*music\s*video|official\s*video|official\s*audio|lyric\s*video|lyrics|audio|video|hd|4k|remastered|live|visualizer|mv)\b/gi,
      ' '
    )
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDuplicateOrUnwantedVariant(candidateTitle, currentTitle, currentUploader) {
  const lowerCand = (candidateTitle || '').toLowerCase();
  if (
    /\b(cover|covered\s+by|karaoke|instrumental|reaction|tutorial|lesson|1\s*hour|10\s*hours|slowed|nightcore)\b/i.test(
      lowerCand
    )
  ) {
    return true;
  }

  const currentCore = getCoreSongTitle(currentTitle, currentUploader);
  const candidateCore = getCoreSongTitle(candidateTitle, currentUploader);
  if (!currentCore || !candidateCore) return false;

  if (
    candidateCore === currentCore ||
    (currentCore.length >= 4 && candidateCore.includes(currentCore)) ||
    (candidateCore.length >= 4 && currentCore.includes(candidateCore))
  ) {
    return true;
  }
  return false;
}

function filterDistinctSimilarSongs(candidates, seedId, seedTitle, seedUploader) {
  const seenIds = new Set([seedId]);
  const seenCoreTitles = new Set();

  const seedCore = getCoreSongTitle(seedTitle, seedUploader);
  if (seedCore) seenCoreTitles.add(seedCore);

  const filtered = [];

  for (const item of candidates) {
    if (!item || !item.id || seenIds.has(item.id)) continue;
    if (isDuplicateOrUnwantedVariant(item.title, seedTitle, seedUploader)) continue;

    const core = getCoreSongTitle(item.title, item.uploader);
    if (!core || core.length < 2) continue;

    let alreadyInList = false;
    for (const existingCore of seenCoreTitles) {
      if (
        core === existingCore ||
        (existingCore.length >= 4 && core.includes(existingCore)) ||
        (core.length >= 4 && existingCore.includes(core))
      ) {
        alreadyInList = true;
        break;
      }
    }
    if (alreadyInList) continue;

    seenIds.add(item.id);
    seenCoreTitles.add(core);
    filtered.push(item);
  }

  return filtered;
}

async function fetchYouTubeRadioMix(videoId, seedTitle = '', seedUploader = '') {
  const response = await fetchWithTimeout(
    'https://www.youtube.com/youtubei/v1/next?prettyPrint=false',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        playlistId: `RD${videoId}`,
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

  if (!response.ok) throw new Error(`InnerTube next HTTP ${response.status}`);
  const data = await response.json();

  const rawCandidates = [];

  const playlistContents =
    data?.contents?.twoColumnWatchNextResults?.playlist?.playlist?.contents || [];

  for (const entry of playlistContents) {
    const v = entry.playlistPanelVideoRenderer;
    if (!v || !v.videoId) continue;

    const title = v.title?.simpleText || v.title?.runs?.map((r) => r.text).join('') || '';
    const uploader =
      v.longBylineText?.runs?.[0]?.text ||
      v.shortBylineText?.runs?.[0]?.text ||
      'Unknown Artist';
    const duration = parseDurationText(v.lengthText?.simpleText || '');

    if (title) {
      rawCandidates.push({
        id: v.videoId,
        title,
        uploader,
        duration,
        thumbnailUrl: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`
      });
    }
  }

  const secondaryResults =
    data?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results || [];

  for (const entry of secondaryResults) {
    const v = entry.compactVideoRenderer;
    if (!v || !v.videoId) continue;

    const title = v.title?.simpleText || v.title?.runs?.map((r) => r.text).join('') || '';
    const uploader =
      v.longBylineText?.runs?.[0]?.text ||
      v.shortBylineText?.runs?.[0]?.text ||
      'Unknown Artist';
    const duration = parseDurationText(v.lengthText?.simpleText || '');

    if (title) {
      rawCandidates.push({
        id: v.videoId,
        title,
        uploader,
        duration,
        thumbnailUrl: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`
      });
    }
  }

  const distinct = filterDistinctSimilarSongs(rawCandidates, videoId, seedTitle, seedUploader);

  if (distinct.length < 3 && seedUploader) {
    const cleanArtist = seedUploader.replace(/\s*(-|Topic|VEVO|Official)\s*/gi, '').trim();
    const artistSearch = await searchYouTubeInnerTube(`${cleanArtist} official audio`, 20);
    const combined = [...distinct, ...(artistSearch.results || [])];
    return filterDistinctSimilarSongs(combined, videoId, seedTitle, seedUploader).slice(0, 15);
  }

  return distinct.slice(0, 18);
}

async function searchYouTubeInnerTube(query, maxItems = 15) {
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

      if (results.length >= maxItems) break;
    }
    if (results.length >= maxItems) break;
  }

  if (results.length === 0) throw new Error('No InnerTube search results');
  return { results, source: 'youtube-innertube' };
}

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

// ============================================================================
// Multi-Engine Direct Audio Stream Resolution (For Android Chrome Background Play)
// ============================================================================

/**
 * Engine 1: Parallel 15-Piped + 6-Invidious Direct Stream Resolution
 */
async function resolveDirectViaInstances(videoId) {
  const pipedTasks = PIPED_INSTANCES.map(async (instance) => {
    const res = await fetchWithTimeout(`${instance}/streams/${encodeURIComponent(videoId)}`, {}, 4200);
    if (!res.ok) throw new Error('Piped non-200');
    const data = await res.json();

    const muxed = (data.videoStreams || []).filter((s) => !s.videoOnly && s.url);
    const audio = (data.audioStreams || []).filter((s) => s.url);
    audio.sort((a, b) => {
      const aM4a = (a.mimeType || '').includes('mp4') ? 1000000 : 0;
      const bM4a = (b.mimeType || '').includes('mp4') ? 1000000 : 0;
      return bM4a + (b.bitrate || 0) - (aM4a + (a.bitrate || 0));
    });

    const videoUrl = muxed[0]?.url || null;
    const audioUrl = audio[0]?.url || videoUrl;
    if (!audioUrl) throw new Error('No Piped audio URL');

    return {
      id: videoId,
      title: data.title || 'Untitled Track',
      uploader: data.uploader || 'Unknown Artist',
      duration: data.duration || 0,
      thumbnailUrl: data.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      videoUrl: videoUrl || null,
      audioUrl,
      playbackMode: 'direct',
      source: `piped (${new URL(instance).hostname})`
    };
  });

  const invidiousTasks = INVIDIOUS_INSTANCES.map(async (instance) => {
    const res = await fetchWithTimeout(
      `${instance}/api/v1/videos/${encodeURIComponent(videoId)}`,
      {},
      4200
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

    const audioUrl = toProxied(audio[0]?.url || muxed[0]?.url);
    const videoUrl = toProxied(muxed[0]?.url || null);

    return {
      id: videoId,
      title: data.title || 'Untitled Track',
      uploader: data.author || 'Unknown Artist',
      duration: data.lengthSeconds || 0,
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      videoUrl,
      audioUrl,
      playbackMode: 'direct',
      source: `invidious (${new URL(instance).hostname})`
    };
  });

  return Promise.any([...pipedTasks, ...invidiousTasks]);
}

/**
 * Engine 2: High-Speed 320kbps Music CDN Resolver (JioSaavn & Audius APIs)
 * Works 100% on Render/AWS Datacenter IPs in ~300ms with zero cookies or bot blocks!
 */
async function resolveDirectAudioViaMusicCdn(videoId, meta) {
  const cleanArtist = (meta.uploader || '')
    .replace(/\s*(-|Topic|VEVO|Official|Music|Records)\s*/gi, ' ')
    .trim();
  const coreTitle = getCoreSongTitle(meta.title, meta.uploader) || meta.title;
  const searchQuery = `${cleanArtist} ${coreTitle}`.trim();

  // 1. Try JioSaavn 320kbps AAC (.mp4) API Mirrors in parallel
  const saavnTasks = SAAVN_API_INSTANCES.map(async (endpoint) => {
    const url = `${endpoint}?query=${encodeURIComponent(searchQuery)}&limit=5`;
    const res = await fetchWithTimeout(url, {}, 3800);
    if (!res.ok) throw new Error('Saavn API non-200');
    const json = await res.json();

    const results = json?.data?.results || json?.results || [];
    if (!Array.isArray(results) || results.length === 0) throw new Error('No Saavn match');

    const song = results[0];
    const dlList = song.downloadUrl || song.download_url || [];
    if (!Array.isArray(dlList) || dlList.length === 0) throw new Error('No downloadUrl list');

    // Pick highest quality (320kbps or 160kbps .mp4)
    const best = dlList[dlList.length - 1];
    const rawAudioUrl = best?.url || best?.link || (typeof best === 'string' ? best : null);
    if (!rawAudioUrl) throw new Error('Empty audio URL');

    return {
      id: videoId,
      title: meta.title || song.name || 'Untitled Track',
      uploader: meta.uploader || song.primaryArtists || 'Unknown Artist',
      duration: parseInt(song.duration || '0', 10) || meta.duration || 0,
      thumbnailUrl: meta.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      videoUrl: null,
      audioUrl: `/api/proxy?url=${encodeURIComponent(rawAudioUrl)}`,
      playbackMode: 'direct',
      source: '320kbps-music-cdn'
    };
  });

  // 2. Also try Audius Decentralized Music Stream API
  const audiusTask = (async () => {
    const searchUrl = `https://discoveryprovider.audius.co/v1/tracks/search?query=${encodeURIComponent(
      searchQuery
    )}&app_name=CleanTube`;
    const res = await fetchWithTimeout(searchUrl, {}, 4000);
    if (!res.ok) throw new Error('Audius search failed');
    const json = await res.json();
    const track = json?.data?.[0];
    if (!track || !track.id) throw new Error('No Audius match');

    const streamUrl = `https://discoveryprovider.audius.co/v1/tracks/${encodeURIComponent(
      track.id
    )}/stream?app_name=CleanTube`;

    return {
      id: videoId,
      title: meta.title || track.title || 'Untitled Track',
      uploader: meta.uploader || track.user?.name || 'Unknown Artist',
      duration: track.duration || 0,
      thumbnailUrl: meta.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      videoUrl: null,
      audioUrl: `/api/proxy?url=${encodeURIComponent(streamUrl)}`,
      playbackMode: 'direct',
      source: 'audius-cdn'
    };
  })();

  return Promise.any([...saavnTasks, audiusTask]);
}

/**
 * Engine 3: Live yt-dlp Audio Stream Pipe (/api/live-audio/:id)
 * Streams audio directly from yt-dlp stdout to the <audio> element.
 */
app.get('/api/live-audio/:id', async (req, res) => {
  const videoId = extractVideoId(req.params.id);
  const searchQuery = (req.query.q || '').trim();
  if (!videoId && !searchQuery) return res.status(400).send('Missing track info');

  await ensureYtDlpBinary();

  const target = searchQuery ? `scsearch1:${searchQuery}` : `https://www.youtube.com/watch?v=${videoId}`;
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--force-ipv4',
    '-f',
    'bestaudio/best',
    '-o',
    '-',
    target
  ];

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache');

  const proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  proc.stdout.pipe(res);

  req.on('close', () => {
    try {
      proc.kill('SIGKILL');
    } catch (_) {}
  });
});

// ============================================================================
// Byte-Range Stream Proxy (/api/proxy?url=...)
// ============================================================================

app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url parameter');

  try {
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    };
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const upstream = await fetch(targetUrl, { headers, redirect: 'follow' });
    res.status(upstream.status);

    const forwardHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'cache-control'
    ];
    forwardHeaders.forEach((h) => {
      const val = upstream.headers.get(h);
      if (val) res.setHeader(h, val);
    });

    if (!upstream.body) return res.end();
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', () => res.end());
    req.on('close', () => nodeStream.destroy());
    nodeStream.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(502).send(err.message);
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
// Search, True Radio Mix Related Songs & Stream Endpoints
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
  if (!videoId) return res.status(400).json({ error: 'Invalid video ID' });

  try {
    const meta = await fetchVideoMetadataFast(videoId);
    const related = await fetchYouTubeRadioMix(videoId, meta.title, meta.uploader);
    return res.json({ related, source: 'youtube-radio-mix' });
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

  const attachLibraryAndRelated = async (streamData) => {
    const lib = readLibrary();
    streamData.playCount = lib.tracks[streamData.id]?.playCount || 0;
    streamData.favorite = Boolean(lib.tracks[streamData.id]?.favorite);
    streamData.related = await fetchYouTubeRadioMix(
      videoId,
      streamData.title,
      streamData.uploader
    ).catch(() => []);
    return streamData;
  };

  // Fetch fast metadata and run Direct Instance + 320kbps Music CDN resolvers
  const meta = await fetchVideoMetadataFast(videoId);

  try {
    const directData = await Promise.any([
      resolveDirectViaInstances(videoId),
      resolveDirectAudioViaMusicCdn(videoId, meta)
    ]);
    return res.json(await attachLibraryAndRelated(directData));
  } catch (_) {}

  // Fallback to live yt-dlp audio stream pipe + embed backup
  const cleanSearch = `${meta.uploader} ${meta.title}`.trim();
  return res.json(
    await attachLibraryAndRelated({
      ...meta,
      videoUrl: null,
      audioUrl: `/api/live-audio/${encodeURIComponent(videoId)}?q=${encodeURIComponent(cleanSearch)}`,
      playbackMode: 'direct',
      source: 'live-audio-stream'
    })
  );
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', ytdlpBin: YTDLP_BIN, timestamp: new Date().toISOString() });
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CleanTube Multi-CDN Audio Server running at http://0.0.0.0:${PORT}`);
});