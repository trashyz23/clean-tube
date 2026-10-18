// DOM Elements
const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');

const videoPlayer = document.getElementById('videoPlayer');
const bgAudioPlayer = document.getElementById('bgAudioPlayer');
const ytEmbedContainer = document.getElementById('ytEmbedContainer');
const artworkStage = document.getElementById('artworkStage');
const audioBarWrapper = document.getElementById('audioBarWrapper');
const overlayThumb = document.getElementById('overlayThumb');

const currentTitle = document.getElementById('currentTitle');
const currentUploader = document.getElementById('currentUploader');
const streamSourceBadge = document.getElementById('streamSourceBadge');
const favBtn = document.getElementById('favBtn');
const autoplaySimilarToggle = document.getElementById('autoplaySimilarToggle');
const repeatToggle = document.getElementById('repeatToggle');
const skipNextBtn = document.getElementById('skipNextBtn');
const playbackStatus = document.getElementById('playbackStatus');

const tabButtons = document.querySelectorAll('.tab-btn');
const queueSubtitle = document.getElementById('queueSubtitle');
const playAllBtn = document.getElementById('playAllBtn');
const shuffleBtn = document.getElementById('shuffleBtn');
const resultsList = document.getElementById('resultsList');

const BROWSER_PIPED_INSTANCES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi-libre.kavin.rocks',
  'https://piped-api.privacy.com.de',
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt',
  'https://pipedapi.drgns.space'
];

// Application State
let currentStream = null;
let activeTab = 'mostPlayed';
let activeEngine = 'direct';
let ytPlayer = null;
let ytApiReady = false;

let mostPlayedList = [];
let favoritesList = [];
let similarList = [];
let searchResultsList = [];

let playbackQueue = [];
let currentQueueIndex = -1;

const recentlyPlayedIds = [];
const recentlyPlayedCoreTitles = [];

if (localStorage.getItem('cleantube_autoplay_similar') !== null) {
  autoplaySimilarToggle.checked = localStorage.getItem('cleantube_autoplay_similar') === 'true';
}
if (localStorage.getItem('cleantube_repeat') === 'true') {
  repeatToggle.checked = true;
}

window.onYouTubeIframeAPIReady = function () {
  ytApiReady = true;
};

function ensureYtPlayer(videoId) {
  return new Promise((resolve) => {
    if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
      ytPlayer.loadVideoById(videoId);
      return resolve(ytPlayer);
    }

    const create = () => {
      ytPlayer = new YT.Player('ytEmbedContainer', {
        height: '100%',
        width: '100%',
        videoId,
        host: 'https://www.youtube-nocookie.com',
        playerVars: { autoplay: 1, playsinline: 1, rel: 0 },
        events: {
          onReady: (e) => {
            e.target.playVideo();
            resolve(ytPlayer);
          },
          onStateChange: (e) => {
            if (e.data === 0) handleTrackEnded();
          }
        }
      });
    };

    if (ytApiReady && window.YT && window.YT.Player) {
      create();
    } else {
      const timer = setInterval(() => {
        if (window.YT && window.YT.Player) {
          clearInterval(timer);
          ytApiReady = true;
          create();
        }
      }, 150);
    }
  });
}

/**
 * Parallel Browser-Side Stream Resolver (Uses your phone's residential IP in parallel with a 3s timeout)
 */
async function resolveExactVideoInBrowser(videoId) {
  const tasks = BROWSER_PIPED_INSTANCES.map(async (instance) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3200);
    try {
      const res = await fetch(`${instance}/streams/${encodeURIComponent(videoId)}`, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('Non-200');
      const data = await res.json();

      const muxed = (data.videoStreams || []).filter((s) => !s.videoOnly && s.url);
      const audio = (data.audioStreams || []).filter((s) => s.url);
      audio.sort((a, b) => {
        const aM4a = (a.mimeType || '').includes('mp4') ? 1000000 : 0;
        const bM4a = (b.mimeType || '').includes('mp4') ? 1000000 : 0;
        return bM4a + (b.bitrate || 0) - (aM4a + (a.bitrate || 0));
      });

      const audioUrl = audio[0]?.url || muxed[0]?.url;
      if (!audioUrl) throw new Error('No audioUrl');

      return {
        audioUrl,
        videoUrl: muxed[0]?.url || null,
        source: `browser-direct (${new URL(instance).hostname})`
      };
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  });

  return Promise.any(tasks);
}

function getCoreTitle(rawTitle = '', uploader = '') {
  let clean = rawTitle.toLowerCase();
  const cleanUploader = (uploader || '')
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
      /\b(official\s*music\s*video|official\s*video|official\s*audio|lyric\s*video|lyrics|audio|video|hd|4k|remastered|live|visualizer|mv|cover)\b/gi,
      ' '
    )
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rememberPlayedTrack(streamData) {
  if (!streamData || !streamData.id) return;

  const idx = recentlyPlayedIds.indexOf(streamData.id);
  if (idx !== -1) recentlyPlayedIds.splice(idx, 1);
  recentlyPlayedIds.push(streamData.id);
  if (recentlyPlayedIds.length > 40) recentlyPlayedIds.shift();

  const coreTitle = getCoreTitle(streamData.title, streamData.uploader);
  if (coreTitle && coreTitle.length >= 2) {
    if (!recentlyPlayedCoreTitles.includes(coreTitle)) {
      recentlyPlayedCoreTitles.push(coreTitle);
      if (recentlyPlayedCoreTitles.length > 40) recentlyPlayedCoreTitles.shift();
    }
  }
}

function wasSongAlreadyPlayed(candidate) {
  if (!candidate || !candidate.id) return true;
  if (recentlyPlayedIds.includes(candidate.id)) return true;

  const candCore = getCoreTitle(candidate.title, candidate.uploader);
  if (!candCore) return false;

  return recentlyPlayedCoreTitles.some(
    (playedCore) =>
      candCore === playedCore ||
      (playedCore.length >= 4 && candCore.includes(playedCore)) ||
      (candCore.length >= 4 && playedCore.includes(candCore))
  );
}

function extractVideoId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  const urlPattern = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = trimmed.match(urlPattern);
  if (match && match[1]) return match[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

function isDirectVideoReference(input) {
  return Boolean(extractVideoId(input));
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds) || seconds <= 0) return '';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

// ============================================================================
// Library, Tabs, Search & Playback
// ============================================================================

async function fetchLibrary() {
  try {
    const res = await fetch('/api/library');
    if (!res.ok) return;
    const data = await res.json();
    mostPlayedList = data.mostPlayed || [];
    favoritesList = data.favorites || [];

    if (activeTab === 'mostPlayed' || activeTab === 'favorites') {
      renderCurrentTabList();
    }
  } catch (_) {}
}

async function fetchSimilarTracks(streamData) {
  if (!streamData || !streamData.id) return;

  if (Array.isArray(streamData.related) && streamData.related.length > 0) {
    similarList = streamData.related.filter((item) => !wasSongAlreadyPlayed(item));
    if (similarList.length === 0) similarList = streamData.related;
    if (activeTab === 'similar') renderCurrentTabList();
    return;
  }

  try {
    const res = await fetch(`/api/related/${encodeURIComponent(streamData.id)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.related) && data.related.length > 0) {
      similarList = data.related.filter((item) => !wasSongAlreadyPlayed(item));
      if (similarList.length === 0) similarList = data.related;
      if (activeTab === 'similar') renderCurrentTabList();
    }
  } catch (_) {}
}

async function recordTrackPlay(streamData) {
  try {
    const res = await fetch('/api/library/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: streamData.id,
        title: streamData.title,
        uploader: streamData.uploader,
        duration: streamData.duration,
        thumbnailUrl: streamData.thumbnailUrl
      })
    });
    if (res.ok) await fetchLibrary();
  } catch (_) {}
}

favBtn.addEventListener('click', async () => {
  if (!currentStream) return;
  try {
    const res = await fetch('/api/library/favorite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: currentStream.id,
        title: currentStream.title,
        uploader: currentStream.uploader,
        duration: currentStream.duration,
        thumbnailUrl: currentStream.thumbnailUrl
      })
    });
    if (res.ok) {
      const data = await res.json();
      currentStream.favorite = data.track.favorite;
      favBtn.classList.toggle('active', currentStream.favorite);
      await fetchLibrary();
    }
  } catch (_) {}
});

async function removeTrackFromLibrary(videoId, event) {
  event.stopPropagation();
  try {
    await fetch(`/api/library/${encodeURIComponent(videoId)}`, { method: 'DELETE' });
    await fetchLibrary();
  } catch (_) {}
}

function switchTab(tabName) {
  activeTab = tabName;
  tabButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  renderCurrentTabList();
}

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function getVisibleList() {
  if (activeTab === 'mostPlayed') return mostPlayedList;
  if (activeTab === 'similar') return similarList;
  if (activeTab === 'favorites') return favoritesList;
  return searchResultsList;
}

function renderCurrentTabList() {
  const list = getVisibleList();

  if (activeTab === 'mostPlayed') {
    queueSubtitle.textContent = `Top ${mostPlayedList.length} most listened tracks`;
  } else if (activeTab === 'similar') {
    queueSubtitle.textContent = currentStream
      ? `Radio Mix based on "${currentStream.title}"`
      : 'Play any song to see similar recommendations';
  } else if (activeTab === 'favorites') {
    queueSubtitle.textContent = `${favoritesList.length} favorited tracks`;
  } else {
    queueSubtitle.textContent = `${searchResultsList.length} search results`;
  }

  if (list.length === 0) {
    if (activeTab === 'mostPlayed') {
      resultsList.innerHTML =
        '<div class="empty-state">Your Most Played list is empty. Search and play a few songs—they will automatically appear here ranked by play count!</div>';
    } else if (activeTab === 'similar') {
      resultsList.innerHTML =
        '<div class="empty-state">Start playing any song to load its Radio Mix of similar tracks here.</div>';
    } else if (activeTab === 'favorites') {
      resultsList.innerHTML =
        '<div class="empty-state">No favorite songs yet. Tap the ♥ heart button while a song is playing to save it here.</div>';
    } else {
      resultsList.innerHTML =
        '<div class="empty-state">Search for any song, artist, or album above.</div>';
    }
    return;
  }

  resultsList.innerHTML = '';
  list.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = `result-item${currentStream && currentStream.id === item.id ? ' playing' : ''}`;
    card.dataset.id = item.id;

    const showPlayCount = item.playCount && item.playCount > 0;
    const isLibraryTab = activeTab === 'mostPlayed' || activeTab === 'favorites';
    const durText = formatDuration(item.duration);

    card.innerHTML = `
      <div class="thumb-wrapper">
        <img src="${item.thumbnailUrl}" alt="" loading="lazy" />
        ${showPlayCount ? `<span class="play-count-badge">Played ${item.playCount}x</span>` : ''}
        ${durText ? `<span class="duration-badge">${durText}</span>` : ''}
      </div>
      <div class="result-info">
        <div class="result-title"></div>
        <div class="result-meta"></div>
      </div>
      ${isLibraryTab ? '<button class="remove-btn" title="Remove from history">×</button>' : '<span></span>'}
    `;

    card.querySelector('.result-title').textContent = item.title;
    card.querySelector('.result-meta').textContent = item.uploader;

    if (isLibraryTab) {
      card.querySelector('.remove-btn').addEventListener('click', (e) => {
        removeTrackFromLibrary(item.id, e);
      });
    }

    card.addEventListener('click', () => {
      playbackQueue = [...list];
      currentQueueIndex = index;
      loadAndPlayStream(item.id);
    });

    resultsList.appendChild(card);
  });
}

playAllBtn.addEventListener('click', () => {
  const list = getVisibleList();
  if (list.length === 0) return;
  playbackQueue = [...list];
  currentQueueIndex = 0;
  loadAndPlayStream(playbackQueue[0].id);
});

shuffleBtn.addEventListener('click', () => {
  const list = getVisibleList();
  if (list.length === 0) return;
  const shuffled = [...list];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  playbackQueue = shuffled;
  currentQueueIndex = 0;
  playbackStatus.textContent = 'Shuffling Queue';
  loadAndPlayStream(playbackQueue[0].id);
});

skipNextBtn.addEventListener('click', () => {
  playNextTrackOrSimilar();
});

async function performSearch(query) {
  searchBtn.disabled = true;
  playbackStatus.textContent = 'Searching...';
  switchTab('search');
  queueSubtitle.textContent = `Searching for "${query}"...`;

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Search failed');

    searchResultsList = data.results || [];
    renderCurrentTabList();
    playbackStatus.textContent = 'Search complete';
  } catch (err) {
    playbackStatus.textContent = `Search error: ${err.message}`;
    resultsList.innerHTML = `<div class="empty-state">Search error: ${err.message}</div>`;
  } finally {
    searchBtn.disabled = false;
  }
}

async function loadAndPlayStream(queryOrId) {
  searchBtn.disabled = true;
  playbackStatus.textContent = 'Loading track...';

  try {
    bgAudioPlayer.pause();
  } catch (_) {}

  try {
    const response = await fetch(`/api/stream/${encodeURIComponent(queryOrId)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not load track');
    }

    // If the server's cloud IP couldn't get a direct URL, try parallel browser resolution using user's residential IP
    if (!data.audioUrl && data.id) {
      try {
        const browserStream = await resolveExactVideoInBrowser(data.id);
        data.audioUrl = browserStream.audioUrl;
        data.videoUrl = browserStream.videoUrl;
        data.source = browserStream.source;
      } catch (_) {}
    }

    currentStream = data;
    rememberPlayedTrack(data);

    currentTitle.textContent = data.title || 'Untitled Track';
    currentUploader.textContent = data.uploader || 'Unknown Artist';
    streamSourceBadge.textContent = `Engine: ${data.source}`;
    favBtn.classList.toggle('active', Boolean(data.favorite));
    overlayThumb.src = data.thumbnailUrl || '';

    document.querySelectorAll('.result-item').forEach((el) => {
      el.classList.toggle('playing', el.dataset.id === data.id);
    });

    configureMediaSession(data);
    recordTrackPlay(data);

    similarList = [];
    fetchSimilarTracks(data);

    if (data.audioUrl) {
      activeEngine = 'direct';
      if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
        ytPlayer.stopVideo();
      }
      ytEmbedContainer.style.display = 'none';
      audioBarWrapper.style.display = 'block';

      bgAudioPlayer.src = data.audioUrl;
      await bgAudioPlayer.play();
      playbackStatus.textContent = 'Playing (Background Ready)';

      if (data.videoUrl && document.visibilityState === 'visible') {
        artworkStage.classList.add('hidden');
        videoPlayer.src = data.videoUrl;
        videoPlayer.currentTime = 0;
        videoPlayer.play().catch(() => {});
      } else {
        videoPlayer.pause();
        videoPlayer.removeAttribute('src');
        artworkStage.classList.remove('hidden');
      }
    } else {
      activeEngine = 'embed';
      videoPlayer.pause();
      bgAudioPlayer.pause();
      artworkStage.classList.add('hidden');
      audioBarWrapper.style.display = 'none';
      ytEmbedContainer.style.display = 'block';
      await ensureYtPlayer(data.id);
      playbackStatus.textContent = 'Playing';
    }
  } catch (err) {
    playbackStatus.textContent = `Error: ${err.message}`;
  } finally {
    searchBtn.disabled = false;
  }
}

bgAudioPlayer.addEventListener('play', () => {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  if (currentStream?.videoUrl && document.visibilityState === 'visible') {
    videoPlayer.currentTime = bgAudioPlayer.currentTime;
    videoPlayer.play().catch(() => {});
  }
});

bgAudioPlayer.addEventListener('pause', () => {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  videoPlayer.pause();
});

bgAudioPlayer.addEventListener('seeking', () => {
  if (currentStream?.videoUrl && document.visibilityState === 'visible') {
    videoPlayer.currentTime = bgAudioPlayer.currentTime;
  }
});

bgAudioPlayer.addEventListener('timeupdate', () => {
  syncMediaSessionPosition(bgAudioPlayer);
  if (
    currentStream?.videoUrl &&
    document.visibilityState === 'visible' &&
    !videoPlayer.paused &&
    Math.abs(videoPlayer.currentTime - bgAudioPlayer.currentTime) > 0.6
  ) {
    videoPlayer.currentTime = bgAudioPlayer.currentTime;
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    videoPlayer.pause();
  } else if (
    document.visibilityState === 'visible' &&
    activeEngine === 'direct' &&
    currentStream?.videoUrl &&
    !bgAudioPlayer.paused
  ) {
    videoPlayer.currentTime = bgAudioPlayer.currentTime;
    videoPlayer.play().catch(() => {});
  }
});

function handleTrackEnded() {
  if (repeatToggle.checked && currentStream) {
    if (activeEngine === 'direct') {
      bgAudioPlayer.currentTime = 0;
      bgAudioPlayer.play();
    } else if (ytPlayer) {
      ytPlayer.seekTo(0);
      ytPlayer.playVideo();
    }
    recordTrackPlay(currentStream);
    return;
  }
  playNextTrackOrSimilar();
}

bgAudioPlayer.addEventListener('ended', handleTrackEnded);

async function playNextTrackOrSimilar() {
  if (autoplaySimilarToggle.checked && currentStream) {
    if (similarList.length === 0) {
      playbackStatus.textContent = 'Finding similar song...';
      await fetchSimilarTracks(currentStream);
    }

    if (similarList.length > 0) {
      const nextSimilar =
        similarList.find((item) => !wasSongAlreadyPlayed(item)) ||
        similarList.find((item) => !recentlyPlayedIds.includes(item.id)) ||
        similarList[0];

      if (nextSimilar && nextSimilar.id) {
        playbackStatus.textContent = `Up Next: ${nextSimilar.title}`;
        await loadAndPlayStream(nextSimilar.id);
        return;
      }
    }
  }

  if (playbackQueue.length === 0) {
    playbackQueue = [...getVisibleList()];
  }
  if (playbackQueue.length > 0) {
    currentQueueIndex = (currentQueueIndex + 1) % playbackQueue.length;
    await loadAndPlayStream(playbackQueue[currentQueueIndex].id);
  } else {
    playbackStatus.textContent = 'Playback Finished';
  }
}

autoplaySimilarToggle.addEventListener('change', (e) => {
  localStorage.setItem('cleantube_autoplay_similar', e.target.checked ? 'true' : 'false');
});

repeatToggle.addEventListener('change', (e) => {
  localStorage.setItem('cleantube_repeat', e.target.checked ? 'true' : 'false');
});

function configureMediaSession(streamData) {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title: streamData.title || 'CleanTube Music',
    artist: streamData.uploader || 'CleanTube',
    album: 'CleanTube Heavy Rotation',
    artwork: streamData.thumbnailUrl
      ? [
          { src: streamData.thumbnailUrl, sizes: '320x180', type: 'image/jpeg' },
          { src: streamData.thumbnailUrl, sizes: '512x512', type: 'image/jpeg' }
        ]
      : []
  });

  navigator.mediaSession.setActionHandler('play', () => {
    if (activeEngine === 'direct') bgAudioPlayer.play();
    else if (ytPlayer) ytPlayer.playVideo();
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    if (activeEngine === 'direct') bgAudioPlayer.pause();
    else if (ytPlayer) ytPlayer.pauseVideo();
  });

  navigator.mediaSession.setActionHandler('seekbackward', (details) => {
    const offset = details.seekOffset || 10;
    bgAudioPlayer.currentTime = Math.max(bgAudioPlayer.currentTime - offset, 0);
    syncMediaSessionPosition(bgAudioPlayer);
  });

  navigator.mediaSession.setActionHandler('seekforward', (details) => {
    const offset = details.seekOffset || 10;
    const maxDuration = bgAudioPlayer.duration || Infinity;
    bgAudioPlayer.currentTime = Math.min(bgAudioPlayer.currentTime + offset, maxDuration);
    syncMediaSessionPosition(bgAudioPlayer);
  });

  navigator.mediaSession.setActionHandler('seekto', (details) => {
    bgAudioPlayer.currentTime = details.seekTime;
    syncMediaSessionPosition(bgAudioPlayer);
  });

  navigator.mediaSession.setActionHandler('previoustrack', () => {
    if (bgAudioPlayer.currentTime > 5) {
      bgAudioPlayer.currentTime = 0;
      return;
    }
    if (recentlyPlayedIds.length > 1) {
      recentlyPlayedIds.pop();
      const previousId = recentlyPlayedIds.pop();
      if (previousId) loadAndPlayStream(previousId);
    }
  });

  navigator.mediaSession.setActionHandler('nexttrack', () => {
    playNextTrackOrSimilar();
  });
}

function syncMediaSessionPosition(player) {
  if (
    'mediaSession' in navigator &&
    typeof navigator.mediaSession.setPositionState === 'function' &&
    player.duration &&
    !isNaN(player.duration) &&
    isFinite(player.duration)
  ) {
    try {
      navigator.mediaSession.setPositionState({
        duration: player.duration,
        playbackRate: player.playbackRate || 1,
        position: Math.min(Math.max(player.currentTime, 0), player.duration)
      });
    } catch (_) {}
  }
}

searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const query = searchInput.value.trim();
  if (!query) return;

  if (isDirectVideoReference(query)) {
    loadAndPlayStream(query);
  } else {
    performSearch(query);
  }
});

fetchLibrary();