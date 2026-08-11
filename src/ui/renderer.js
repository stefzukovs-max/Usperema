/*
 * Map renderer.
 *
 * The terrain and the political overlay are pre-rendered once into offscreen
 * canvases at a fixed cell scale; the per-frame work is just blitting those
 * two layers under the camera transform and drawing the live overlays
 * (armies, movement paths, battles, labels).
 */
(function (global) {
  'use strict';

  var SWW = global.SWW = global.SWW || {};
  var TERRAIN = SWW.worldgen.TERRAIN;
  var UnitData = SWW.UnitData;
  var clamp = SWW.util.clamp;

  var CELL = 4;              // offscreen pixels per grid cell

  var OCEAN = ['#12283d', '#16304a'];
  var SHORE = '#1e4666';
  var NEUTRAL = '#6a7480';

  function Renderer(canvas, state) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = state;
    this.camera = { x: state.grid.w / 2, y: state.grid.h / 2, zoom: 4 };
    this.minZoom = 2;
    this.maxZoom = 26;
    this.terrainLayer = null;
    this.politicalLayer = null;
    this.fogLayer = null;
    this.buildTerrain();
    this.buildPolitical();
  }

  Renderer.prototype.makeLayer = function () {
    var c = global.document.createElement('canvas');
    c.width = this.state.grid.w * CELL;
    c.height = this.state.grid.h * CELL;
    return c;
  };

  /** Static layer: terrain colours, coastline, ocean texture. */
  Renderer.prototype.buildTerrain = function () {
    var state = this.state, g = state.grid;
    var layer = this.makeLayer();
    var ctx = layer.getContext('2d');
    var land = state.land, owner = state.cellOwner;

    for (var y = 0; y < g.h; y++) {
      for (var x = 0; x < g.w; x++) {
        var idx = y * g.w + x;
        var col;
        if (!land[idx]) {
          col = OCEAN[(x + y) & 1];
        } else {
          var prov = state.provinces[owner[idx]];
          var t = prov && TERRAIN[prov.terrain] ? TERRAIN[prov.terrain] : TERRAIN.plains;
          col = t.color;
          // Gentle per-cell variation so large provinces are not flat slabs.
          if ((x * 7 + y * 13) % 5 === 0) col = shade(col, -6);
          else if ((x * 3 + y * 5) % 7 === 0) col = shade(col, 6);
        }
        ctx.fillStyle = col;
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
    // Coastline: lighten water cells that touch land.
    ctx.fillStyle = SHORE;
    for (var yy = 0; yy < g.h; yy++) {
      for (var xx = 0; xx < g.w; xx++) {
        var i2 = yy * g.w + xx;
        if (land[i2]) continue;
        var touches = (xx > 0 && land[i2 - 1]) || (xx < g.w - 1 && land[i2 + 1]) ||
          (yy > 0 && land[i2 - g.w]) || (yy < g.h - 1 && land[i2 + g.w]);
        if (touches) ctx.fillRect(xx * CELL, yy * CELL, CELL, CELL);
      }
    }
    this.terrainLayer = layer;
  };

  /** Ownership wash plus province and national borders. */
  Renderer.prototype.buildPolitical = function () {
    var state = this.state, g = state.grid;
    var layer = this.politicalLayer || this.makeLayer();
    var ctx = layer.getContext('2d');
    ctx.clearRect(0, 0, layer.width, layer.height);
    var land = state.land, owner = state.cellOwner;

    ctx.globalAlpha = 0.55;
    for (var y = 0; y < g.h; y++) {
      for (var x = 0; x < g.w; x++) {
        var idx = y * g.w + x;
        if (!land[idx]) continue;
        var prov = state.provinces[owner[idx]];
        if (!prov) continue;
        var nation = prov.nationId ? state.nationById[prov.nationId] : null;
        ctx.fillStyle = nation ? nation.color : NEUTRAL;
        ctx.globalAlpha = nation ? 0.55 : 0.16;
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
    ctx.globalAlpha = 1;

    // Borders: thin between provinces, bright between nations.
    for (var yy = 0; yy < g.h; yy++) {
      for (var xx = 0; xx < g.w; xx++) {
        var i2 = yy * g.w + xx;
        if (!land[i2]) continue;
        var a = state.provinces[owner[i2]];
        if (!a) continue;
        drawEdge.call(this, xx, yy, i2, i2 + 1, xx < g.w - 1, true);
        drawEdge.call(this, xx, yy, i2, i2 + g.w, yy < g.h - 1, false);
      }
    }

    function drawEdge(x, y, i, j, inBounds, horizontal) {
      if (!inBounds || !land[j]) return;
      var pa = state.provinces[owner[i]], pb = state.provinces[owner[j]];
      if (!pa || !pb || pa === pb) return;
      var national = pa.nationId !== pb.nationId;
      ctx.fillStyle = national ? 'rgba(12,18,24,0.85)' : 'rgba(20,30,38,0.35)';
      var w = national ? 2 : 1;
      if (horizontal) ctx.fillRect((x + 1) * CELL - (w >> 1), y * CELL, w, CELL);
      else ctx.fillRect(x * CELL, (y + 1) * CELL - (w >> 1), CELL, w);
    }

    this.politicalLayer = layer;
    state.mapDirty = false;
  };

  function shade(hex, amount) {
    var n = parseInt(hex.slice(1), 16);
    var r = clamp(((n >> 16) & 255) + amount, 0, 255);
    var g = clamp(((n >> 8) & 255) + amount, 0, 255);
    var b = clamp((n & 255) + amount, 0, 255);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  // --- camera --------------------------------------------------------------

  Renderer.prototype.resize = function () {
    var dpr = global.devicePixelRatio || 1;
    var rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.viewW = rect.width;
    this.viewH = rect.height;
    this.dpr = dpr;
    this.minZoom = Math.max(1.2, this.viewW / this.state.grid.w * 0.9);
    this.camera.zoom = clamp(this.camera.zoom, this.minZoom, this.maxZoom);
    this.clampCamera();
  };

  Renderer.prototype.clampCamera = function () {
    var g = this.state.grid;
    var halfW = this.viewW / (2 * this.camera.zoom);
    var halfH = this.viewH / (2 * this.camera.zoom);
    this.camera.x = clamp(this.camera.x, Math.min(halfW, g.w / 2), Math.max(g.w - halfW, g.w / 2));
    this.camera.y = clamp(this.camera.y, Math.min(halfH, g.h / 2), Math.max(g.h - halfH, g.h / 2));
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

  Renderer.prototype.provinceAt = function (sx, sy) {
    var m = this.toMap(sx, sy);
    var g = this.state.grid;
    var x = Math.floor(m.x), y = Math.floor(m.y);
    if (x < 0 || y < 0 || x >= g.w || y >= g.h) return null;
    var id = this.state.cellOwner[y * g.w + x];
    return id >= 0 ? this.state.provinces[id] : null;
  };

  /** Screen position of an army, interpolated along its current leg. */
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
    if (state.mapDirty) this.buildPolitical();
    var ctx = this.ctx;
    var z = this.camera.zoom;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.fillStyle = OCEAN[0];
    ctx.fillRect(0, 0, this.viewW, this.viewH);

    var originX = -this.camera.x * z + this.viewW / 2;
    var originY = -this.camera.y * z + this.viewH / 2;
    var scale = z / CELL;

    ctx.imageSmoothingEnabled = z < 8;
    ctx.save();
    ctx.translate(originX, originY);
    ctx.scale(scale, scale);
    ctx.drawImage(this.terrainLayer, 0, 0);
    ctx.drawImage(this.politicalLayer, 0, 0);
    ctx.restore();

    this.drawFog(ctx, ui);
    this.drawProvinceMarkers(ctx, ui);
    this.drawPaths(ctx, ui);
    this.drawArmies(ctx, ui);
    this.drawLabels(ctx, ui);
    ctx.restore();
  };

  /**
   * Dim provinces the player cannot see into.  Fog follows province borders
   * exactly, so it is painted cell-by-cell into its own layer and rebuilt only
   * when the visible set actually changes.
   */
  Renderer.prototype.buildFog = function (visible) {
    var state = this.state, g = state.grid;
    var layer = this.fogLayer || (this.fogLayer = this.makeLayer());
    var ctx = layer.getContext('2d');
    ctx.clearRect(0, 0, layer.width, layer.height);
    ctx.fillStyle = 'rgba(5,10,16,0.42)';
    for (var i = 0; i < state.landCount; i++) {
      var p = state.provinces[i];
      if (p.size === 0 || visible[p.id]) continue;
      for (var c = 0; c < p.cells.length; c++) {
        var idx = p.cells[c];
        ctx.fillRect((idx % g.w) * CELL, ((idx / g.w) | 0) * CELL, CELL, CELL);
      }
    }
  };

  Renderer.prototype.drawFog = function (ctx, ui) {
    if (!ui || !ui.visible) return;
    if (this.fogStamp !== ui.visibleStamp || !this.fogLayer) {
      this.fogStamp = ui.visibleStamp;
      this.buildFog(ui.visible);
    }
    var z = this.camera.zoom;
    ctx.save();
    ctx.translate(-this.camera.x * z + this.viewW / 2, -this.camera.y * z + this.viewH / 2);
    ctx.scale(z / CELL, z / CELL);
    ctx.drawImage(this.fogLayer, 0, 0);
    ctx.restore();
  };

  /** City dots, capital stars, capture progress, selection ring. */
  Renderer.prototype.drawProvinceMarkers = function (ctx, ui) {
    var state = this.state;
    var z = this.camera.zoom;
    for (var i = 0; i < state.landCount; i++) {
      var p = state.provinces[i];
      if (p.size === 0) continue;
      var s = this.toScreen(p.cx, p.cy);
      if (s.x < -30 || s.y < -30 || s.x > this.viewW + 30 || s.y > this.viewH + 30) continue;

      var major = p.isCapital || p.cityLevel >= 4;
      var r = clamp(1.4 + p.cityLevel * 0.55, 2, 6) * clamp(z / 5, 0.5, 1.6);
      if (major || z > 6.5) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fillStyle = p.isCapital ? '#f4e4b0' : major ? 'rgba(235,244,255,0.8)' : 'rgba(214,230,244,0.5)';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(8,14,20,0.8)';
        ctx.stroke();
      }

      if (p.capture && z > 3) {
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
      if (state.battleProvinces && state.time - state.battleProvinces[p.id] < 1.01 && z > 2.5) {
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.font = Math.round(clamp(z * 1.8, 10, 22)) + 'px sans-serif';
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
    var stacksAt = {};
    var i;
    for (i = 0; i < state.armies.length; i++) {
      var a = state.armies[i];
      var isPlayer = a.ownerId === state.playerId;
      if (!isPlayer && ui && ui.visible && !ui.visible[a.provinceId]) continue;
      var key = a.path.length ? a.id : a.provinceId;
      (stacksAt[key] || (stacksAt[key] = [])).push(a);
    }

    var h = clamp(z * 2.2, 14, 30);
    var w = h * 1.6;
    for (var key in stacksAt) {
      var list = stacksAt[key];
      for (var k = 0; k < list.length; k++) {
        var army = list[k];
        var pt = this.armyPoint(army);
        var s = this.toScreen(pt.x, pt.y);
        if (s.x < -40 || s.y < -40 || s.x > this.viewW + 40 || s.y > this.viewH + 40) continue;
        var offset = (k - (list.length - 1) / 2) * (w * 0.55);
        var x = s.x + offset, y = s.y - h * 0.9;
        drawStack.call(this, ctx, army, x, y, w, h, ui);
      }
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
    if (z < 6) return;
    var state = this.state;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = Math.round(clamp(z * 1.05, 9, 15)) + 'px "Segoe UI", system-ui, sans-serif';
    for (var i = 0; i < state.landCount; i++) {
      var p = state.provinces[i];
      if (p.size === 0) continue;
      if (z < 9 && p.cityLevel < 4 && !p.isCapital) continue;
      var s = this.toScreen(p.cx, p.cy);
      if (s.x < 0 || s.y < 0 || s.x > this.viewW || s.y > this.viewH) continue;
      var text = p.name + (p.cityLevel > 1 ? ' (' + p.cityLevel + ')' : '');
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(6,12,18,0.85)';
      ctx.strokeText(text, s.x, s.y + 6);
      ctx.fillStyle = p.isCapital ? '#ffe9a8' : '#e8f2ff';
      ctx.fillText(text, s.x, s.y + 6);
    }
    ctx.restore();
  };

  SWW.Renderer = Renderer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
