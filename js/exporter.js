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

  /* ---------- Video (deterministic frame capture — avoids captureStream(60) crashes) ---------- */
  function pickVideoMime() {
    /* VP8 first: most stable for canvas capture on Chrome/Edge */
    var candidates = [
      "video/webm;codecs=vp8",
      "video/webm;codecs=vp9",
      "video/webm"
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return null;
  }

  function recorderOptions(mime, w, h) {
    var px = w * h;
    var bps = px >= 1920 * 1080 ? 6000000 : px >= 1280 * 720 ? 4000000 : 2500000;
    return { mimeType: mime, videoBitsPerSecond: bps };
  }

  function exportVideo(P, aspect) {
    if (busy) return;
    if (!window.MediaRecorder) { UI.toast("Video recording not supported in this browser"); return; }
    var mime = pickVideoMime();
    if (!mime) { UI.toast("Video recording not supported in this browser"); return; }
    busy = true;

    var prev = Engine.size();
    var wasPlaying = Engine.isPlaying();
    var h = parseInt(P.vidRes, 10);
    var w = evenRound(h * aspect);
    var fps = 30;
    var loops = parseInt(P.vidLoops, 10) || 1;
    var totalSec = P.loop * loops;
    var nFrames = Math.max(2, Math.round(totalSec * fps));
    var frameMs = 1000 / fps;
    var ext = "webm";

    Engine.suspend();
    Engine.setPlaying(false);
    Engine.setSize(w, h);
    showOverlay("Rendering video");

    var canvas = Engine.canvas();
    var stream = canvas.captureStream(0);
    var track = stream.getVideoTracks()[0];
    var rec;
    try {
      rec = new MediaRecorder(stream, recorderOptions(mime, w, h));
    } catch (err) {
      try {
        rec = new MediaRecorder(stream, { mimeType: mime });
      } catch (err2) {
        finishVideo(prev, wasPlaying, null, w, h, ext, 0);
        UI.toast("Video recording failed: " + (err2.message || "unsupported codec"));
        return;
      }
    }

    var parts = [];
    rec.ondataavailable = function (e) { if (e.data && e.data.size) parts.push(e.data); };
    rec.onerror = function () {
      cancelled = true;
      try { rec.stop(); } catch (ignore) {}
      finishVideo(prev, wasPlaying, null, w, h, ext, totalSec);
      UI.toast("Video recording failed");
    };
    rec.onstop = function () {
      finishVideo(prev, wasPlaying, parts.length ? new Blob(parts, { type: mime }) : null, w, h, ext, totalSec);
    };

    rec.start(250);
    var finished = false;
    captureVideoFrames(0);

    function finishVideo(prevSize, resumePlaying, blob, width, height, extension, seconds) {
      if (finished) return;
      finished = true;
      Engine.setSize(prevSize[0], prevSize[1]);
      Engine.setPlaying(resumePlaying);
      Engine.resume();
      hideOverlay();
      busy = false;
      if (blob && !cancelled) {
        download(blob, stamp(P, extension));
        UI.toast("Saved " + seconds.toFixed(1) + "s " + extension.toUpperCase() + " (" + width + "\u00d7" + height + ")");
      }
    }

    function captureVideoFrames(f) {
      if (cancelled || f >= nFrames) {
        try { rec.stop(); } catch (ignore) {}
        return;
      }

      var t = f / fps;
      var phase = (t % P.loop) / P.loop;
      Engine.setLoopTime(t % P.loop);
      Engine.renderAt(phase);
      if (track && track.requestFrame) track.requestFrame();

      setProgress((f + 1) / nFrames,
        "frame " + (f + 1) + "/" + nFrames + " \u00b7 " + w + "\u00d7" + h + " @ " + fps + "fps");

      setTimeout(function () { captureVideoFrames(f + 1); }, frameMs);
    }
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
