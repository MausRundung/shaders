/* Celebration effect for finished exports: a palette-colored particle
   burst with an expanding ring and a success toast with a drawn check.
   Pure transform/opacity + one lightweight 2d canvas, auto-cleans. */

var FX = (function () {

  function celebrate(message) {
    burst();
    successToast(message);
  }

  function burst() {
    var c = document.createElement("canvas");
    c.className = "fx-layer";
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = innerWidth * dpr;
    c.height = innerHeight * dpr;
    document.body.appendChild(c);
    var ctx = c.getContext("2d");
    ctx.scale(dpr, dpr);

    var cx = innerWidth / 2;
    var cy = innerHeight * 0.42;

    var ring = document.createElement("div");
    ring.className = "fx-ring";
    ring.style.left = cx + "px";
    ring.style.top = cy + "px";
    document.body.appendChild(ring);
    setTimeout(function () { ring.remove(); }, 750);

    var colors = [P.c1, P.c2, P.c3, P.c4, "#ffffff"];
    var parts = [];
    var N = 110;
    for (var i = 0; i < N; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 4 + Math.random() * 13;
      parts.push({
        x: cx, y: cy,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 3,
        r: 1.5 + Math.random() * 3.2,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        col: colors[(Math.random() * colors.length) | 0],
        shape: Math.random() < 0.4 ? 1 : 0,
        life: 1
      });
    }

    var t0 = performance.now();
    function frame(now) {
      var dt = Math.min((now - t0) / 1000, 2);
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      var alive = false;
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        p.x += p.vx; p.y += p.vy;
        p.vx *= 0.965; p.vy = p.vy * 0.965 + 0.32;
        p.rot += p.vr;
        p.life -= 0.012 + Math.random() * 0.006;
        if (p.life <= 0) continue;
        alive = true;
        ctx.globalAlpha = Math.max(p.life, 0);
        ctx.fillStyle = p.col;
        if (p.shape === 1) {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillRect(-p.r, -p.r * 0.55, p.r * 2, p.r * 1.1);
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (alive && dt < 2) requestAnimationFrame(frame);
      else c.remove();
    }
    requestAnimationFrame(frame);
  }

  var toastTimer = null;
  function successToast(message) {
    var t = document.getElementById("toast");
    t.innerHTML = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.6" fill="none" stroke="#7de8a4" stroke-width="1.4" opacity="0.6"/><path d="M5 8.2 L7.2 10.4 L11.2 5.8" fill="none" stroke="#7de8a4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>' + message + "</span>";
    t.classList.add("success");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.hidden = true;
      t.classList.remove("success");
      t.textContent = "";
    }, 3400);
  }

  return { celebrate: celebrate };
})();
