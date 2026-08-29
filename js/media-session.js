/**
 * Media Session API — lock screen / notification / headset / car media keys
 *
 * Artwork strategy (mobile lock-screen / notification):
 *  1) Explicit cover URL from disc-art (iTunes) when ready
 *  2) Cached cover from localStorage
 *  3) Procedural disc data-URL (unique per track) while waiting for iTunes
 *  4) App logo only as last-resort fallback
 */
(function () {
  let currentLyric = '';
  let logoArtwork = [];
  /** @type {Record<string, string>} trackId → cover or data URL for this session */
  let coverByTrack = {};

  function init() {
    if (!('mediaSession' in navigator)) {
      console.info('Media Session API not supported');
      return;
    }

    // Logo fallback for lock screen (works on GitHub Pages subpaths)
    let path = window.location.pathname;
    if (!path.endsWith('/')) path = path.replace(/\/[^/]*$/, '/');
    const base = window.location.origin + path;
    const logo = new URL('logo-web.png', base).href;
    const logoSm = new URL('logo-web-removebg.png', base).href;
    logoArtwork = [
      { src: logoSm, sizes: '192x192', type: 'image/png' },
      { src: logo, sizes: '512x512', type: 'image/png' },
    ];

    // Wrap handlers so OS lock-screen / headset events keep the continuous
    // playback chain (important for Android after background track changes).
    const handlers = {
      play: () => {
        try {
          MPPlayer.play();
        } catch (_) {}
      },
      pause: () => {
        try {
          MPPlayer.pause();
        } catch (_) {}
      },
      previoustrack: () => {
        try {
          MPPlayer.previous();
        } catch (_) {}
      },
      // fromEnded-style advance: always autoplay next with intent
      nexttrack: () => {
        try {
          MPPlayer.next(true);
        } catch (_) {}
      },
      seekbackward: (details) => {
        try {
          const p = MPPlayer.getProgress();
          MPPlayer.seek(Math.max(0, p.current - (details.seekOffset || 10)), false);
        } catch (_) {}
      },
      seekforward: (details) => {
        try {
          const p = MPPlayer.getProgress();
          MPPlayer.seek(p.current + (details.seekOffset || 10), false);
        } catch (_) {}
      },
      seekto: (details) => {
        try {
          if (details.seekTime != null) MPPlayer.seek(details.seekTime, false);
        } catch (_) {}
      },
      stop: () => {
        try {
          MPPlayer.pause();
          const a = MPPlayer.getAudio();
          if (a) a.currentTime = 0;
        } catch (_) {}
      },
    };

    function installHandlers() {
      for (const [action, handler] of Object.entries(handlers)) {
        try {
          navigator.mediaSession.setActionHandler(action, handler);
        } catch (e) {
          // Some actions unsupported on this platform
        }
      }
    }
    installHandlers();

    // Android may drop handlers / metadata after long background
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      installHandlers();
      try {
        var t = window.MPPlayer && MPPlayer.getCurrentTrack && MPPlayer.getCurrentTrack();
        if (t) updateMetadata(t);
      } catch (_) {}
    });
  }

  function mimeForSrc(src) {
    if (!src) return 'image/jpeg';
    if (src.indexOf('data:image/png') === 0 || /\.png(\?|$)/i.test(src)) return 'image/png';
    if (src.indexOf('data:image/webp') === 0 || /\.webp(\?|$)/i.test(src)) return 'image/webp';
    return 'image/jpeg';
  }

  function resolveCoverUrl(track, coverUrl) {
    var id = String(track.id);
    if (coverUrl) {
      coverByTrack[id] = coverUrl;
      return coverUrl;
    }
    if (coverByTrack[id]) return coverByTrack[id];
    try {
      var map = MPUtils.storageGet('mp-disc-covers-v1', {}) || {};
      if (map[id]) {
        coverByTrack[id] = map[id];
        return map[id];
      }
    } catch (_) {}
    return null;
  }

  /**
   * @param {object} track
   * @param {string} [coverUrl] https cover or data: URL — upgrades lock-screen art
   */
  function updateMetadata(track, coverUrl) {
    if (!('mediaSession' in navigator) || !track) return;
    try {
      const albumParts = [track.genre || '果子狸のMusic Player'];
      if (currentLyric) albumParts.push(currentLyric);

      var cover = resolveCoverUrl(track, coverUrl);
      var art = logoArtwork;
      if (cover) {
        var mime = mimeForSrc(cover);
        // Song art first — Android often picks the first entry
        art = [
          { src: cover, sizes: '512x512', type: mime },
          { src: cover, sizes: '300x300', type: mime },
          { src: cover, sizes: '192x192', type: mime },
        ].concat(logoArtwork);
      }

      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name,
        artist: track.artist,
        album: albumParts.join(' · '),
        artwork: art,
      });
    } catch (e) {
      console.warn('MediaMetadata failed', e);
    }
  }

  /** Called by disc-art when a cover (or procedural snapshot) is ready. */
  function setArtwork(track, coverUrl) {
    if (!track || !coverUrl) return;
    updateMetadata(track, coverUrl);
  }

  function updatePlaybackState(playing) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    } catch (_) {}
  }

  function updatePosition(progress) {
    if (!('mediaSession' in navigator)) return;
    if (!progress || !progress.duration || !Number.isFinite(progress.duration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: progress.duration,
        playbackRate: 1,
        position: Math.min(progress.current, progress.duration),
      });
    } catch (_) {
      /* setPositionState not supported */
    }
  }

  function setLyricLine(text) {
    currentLyric = text || '';
    const track = MPPlayer.getCurrentTrack();
    if (track) updateMetadata(track);
  }

  window.MPMediaSession = {
    init,
    updateMetadata,
    setArtwork,
    updatePlaybackState,
    updatePosition,
    setLyricLine,
  };
})();
