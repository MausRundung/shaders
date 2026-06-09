/* Small builder library for the control rail. main.js wires it to state. */

var UI = (function () {

  var DICE_SVG = '<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5.4" cy="5.4" r="1.25" fill="currentColor"/><circle cx="10.6" cy="10.6" r="1.25" fill="currentColor"/><circle cx="10.6" cy="5.4" r="1.25" fill="currentColor"/><circle cx="5.4" cy="10.6" r="1.25" fill="currentColor"/></svg>';

  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  function section(rail, title, onDice) {
    var sec = el("div", "rail-section", rail);
    var head = el("div", "section-head", sec);
    var t = el("div", "section-title", head);
    t.textContent = title;
    if (onDice) {
      var d = el("button", "section-dice", head);
      d.innerHTML = DICE_SVG;
      d.title = "Randomize " + title.toLowerCase();
      d.addEventListener("click", onDice);
    }
    return sec;
  }

  function fmtDefault(v) { return (+v).toFixed(2); }

  function slider(parent, opts) {
    var wrap = el("div", "ctl", parent);
    var head = el("div", "ctl-head", wrap);
    var lab = el("span", "ctl-label", head);
    lab.textContent = opts.label;
    var val = el("span", "ctl-value", head);
    var input = el("input", null, wrap);
    input.type = "range";
    input.min = opts.min; input.max = opts.max; input.step = opts.step;
    var fmt = opts.fmt || fmtDefault;

    function paint(v) {
      var pct = ((v - opts.min) / (opts.max - opts.min)) * 100;
      input.style.setProperty("--fill", pct + "%");
      val.textContent = fmt(v);
    }
    input.addEventListener("input", function () {
      var v = parseFloat(input.value);
      paint(v);
      opts.set(v);
    });
    function refresh() {
      var v = opts.get();
      input.value = v;
      paint(v);
    }
    refresh();
    return refresh;
  }

  function selectRow(parent, opts) {
    var row = el("div", "field-row", parent);
    var lab = el("span", "ctl-label", row);
    lab.textContent = opts.label;
    var sel = el("select", null, row);
    opts.options.forEach(function (o) {
      var op = el("option", null, sel);
      op.value = o[0]; op.textContent = o[1];
    });
    sel.addEventListener("change", function () { opts.set(sel.value); });
    function refresh() { sel.value = opts.get(); }
    refresh();
    return refresh;
  }

  function toggleRow(parent, opts) {
    var row = el("div", "toggle-row", parent);
    var lab = el("span", "ctl-label", row);
    lab.textContent = opts.label;
    var tg = el("button", "toggle", row);
    tg.setAttribute("role", "switch");
    tg.addEventListener("click", function () { opts.set(!opts.get()); refresh(); });
    function refresh() { tg.classList.toggle("on", !!opts.get()); }
    refresh();
    return refresh;
  }

  function colorSwatches(parent, defs, get, set) {
    var row = el("div", "swatch-row", parent);
    var refreshers = [];
    defs.forEach(function (d, i) {
      if (d.gap) { el("div", "swatch-gap", row); return; }
      var wrap = el("div", "swatch-wrap", row);
      var sw = el("div", "swatch", wrap);
      var input = el("input", null, sw);
      input.type = "color";
      input.addEventListener("input", function () {
        sw.style.background = input.value;
        set(d.key, input.value);
      });
      var lab = el("div", "swatch-label", wrap);
      lab.textContent = d.label;
      refreshers.push(function () {
        var v = get(d.key);
        input.value = v;
        sw.style.background = v;
      });
    });
    function refresh() { refreshers.forEach(function (r) { r(); }); }
    refresh();
    return refresh;
  }

  function presetChips(parent, palettes, onPick) {
    var row = el("div", "preset-row", parent);
    var chips = [];
    palettes.forEach(function (pal, i) {
      var chip = el("button", "preset-chip", row);
      chip.title = pal.name;
      pal.colors.forEach(function (c) {
        var b = el("i", null, chip);
        b.style.background = c;
      });
      chip.addEventListener("click", function () { onPick(i); });
      chips.push(chip);
    });
    return function setActive(idx) {
      chips.forEach(function (c, i) { c.classList.toggle("active", i === idx); });
    };
  }

  function modeGrid(parent, modes, get, set) {
    var grid = el("div", "mode-grid", parent);
    var cards = [];
    modes.forEach(function (m) {
      var card = el("button", "mode-card", grid);
      card.innerHTML = m.icon + "<span>" + m.name + "</span>";
      card.title = m.full;
      card.addEventListener("click", function () { set(m.id); refresh(); });
      cards.push(card);
    });
    function refresh() {
      var cur = get();
      cards.forEach(function (c, i) { c.classList.toggle("active", modes[i].id === cur); });
    }
    refresh();
    return refresh;
  }

  function lockRow(parent, opts) {
    var lab = el("label", "style-lock", parent);
    var input = el("input", null, lab);
    input.type = "checkbox";
    var box = el("span", "lock-box", lab);
    box.innerHTML = '<svg viewBox="0 0 10 10"><path d="M1.5 5.5 L4 8 L8.5 2.5" fill="none" stroke="#0a0a0c" stroke-width="2"/></svg>';
    var txt = el("span", null, lab);
    txt.textContent = opts.label;
    input.addEventListener("change", function () { opts.set(input.checked); });
    function refresh() { input.checked = !!opts.get(); }
    refresh();
    return refresh;
  }

  function seedRow(parent, opts) {
    var row = el("div", "seed-row ctl", parent);
    var input = el("input", "num-input mono", row);
    input.type = "number"; input.min = 0; input.max = 9999;
    input.addEventListener("change", function () {
      opts.set(Math.max(0, Math.min(9999, parseInt(input.value, 10) || 0)));
    });
    var btn = el("button", "mini-btn", row);
    btn.innerHTML = DICE_SVG + "New seed";
    btn.addEventListener("click", opts.onDice);
    function refresh() { input.value = Math.round(opts.get()); }
    refresh();
    return refresh;
  }

  function exportButton(parent, label, ext, svg, onClick) {
    var b = el("button", "export-btn", parent);
    b.innerHTML = svg + "<span>" + label + '</span><span class="ext">' + ext + "</span>";
    b.addEventListener("click", onClick);
    return b;
  }

  function segmented(container, options, get, set) {
    options.forEach(function (o) {
      var b = el("button", null, container);
      b.textContent = o[1];
      b.dataset.v = o[0];
      b.addEventListener("click", function () { set(o[0]); refresh(); });
    });
    function refresh() {
      var cur = String(get());
      Array.prototype.forEach.call(container.children, function (b) {
        b.classList.toggle("active", b.dataset.v === cur);
      });
    }
    refresh();
    return refresh;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  return {
    el: el, section: section, slider: slider, selectRow: selectRow,
    toggleRow: toggleRow, colorSwatches: colorSwatches, presetChips: presetChips,
    modeGrid: modeGrid, lockRow: lockRow, seedRow: seedRow,
    exportButton: exportButton, segmented: segmented, toast: toast
  };
})();
