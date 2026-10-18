// DOM Elements
const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');

const videoPlayer = document.getElementById('videoPlayer');
const bgAudioPlayer = document.getElementById('bgAudioPlayer');
const ytEmbedContainer = document.getElementById('ytEmbedContainer');

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

// Application State
let currentStream = null;
let activeTab = 'mostPlayed';
let activeEngine = 'embed'; // 'direct' | 'embed'
let ytPlayer = null;
let ytApiReady = false;

let mostPlayedList = [];
let favoritesList = [];
let similarList = [];
let searchResultsList = [];

let playbackQueue = [];
let currentQueueIndex = -1;
const recentlyPlayedIds = [];

if (localStorage.getItem('cleantube_autoplay_similar') !== null) {
  autoplaySimilarToggle.checked = localStorage.getItem('cleantube_autoplay_similar') === 'true';
}
if (localStorage.getItem('cleantube_repeat') === 'true') {
  repeatToggle.checked = true;
}

// Initialize YouTube IFrame API for Cloud/Render playback
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
        playerVars: {
          autoplay: 1,
          playsinline: 1,
          rel: 0,
          modestbranding: 1
        },
        events: {
          onReady: (event) => {
            event.target.playVideo();
            resolve(ytPlayer);
          },
          onStateChange: (event) => {
            // YT.PlayerState.ENDED === 0
            if (event.data === 0) {
              handleTrackEnded();
            } else if (event.data === 1) {
              playbackStatus.textContent = 'Playing';
              if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
            } else if (event.data === 2) {
              playbackStatus.textContent = 'Paused';
              if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
            }
          },
          onError: () => {
            // If a video restricts embedding, automatically skip to the next similar track
            playbackStatus.textContent = 'Track restricted — skipping to similar song...';
            setTimeout(() => playNextTrackOrSimilar(), 800);
          }
        }
      });
    };

    if (ytApiReady && window.YT && window.YT.Player) {
      create();
    } else {
      const checkInterval = setInterval(() => {
        if (window.YT && window.YT.Player) {
          clearInterval(checkInterval);
          ytApiReady = true;
          create();
        }
      }, 150);
    }
  });
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
    similarList = streamData.related;
    if (activeTab === 'similar') renderCurrentTabList();
    return;
  }

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

/**
 * Loads and plays a song using either Direct Stream or the Instant Cloud Embed Engine
 */
async function loadAndPlayStream(queryOrId) {
  searchBtn.disabled = true;
  playbackStatus.textContent = 'Loading track...';

  try {
    const response = await fetch(`/api/stream/${encodeURIComponent(queryOrId)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to load track');
    }

    currentStream = data;
    rememberPlayedId(data.id);

    currentTitle.textContent = data.title || 'Untitled Track';
    currentUploader.textContent = data.uploader || 'Unknown Artist';
    streamSourceBadge.textContent = `Engine: ${data.source}`;
    favBtn.classList.toggle('active', Boolean(data.favorite));

    document.querySelectorAll('.result-item').forEach((el) => {
      el.classList.toggle('playing', el.dataset.id === data.id);
    });

    configureMediaSession(data);
    recordTrackPlay(data);

    similarList = [];
    fetchSimilarTracks(data);

    // Choose playback engine based on whether direct stream URLs were available
    if (data.playbackMode === 'direct' && (data.videoUrl || data.audioUrl)) {
      activeEngine = 'direct';
      if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
        ytPlayer.stopVideo();
      }
      ytEmbedContainer.style.display = 'none';
      videoPlayer.style.display = 'block';

      videoPlayer.poster = data.thumbnailUrl || '';
      videoPlayer.src = data.videoUrl || data.audioUrl;
      bgAudioPlayer.src = data.audioUrl || data.videoUrl;

      await videoPlayer.play();
      playbackStatus.textContent = 'Playing Direct Stream';
    } else {
      // Cloud / Render Instant Embed Mode
      activeEngine = 'embed';
      videoPlayer.pause();
      bgAudioPlayer.pause();
      videoPlayer.style.display = 'none';
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

function handleTrackEnded() {
  if (repeatToggle.checked && currentStream) {
    if (activeEngine === 'embed' && ytPlayer) {
      ytPlayer.seekTo(0);
      ytPlayer.playVideo();
    } else {
      videoPlayer.currentTime = 0;
      videoPlayer.play();
    }
    recordTrackPlay(currentStream);
    return;
  }

  playNextTrackOrSimilar();
}

async function playNextTrackOrSimilar() {
  if (autoplaySimilarToggle.checked && currentStream) {
    if (similarList.length === 0) {
      playbackStatus.textContent = 'Finding similar song...';
      await fetchSimilarTracks(currentStream);
    }

    if (similarList.length > 0) {
      const nextSimilar =
        similarList.find((item) => !recentlyPlayedIds.includes(item.id)) || similarList[0];

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
    if (activeEngine === 'embed' && ytPlayer) {
      ytPlayer.playVideo();
    } else {
      videoPlayer.play();
    }
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    if (activeEngine === 'embed' && ytPlayer) {
      ytPlayer.pauseVideo();
    } else {
      videoPlayer.pause();
    }
  });

  navigator.mediaSession.setActionHandler('previoustrack', () => {
    if (recentlyPlayedIds.length > 1) {
      recentlyPlayedIds.pop();
      const previousId = recentlyPlayedIds.pop();
      if (previousId) {
        loadAndPlayStream(previousId);
      }
    }
  });

  navigator.mediaSession.setActionHandler('nexttrack', () => {
    playNextTrackOrSimilar();
  });
}

videoPlayer.addEventListener('ended', handleTrackEnded);

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