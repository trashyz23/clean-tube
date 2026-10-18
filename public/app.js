// DOM Elements
const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');

const videoPlayer = document.getElementById('videoPlayer');
const bgAudioPlayer = document.getElementById('bgAudioPlayer');
const audioOverlay = document.getElementById('audioOverlay');
const overlayThumb = document.getElementById('overlayThumb');

const currentTitle = document.getElementById('currentTitle');
const currentUploader = document.getElementById('currentUploader');
const streamSourceBadge = document.getElementById('streamSourceBadge');
const favBtn = document.getElementById('favBtn');
const autoplaySimilarToggle = document.getElementById('autoplaySimilarToggle');
const audioOnlyToggle = document.getElementById('audioOnlyToggle');
const repeatToggle = document.getElementById('repeatToggle');
const playbackStatus = document.getElementById('playbackStatus');

const tabButtons = document.querySelectorAll('.tab-btn');
const queueSubtitle = document.getElementById('queueSubtitle');
const playAllBtn = document.getElementById('playAllBtn');
const shuffleBtn = document.getElementById('shuffleBtn');
const resultsList = document.getElementById('resultsList');

// Application State
let currentStream = null;
let activeTab = 'mostPlayed'; // 'mostPlayed' | 'similar' | 'favorites' | 'search'

let mostPlayedList = [];
let favoritesList = [];
let similarList = [];
let searchResultsList = [];

// Active Playback Queue & Session History (prevents Autoplay from looping the same 2 songs)
let playbackQueue = [];
let currentQueueIndex = -1;
let isCustomQueueActive = false; // true when user explicitly clicks "Play All" or "Shuffle"
const recentlyPlayedIds = [];
let isBackgroundAudioActive = false;

// Restore saved toggle states
if (localStorage.getItem('cleantube_autoplay_similar') !== null) {
  autoplaySimilarToggle.checked = localStorage.getItem('cleantube_autoplay_similar') === 'true';
}
if (localStorage.getItem('cleantube_audio_only') === 'true') {
  audioOnlyToggle.checked = true;
}
if (localStorage.getItem('cleantube_repeat') === 'true') {
  repeatToggle.checked = true;
}

function rememberPlayedId(id) {
  if (!id) return;
  const idx = recentlyPlayedIds.indexOf(id);
  if (idx !== -1) recentlyPlayedIds.splice(idx, 1);
  recentlyPlayedIds.push(id);
  if (recentlyPlayedIds.length > 35) {
    recentlyPlayedIds.shift();
  }
}

function isDirectVideoReference(input) {
  const trimmed = input.trim();
  const urlPattern = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  if (urlPattern.test(trimmed)) return true;
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return true;
  return false;
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds) || seconds <= 0) return 'LIVE';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function getActiveMediaElement() {
  return isBackgroundAudioActive ? bgAudioPlayer : videoPlayer;
}

/**
 * Fetches Most Played & Favorites from the server
 */
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
  } catch (err) {
    console.warn('Could not load library:', err);
  }
}

/**
 * Fetches Similar / Recommended songs in the background if not already provided
 */
async function fetchSimilarTracks(streamData) {
  if (!streamData || !streamData.id) return;

  // If Piped already returned related videos with the stream, use them immediately
  if (Array.isArray(streamData.related) && streamData.related.length > 0) {
    similarList = streamData.related;
    if (activeTab === 'similar') renderCurrentTabList();
    return;
  }

  // Otherwise query /api/related/:id (uses Piped or yt-dlp YouTube Radio Mix RD<id>)
  try {
    const fallbackQuery = `${streamData.uploader || ''} ${streamData.title || ''}`.trim();
    const res = await fetch(
      `/api/related/${encodeURIComponent(streamData.id)}?q=${encodeURIComponent(fallbackQuery)}`
    );
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.related) && data.related.length > 0) {
      similarList = data.related;
      if (activeTab === 'similar') renderCurrentTabList();
    }
  } catch (err) {
    console.warn('Could not fetch similar tracks:', err);
  }
}

/**
 * Records a play in the server's Most Watched library
 */
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
    if (res.ok) {
      await fetchLibrary();
    }
  } catch (_) {}
}

/**
 * Toggles Favorite status on the currently playing track
 */
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

/**
 * Switch Sidebar Tabs
 */
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
      ? `Recommended based on "${currentStream.title}"`
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
        '<div class="empty-state">Start playing any song to load similar & recommended tracks here.</div>';
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

    card.innerHTML = `
      <div class="thumb-wrapper">
        <img src="${item.thumbnailUrl}" alt="" loading="lazy" />
        ${showPlayCount ? `<span class="play-count-badge">Played ${item.playCount}x</span>` : ''}
        <span class="duration-badge">${formatDuration(item.duration)}</span>
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
      // If user clicked a song inside Most Played or Favorites, keep that list as fallback queue
      isCustomQueueActive = false;
      loadAndPlayStream(item.id);
    });

    resultsList.appendChild(card);
  });
}

/**
 * Play All & Shuffle Buttons explicitly lock in the current tab's playlist
 */
playAllBtn.addEventListener('click', () => {
  const list = getVisibleList();
  if (list.length === 0) return;
  playbackQueue = [...list];
  currentQueueIndex = 0;
  isCustomQueueActive = true;
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
  isCustomQueueActive = true;
  playbackStatus.textContent = 'Shuffling Queue';
  loadAndPlayStream(playbackQueue[0].id);
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

/**
 * Resolves direct stream URLs, starts playback, increments play count, and loads similar songs
 */
async function loadAndPlayStream(queryOrId) {
  searchBtn.disabled = true;
  playbackStatus.textContent = 'Loading track...';

  try {
    const response = await fetch(`/api/stream/${encodeURIComponent(queryOrId)}`);
    const data = await response.json();

    if (!response.ok) throw new Error(data.error || 'Failed to resolve stream');

    currentStream = data;
    rememberPlayedId(data.id);

    currentTitle.textContent = data.title || 'Untitled Track';
    currentUploader.textContent = data.uploader || 'Unknown Artist';
    streamSourceBadge.textContent = `Resolver: ${data.source}`;
    favBtn.classList.toggle('active', Boolean(data.favorite));

    videoPlayer.poster = data.thumbnailUrl || '';
    overlayThumb.src = data.thumbnailUrl || '';

    document.querySelectorAll('.result-item').forEach((el) => {
      el.classList.toggle('playing', el.dataset.id === data.id);
    });

    const primaryVideoSrc = data.videoUrl || data.audioUrl;
    const primaryAudioSrc = data.audioUrl || data.videoUrl;

    videoPlayer.src = primaryVideoSrc;
    bgAudioPlayer.src = primaryAudioSrc;

    configureMediaSession(data);
    recordTrackPlay(data);

    // Fetch similar/recommended songs in the background for Autoplay
    similarList = [];
    fetchSimilarTracks(data);

    const shouldUseAudioMode = audioOnlyToggle.checked || document.visibilityState === 'hidden';
    isBackgroundAudioActive = false;

    if (shouldUseAudioMode) {
      activateBackgroundAudio(0, true);
    } else {
      audioOverlay.classList.remove('active');
      await videoPlayer.play();
      playbackStatus.textContent = 'Playing';
    }
  } catch (err) {
    playbackStatus.textContent = `Error: ${err.message}`;
  } finally {
    searchBtn.disabled = false;
  }
}

/**
 * Smart Next Track / Autoplay Similar Handler
 * Triggered when a song ends or when the user taps "Next" on the lock screen.
 */
async function playNextTrackOrSimilar() {
  // 1. If "Autoplay Similar" is enabled, pick the top unplayed similar recommendation
  if (autoplaySimilarToggle.checked && currentStream) {
    if (similarList.length === 0) {
      playbackStatus.textContent = 'Finding similar song...';
      await fetchSimilarTracks(currentStream);
    }

    if (similarList.length > 0) {
      // Pick the first recommended song that hasn't been played recently in this session
      const nextSimilar =
        similarList.find((item) => !recentlyPlayedIds.includes(item.id)) || similarList[0];

      if (nextSimilar && nextSimilar.id) {
        playbackStatus.textContent = `Autoplaying Similar: ${nextSimilar.title}`;
        await loadAndPlayStream(nextSimilar.id);
        return;
      }
    }
  }

  // 2. Fallback: Advance through the user's current queue (Most Played / Favorites / Search)
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

function activateBackgroundAudio(resumeTime = videoPlayer.currentTime, autoPlay = !videoPlayer.paused) {
  if (!currentStream || isBackgroundAudioActive) return;
  isBackgroundAudioActive = true;

  videoPlayer.pause();

  if (Math.abs(bgAudioPlayer.currentTime - resumeTime) > 0.5) {
    bgAudioPlayer.currentTime = resumeTime || 0;
  }

  audioOverlay.classList.add('active');

  if (autoPlay) {
    bgAudioPlayer
      .play()
      .then(() => {
        playbackStatus.textContent = 'Background Audio Active';
      })
      .catch((err) => {
        playbackStatus.textContent = `Tap Play: ${err.message}`;
      });
  } else {
    playbackStatus.textContent = 'Paused (Audio Mode)';
  }
}

function activateForegroundVideo(resumeTime = bgAudioPlayer.currentTime, autoPlay = !bgAudioPlayer.paused) {
  if (!currentStream || !isBackgroundAudioActive || audioOnlyToggle.checked) return;
  isBackgroundAudioActive = false;

  bgAudioPlayer.pause();

  if (Math.abs(videoPlayer.currentTime - resumeTime) > 0.5) {
    videoPlayer.currentTime = resumeTime || 0;
  }

  audioOverlay.classList.remove('active');

  if (autoPlay) {
    videoPlayer
      .play()
      .then(() => {
        playbackStatus.textContent = 'Playing Video';
      })
      .catch(() => {
        playbackStatus.textContent = 'Paused';
      });
  } else {
    playbackStatus.textContent = 'Paused';
  }
}

document.addEventListener('visibilitychange', () => {
  if (!currentStream) return;

  if (document.visibilityState === 'hidden') {
    const pos = isBackgroundAudioActive ? bgAudioPlayer.currentTime : videoPlayer.currentTime;
    const playing = isBackgroundAudioActive ? !bgAudioPlayer.paused : !videoPlayer.paused;
    activateBackgroundAudio(pos, playing);
  } else if (document.visibilityState === 'visible') {
    const pos = bgAudioPlayer.currentTime;
    const playing = !bgAudioPlayer.paused;
    activateForegroundVideo(pos, playing);
  }
});

autoplaySimilarToggle.addEventListener('change', (e) => {
  localStorage.setItem('cleantube_autoplay_similar', e.target.checked ? 'true' : 'false');
});

audioOnlyToggle.addEventListener('change', (e) => {
  localStorage.setItem('cleantube_audio_only', e.target.checked ? 'true' : 'false');
  if (!currentStream) return;

  if (e.target.checked) {
    activateBackgroundAudio(videoPlayer.currentTime, !videoPlayer.paused);
  } else {
    activateForegroundVideo(bgAudioPlayer.currentTime, !bgAudioPlayer.paused);
  }
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

  navigator.mediaSession.setActionHandler('play', async () => {
    const player = getActiveMediaElement();
    await player.play();
    navigator.mediaSession.playbackState = 'playing';
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    const player = getActiveMediaElement();
    player.pause();
    navigator.mediaSession.playbackState = 'paused';
  });

  navigator.mediaSession.setActionHandler('seekbackward', (details) => {
    const player = getActiveMediaElement();
    const offset = details.seekOffset || 10;
    player.currentTime = Math.max(player.currentTime - offset, 0);
    syncMediaSessionPosition(player);
  });

  navigator.mediaSession.setActionHandler('seekforward', (details) => {
    const player = getActiveMediaElement();
    const offset = details.seekOffset || 10;
    const maxDuration = player.duration || Infinity;
    player.currentTime = Math.min(player.currentTime + offset, maxDuration);
    syncMediaSessionPosition(player);
  });

  navigator.mediaSession.setActionHandler('seekto', (details) => {
    const player = getActiveMediaElement();
    if (details.fastSeek && 'fastSeek' in player) {
      player.fastSeek(details.seekTime);
    } else {
      player.currentTime = details.seekTime;
    }
    syncMediaSessionPosition(player);
  });

  navigator.mediaSession.setActionHandler('previoustrack', () => {
    const player = getActiveMediaElement();
    if (player.currentTime > 5) {
      player.currentTime = 0;
      return;
    }
    if (recentlyPlayedIds.length > 1) {
      // Pop current song and play the previously played song
      recentlyPlayedIds.pop();
      const previousId = recentlyPlayedIds.pop();
      if (previousId) {
        loadAndPlayStream(previousId);
        return;
      }
    }
    player.currentTime = 0;
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

[videoPlayer, bgAudioPlayer].forEach((player) => {
  player.addEventListener('timeupdate', () => {
    if (player === getActiveMediaElement()) {
      syncMediaSessionPosition(player);
    }
  });

  player.addEventListener('play', () => {
    if (player === getActiveMediaElement() && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
  });

  player.addEventListener('pause', () => {
    if (player === getActiveMediaElement() && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
  });

  player.addEventListener('ended', () => {
    if (player !== getActiveMediaElement()) return;

    // 1. If "Repeat Song" is checked, loop the current song
    if (repeatToggle.checked && currentStream) {
      player.currentTime = 0;
      player.play();
      recordTrackPlay(currentStream);
      return;
    }

    // 2. Otherwise play a similar/recommended video (or next in queue if Autoplay Similar is unchecked)
    playNextTrackOrSimilar();
  });
});

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

// Load user's Most Played music on startup
fetchLibrary();