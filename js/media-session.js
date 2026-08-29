/**
 * Media Session API — lock screen / notification / headset / car media keys
 *
 * Artwork (Android/Chrome):
 *  - Target size is ~512×512; tiny images are often ignored → falls back to app icon.
 *  - Prefer same-origin blob: JPEG URLs materialized from covers / procedural art.
 *  - When song art exists, do NOT also list the app logo (Android may pick the logo).
 */
(function () {
  let currentLyric = '';
  let logoArtwork = [];
  /** @type {Record<string, string>} raw source (https / data) preferred for a track */
  let coverSourceByTrack = {};
  /** @type {Record<string, string>} materialized blob: URLs for Media Session */
  let blobUrlByTrack = {};
  let artworkJob = 0;

  function init() {
    if (!('mediaSession' in navigator)) {
      console.info('Media Session API not supported');
      return;
    }

    let path = window.location.pathname;
    if (!path.endsWith('/')) path = path.replace(/\/[^/]*$/, '/');
    const base = window.location.origin + path;
    const logo = new URL('logo-web.png', base).href;
    const logoSm = new URL('logo-web-removebg.png', base).href;
    logoArtwork = [
      { src: logoSm, sizes: '192x192', type: 'image/png' },
      { src: logo, sizes: '512x512', type: 'image/png' },
    ];

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
          /* unsupported action */
        }
      }
    }
    installHandlers();

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      installHandlers();
      try {
        var t = window.MPPlayer && MPPlayer.getCurrentTrack && MPPlayer.getCurrentTrack();
        if (t) updateMetadata(t);
      } catch (_) {}
    });
  }

  function revokeBlob(id) {
    var u = blobUrlByTrack[id];
    if (!u) return;
    try {
      URL.revokeObjectURL(u);
    } catch (_) {}
    delete blobUrlByTrack[id];
  }

  function loadImage(src, cors) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      if (cors) img.crossOrigin = 'anonymous';
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        reject(new Error('image load failed'));
      };
      img.src = src;
    });
  }

  function canvasToJpegBlobUrl(canvas) {
    return new Promise(function (resolve, reject) {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob(
          function (blob) {
            if (!blob) {
              reject(new Error('toBlob empty'));
              return;
            }
            resolve(URL.createObjectURL(blob));
          },
          'image/jpeg',
          0.92
        );
      } else {
        try {
          resolve(canvas.toDataURL('image/jpeg', 0.92));
        } catch (e) {
          reject(e);
        }
      }
    });
  }

  /** Cover-fit into a 512×512 JPEG blob URL (Android notification target size). */
  function toSquareArtworkUrl(source) {
    var size = 512;
    var c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#1a1408';
    ctx.fillRect(0, 0, size, size);
    var sw = source.naturalWidth || source.width || size;
    var sh = source.naturalHeight || source.height || size;
    if (!sw || !sh) return canvasToJpegBlobUrl(c);
    var scale = Math.max(size / sw, size / sh);
    var dw = sw * scale;
    var dh = sh * scale;
    ctx.drawImage(source, (size - dw) / 2, (size - dh) / 2, dw, dh);
    return canvasToJpegBlobUrl(c);
  }

  /**
   * Turn https / data / blob into a same-origin-ish JPEG blob URL for Media Session.
   * @param {string} src
   * @returns {Promise<string>}
   */
  function materializeArtwork(src) {
    if (!src) return Promise.reject(new Error('no src'));

    // Already a JPEG/PNG data URL — decode then resize
    if (src.indexOf('data:') === 0) {
      return loadImage(src, false).then(toSquareArtworkUrl);
    }

    // Fetch with CORS (iTunes mzstatic sends ACAO: *)
    return fetch(src, { mode: 'cors', credentials: 'omit', cache: 'force-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('art fetch ' + res.status);
        return res.blob();
      })
      .then(function (blob) {
        if (typeof createImageBitmap === 'function') {
          return createImageBitmap(blob).then(toSquareArtworkUrl);
        }
        var obj = URL.createObjectURL(blob);
        return loadImage(obj, false)
          .then(toSquareArtworkUrl)
          .then(function (out) {
            try {
              URL.revokeObjectURL(obj);
            } catch (_) {}
            return out;
          });
      })
      .catch(function () {
        // Fallback: <img crossOrigin>
        return loadImage(src, true).then(toSquareArtworkUrl);
      });
  }

  function resolveSource(track, coverUrl) {
    var id = String(track.id);
    if (coverUrl) {
      coverSourceByTrack[id] = coverUrl;
      return coverUrl;
    }
    if (coverSourceByTrack[id]) return coverSourceByTrack[id];
    try {
      var map = MPUtils.storageGet('mp-disc-covers-v1', {}) || {};
      if (map[id]) {
        var u = String(map[id])
          .replace(/100x100bb/g, '600x600bb')
          .replace(/60x60bb/g, '600x600bb')
          .replace(/300x300bb/g, '600x600bb');
        coverSourceByTrack[id] = u;
        return u;
      }
    } catch (_) {}
    return null;
  }

  function applyMetadata(track, artEntries) {
    if (!('mediaSession' in navigator) || !track) return;
    try {
      const albumParts = [track.genre || '果子狸のMusic Player'];
      if (currentLyric) albumParts.push(currentLyric);
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name,
        artist: track.artist,
        album: albumParts.join(' · '),
        artwork: artEntries && artEntries.length ? artEntries : logoArtwork,
      });
    } catch (e) {
      console.warn('MediaMetadata failed', e);
    }
  }

  /**
   * @param {object} track
   * @param {string} [coverUrl] https / data / blob source to prefer
   */
  function updateMetadata(track, coverUrl) {
    if (!('mediaSession' in navigator) || !track) return;

    var id = String(track.id);
    var source = resolveSource(track, coverUrl);

    // Fast path: already materialized for this source
    if (source && blobUrlByTrack[id] && coverSourceByTrack[id] === source) {
      applyMetadata(track, [
        { src: blobUrlByTrack[id], sizes: '512x512', type: 'image/jpeg' },
        { src: blobUrlByTrack[id], sizes: '256x256', type: 'image/jpeg' },
      ]);
      return;
    }

    if (!source) {
      applyMetadata(track, logoArtwork);
      return;
    }

    // Optimistic: apply source immediately (may work on some devices), then upgrade to blob
    var mime =
      source.indexOf('data:image/png') === 0 || /\.png(\?|$)/i.test(source)
        ? 'image/png'
        : 'image/jpeg';
    applyMetadata(track, [
      { src: source, sizes: '512x512', type: mime },
      { src: source, sizes: '256x256', type: mime },
    ]);

    var job = ++artworkJob;
    materializeArtwork(source)
      .then(function (blobUrl) {
        if (job !== artworkJob) {
          try {
            URL.revokeObjectURL(blobUrl);
          } catch (_) {}
          return;
        }
        var cur =
          window.MPPlayer && MPPlayer.getCurrentTrack && MPPlayer.getCurrentTrack();
        if (!cur || String(cur.id) !== id) {
          try {
            URL.revokeObjectURL(blobUrl);
          } catch (_) {}
          return;
        }
        revokeBlob(id);
        blobUrlByTrack[id] = blobUrl;
        // Song art only — no logo fallback entries
        applyMetadata(track, [
          { src: blobUrl, sizes: '512x512', type: 'image/jpeg' },
          { src: blobUrl, sizes: '256x256', type: 'image/jpeg' },
        ]);
      })
      .catch(function () {
        /* keep optimistic source or logo already applied */
      });
  }

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
