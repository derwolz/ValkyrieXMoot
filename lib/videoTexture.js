import * as THREE from 'three';

/**
 * Load a video file from data/videos/ as a THREE.VideoTexture for use on a
 * moot sprite.  The texture loops silently at the native frame rate.
 *
 * Returns a Promise that resolves to the VideoTexture on success, or rejects if
 * the file cannot be loaded.  The caller is responsible for disposing the
 * texture (and calling video.pause()) when the sprite is removed.
 *
 * tex.userData.video is set to the underlying HTMLVideoElement so callers can
 * pause or stop it independently.
 *
 * @param {string} file  Filename relative to data/videos/ (e.g. 'foo.mp4').
 * @returns {Promise<THREE.VideoTexture>}
 */
export function loadVideoTexture(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.src = 'data/videos/' + file;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';

    // Resolve as soon as we have enough data to render the first frame.
    video.oncanplay = () => {
      // Autoplay may be blocked on some browsers; the texture will still render
      // once the user interacts with the page (browsers auto-resume muted video
      // on first interaction in most environments).
      video.play().catch(() => {});
      const tex = new THREE.VideoTexture(video);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      // Expose the raw element so callers can pause/stop it on cleanup.
      tex.userData.video = video;
      resolve(tex);
    };

    video.onerror = () => {
      reject(new Error('video load failed: data/videos/' + file));
    };

    // Kick off the load.
    video.load();
  });
}
