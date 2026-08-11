/*
 * Map renderer.
 *
 * Province outlines are real vector paths, so borders stay crisp at any zoom.
 * Drawing eight hundred of them every frame is too slow when the whole world
 * is on screen, so there are two modes:
 *
 *   zoomed out  — blit a cached raster of the political map, repainted only
 *                 where provinces actually change hands
 *   zoomed in   — draw vectors directly, with bounding-box culling keeping the
 *                 province count small
 *
 * Both modes use the same colours and line weights, so crossing the threshold
 * is not noticeable.
 */
(function (global) {
  'use strict';

  var SWW = global.SWW = global.SWW || {};
  var TERRAIN = SWW.worldgen.TERRAIN;
  var UnitData = SWW.UnitData;
  var clamp = SWW.util.clamp;

  var BASE_SCALE = 2;            // cached-raster pixels per map unit
  var VECTOR_ZOOM = 5;           // switch to vectors at or above this zoom

  var OCEAN = '#12283d';
  var OCEAN_DEEP = '#0e2033';
  var NEUTRAL = '#6a7480';
  var COAST_LINE = 'rgba(6,13,20,0.85)';
  var NATIONAL_LINE = 'rgba(9,15,21,0.9)';
  var PROVINCE_LINE = 'rgba(26,38,48,0.34)';

  function Renderer(canvas, state) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = state;
    this.camera = { x: state.mapW / 2, y: state.mapH / 2, zoom: 4 };
    this.minZoom = 1;
    this.maxZoom = 40;
    this.paths = new Array(state.provinces.length);
    this.fillCache = new Array(state.provinces.length);
    this.runBounds = new Array(state.runs.length);
    this.baseLayer = null;
    this.viewW = 1; this.viewH = 1; this.dpr = 1;
    this.buildBase();
  }

  // --- geometry ------------------------------------------------------------

  /** Path2D for a province, built once and reused for fills and hit tests. */
  Renderer.prototype.pathFor = function (prov) {
    var cached = this.paths[prov.id];
    if (cached) return cached;
    var path = new global.Path2D();
    var map = SWW.mapdata.load();
    for (var l = 0; l < prov.loops.length; l++) {
      var pts = SWW.mapdata.loopPoints(map, prov.loops[l]);
      if (pts.length < 6) continue;
      path.moveTo(pts[0], pts[1]);
      for (var i = 2; i < pts.length; i += 2) path.lineTo(pts[i], pts[i + 1]);
      path.closePath();
    }
    this.paths[prov.id] = path;
    return path;
  };

  Renderer.prototype.boundsFor = function (runIndex) {
    var b = this.runBounds[runIndex];
    if (b) return b;
    var pts = this.state.runs[runIndex].pts;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < pts.length; i += 2) {
      if (pts[i] < x0) x0 = pts[i];
      if (pts[i] > x1) x1 = pts[i];
      if (pts[i + 1] < y0) y0 = pts[i + 1];
      if (pts[i + 1] > y1) y1 = pts[i + 1];
    }
    b = [x0, y0, x1, y1];
    this.runBounds[runIndex] = b;
    return b;
  };

  /** Terrain colour blended toward the owner's national colour. */
  Renderer.prototype.fillFor = function (prov) {
    var key = prov.nationId || '-';
    var cached = this.fillCache[prov.id];
    if (cached && cached.key === key) return cached.color;
    var terrain = TERRAIN[prov.terrain] || TERRAIN.plains;
    var owner = prov.nationId ? this.state.nationById[prov.nationId] : null;
    var color = owner ? mix(terrain.color, owner.color, 0.66) : mix(terrain.color, NEUTRAL, 0.2);
    this.fillCache[prov.id] = { key: key, color: color };
    return color;
  };

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mix(a, b, t) {
    var ca = hexToRgb(a), cb = hexToRgb(b);
    return 'rgb(' + Math.round(ca[0] + (cb[0] - ca[0]) * t) + ',' +
      Math.round(ca[1] + (cb[1] - ca[1]) * t) + ',' +
      Math.round(ca[2] + (cb[2] - ca[2]) * t) + ')';
  }

  // --- cached political raster --------------------------------------------

  Renderer.prototype.buildBase = function () {
    var state = this.state;
    var layer = global.document.createElement('canvas');
    layer.width = Math.round(state.mapW * BASE_SCALE);
    layer.height = Math.round(state.mapH * BASE_SCALE);
    var ctx = layer.getContext('2d');
    ctx.scale(BASE_SCALE, BASE_SCALE);
    ctx.fillStyle = OCEAN_DEEP;
    ctx.fillRect(0, 0, state.mapW, state.mapH);
    this.baseLayer = layer;
    this.baseCtx = ctx;
    this.paintBase(ctx, null);
  };

  /**
   * Paint the political map into the cached raster.  With `only` set, just that
   * province and its immediate surroundings are redrawn, which is what happens
   * when a province changes hands.
   */
  Renderer.prototype.paintBase = function (ctx, only) {
    var state = this.state;
    var i;
    if (only) {
      var b = only.bbox;
      ctx.save();
      ctx.beginPath();
      ctx.rect(b[0] - 2, b[1] - 2, b[2] - b[0] + 4, b[3] - b[1] + 4);
      ctx.clip();
      ctx.fillStyle = OCEAN_DEEP;
      ctx.fillRect(b[0] - 2, b[1] - 2, b[2] - b[0] + 4, b[3] - b[1] + 4);
    }

    var list = only
      ? [only].concat(only.neighbors.map(function (id) { return state.provinces[id]; }))
      : state.provinces;
    for (i = 0; i < list.length; i++) {
      var prov = list[i];
      if (prov.isSea) continue;
      ctx.fillStyle = this.fillFor(prov);
      ctx.fill(this.pathFor(prov));
    }

    this.strokeBorders(ctx, 1, only ? only.bbox : null);
    if (only) ctx.restore();
  };

  /**
   * Draw every border once, choosing its weight from the two provinces that
   * share it.  `scale` is the current pixels-per-map-unit, so line widths stay
   * visually constant however far the map is zoomed.
   */
  Renderer.prototype.strokeBorders = function (ctx, scale, clipBox) {
    var state = this.state;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // Province lines first, then national, then coast, so the heavier lines sit
    // on top where they meet.
    for (var pass = 0; pass < 3; pass++) {
      ctx.beginPath();
      var any = false;
      for (var r = 0; r < state.runs.length; r++) {
        var run = state.runs[r];
        var a = state.provinces[run.a];
        var b = run.b >= 0 ? state.provinces[run.b] : null;
        if (a.isSea && (!b || b.isSea)) continue;
        var coast = !b || (b.isSea !== a.isSea);
        var national = !coast && a.nationId !== b.nationId;
        var kind = coast ? 2 : national ? 1 : 0;
        if (kind !== pass) continue;
        if (clipBox) {
          var bb = this.boundsFor(r);
          if (bb[2] < clipBox[0] - 3 || bb[0] > clipBox[2] + 3 ||
            bb[3] < clipBox[1] - 3 || bb[1] > clipBox[3] + 3) continue;
        }
        var pts = run.pts;
        ctx.moveTo(pts[0], pts[1]);
        for (var i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
        any = true;
      }
      if (!any) continue;
      ctx.strokeStyle = pass === 2 ? COAST_LINE : pass === 1 ? NATIONAL_LINE : PROVINCE_LINE;
      ctx.lineWidth = (pass === 2 ? 1.1 : pass === 1 ? 1.4 : 0.5) / scale;
      ctx.stroke();
    }
  };

  /** Called after a province changes hands. */
  Renderer.prototype.repaint = function (provinceId) {
    var prov = this.state.provinces[provinceId];
    if (!prov || !this.baseCtx) return;
    this.fillCache[provinceId] = null;
    this.paintBase(this.baseCtx, prov);
  };

  // --- camera --------------------------------------------------------------

  Renderer.prototype.resize = function () {
    var dpr = global.devicePixelRatio || 1;
    var rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.viewW = rect.width;
    this.viewH = rect.height;
    this.dpr = dpr;
    // Zoom out far enough that the whole world always fits on screen.
    this.minZoom = Math.max(0.15,
      Math.min(rect.width / this.state.mapW, rect.height / this.state.mapH) * 0.98);
    this.camera.zoom = clamp(this.camera.zoom, this.minZoom, this.maxZoom);
    this.clampCamera();
  };

  Renderer.prototype.clampCamera = function () {
    var w = this.state.mapW, h = this.state.mapH;
    var halfW = this.viewW / (2 * this.camera.zoom);
    var halfH = this.viewH / (2 * this.camera.zoom);
    this.camera.x = clamp(this.camera.x, Math.min(halfW, w / 2), Math.max(w - halfW, w / 2));
    this.camera.y = clamp(this.camera.y, Math.min(halfH, h / 2), Math.max(h - halfH, h / 2));
  };

  Renderer.prototype.toScreen = function (mx, my) {
    return {
      x: (mx - this.camera.x) * this.camera.zoom + this.viewW / 2,
      y: (my - this.camera.y) * this.camera.zoom + this.viewH / 2
    };
  };

  Renderer.prototype.toMap = function (sx, sy) {
    return {
      x: (sx - this.viewW / 2) / this.camera.zoom + this.camera.x,
      y: (sy - this.viewH / 2) / this.camera.zoom + this.camera.y
    };
  };

  Renderer.prototype.panBy = function (dx, dy) {
    this.camera.x -= dx / this.camera.zoom;
    this.camera.y -= dy / this.camera.zoom;
    this.clampCamera();
  };

  Renderer.prototype.zoomAt = function (factor, sx, sy) {
    var before = this.toMap(sx, sy);
    this.camera.zoom = clamp(this.camera.zoom * factor, this.minZoom, this.maxZoom);
    var after = this.toMap(sx, sy);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
    this.clampCamera();
  };

  Renderer.prototype.centerOn = function (provinceId, zoom) {
    var p = this.state.provinces[provinceId];
    if (!p) return;
    this.camera.x = p.cx;
    this.camera.y = p.cy;
    if (zoom) this.camera.zoom = clamp(zoom, this.minZoom, this.maxZoom);
    this.clampCamera();
  };

  /** The map rectangle currently on screen, with a margin. */
  Renderer.prototype.viewBox = function (margin) {
    var m = margin || 0;
    var halfW = this.viewW / (2 * this.camera.zoom) + m;
    var halfH = this.viewH / (2 * this.camera.zoom) + m;
    return [this.camera.x - halfW, this.camera.y - halfH,
      this.camera.x + halfW, this.camera.y + halfH];
  };

  function overlaps(box, bb) {
    return !(bb[2] < box[0] || bb[0] > box[2] || bb[3] < box[1] || bb[1] > box[3]);
  }

  /** Province under a screen point: bounding boxes first, then an exact test. */
  Renderer.prototype.provinceAt = function (sx, sy) {
    var m = this.toMap(sx, sy);
    var state = this.state;
    var ctx = this.ctx;
    var fallback = null, fallbackD = Infinity;
    for (var i = 0; i < state.provinces.length; i++) {
      var p = state.provinces[i];
      var b = p.bbox;
      if (m.x < b[0] - 0.5 || m.x > b[2] + 0.5 || m.y < b[1] - 0.5 || m.y > b[3] + 0.5) continue;
      if (ctx.isPointInPath(this.pathFor(p), m.x, m.y)) return p;
      var dx = p.cx - m.x, dy = p.cy - m.y;
      var d = dx * dx + dy * dy;
      if (d < fallbackD) { fallbackD = d; fallback = p; }
    }
    // Exactly on a border the hit test can fall through the crack; accept the
    // nearest province whose box contains the point.
    return fallbackD < 9 ? fallback : null;
  };

  Renderer.prototype.armyPoint = function (army) {
    var from = this.state.provinces[army.provinceId];
    if (!army.path.length || !army.legTotal) return { x: from.cx, y: from.cy };
    var to = this.state.provinces[army.path[0]];
    var t = clamp(1 - army.legRemaining / army.legTotal, 0, 1);
    return { x: from.cx + (to.cx - from.cx) * t, y: from.cy + (to.cy - from.cy) * t };
  };

  // --- frame ---------------------------------------------------------------

  Renderer.prototype.draw = function (ui) {
    var state = this.state;
    if (state.dirtyProvinces && state.dirtyProvinces.length) {
      for (var d = 0; d < state.dirtyProvinces.length; d++) this.repaint(state.dirtyProvinces[d]);
      state.dirtyProvinces.length = 0;
    }
    var ctx = this.ctx;
    var z = this.camera.zoom;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.fillStyle = OCEAN;
    ctx.fillRect(0, 0, this.viewW, this.viewH);

    ctx.save();
    ctx.translate(-this.camera.x * z + this.viewW / 2, -this.camera.y * z + this.viewH / 2);
    ctx.scale(z, z);
    if (z < VECTOR_ZOOM) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.baseLayer, 0, 0, state.mapW, state.mapH);
    } else {
      this.drawVector(ctx, ui, z);
    }
    ctx.restore();

    this.drawProvinceMarkers(ctx, ui);
    this.drawPaths(ctx, ui);
    this.drawArmies(ctx, ui);
    this.drawLabels(ctx, ui);
    ctx.restore();
  };

  Renderer.prototype.drawVector = function (ctx, ui, z) {
    var state = this.state;
    var box = this.viewBox(2);
    var visible = [];
    var i;
    for (i = 0; i < state.provinces.length; i++) {
      var p = state.provinces[i];
      if (p.isSea || !overlaps(box, p.bbox)) continue;
      visible.push(p);
      ctx.fillStyle = this.fillFor(p);
      ctx.fill(this.pathFor(p));
    }
    this.strokeBorders(ctx, z, box);

    // Dim what the player cannot see into.  Only in vector mode: at world zoom
    // the political map is common knowledge — it is the armies that are hidden.
    if (ui && ui.visible) {
      ctx.save();
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = '#050a10';
      for (i = 0; i < visible.length; i++) {
        if (ui.visible[visible[i].id]) continue;
        ctx.fill(this.pathFor(visible[i]));
      }
      ctx.restore();
    }
  };

  Renderer.prototype.drawProvinceMarkers = function (ctx, ui) {
    var state = this.state;
    var z = this.camera.zoom;
    var box = this.viewBox(4);
    for (var i = 0; i < state.landCount; i++) {
      var p = state.provinces[i];
      if (p.cx < box[0] || p.cx > box[2] || p.cy < box[1] || p.cy > box[3]) continue;
      var major = p.isCapital || p.cityLevel >= 4;
      if (!major && z < 6) continue;
      var s = this.toScreen(p.cx, p.cy);
      var r = clamp(1.2 + p.cityLevel * 0.5, 1.8, 5.5) * clamp(z / 6, 0.55, 1.5);

      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = p.isCapital ? '#f4e4b0' : major ? 'rgba(235,244,255,0.82)' : 'rgba(214,230,244,0.5)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(8,14,20,0.8)';
      ctx.stroke();

      if (p.capture && z > 2.5) {
        var frac = clamp(p.capture.progress / p.capture.needed, 0, 1);
        var nation = state.nationById[p.capture.by];
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 5, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.strokeStyle = nation ? nation.color : '#fff';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
      if (ui && ui.selectedProvinceId === p.id) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 8, 0, Math.PI * 2);
        ctx.strokeStyle = '#7fe3ff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (state.battleProvinces && state.time - state.battleProvinces[p.id] < 1.01 && z > 2) {
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.font = Math.round(clamp(z * 1.6, 11, 22)) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚔', s.x, s.y - r - 10);
        ctx.restore();
      }
    }
  };

  Renderer.prototype.drawPaths = function (ctx, ui) {
    var state = this.state;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    for (var i = 0; i < state.armies.length; i++) {
      var army = state.armies[i];
      if (!army.path.length) continue;
      var isPlayer = army.ownerId === state.playerId;
      if (!isPlayer && (!ui || !ui.visible || !ui.visible[army.provinceId])) continue;
      if (!isPlayer && ui && ui.selectedArmyId !== army.id) continue;
      var nation = state.nationById[army.ownerId];
      ctx.strokeStyle = ui && ui.selectedArmyId === army.id ? '#7fe3ff' : (nation ? nation.color : '#fff');
      ctx.globalAlpha = ui && ui.selectedArmyId === army.id ? 0.95 : 0.5;
      var pt = this.armyPoint(army);
      var s = this.toScreen(pt.x, pt.y);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      for (var j = 0; j < army.path.length; j++) {
        var np = state.provinces[army.path[j]];
        var ns = this.toScreen(np.cx, np.cy);
        ctx.lineTo(ns.x, ns.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  };

  Renderer.prototype.drawArmies = function (ctx, ui) {
    var state = this.state;
    var z = this.camera.zoom;
    var box = this.viewBox(6);
    var stacksAt = {};
    var i;
    for (i = 0; i < state.armies.length; i++) {
      var a = state.armies[i];
      var isPlayer = a.ownerId === state.playerId;
      if (!isPlayer && ui && ui.visible && !ui.visible[a.provinceId]) continue;
      var home = state.provinces[a.provinceId];
      if (home.cx < box[0] || home.cx > box[2] || home.cy < box[1] || home.cy > box[3]) continue;
      var key = a.path.length ? a.id : a.provinceId;
      (stacksAt[key] || (stacksAt[key] = [])).push(a);
    }

    // Full markers would swamp the world view, so far out they become dots.
    var dots = z < 2.2;
    var h = clamp(z * 1.6, 13, 28);
    var w = h * 1.6;
    for (var key in stacksAt) {
      var list = stacksAt[key];
      for (var k = 0; k < list.length; k++) {
        var army = list[k];
        var pt = this.armyPoint(army);
        var s = this.toScreen(pt.x, pt.y);
        if (s.x < -40 || s.y < -40 || s.x > this.viewW + 40 || s.y > this.viewH + 40) continue;
        if (dots) {
          drawDot.call(this, ctx, army, s.x, s.y, ui);
          continue;
        }
        var offset = (k - (list.length - 1) / 2) * (w * 0.55);
        drawStack.call(this, ctx, army, s.x + offset, s.y - h * 0.9, w, h, ui);
      }
    }

    function drawDot(c, army, x, y, uiRef) {
      var nation = state.nationById[army.ownerId];
      var selected = uiRef && uiRef.selectedArmyId === army.id;
      var r = selected ? 4 : 2.6;
      c.beginPath();
      c.arc(x, y - 3, r, 0, Math.PI * 2);
      c.fillStyle = nation ? nation.color : '#888';
      c.fill();
      c.lineWidth = 1;
      c.strokeStyle = selected ? '#7fe3ff' : (army.inCombat ? '#ff7a5f' : 'rgba(0,0,0,0.75)');
      c.stroke();
    }

    function drawStack(c, army, x, y, bw, bh, uiRef) {
      var nation = state.nationById[army.ownerId];
      var strength = SWW.state.armyStrength(army);
      var selected = uiRef && uiRef.selectedArmyId === army.id;

      c.save();
      c.translate(x, y);
      c.fillStyle = 'rgba(8,14,20,0.55)';
      c.fillRect(-bw / 2 + 1.5, -bh / 2 + 1.5, bw, bh);
      c.fillStyle = nation ? nation.color : '#888';
      c.fillRect(-bw / 2, -bh / 2, bw, bh);
      c.fillStyle = 'rgba(0,0,0,0.30)';
      c.fillRect(-bw / 2, bh / 2 - bh * 0.22, bw, bh * 0.22);
      c.fillStyle = '#6fe08a';
      c.fillRect(-bw / 2, bh / 2 - bh * 0.22, bw * clamp(strength.ratio, 0, 1), bh * 0.22);

      c.strokeStyle = selected ? '#7fe3ff' : (army.inCombat ? '#ff7a5f' : 'rgba(0,0,0,0.7)');
      c.lineWidth = selected || army.inCombat ? 2 : 1;
      c.strokeRect(-bw / 2, -bh / 2, bw, bh);

      var lead = army.units[0] ? UnitData.BY_ID[army.units[0].typeId] : null;
      c.fillStyle = '#f2f7ff';
      c.font = 'bold ' + Math.round(bh * 0.5) + 'px sans-serif';
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      if (lead) c.fillText(lead.icon, -bw / 2 + bw * 0.10, -bh * 0.10);
      c.textAlign = 'right';
      c.font = 'bold ' + Math.round(bh * 0.42) + 'px sans-serif';
      c.fillText(String(SWW.state.unitCount(army)), bw / 2 - bw * 0.08, -bh * 0.10);
      c.restore();
    }
  };

  Renderer.prototype.drawLabels = function (ctx, ui) {
    var z = this.camera.zoom;
    if (z < 5) return;
    var state = this.state;
    var box = this.viewBox(2);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = Math.round(clamp(z * 0.8, 10, 15)) + 'px "Segoe UI", system-ui, sans-serif';
    for (var i = 0; i < state.landCount; i++) {
      var p = state.provinces[i];
      if (p.cx < box[0] || p.cx > box[2] || p.cy < box[1] || p.cy > box[3]) continue;
      if (z < 9 && p.cityLevel < 4 && !p.isCapital) continue;
      var s = this.toScreen(p.cx, p.cy);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(6,12,18,0.85)';
      ctx.strokeText(p.name, s.x, s.y + 6);
      ctx.fillStyle = p.isCapital ? '#ffe9a8' : '#e8f2ff';
      ctx.fillText(p.name, s.x, s.y + 6);
    }
    ctx.restore();
  };

  SWW.Renderer = Renderer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
