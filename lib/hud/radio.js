import { HUD } from '../config.js';

/**
 * lib/hud/radio.js — 3-channel HUD radio widget.
 *
 * Channels:
 *   off  → VIBE FM (pop)  → AKIBA WAVE (j-pop) → STEEL STORM (rock/metal) → off
 *
 * No actual audio — purely visual. Each track has a fake duration; the widget
 * auto-advances through the playlist. The widget persists across game-over /
 * restarts (radio keeps playing).
 *
 * API:
 *   const radio = createRadio();
 *   radio.cycleChannel();   // call on T-key press
 *   radio.tick(dt);         // call every frame while playing
 */

// ── Station data ─────────────────────────────────────────────────────────────

/** @typedef {{ title: string, artist: string, duration: number, src?: string }} Track */
/** @typedef {{ name: string, slug: string, accent: string, tracks: Track[] }} Station */

/**
 * Stations point to /data/music/<slug>/ — drop .mp3 / .ogg / .wav files in any
 * of those folders and they'll be picked up. Track titles default to the
 * filename (extension stripped, underscores → spaces) until you add metadata.
 *
 * @type {Station[]}
 */
const STATIONS = [
  { name: 'VIBE FM', slug: 'vibe_fm', accent: '#ff55cc', tracks: [] },
  { name: 'AKIBA WAVE', slug: 'akiba_wave', accent: '#55eeff', tracks: [] },
  { name: 'STEEL STORM', slug: 'steel_storm', accent: '#ff6622', tracks: [] },
];

const AUDIO_EXTS = /\.(mp3|ogg|wav|m4a|flac|aac)$/i;
const STORAGE_KEY = 'vxm_radio_channel';

/** Pretty-format a filename for display: strip extension, underscores → spaces. */
function _trackTitleFromName(name) {
  return name.replace(AUDIO_EXTS, '').replace(/_/g, ' ');
}

/**
 * Fetch the directory index nginx serves at /data/music/<slug>/ and turn it
 * into a track list. Falls back to an empty list on error / 404.
 */
async function _loadStationTracks(station) {
  try {
    const res = await fetch(`/data/music/${station.slug}/`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const list = await res.json();
    if (!Array.isArray(list)) return [];
    return list
      .filter((e) => e && e.type === 'file' && AUDIO_EXTS.test(e.name))
      .map((e) => ({
        title: _trackTitleFromName(e.name),
        artist: station.name,
        duration: 30, // placeholder; replaced when audio metadata loads
        src: `/data/music/${station.slug}/${encodeURIComponent(e.name)}`,
      }));
  } catch {
    return [];
  }
}

// channels: index 0 = off, 1-3 = stations
const CHANNEL_COUNT = STATIONS.length + 1; // 0=off, 1,2,3

// ── DOM creation ─────────────────────────────────────────────────────────────

function _createWidget() {
  const style = document.createElement('style');
  style.textContent = `
    #radio-widget {
      position: fixed;
      bottom: 14px;
      left: 14px;
      min-width: 220px;
      max-width: 280px;
      padding: 8px 12px 10px;
      background: rgba(8, 8, 14, 0.82);
      border: 1px solid var(--radio-accent, #ff55cc);
      border-radius: 3px;
      font-family: monospace;
      font-size: 11px;
      color: #ccc;
      pointer-events: none;
      display: none;
      flex-direction: column;
      gap: 4px;
      z-index: 8;
      box-shadow: 0 0 10px var(--radio-accent-glow, rgba(255,85,204,0.25));
    }
    #radio-widget.on { display: flex; }
    #radio-station {
      font-size: 13px;
      font-weight: 700;
      color: var(--radio-accent, #ff55cc);
      text-shadow: 0 0 6px var(--radio-accent-glow, rgba(255,85,204,0.5));
      letter-spacing: 3px;
    }
    #radio-track {
      font-size: 12px;
      color: #eee;
      letter-spacing: 1px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #radio-artist {
      font-size: 10px;
      color: #999;
      letter-spacing: 1px;
    }
    #radio-progress {
      margin-top: 4px;
      width: 100%;
      height: 2px;
      background: rgba(255,255,255,0.12);
      border-radius: 1px;
      overflow: hidden;
    }
    #radio-progress-fill {
      height: 100%;
      background: var(--radio-accent, #ff55cc);
      width: 0%;
      transition: width 0.5s linear;
    }
  `;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.id = 'radio-widget';
  el.innerHTML = `
    <div id="radio-station"></div>
    <div id="radio-track"></div>
    <div id="radio-artist"></div>
    <div id="radio-progress"><div id="radio-progress-fill"></div></div>
  `;
  document.body.appendChild(el);

  return {
    widget: el,
    station: el.querySelector('#radio-station'),
    track: el.querySelector('#radio-track'),
    artist: el.querySelector('#radio-artist'),
    progressFill: el.querySelector('#radio-progress-fill'),
  };
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createRadio() {
  const dom = _createWidget();

  // Load any saved channel selection from localStorage. Default = off.
  let channelIndex = 0;
  let trackIndex = 0;
  let trackElapsed = 0;
  try {
    const saved = Number.parseInt(localStorage.getItem(STORAGE_KEY) ?? '0', 10);
    if (Number.isFinite(saved) && saved >= 0 && saved < CHANNEL_COUNT) channelIndex = saved;
  } catch {
    /* storage disabled */
  }

  function _saveChannel() {
    try {
      localStorage.setItem(STORAGE_KEY, String(channelIndex));
    } catch {}
  }

  // Single shared audio element. Tracks without `src` play silently (visual only).
  const audio = new Audio();
  audio.preload = 'auto';
  audio.addEventListener('ended', () => {
    const station = _stationData();
    if (!station) return;
    trackIndex = (trackIndex + 1) % station.tracks.length;
    trackElapsed = 0;
    _renderTrack();
    _playCurrent();
  });
  audio.addEventListener('loadedmetadata', () => {
    // Use real duration when available so the visual progress bar matches audio.
    const station = _stationData();
    if (!station || !Number.isFinite(audio.duration)) return;
    station.tracks[trackIndex].duration = audio.duration;
  });
  audio.addEventListener('error', () => {
    // Fall through silently — visual playback still advances on the fake duration.
  });

  function _stationData() {
    return channelIndex > 0 ? STATIONS[channelIndex - 1] : null;
  }

  // Browsers block audio.play() until the user has interacted with the page.
  // Track whether we should resume playback as soon as a gesture lands.
  let _gestureUnlocked = false;
  let _wantsPlaying = channelIndex > 0;
  const _domCache = {
    station: '',
    track: '',
    artist: '',
    accent: '',
    accentGlow: '',
    progressWidth: '',
    widgetOn: false,
  };
  let _progressAccumulator = 0;

  function _setText(el, key, value) {
    if (_domCache[key] === value) return;
    el.textContent = value;
    _domCache[key] = value;
  }

  function _setWidgetOn(on) {
    if (_domCache.widgetOn === on) return;
    dom.widget.classList.toggle('on', on);
    _domCache.widgetOn = on;
  }

  function _playCurrent() {
    const station = _stationData();
    if (!station) {
      audio.pause();
      audio.removeAttribute('src');
      return;
    }
    const track = station.tracks[trackIndex];
    if (!track.src) {
      audio.pause();
      audio.removeAttribute('src');
      return;
    }
    if (audio.src !== track.src) audio.src = track.src;
    audio.currentTime = 0;
    audio
      .play()
      .then(() => {
        _gestureUnlocked = true;
      })
      .catch(() => {
        // Autoplay blocked — _onUserGesture will retry on the first user input.
      });
  }

  function _onUserGesture() {
    if (_gestureUnlocked) return;
    _gestureUnlocked = true;
    if (_wantsPlaying) _playCurrent();
  }
  // Single-shot listener (returns to inert after the first gesture lands).
  ['keydown', 'pointerdown', 'touchstart'].forEach((evt) => {
    window.addEventListener(evt, _onUserGesture, { once: true });
  });

  function _applyStyle(station) {
    if (!station) return;
    if (_domCache.accent !== station.accent) {
      dom.widget.style.setProperty('--radio-accent', station.accent);
      _domCache.accent = station.accent;
    }
    // Glow is accent at 35% opacity.
    // Parse hex to rgba — accent is always #rrggbb.
    const r = Number.parseInt(station.accent.slice(1, 3), 16);
    const g = Number.parseInt(station.accent.slice(3, 5), 16);
    const b = Number.parseInt(station.accent.slice(5, 7), 16);
    const glow = `rgba(${r},${g},${b},0.35)`;
    if (_domCache.accentGlow !== glow) {
      dom.widget.style.setProperty('--radio-accent-glow', glow);
      _domCache.accentGlow = glow;
    }
  }

  function _renderTrack() {
    const station = _stationData();
    if (!station) return;
    if (station.tracks.length === 0) {
      _renderEmptyStation();
      return;
    }
    const track = station.tracks[trackIndex];
    _setText(dom.station, 'station', station.name);
    _setText(dom.track, 'track', track.title);
    _setText(dom.artist, 'artist', track.artist);
    _applyStyle(station);
    dom.progressFill.style.transition = 'none';
    dom.progressFill.style.width = '0%';
    _domCache.progressWidth = '0%';
    _progressAccumulator = 0;
    dom.progressFill.offsetWidth; // eslint-disable-line no-unused-expressions
    dom.progressFill.style.transition = '';
  }

  function _renderEmptyStation() {
    const station = _stationData();
    if (!station) return;
    _setText(dom.station, 'station', station.name);
    _setText(dom.track, 'track', '— no tracks —');
    _setText(dom.artist, 'artist', `drop files in /data/music/${station.slug}/`);
    _applyStyle(station);
    if (_domCache.progressWidth !== '0%') {
      dom.progressFill.style.width = '0%';
      _domCache.progressWidth = '0%';
    }
  }

  function _updateProgress(force = false) {
    const station = _stationData();
    if (!station) return;
    const track = station.tracks[trackIndex];
    const updateHz = Math.max(1, HUD.radioProgressUpdateHz ?? 4);
    const interval = 1 / updateHz;
    if (!force && _progressAccumulator < interval) return;
    _progressAccumulator = 0;
    const pct = Math.min(100, (trackElapsed / track.duration) * 100);
    const width = `${pct.toFixed(1)}%`;
    if (_domCache.progressWidth === width) return;
    dom.progressFill.style.width = width;
    _domCache.progressWidth = width;
  }

  return {
    /**
     * Cycle to next channel: off → VIBE FM → AKIBA WAVE → STEEL STORM → off.
     */
    cycleChannel() {
      channelIndex = (channelIndex + 1) % CHANNEL_COUNT;
      _saveChannel();
      const station = _stationData();
      _wantsPlaying = !!station;
      if (station) {
        trackIndex = 0;
        trackElapsed = 0;
        _setWidgetOn(true);
        _renderTrack();
        _updateProgress(true);
        _playCurrent();
      } else {
        _setWidgetOn(false);
        audio.pause();
        audio.removeAttribute('src');
      }
    },

    /** Set or replace the audio src list for one station. Pass src=null to clear. */
    setStationTracks(channelName, tracks) {
      const s = STATIONS.find((x) => x.name === channelName);
      if (!s) return;
      s.tracks = tracks;
      // If currently playing this station, refresh.
      const cur = _stationData();
      if (cur && cur.name === channelName) {
        trackIndex = 0;
        trackElapsed = 0;
        _renderTrack();
        _playCurrent();
      }
    },

    /** Set audio volume [0..1]. */
    setVolume(v) {
      audio.volume = Math.max(0, Math.min(1, v));
    },

    /**
     * Discover tracks for every station by listing /data/music/<slug>/ from
     * the server, then start playback if a saved channel was restored.
     */
    async loadAll() {
      await Promise.all(
        STATIONS.map(async (s) => {
          s.tracks = await _loadStationTracks(s);
        }),
      );
      // If a station was saved and has tracks, light it up.
      const station = _stationData();
      if (station && station.tracks.length > 0) {
        trackIndex = 0;
        trackElapsed = 0;
        _setWidgetOn(true);
        _renderTrack();
        _updateProgress(true);
        _playCurrent();
      } else if (channelIndex > 0) {
        // Saved channel exists but has no tracks — show the empty station header.
        _setWidgetOn(true);
        _renderEmptyStation();
      }
    },

    /**
     * Must be called every frame with the elapsed time in seconds.
     * @param {number} dt
     */
    tick(dt) {
      const station = _stationData();
      if (!station) return;
      if (station.tracks.length === 0) return;

      const track = station.tracks[trackIndex];

      if (track.src && !audio.paused && Number.isFinite(audio.duration)) {
        trackElapsed = audio.currentTime;
        // 'ended' event handles advancement when audio actually finishes.
      } else {
        trackElapsed += dt;
        if (trackElapsed >= track.duration) {
          trackIndex = (trackIndex + 1) % station.tracks.length;
          trackElapsed = 0;
          _renderTrack();
          _playCurrent();
        }
      }
      _progressAccumulator += dt;
      _updateProgress();
    },
  };
}
