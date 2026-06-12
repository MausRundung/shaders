/* WebGL2 engine: compiles the uber shader, owns the render loop,
   exposes deterministic renderAt(phase) for exporters. */

var Engine = (function () {
  var canvas, gl, program, uniforms = {};
  var playing = true;
  var suspended = false;
  var started = false;
  var ready = false;
  var loopT = 0;            // seconds into current loop
  var lastTick = 0;
  var fps = 60, fpsAcc = 0, fpsN = 0, fpsCb = null;
  var maxFps = 60, minFrameMs = 1000 / 60, lastDraw = 0;
  var getParams = null;     // injected: () => P

  var UNIFORM_NAMES = [
    "u_res", "u_phase", "u_seed", "u_mode",
    "u_c1", "u_c2", "u_c3", "u_c4", "u_bg",
    "u_hue", "u_sat", "u_exposure", "u_contrast",
    "u_scale", "u_complex", "u_warp", "u_flow", "u_stretch",
    "u_light", "u_gloss", "u_lightAngle", "u_irid", "u_glow",
    "u_grain", "u_cell", "u_lines", "u_ca", "u_vig", "u_soft",
    "u_travel",
    "u_synth", "u_modeB", "u_mixOp", "u_blend",
    "u_genome", "u_g1", "u_g2", "u_g3"
  ];

  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error("Shader compile error:\n" + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  /* Two-stage boot: the slim base shader (no genome) links in a second
     or two and gets pixels on screen; the full shader compiles in the
     background via KHR_parallel_shader_compile and is swapped in when
     the driver finishes. The main thread never blocks on a long link. */

  var fullReady = false;

  function buildProgram(fragSrc, parallel, cb) {
    var prog = gl.createProgram();
    try {
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT_SRC));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragSrc));
    } catch (e) {
      cb(null, String(e.message || e));
      return;
    }
    gl.linkProgram(prog);

    function check() {
      if (gl.isContextLost()) { cb(null, "context lost"); return; }
      if (gl.getProgramParameter(prog, gl.LINK_STATUS)) cb(prog, null);
      else cb(null, gl.getProgramInfoLog(prog) || "unknown link error");
    }

    if (parallel) {
      (function poll() {
        if (gl.isContextLost()) { cb(null, "context lost"); return; }
        if (gl.getProgramParameter(prog, parallel.COMPLETION_STATUS_KHR)) check();
        else setTimeout(poll, 80);
      })();
    } else {
      setTimeout(check, 30);
    }
  }

  function adoptProgram(prog) {
    program = prog;
    gl.useProgram(program);
    UNIFORM_NAMES.forEach(function (n) {
      uniforms[n] = gl.getUniformLocation(program, n);
    });
  }

  function init(canvasEl, paramsGetter, opts) {
    opts = opts || {};
    canvas = canvasEl;
    getParams = paramsGetter;
    gl = canvas.getContext("webgl2", {
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: "default"
    });
    if (!gl) {
      if (opts.onError) { opts.onError("WebGL2 not available"); return; }
      throw new Error("WebGL2 not available");
    }

    canvas.addEventListener("webglcontextlost", function (e) {
      e.preventDefault();
      suspended = true;
      started = false;
      ready = false;
      if (opts.onContextLost) opts.onContextLost();
    }, false);

    var parallel = gl.getExtension("KHR_parallel_shader_compile");

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    buildProgram(FRAG_SRC_BASE, parallel, function (baseProg, err) {
      if (!baseProg) {
        if (opts.onError) opts.onError("Program link error: " + err);
        return;
      }
      adoptProgram(baseProg);
      ready = true;
      lastTick = performance.now();
      started = false;

      if (opts.onReady) opts.onReady();
      if (opts.autostart !== false) start();

      /* upgrade to the full shader (genome styles) in the background */
      buildProgram(FRAG_SRC_FULL, parallel, function (fullProg, ferr) {
        if (!fullProg) return;   /* keep base; genome styles unavailable */
        adoptProgram(fullProg);
        gl.deleteProgram(baseProg);
        fullReady = true;
        if (opts.onFullReady) opts.onFullReady();
      });
    });
  }

  function isLost() {
    return !gl || gl.isContextLost();
  }

  function canRender() {
    return ready && gl && !gl.isContextLost();
  }

  function start() {
    if (!canRender() || started) return;
    started = true;
    suspended = false;
    lastTick = performance.now();
    requestAnimationFrame(tick);
  }

  function setSize(w, h) {
    if (!canvas || !canRender()) return;
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
  }

  function pushUniforms(P, phase) {
    if (!canRender()) return;
    gl.uniform2f(uniforms.u_res, canvas.width, canvas.height);
    gl.uniform1f(uniforms.u_phase, phase);
    gl.uniform1f(uniforms.u_seed, P.seed);
    gl.uniform1i(uniforms.u_mode, P.mode);

    gl.uniform3fv(uniforms.u_c1, hexToRgb01(P.c1));
    gl.uniform3fv(uniforms.u_c2, hexToRgb01(P.c2));
    gl.uniform3fv(uniforms.u_c3, hexToRgb01(P.c3));
    gl.uniform3fv(uniforms.u_c4, hexToRgb01(P.c4));
    gl.uniform3fv(uniforms.u_bg, hexToRgb01(P.bg));

    gl.uniform1f(uniforms.u_hue, P.hue);
    gl.uniform1f(uniforms.u_sat, P.sat);
    gl.uniform1f(uniforms.u_exposure, P.exposure);
    gl.uniform1f(uniforms.u_contrast, P.contrast);

    gl.uniform1f(uniforms.u_scale, P.scale);
    gl.uniform1f(uniforms.u_complex, P.complex);
    gl.uniform1f(uniforms.u_warp, P.warp);
    gl.uniform1f(uniforms.u_flow, P.flow);
    gl.uniform1f(uniforms.u_stretch, P.stretch);

    gl.uniform1f(uniforms.u_light, P.light);
    gl.uniform1f(uniforms.u_gloss, P.gloss);
    gl.uniform1f(uniforms.u_lightAngle, P.lightAngle);
    gl.uniform1f(uniforms.u_irid, P.irid);
    gl.uniform1f(uniforms.u_glow, P.glow);

    gl.uniform1f(uniforms.u_grain, P.grain);
    gl.uniform1f(uniforms.u_cell, P.cell);
    gl.uniform1f(uniforms.u_lines, P.lines);
    gl.uniform1f(uniforms.u_ca, P.ca);
    gl.uniform1f(uniforms.u_vig, P.vig);
    gl.uniform1f(uniforms.u_soft, P.soft);

    gl.uniform1f(uniforms.u_travel, P.travel);

    gl.uniform1i(uniforms.u_synth, P.synthOn ? 1 : 0);
    gl.uniform1i(uniforms.u_modeB, P.modeB | 0);
    gl.uniform1i(uniforms.u_mixOp, P.mixOp | 0);
    gl.uniform1f(uniforms.u_blend, P.blend);

    var g = P.genes || [0,0,0,0, 0,0,0,0, 0,0,0,0];
    gl.uniform1i(uniforms.u_genome, P.genomeOn ? 1 : 0);
    gl.uniform4f(uniforms.u_g1, g[0], g[1], g[2], g[3]);
    gl.uniform4f(uniforms.u_g2, g[4], g[5], g[6], g[7]);
    gl.uniform4f(uniforms.u_g3, g[8], g[9], g[10], g[11]);
  }

  function renderAt(phase) {
    if (!canRender()) return;
    var P = getParams();
    pushUniforms(P, phase);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function currentPhase() {
    var P = getParams();
    return (loopT / P.loop) % 1;
  }

  function tick(now) {
    if (suspended || !canRender()) return;
    if (now - lastDraw < minFrameMs) {
      requestAnimationFrame(tick);
      return;
    }
    lastDraw = now;

    var dt = Math.min((now - lastTick) / 1000, 0.1);
    lastTick = now;

    if (playing) {
      var P = getParams();
      loopT = (loopT + dt) % P.loop;
    }
    renderAt(currentPhase());

    fpsAcc += dt; fpsN++;
    if (fpsAcc >= 0.5) {
      fps = Math.round(fpsN / fpsAcc);
      fpsAcc = 0; fpsN = 0;
      if (fpsCb) fpsCb(fps);
    }
    requestAnimationFrame(tick);
  }

  function setMaxFps(n) {
    maxFps = Math.max(15, Math.min(n, 60));
    minFrameMs = 1000 / maxFps;
  }

  function readPixels() {
    var w = canvas.width, h = canvas.height;
    var buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    /* flip vertically: GL origin is bottom-left */
    var flipped = new Uint8Array(w * h * 4);
    var row = w * 4;
    for (var y = 0; y < h; y++) {
      flipped.set(buf.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
    }
    return flipped;
  }

  return {
    init: init,
    start: start,
    isReady: function () { return ready; },
    setSize: setSize,
    renderAt: renderAt,
    readPixels: readPixels,
    currentPhase: currentPhase,
    resetTime: function () { loopT = 0; },
    setLoopTime: function (t) { loopT = t; },
    suspend: function () { suspended = true; started = false; },
    resume: function () {
      if (!canRender()) return;
      suspended = false;
      started = false;
      start();
    },
    isLost: isLost,
    setMaxFps: setMaxFps,
    hasGenome: function () { return fullReady; },
    setPlaying: function (v) { playing = v; lastTick = performance.now(); },
    isPlaying: function () { return playing; },
    onFps: function (cb) { fpsCb = cb; },
    canvas: function () { return canvas; },
    size: function () { return canvas ? [canvas.width, canvas.height] : [0, 0]; }
  };
})();
