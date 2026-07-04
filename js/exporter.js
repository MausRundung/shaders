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
        FX.celebrate("Saved " + w + "\u00d7" + h + " PNG");
      }
    }, "image/png");
  }

  /* ---------- Video (WebCodecs: deterministic offline encode, no MediaRecorder) ---------- */

  function videoDurationSec(P) {
    var v = String(P.vidLen || "l2");
    if (v.charAt(0) === "s") return Math.max(1, parseInt(v.slice(1), 10) || 5);
    return P.loop * Math.max(1, parseInt(v.slice(1), 10) || 1);
  }

  function videoBitrate(w, h, fps) {
    var px = w * h;
    var base = px >= 2560 * 1440 ? 14000000 : px >= 1920 * 1080 ? 9000000 : px >= 1280 * 720 ? 6000000 : 3500000;
    return fps >= 60 ? Math.round(base * 1.4) : base;
  }

  async function pickEncoderConfig(w, h, fps) {
    var candidates = [
      { codec: "vp09.00.10.08", codecId: "V_VP9" },
      { codec: "vp8", codecId: "V_VP8" }
    ];
    for (var i = 0; i < candidates.length; i++) {
      var cfg = {
        codec: candidates[i].codec,
        width: w, height: h,
        bitrate: videoBitrate(w, h, fps),
        framerate: fps
      };
      try {
        var sup = await VideoEncoder.isConfigSupported(cfg);
        if (sup && sup.supported) return { config: cfg, codecId: candidates[i].codecId };
      } catch (e) { /* try next codec */ }
    }
    return null;
  }

  async function exportVideo(P, aspect) {
    if (busy) return;
    if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") {
      UI.toast("This browser has no WebCodecs support, use a current Chrome, Edge or Firefox");
      return;
    }
    busy = true;

    var prev = Engine.size();
    var wasPlaying = Engine.isPlaying();
    var h = parseInt(P.vidRes, 10);
    var w = evenRound(h * aspect);
    var fps = parseInt(P.vidFps, 10) || 30;
    var totalSec = videoDurationSec(P);
    var nFrames = Math.max(2, Math.round(totalSec * fps));

    showOverlay("Rendering video");
    Engine.suspend();
    Engine.setPlaying(false);
    Engine.setSize(w, h);

    var picked = await pickEncoderConfig(w, h, fps);
    if (!picked) {
      restore();
      UI.toast("No supported video codec (VP9/VP8) found");
      return;
    }

    var encFrames = [];
    var encError = null;
    var encoder = new VideoEncoder({
      output: function (chunk) {
        var data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        encFrames.push({
          data: data,
          timestampMs: chunk.timestamp / 1000,
          key: chunk.type === "key"
        });
      },
      error: function (e) { encError = e; }
    });
    encoder.configure(picked.config);

    var canvas = Engine.canvas();
    var usPerFrame = 1e6 / fps;

    try {
      for (var f = 0; f < nFrames; f++) {
        if (cancelled || encError) break;

        var t = f / fps;
        Engine.setLoopTime(t % P.loop);
        Engine.renderAt((t % P.loop) / P.loop);

        var vf = new VideoFrame(canvas, {
          timestamp: Math.round(f * usPerFrame),
          duration: Math.round(usPerFrame)
        });
        /* keyframe every 2 seconds keeps files small and seekable */
        encoder.encode(vf, { keyFrame: f % (fps * 2) === 0 });
        vf.close();

        setProgress(0.9 * (f + 1) / nFrames,
          "frame " + (f + 1) + "/" + nFrames + " \u00b7 " + w + "\u00d7" + h + " @ " + fps + "fps");

        /* backpressure: never let the encoder queue grow unbounded */
        while (encoder.encodeQueueSize > 2) await wait(2);
        if (f % 8 === 7) await wait(0);
      }

      if (!cancelled && !encError) {
        setProgress(0.93, "finalizing encode");
        await encoder.flush();
      }
    } catch (e) {
      encError = e;
    }

    try { encoder.close(); } catch (ignore) {}

    /* restore live view before the (fast) muxing step */
    Engine.setSize(prev[0], prev[1]);
    Engine.setPlaying(wasPlaying);
    Engine.resume();

    if (cancelled) { hideOverlay(); busy = false; return; }
    if (encError || !encFrames.length) {
      hideOverlay(); busy = false;
      UI.toast("Video encode failed" + (encError && encError.message ? ": " + encError.message : ""));
      return;
    }

    setProgress(0.97, "writing webm container");
    await wait(0);
    var webm = WebMMux.mux({
      codecId: picked.codecId,
      width: w, height: h,
      durationMs: totalSec * 1000,
      frames: encFrames
    });

    hideOverlay();
    busy = false;
    download(new Blob([webm], { type: "video/webm" }), stamp(P, "webm"));
    FX.celebrate("Saved " + totalSec.toFixed(1) + "s video \u00b7 " + w + "\u00d7" + h + " @ " + fps + "fps");

    function restore() {
      Engine.setSize(prev[0], prev[1]);
      Engine.setPlaying(wasPlaying);
      Engine.resume();
      hideOverlay();
      busy = false;
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
      dither: P.gifDither, loop: P.gifLoop,
      onProgress: function (frac, detail) { setProgress(0.4 + 0.6 * frac, "encoding \u00b7 " + detail); },
      isCancelled: function () { return cancelled; }
    });

    hideOverlay();
    busy = false;
    if (data && !cancelled) {
      download(new Blob([data], { type: "image/gif" }), stamp(P, "gif"));
      FX.celebrate("Saved " + nFrames + "-frame looping GIF (" + w + "\u00d7" + h + ")");
    }
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  document.addEventListener("DOMContentLoaded", function () {
    $("overlay-cancel").addEventListener("click", function () { cancelled = true; });
  });

  function getCodeString(P) {
    return '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<title>LUMEN Shader Export</title>\n' +
'<style>\n' +
'  body { margin: 0; padding: 0; background: #000; overflow: hidden; height: 100vh; }\n' +
'  canvas { display: block; width: 100vw; height: 100vh; }\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'<canvas id="view"></canvas>\n' +
'<script>\n' +
'// LUMEN Shader Export\n' +
'// Generated by lumenshaders.vercel.app\n\n' +
'const P = ' + JSON.stringify(P, null, 2) + ';\n\n' +
'const VERT_SRC = ' + JSON.stringify(VERT_SRC) + ';\n' +
'const FRAG_SRC = ' + JSON.stringify(FRAG_SRC_FULL) + ';\n\n' +
'const canvas = document.getElementById("view");\n' +
'const gl = canvas.getContext("webgl2", { antialias: false });\n\n' +
'if (!gl) {\n' +
'  document.body.innerHTML = "<div style=\\"color:white;padding:20px;\\">WebGL2 not supported.</div>";\n' +
'  throw new Error("WebGL2 not supported");\n' +
'}\n\n' +
'function compile(type, src) {\n' +
'  const sh = gl.createShader(type);\n' +
'  gl.shaderSource(sh, src);\n' +
'  gl.compileShader(sh);\n' +
'  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {\n' +
'    console.error(gl.getShaderInfoLog(sh));\n' +
'  }\n' +
'  return sh;\n' +
'}\n\n' +
'const prog = gl.createProgram();\n' +
'gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT_SRC));\n' +
'gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG_SRC));\n' +
'gl.linkProgram(prog);\n' +
'gl.useProgram(prog);\n\n' +
'const unilocs = {};\n' +
'const uniformNames = [\n' +
'  "u_res", "u_phase", "u_seed", "u_mode",\n' +
'  "u_c1", "u_c2", "u_c3", "u_c4", "u_bg",\n' +
'  "u_hue", "u_sat", "u_exposure", "u_contrast",\n' +
'  "u_scale", "u_complex", "u_warp", "u_flow", "u_stretch",\n' +
'  "u_light", "u_gloss", "u_lightAngle", "u_irid", "u_glow",\n' +
'  "u_grain", "u_cell", "u_lines", "u_ca", "u_vig", "u_soft",\n' +
'  "u_travel", "u_synth", "u_modeB", "u_mixOp", "u_blend",\n' +
'  "u_genome", "u_g1", "u_g2", "u_g3"\n' +
'];\n' +
'uniformNames.forEach(n => unilocs[n] = gl.getUniformLocation(prog, n));\n\n' +
'const buf = gl.createBuffer();\n' +
'gl.bindBuffer(gl.ARRAY_BUFFER, buf);\n' +
'gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);\n' +
'gl.enableVertexAttribArray(0);\n' +
'gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);\n\n' +
'function hexToRgb01(hex) {\n' +
'  if (hex[0] === "#") hex = hex.slice(1);\n' +
'  const num = parseInt(hex, 16);\n' +
'  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];\n' +
'}\n\n' +
'function pushUniforms(phase) {\n' +
'  gl.uniform2f(unilocs.u_res, canvas.width, canvas.height);\n' +
'  gl.uniform1f(unilocs.u_phase, phase);\n' +
'  gl.uniform1f(unilocs.u_seed, P.seed);\n' +
'  gl.uniform1i(unilocs.u_mode, P.mode);\n\n' +
'  gl.uniform3fv(unilocs.u_c1, hexToRgb01(P.c1));\n' +
'  gl.uniform3fv(unilocs.u_c2, hexToRgb01(P.c2));\n' +
'  gl.uniform3fv(unilocs.u_c3, hexToRgb01(P.c3));\n' +
'  gl.uniform3fv(unilocs.u_c4, hexToRgb01(P.c4));\n' +
'  gl.uniform3fv(unilocs.u_bg, hexToRgb01(P.bg));\n\n' +
'  gl.uniform1f(unilocs.u_hue, P.hue);\n' +
'  gl.uniform1f(unilocs.u_sat, P.sat);\n' +
'  gl.uniform1f(unilocs.u_exposure, P.exposure);\n' +
'  gl.uniform1f(unilocs.u_contrast, P.contrast);\n\n' +
'  gl.uniform1f(unilocs.u_scale, P.scale);\n' +
'  gl.uniform1f(unilocs.u_complex, P.complex);\n' +
'  gl.uniform1f(unilocs.u_warp, P.warp);\n' +
'  gl.uniform1f(unilocs.u_flow, P.flow);\n' +
'  gl.uniform1f(unilocs.u_stretch, P.stretch);\n\n' +
'  gl.uniform1f(unilocs.u_light, P.light);\n' +
'  gl.uniform1f(unilocs.u_gloss, P.gloss);\n' +
'  gl.uniform1f(unilocs.u_lightAngle, P.lightAngle);\n' +
'  gl.uniform1f(unilocs.u_irid, P.irid);\n' +
'  gl.uniform1f(unilocs.u_glow, P.glow);\n\n' +
'  gl.uniform1f(unilocs.u_grain, P.grain);\n' +
'  gl.uniform1f(unilocs.u_cell, P.cell);\n' +
'  gl.uniform1f(unilocs.u_lines, P.lines);\n' +
'  gl.uniform1f(unilocs.u_ca, P.ca);\n' +
'  gl.uniform1f(unilocs.u_vig, P.vig);\n' +
'  gl.uniform1f(unilocs.u_soft, P.soft);\n\n' +
'  gl.uniform1f(unilocs.u_travel, P.travel);\n\n' +
'  gl.uniform1i(unilocs.u_synth, P.synthOn ? 1 : 0);\n' +
'  gl.uniform1i(unilocs.u_modeB, P.modeB | 0);\n' +
'  gl.uniform1i(unilocs.u_mixOp, P.mixOp | 0);\n' +
'  gl.uniform1f(unilocs.u_blend, P.blend);\n\n' +
'  const g = P.genes || [0,0,0,0, 0,0,0,0, 0,0,0,0];\n' +
'  gl.uniform1i(unilocs.u_genome, P.genomeOn ? 1 : 0);\n' +
'  gl.uniform4f(unilocs.u_g1, g[0], g[1], g[2], g[3]);\n' +
'  gl.uniform4f(unilocs.u_g2, g[4], g[5], g[6], g[7]);\n' +
'  gl.uniform4f(unilocs.u_g3, g[8], g[9], g[10], g[11]);\n' +
'}\n\n' +
'function resize() {\n' +
'  const dpr = Math.min(window.devicePixelRatio || 1, 2);\n' +
'  canvas.width = Math.round(window.innerWidth * dpr);\n' +
'  canvas.height = Math.round(window.innerHeight * dpr);\n' +
'  gl.viewport(0, 0, canvas.width, canvas.height);\n' +
'}\n' +
'window.addEventListener("resize", resize);\n' +
'resize();\n\n' +
'let loopT = 0;\n' +
'let lastTick = performance.now();\n\n' +
'function tick(now) {\n' +
'  const dt = Math.min((now - lastTick) / 1000, 0.1);\n' +
'  lastTick = now;\n' +
'  loopT = (loopT + dt) % P.loop;\n' +
'  const phase = (loopT / P.loop) % 1;\n' +
'  pushUniforms(phase);\n' +
'  gl.drawArrays(gl.TRIANGLES, 0, 3);\n' +
'  requestAnimationFrame(tick);\n' +
'}\n' +
'requestAnimationFrame(tick);\n' +
'</script>\n' +
'</body>\n' +
'</html>';
  }

  return {
    exportPNG: exportPNG,
    exportVideo: exportVideo,
    exportGIF: exportGIF,
    getCodeString: getCodeString,
    exportCode: function(P) {
      try {
        var html = getCodeString(P);
        var blob = new Blob([html], { type: "text/html" });
        download(blob, stamp(P, "html"));
        if (typeof FX !== "undefined" && FX.celebrate) {
          FX.celebrate("Saved WebGL code as HTML");
        } else if (typeof UI !== "undefined" && UI.toast) {
          UI.toast("Saved WebGL code as HTML");
        }
      } catch (e) {
        console.error("Export Code Error:", e);
        if (typeof UI !== "undefined" && UI.toast) UI.toast("Error: " + e.message);
      }
    },
    isBusy: function () { return busy; }
  };
})();
