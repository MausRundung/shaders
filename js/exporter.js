/* Export pipeline: PNG stills, WebM/MP4 video, looping GIF. */

var Exporter = (function () {
  var cancelled = false;
  var busy = false;

  function $(id) { return document.getElementById(id); }

  function showOverlay(title) {
    cancelled = false;
    $("overlay-title").textContent = title;
    $("overlay-detail").textContent = "preparing";
    $("overlay-bar").style.width = "0%";
    $("overlay").hidden = false;
  }
  function setProgress(frac, detail) {
    $("overlay-bar").style.width = Math.round(frac * 100) + "%";
    if (detail) $("overlay-detail").textContent = detail;
  }
  function hideOverlay() { $("overlay").hidden = true; }

  function download(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  function stamp(P, ext) {
    var mode = MODES[P.mode].key;
    return "lumen-" + mode + "-" + String(Math.round(P.seed)).padStart(4, "0") + "." + ext;
  }

  function evenRound(v) { return 2 * Math.round(v / 2); }

  /* ---------- PNG ---------- */
  function exportPNG(P, aspect) {
    if (busy) return;
    busy = true;
    var prev = Engine.size();
    var h = parseInt(P.imgRes, 10);
    var w = evenRound(h * aspect);
    Engine.setSize(w, h);
    Engine.renderAt(Engine.currentPhase());
    Engine.canvas().toBlob(function (blob) {
      Engine.setSize(prev[0], prev[1]);
      Engine.renderAt(Engine.currentPhase());
      busy = false;
      if (blob) {
        download(blob, stamp(P, "png"));
        UI.toast("Saved " + w + "\u00d7" + h + " PNG");
      }
    }, "image/png");
  }

  /* ---------- Video (realtime capture) ---------- */
  function pickVideoMime() {
    var candidates = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
      "video/mp4"
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return null;
  }

  function exportVideo(P, aspect) {
    if (busy) return;
    var mime = pickVideoMime();
    if (!mime) { UI.toast("Video recording not supported in this browser"); return; }
    busy = true;

    var prev = Engine.size();
    var h = parseInt(P.vidRes, 10);
    var w = evenRound(h * aspect);
    Engine.setSize(w, h);

    var wasPlaying = Engine.isPlaying();
    Engine.setPlaying(true);
    Engine.resetTime();

    var durMs = P.loop * P.vidLoops * 1000;
    var ext = mime.indexOf("mp4") >= 0 ? "mp4" : "webm";
    showOverlay("Recording video");

    var stream = Engine.canvas().captureStream(60);
    var rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 18000000 });
    var parts = [];
    rec.ondataavailable = function (e) { if (e.data.size) parts.push(e.data); };
    rec.onstop = function () {
      Engine.setSize(prev[0], prev[1]);
      Engine.setPlaying(wasPlaying);
      hideOverlay();
      busy = false;
      if (!cancelled) {
        download(new Blob(parts, { type: mime }), stamp(P, ext));
        UI.toast("Saved " + (durMs / 1000).toFixed(1) + "s " + ext.toUpperCase() + " (" + w + "\u00d7" + h + ")");
      }
    };
    rec.start(200);

    var t0 = performance.now();
    (function poll() {
      var el = performance.now() - t0;
      if (cancelled) { rec.stop(); return; }
      setProgress(Math.min(el / durMs, 1), (el / 1000).toFixed(1) + "s / " + (durMs / 1000).toFixed(1) + "s \u00b7 " + w + "\u00d7" + h);
      if (el >= durMs) { rec.stop(); return; }
      requestAnimationFrame(poll);
    })();
  }

  /* ---------- GIF (offline, deterministic, perfect loop) ---------- */
  async function exportGIF(P, aspect) {
    if (busy) return;
    busy = true;

    var prev = Engine.size();
    var wasPlaying = Engine.isPlaying();
    Engine.setPlaying(false);

    var w = parseInt(P.gifW, 10);
    var h = evenRound(w / aspect);
    var fps = parseInt(P.gifFps, 10);
    var nFrames = Math.max(2, Math.round(P.loop * fps));

    showOverlay("Rendering GIF");
    Engine.setSize(w, h);

    var frames = [];
    for (var f = 0; f < nFrames; f++) {
      if (cancelled) break;
      Engine.renderAt(f / nFrames);
      frames.push(Engine.readPixels());
      setProgress(0.4 * (f + 1) / nFrames, "capturing " + (f + 1) + "/" + nFrames);
      if (f % 4 === 3) await wait(0);
    }

    Engine.setSize(prev[0], prev[1]);
    Engine.setPlaying(wasPlaying);

    if (cancelled) { hideOverlay(); busy = false; return; }

    var data = await GIFEnc.encode({
      frames: frames, width: w, height: h, fps: fps,
      dither: P.gifDither,
      onProgress: function (frac, detail) { setProgress(0.4 + 0.6 * frac, "encoding \u00b7 " + detail); },
      isCancelled: function () { return cancelled; }
    });

    hideOverlay();
    busy = false;
    if (data && !cancelled) {
      download(new Blob([data], { type: "image/gif" }), stamp(P, "gif"));
      UI.toast("Saved " + nFrames + "-frame looping GIF (" + w + "\u00d7" + h + ")");
    }
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  document.addEventListener("DOMContentLoaded", function () {
    $("overlay-cancel").addEventListener("click", function () { cancelled = true; });
  });

  return {
    exportPNG: exportPNG,
    exportVideo: exportVideo,
    exportGIF: exportGIF,
    isBusy: function () { return busy; }
  };
})();
