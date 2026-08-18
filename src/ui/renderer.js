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

  var IA = global.IA = global.IA || {};
  var TERRAIN = IA.worldgen.TERRAIN;
  var UnitData = IA.UnitData;
  var clamp = IA.util.clamp;

  var BASE_SCALE = 2;            // cached-raster pixels per map unit
  var VECTOR_ZOOM = 5;           // switch to vectors at or above this zoom

  /*
   * Phones report pixel ratios of 3 and up.  Rendering the map at native
   * density triples the fill rate for a difference nobody can see on a moving
   * map, and it is the difference between 60 and 30 frames a second.
   */
  var MAX_DPR = 2;

  /*
   * Terrain patterns are the most expensive thing the renderer draws, and
   * while the map is being dragged nobody is studying the ground texture.  It
   * is dropped during motion and faded back in once the map settles.
   */
  var DETAIL_DELAY = 90;         // ms of stillness before detail starts
  var DETAIL_FADE = 220;         // ms to fade it back in

  var OCEAN = '#2b3a44';            // map-paper sea, not open ocean blue
  var OCEAN_DEEP = '#243139';
  var NEUTRAL = '#8d8570';
  var COAST_LINE = 'rgba(28,26,18,0.85)';
  var NATIONAL_LINE = 'rgba(28,25,16,0.80)';
  var PROVINCE_LINE = 'rgba(40,36,24,0.34)';
  var SHELF = 'rgba(196,214,220,0.09)';       // shallow water hugging the coast

  /*
   * Terrain texture.
   *
   * Each terrain type gets a small tiling pattern — ridges for mountains,
   * canopy for forest, dunes for desert, a street grid for cities.  They are
   * drawn over the province colour, which turns a flat political fill into
   * something that reads as ground.  The pattern transform keeps the texture at
   * a roughly constant size on screen however far the map is zoomed.
   */
  var TILE = 32;

  function makeTile(kind) {
    var c = global.document.createElement('canvas');
    c.width = TILE; c.height = TILE;
    var x = c.getContext('2d');
    var i;
    var dark = 'rgba(12,20,14,0.16)';
    var light = 'rgba(240,255,235,0.10)';

    function ridge(px, py, w, h) {
      x.beginPath();
      x.moveTo(px - w, py + h);
      x.lineTo(px, py - h);
      x.lineTo(px + w, py + h);
      x.stroke();
    }

    switch (kind) {
      case 'mountain':
        x.lineWidth = 1.6; x.lineCap = 'round';
        x.strokeStyle = dark;
        ridge(8, 10, 5, 5); ridge(23, 21, 6, 6); ridge(15, 29, 4, 4);
        x.strokeStyle = light;
        ridge(8, 9, 5, 5); ridge(23, 20, 6, 6); ridge(15, 28, 4, 4);
        break;
      case 'forest':
      case 'taiga':
      case 'jungle':
        for (i = 0; i < 7; i++) {
          var fx = (i * 11 + (i % 3) * 4) % TILE;
          var fy = (i * 17 + (i % 2) * 6) % TILE;
          x.fillStyle = dark;
          x.beginPath(); x.arc(fx, fy + 1.2, 2.5, 0, Math.PI * 2); x.fill();
          x.fillStyle = light;
          x.beginPath(); x.arc(fx, fy, 2.1, 0, Math.PI * 2); x.fill();
        }
        break;
      case 'desert':
        x.lineWidth = 1.4; x.lineCap = 'round';
        for (i = 0; i < 4; i++) {
          var dy = i * 8 + 4;
          x.strokeStyle = light;
          x.beginPath();
          x.moveTo(-2, dy); x.quadraticCurveTo(TILE / 2, dy - 5, TILE + 2, dy);
          x.stroke();
          x.strokeStyle = dark;
          x.beginPath();
          x.moveTo(-2, dy + 1.6); x.quadraticCurveTo(TILE / 2, dy - 3.4, TILE + 2, dy + 1.6);
          x.stroke();
        }
        break;
      case 'urban':
        x.fillStyle = 'rgba(250,252,255,0.12)';
        for (i = 0; i < 10; i++) {
          var bx = (i * 13) % TILE, by = (i * 7 + (i % 4) * 5) % TILE;
          x.fillRect(bx, by, 3 + (i % 3), 3 + ((i + 1) % 3));
        }
        x.strokeStyle = 'rgba(10,16,22,0.18)';
        x.lineWidth = 1;
        x.beginPath();
        x.moveTo(0, 16); x.lineTo(TILE, 16); x.moveTo(16, 0); x.lineTo(16, TILE);
        x.stroke();
        break;
      case 'tundra':
        for (i = 0; i < 12; i++) {
          x.fillStyle = i % 2 ? light : dark;
          x.fillRect((i * 9) % TILE, (i * 13) % TILE, 2, 1.4);
        }
        break;
      case 'farmland':
        x.strokeStyle = 'rgba(18,26,16,0.10)';
        x.lineWidth = 1;
        for (i = 0; i < 4; i++) {
          x.beginPath(); x.moveTo(0, i * 8 + 4); x.lineTo(TILE, i * 8 + 4); x.stroke();
          x.beginPath(); x.moveTo(i * 8 + 4, 0); x.lineTo(i * 8 + 4, TILE); x.stroke();
        }
        break;
      default:                                  // plains, steppe
        for (i = 0; i < 9; i++) {
          x.fillStyle = i % 2 ? light : dark;
          x.fillRect((i * 11) % TILE, (i * 19) % TILE, 3, 1.2);
        }
        break;
    }
    return c;
  }

  var TILES = {};
  function tileFor(kind) {
    if (!TILES[kind]) TILES[kind] = makeTile(kind);
    return TILES[kind];
  }

  function Renderer(canvas, state) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = state;
    this.camera = { x: state.mapW / 2, y: state.mapH / 2, zoom: 4 };
    this.minZoom = 1;
    this.maxZoom = 40;
    this.mode = 'political';
    this.paths = new Array(state.provinces.length);
    this.fillCache = new Array(state.provinces.length);
    this.runBounds = new Array(state.runs.length);
    this.baseLayer = null;
    this.viewW = 1; this.viewH = 1; this.dpr = 1;
    /*
     * Shaded relief is geography, so it is built once and never rebuilt.  It is
     * laid over the political fills in both the cached raster and the vector
     * layer, which is why it costs nothing per frame.
     */
    try {
      this.relief = IA.relief.build(state);
    } catch (e) {
      this.relief = null;                 // shading is never worth a broken map
    }
    this.buildBase();
  }

  // --- geometry ------------------------------------------------------------

  /** Path2D for a province, built once and reused for fills and hit tests. */
  Renderer.prototype.pathFor = function (prov) {
    var cached = this.paths[prov.id];
    if (cached) return cached;
    var path = new global.Path2D();
    var map = IA.mapdata.load();
    for (var l = 0; l < prov.loops.length; l++) {
      var pts = IA.mapdata.loopPoints(map, prov.loops[l]);
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
  /*
   * Map modes.
   *
   * The same geometry, filled by a different question.  Several of the
   * simulation's most consequential systems — supply above all — were invisible
   * on the map, which is where a player actually looks: you could only find out
   * a province was cut off by selecting it.
   *
   * Each mode is a fill function and a legend.  The rest of the renderer does
   * not know or care which one is in force; changing mode bumps the map epoch
   * and the cached layer is rebuilt once.
   */
  var MODES = {
    political: {
      name: 'Political', hint: 'Who holds what.',
      fill: function (r, prov) {
        var terrain = TERRAIN[prov.terrain] || TERRAIN.plains;
        var owner = prov.nationId ? r.state.nationById[prov.nationId] : null;
        return owner ? mix(terrain.color, owner.color, 0.66) : mix(terrain.color, NEUTRAL, 0.2);
      },
      key: function (r, prov) { return prov.nationId || '-'; }
    },
    terrain: {
      name: 'Terrain', hint: 'The ground itself, without the politics.',
      fill: function (r, prov) { return (TERRAIN[prov.terrain] || TERRAIN.plains).color; },
      key: function () { return 'terrain'; },
      legend: function () {
        return ['plains', 'farmland', 'forest', 'steppe', 'desert', 'mountain', 'tundra', 'urban']
          .map(function (t) { return { colour: TERRAIN[t].color, label: TERRAIN[t].name }; });
      }
    },
    supply: {
      name: 'Supply', hint: 'How far your depots reach, and where the line is cut.',
      fill: function (r, prov) {
        if (prov.nationId !== r.state.playerId) return prov.nationId ? '#3a3830' : '#2e2c26';
        if (!prov.inSupply) return '#8f2f22';
        var t = clamp((prov.supply || 0) / 4, 0, 1);
        return mix('#6b5c2c', '#a8c46a', t);
      },
      key: function (r, prov) {
        return prov.nationId === r.state.playerId
          ? 'S' + (prov.inSupply ? Math.round((prov.supply || 0) * 2) : 'x')
          : 'other';
      },
      legend: function () {
        return [
          { colour: '#a8c46a', label: 'Secure' },
          { colour: '#6b5c2c', label: 'Stretched' },
          { colour: '#8f2f22', label: 'Cut off' },
          { colour: '#3a3830', label: 'Not yours' }
        ];
      }
    },
    resources: {
      name: 'Resources', hint: 'What each province yields.',
      fill: function (r, prov) {
        var c = DEPOSIT_COLOUR[prov.deposit];
        return c || '#3a382e';
      },
      key: function (r, prov) { return 'D' + (prov.deposit || '-'); },
      legend: function () {
        var out = [];
        for (var k in DEPOSIT_COLOUR) {
          var meta = UnitData.RESOURCE_META[k];
          out.push({ colour: DEPOSIT_COLOUR[k], label: meta ? meta.name : k });
        }
        out.push({ colour: '#3a382e', label: 'No deposit' });
        return out;
      }
    },
    diplomacy: {
      name: 'Diplomacy', hint: 'Who is with you and who is against you.',
      fill: function (r, prov) {
        var state = r.state;
        if (!prov.nationId) return '#2e2c26';
        if (prov.nationId === state.playerId) return '#d9b455';
        var t = IA.state.treaty(state, state.playerId, prov.nationId);
        if (t === 'war') return '#8f2f22';
        if (t === 'alliance') return '#4f7f7a';
        if (t === 'nap') return '#5c6d8a';
        return '#4a4636';
      },
      key: function (r, prov) {
        return prov.nationId
          ? 'T' + IA.state.treaty(r.state, r.state.playerId, prov.nationId) +
            (prov.nationId === r.state.playerId ? 'me' : '')
          : '-';
      },
      legend: function () {
        return [
          { colour: '#d9b455', label: 'You' },
          { colour: '#4f7f7a', label: 'Allied' },
          { colour: '#5c6d8a', label: 'Non-aggression' },
          { colour: '#4a4636', label: 'At peace' },
          { colour: '#8f2f22', label: 'At war' }
        ];
      }
    },
    unrest: {
      name: 'Morale', hint: 'Where the ground is quiet, and where it is not.',
      fill: function (r, prov) {
        if (!prov.nationId) return '#2e2c26';
        var m = clamp(prov.morale / 100, 0, 1);
        return mix('#8f2f22', '#7d9a5b', m);
      },
      key: function (r, prov) { return 'M' + Math.round(prov.morale / 4); },
      legend: function () {
        return [
          { colour: '#7d9a5b', label: 'Steady' },
          { colour: '#8f2f22', label: 'Close to revolt' }
        ];
      }
    },
    blockade: {
      name: 'Blockade', hint: 'Which ports are shut, and whose fleet holds the water.',
      seaControl: true,
      fill: function (r, prov) {
        if (!prov.seaport) return prov.nationId ? '#35342d' : '#2b2a25';
        if (prov.blockaded) return '#8f2f22';
        return prov.nationId === r.state.playerId ? '#6ba884' : '#4a6f86';
      },
      key: function (r, prov) {
        if (!prov.seaport) return prov.nationId ? 'inland' : '-';
        return prov.blockaded ? 'shut' : prov.nationId === r.state.playerId ? 'mine' : 'open';
      },
      legend: function () {
        return [
          { colour: '#6ba884', label: 'Your port, open' },
          { colour: '#4a6f86', label: 'Other port, open' },
          { colour: '#8f2f22', label: 'Blockaded' },
          { colour: '#35342d', label: 'No harbour' }
        ];
      }
    }
  };

  var MODE_ORDER = ['political', 'terrain', 'supply', 'resources', 'diplomacy', 'unrest', 'blockade'];

  var DEPOSIT_COLOUR = {
    grain: '#b9b055', timber: '#5f7f4c', coal: '#4b4a45',
    iron: '#8a7f76', oil: '#6b5b78'
  };

  Renderer.prototype.setMode = function (id) {
    if (!MODES[id] || this.mode === id) return;
    this.mode = id;
    this.fillCache = new Array(this.state.provinces.length);
    this.mapEpoch = (this.mapEpoch || 0) + 1;
    // The cached political raster carries the fills too, so it has to go.
    this.buildBase();
  };

  Renderer.prototype.modeSpec = function () { return MODES[this.mode] || MODES.political; };

  /** Terrain colour blended toward whatever the current map mode asks for. */
  Renderer.prototype.fillFor = function (prov) {
    var spec = this.modeSpec();
    var key = spec.name + '|' + spec.key(this, prov);
    var cached = this.fillCache[prov.id];
    if (cached && cached.key === key) return cached.color;
    var color = spec.fill(this, prov);
    this.fillCache[prov.id] = { key: key, color: color };
    return color;
  };

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /*
   * Ink that reads on a given ground.  Rec. 709 luminance, with the threshold
   * set where a mid olive stops taking dark ink.
   */
  var inkCache = {};
  function inkOn(hex) {
    var hit = inkCache[hex];
    if (hit) return hit;
    var c = hexToRgb(hex);
    var lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    return (inkCache[hex] = lum > 0.52 ? 'rgba(10,12,8,0.94)' : 'rgba(246,240,224,0.95)');
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

    if (!only) this.drawShelf(ctx, 1, null);
    for (i = 0; i < list.length; i++) {
      var prov = list[i];
      if (prov.isSea) continue;
      var path = this.pathFor(prov);
      ctx.fillStyle = this.fillFor(prov);
      ctx.fill(path);
      this.textureProvince(ctx, prov, path, BASE_SCALE);
    }

    this.drawRelief(ctx, only ? [only.bbox[0] - 2, only.bbox[1] - 2, only.bbox[2] + 2, only.bbox[3] + 2]
      : [0, 0, state.mapW, state.mapH]);
    this.strokeBorders(ctx, 1, only ? only.bbox : null);
    if (only) ctx.restore();
  };

  /** Lay the terrain pattern over a province's colour. */
  Renderer.prototype.textureProvince = function (ctx, prov, path, screenScale, alpha) {
    var pattern = this.patternFor(ctx, prov.terrain);
    if (!pattern) return;
    // Aim for a tile roughly 30 screen pixels across at any zoom.  The matrix
    // only depends on the scale, so it is rebuilt when the zoom changes rather
    // than once per province per frame.
    if (global.DOMMatrix && pattern.setTransform) {
      if (this._patternScale !== screenScale) {
        this._patternScale = screenScale;
        this._patternMatrix = new global.DOMMatrix([
          30 / (TILE * screenScale), 0, 0, 30 / (TILE * screenScale), 0, 0
        ]);
        this._patternStamped = null;
      }
      if (this._patternStamped !== pattern) pattern.setTransform(this._patternMatrix);
    }
    if (alpha !== undefined && alpha < 1) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = pattern;
      ctx.fill(path);
      ctx.restore();
      return;
    }
    ctx.fillStyle = pattern;
    ctx.fill(path);
  };

  Renderer.prototype.patternFor = function (ctx, kind) {
    if (!this._patterns) this._patterns = new global.Map();
    var perCtx = this._patterns.get(ctx);
    if (!perCtx) { perCtx = {}; this._patterns.set(ctx, perCtx); }
    if (perCtx[kind] === undefined) {
      try {
        perCtx[kind] = ctx.createPattern(tileFor(kind), 'repeat');
      } catch (e) {
        perCtx[kind] = null;
      }
    }
    return perCtx[kind];
  };

  /** A pale band of shallow water just off the coast, as on a printed atlas. */
  Renderer.prototype.drawShelf = function (ctx, scale, clipBox) {
    var state = this.state;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = SHELF;
    var widths = [7, 4, 2];
    for (var w = 0; w < widths.length; w++) {
      ctx.beginPath();
      var any = false;
      for (var r = 0; r < state.runs.length; r++) {
        var run = state.runs[r];
        var a = state.provinces[run.a];
        var b = run.b >= 0 ? state.provinces[run.b] : null;
        if (!b || a.isSea === b.isSea) continue;          // coastline only
        if (clipBox) {
          var bb = this.boundsFor(r);
          if (bb[2] < clipBox[0] - 8 || bb[0] > clipBox[2] + 8 ||
            bb[3] < clipBox[1] - 8 || bb[1] > clipBox[3] + 8) continue;
        }
        var pts = run.pts;
        ctx.moveTo(pts[0], pts[1]);
        for (var i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
        any = true;
      }
      if (!any) break;
      ctx.lineWidth = widths[w] / scale;
      ctx.stroke();
    }
    ctx.restore();
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
      ctx.lineWidth = (pass === 2 ? 1.2 : pass === 1 ? 1.7 : 0.6) / scale;
      ctx.stroke();
    }
  };

  /** Called after a province changes hands. */
  Renderer.prototype.repaint = function (provinceId) {
    var prov = this.state.provinces[provinceId];
    if (!prov || !this.baseCtx) return;
    this.fillCache[provinceId] = null;
    this.mapEpoch = (this.mapEpoch || 0) + 1;
    this.paintBase(this.baseCtx, prov);
  };

  // --- camera --------------------------------------------------------------

  Renderer.prototype.resize = function () {
    var dpr = Math.min(global.devicePixelRatio || 1, MAX_DPR);
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

  function now() {
    return global.performance ? global.performance.now() : Date.now();
  }

  /** Called whenever the view moves, so detail knows to stand down. */
  Renderer.prototype.noteMotion = function () { this.lastMotion = now(); };

  /** 0 while the map is moving, easing to 1 once it has settled. */
  Renderer.prototype.detailAlpha = function () {
    var since = now() - (this.lastMotion || 0);
    if (since < DETAIL_DELAY) return 0;
    return clamp((since - DETAIL_DELAY) / DETAIL_FADE, 0, 1);
  };

  Renderer.prototype.panBy = function (dx, dy) {
    this.camera.x -= dx / this.camera.zoom;
    this.camera.y -= dy / this.camera.zoom;
    this.clampCamera();
    this.noteMotion();
  };

  Renderer.prototype.zoomAt = function (factor, sx, sy) {
    var before = this.toMap(sx, sy);
    this.camera.zoom = clamp(this.camera.zoom * factor, this.minZoom, this.maxZoom);
    var after = this.toMap(sx, sy);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
    this.clampCamera();
    this.noteMotion();
  };

  Renderer.prototype.centerOn = function (provinceId, zoom) {
    var p = this.state.provinces[provinceId];
    if (!p) return;
    this.camera.x = p.cx;
    this.camera.y = p.cy;
    if (zoom) this.camera.zoom = clamp(zoom, this.minZoom, this.maxZoom);
    this.clampCamera();
    this.noteMotion();
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

  /** Map units to CSS pixels.  The device-ratio scale is applied by the caller. */
  Renderer.prototype.applyCamera = function (ctx) {
    var z = this.camera.zoom;
    ctx.translate(-this.camera.x * z + this.viewW / 2, -this.camera.y * z + this.viewH / 2);
    ctx.scale(z, z);
  };

  /** Land provinces whose bounding box meets the view. */
  Renderer.prototype.visibleLand = function (box) {
    var state = this.state, out = [];
    for (var i = 0; i < state.provinces.length; i++) {
      var p = state.provinces[i];
      if (p.isSea || !overlaps(box, p.bbox)) continue;
      out.push(p);
    }
    return out;
  };

  /**
   * Lay the shaded relief over the fills.  Only the slice of it under the view
   * is drawn, so zooming in does not scale a world-sized image.
   */
  Renderer.prototype.drawRelief = function (ctx, box) {
    var relief = this.relief;
    if (!relief) return;
    var state = this.state;
    var sx = relief.width / state.mapW, sy = relief.height / state.mapH;
    var x0 = Math.max(0, Math.floor(box[0] * sx));
    var y0 = Math.max(0, Math.floor(box[1] * sy));
    var x1 = Math.min(relief.width, Math.ceil(box[2] * sx));
    var y1 = Math.min(relief.height, Math.ceil(box[3] * sy));
    if (x1 <= x0 || y1 <= y0) return;
    ctx.drawImage(relief, x0, y0, x1 - x0, y1 - y0,
      x0 / sx, y0 / sy, (x1 - x0) / sx, (y1 - y0) / sy);
  };

  /** The ground itself: coastal shelf, province fills, relief, then borders. */
  Renderer.prototype.drawGround = function (ctx, z, box, list) {
    this.drawShelf(ctx, z, box);
    for (var i = 0; i < list.length; i++) {
      ctx.fillStyle = this.fillFor(list[i]);
      ctx.fill(this.pathFor(list[i]));
    }
    this.drawRelief(ctx, box);
    this.strokeBorders(ctx, z, box);
  };

  /*
   * The scrolling map layer.
   *
   * Stroking the borders and the coastal shelf is by far the most expensive
   * thing on screen — about seventeen milliseconds of rasterising at a
   * continental zoom, which is the whole frame budget on a phone — and almost
   * none of it changes from one frame to the next.  A map held still redraws an
   * identical picture sixty times a second, and a map being dragged redraws a
   * picture that has moved by nine pixels.
   *
   * So the ground is kept in a layer the size of the viewport, and each frame
   * only reconciles it with where the camera now is:
   *
   *   still      — nothing to do, blit it
   *   dragged    — scroll the layer by whole device pixels and repaint just the
   *                strip that scrolled in, a few percent of the view
   *   zoomed, resized, or a province changed hands — repaint the lot
   *
   * The layer is aligned to `anchor` rather than to the camera, because
   * scrolling by a fraction of a pixel would resample the whole layer and blur
   * it.  Anchor and camera therefore differ by up to half a device pixel, which
   * is why the armies and labels drawn live over the top are not visibly out of
   * step with the ground beneath them.
   *
   * Terrain texture is a second layer, so it can fade in over a still map by
   * changing an alpha rather than by redrawing anything.
   */
  var LAYER_OVERLAP = 3;         // device pixels of the strip that fall on good ground

  function newCanvas(w, h) {
    var c = global.document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /** Map-unit box covering a device-pixel rect of a layer drawn for `anchor`. */
  Renderer.prototype.boxOfRect = function (anchor, x, y, w, h) {
    var s = this.camera.zoom * this.dpr;
    var mx = anchor.x - this.viewW / (2 * this.camera.zoom) + x / s;
    var my = anchor.y - this.viewH / (2 * this.camera.zoom) + y / s;
    // The margin covers line widths that reach in from outside the rect.
    return [mx - 2, my - 2, mx + w / s + 2, my + h / s + 2];
  };

  /** Paint the ground into `target`, either whole or clipped to device rects. */
  Renderer.prototype.paintLayer = function (target, anchor, rects) {
    var z = this.camera.zoom;
    var ctx = target.getContext('2d');
    var i;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.save();
    var box;
    if (rects) {
      ctx.beginPath();
      for (i = 0; i < rects.length; i++) ctx.rect(rects[i][0], rects[i][1], rects[i][2], rects[i][3]);
      ctx.clip();
      box = this.boxOfRect(anchor, rects[0][0], rects[0][1], rects[0][2], rects[0][3]);
      for (i = 1; i < rects.length; i++) {
        var b = this.boxOfRect(anchor, rects[i][0], rects[i][1], rects[i][2], rects[i][3]);
        if (b[0] < box[0]) box[0] = b[0];
        if (b[1] < box[1]) box[1] = b[1];
        if (b[2] > box[2]) box[2] = b[2];
        if (b[3] > box[3]) box[3] = b[3];
      }
    } else {
      box = this.boxOfRect(anchor, 0, 0, target.width, target.height);
    }
    ctx.fillStyle = OCEAN;
    ctx.fillRect(0, 0, target.width, target.height);
    ctx.scale(this.dpr, this.dpr);
    ctx.translate(-anchor.x * z + this.viewW / 2, -anchor.y * z + this.viewH / 2);
    ctx.scale(z, z);
    if (z < VECTOR_ZOOM) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.baseLayer, 0, 0, this.state.mapW, this.state.mapH);
    } else {
      this.drawGround(ctx, z, box, this.visibleLand(box));
    }
    ctx.restore();
  };

  Renderer.prototype.updateLayer = function () {
    var W = Math.max(1, Math.round(this.viewW * this.dpr));
    var H = Math.max(1, Math.round(this.viewH * this.dpr));
    if (!this.layer || this.layer.width !== W || this.layer.height !== H) {
      this.layer = newCanvas(W, H);
      this.spare = newCanvas(W, H);
      this.layerSig = null;
    }
    // Anything that changes the whole picture: a new zoom, a new canvas size,
    // or ground that has changed hands.
    var sig = [this.camera.zoom, this.dpr, W, H, this.mapEpoch || 0].join(',');
    this.anchorEpoch = (this.anchorEpoch || 0) + 1;
    if (this.layerSig !== sig) {
      this.layerSig = sig;
      this.anchor = { x: this.camera.x, y: this.camera.y };
      this.paintLayer(this.layer, this.anchor, null);
      return;
    }

    var s = this.camera.zoom * this.dpr;
    var sdx = Math.round((this.anchor.x - this.camera.x) * s);
    var sdy = Math.round((this.anchor.y - this.camera.y) * s);
    if (!sdx && !sdy) { this.anchorEpoch--; return; }
    if (Math.abs(sdx) >= W || Math.abs(sdy) >= H) {     // jumped clean off
      this.anchor.x = this.camera.x;
      this.anchor.y = this.camera.y;
      this.paintLayer(this.layer, this.anchor, null);
      return;
    }

    this.anchor.x -= sdx / s;
    this.anchor.y -= sdy / s;
    var spare = this.spare;
    var sc = spare.getContext('2d');
    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.clearRect(0, 0, W, H);
    sc.drawImage(this.layer, sdx, sdy);

    /*
     * The repainted strip reaches a little way back into ground that scrolled
     * across intact.  A stroke that crosses the edge of a clip is blended
     * against whatever is already there, which would leave a faint trace along
     * every border the strip cut through, and those traces build up over a long
     * drag.  Landing that edge inside pixels that are already correct makes the
     * blend a blend of two identical values, so it leaves no mark.
     */
    var pad = LAYER_OVERLAP;
    var rects = [];
    if (sdx > 0) rects.push([0, 0, sdx + pad, H]);
    else if (sdx < 0) rects.push([W + sdx - pad, 0, -sdx + pad, H]);
    if (sdy > 0) rects.push([0, 0, W, sdy + pad]);
    else if (sdy < 0) rects.push([0, H + sdy - pad, W, -sdy + pad]);
    this.paintLayer(spare, this.anchor, rects);

    this.spare = this.layer;
    this.layer = spare;
  };

  /** Terrain texture for the current anchor, built only once the map settles. */
  Renderer.prototype.updateTexLayer = function () {
    var key = this.layerSig + '|' + this.anchorEpoch;
    if (this.texKey === key) return;
    this.texKey = key;
    var z = this.camera.zoom;
    var W = this.layer.width, H = this.layer.height;
    if (!this.layerTex || this.layerTex.width !== W || this.layerTex.height !== H) {
      this.layerTex = newCanvas(W, H);
    }
    var ctx = this.layerTex.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.translate(-this.anchor.x * z + this.viewW / 2, -this.anchor.y * z + this.viewH / 2);
    ctx.scale(z, z);
    var list = this.visibleLand(this.boxOfRect(this.anchor, 0, 0, W, H));
    for (var i = 0; i < list.length; i++) {
      this.textureProvince(ctx, list[i], this.pathFor(list[i]), z);
    }
    ctx.restore();
  };

  /**
   * Dim what the player cannot see into.  Vision changes as armies march, so
   * this is drawn live rather than baked into the cached layer.  Only in vector
   * mode: at world zoom the political map is common knowledge — it is the
   * armies that are hidden.
   */
  Renderer.prototype.drawFog = function (ctx, ui) {
    if (!ui || !ui.visible) return;
    var state = this.state;
    var box = this.viewBox(2);
    ctx.save();
    this.applyCamera(ctx);
    ctx.globalAlpha = 0.34;
    ctx.fillStyle = '#050a10';
    for (var i = 0; i < state.provinces.length; i++) {
      var p = state.provinces[i];
      if (p.isSea || ui.visible[p.id] || !overlaps(box, p.bbox)) continue;
      ctx.fill(this.pathFor(p));
    }
    ctx.restore();
  };

  /**
   * Weather lies over the ground rather than in it: it changes every day, and
   * baking it into the cached layer would repaint the whole map each midnight.
   * Only conditions that actually cost you something are drawn, so a clear day
   * looks like a clear day.
   */
  Renderer.prototype.drawWeather = function (ctx) {
    var state = this.state;
    var box = this.viewBox(2);
    ctx.save();
    this.applyCamera(ctx);
    for (var i = 0; i < state.provinces.length; i++) {
      var p = state.provinces[i];
      // Land only.  Sea zones are large and rectangular, so a wash over them
      // draws the weather grid itself across the ocean in hard diagonal bands
      // rather than reading as weather.
      if (p.size === 0 || p.isSea || !overlaps(box, p.bbox)) continue;
      var wash = IA.weather.of(p).wash;
      if (!wash) continue;
      ctx.fillStyle = wash;
      ctx.fill(this.pathFor(p));
    }
    ctx.restore();
  };

  /*
   * Who holds the water.
   *
   * Drawn live rather than baked into the base raster, because fleets move and
   * a blockade that took three days to form should show the hour it does.  Only
   * the zones that actually have ships in them are touched, so this costs
   * nothing on a map where nobody has put to sea.
   */
  Renderer.prototype.drawSeaControl = function (ctx) {
    var state = this.state;
    if (!state.seaControl) return;
    var box = this.viewBox(2);
    ctx.save();
    this.applyCamera(ctx);
    for (var id in state.seaControl) {
      var prov = state.provinces[id];
      if (!prov || !overlaps(box, prov.bbox)) continue;
      var fleets = IA.naval.fleetsIn(state, prov.id);
      if (!fleets.length) continue;
      var top = state.nationById[fleets[0].nationId];
      if (!top) continue;
      var path = this.pathFor(prov);
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = top.color;
      ctx.fill(path);
      // Water the player's own shipping can no longer use is marked as closed,
      // which is the only thing about somebody else's navy that matters.
      ctx.globalAlpha = 1;
      if (!IA.naval.passable(state, state.playerId, prov.id)) {
        ctx.lineWidth = 2 / this.camera.zoom;
        ctx.strokeStyle = 'rgba(200,60,44,.85)';
        ctx.stroke(path);
      }
    }
    ctx.restore();
  };

  Renderer.prototype.draw = function (ui) {
    var state = this.state;
    if (state.dirtyProvinces && state.dirtyProvinces.length) {
      for (var d = 0; d < state.dirtyProvinces.length; d++) this.repaint(state.dirtyProvinces[d]);
      state.dirtyProvinces.length = 0;
      this.refreshNationLabels();
    }
    var ctx = this.ctx;
    var z = this.camera.zoom;
    var detail = this.detailAlpha();

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    this.updateLayer();
    ctx.drawImage(this.layer, 0, 0, this.viewW, this.viewH);
    if (z >= VECTOR_ZOOM && detail > 0) {
      this.updateTexLayer();
      ctx.save();
      ctx.globalAlpha = detail;
      ctx.drawImage(this.layerTex, 0, 0, this.viewW, this.viewH);
      ctx.restore();
    }

    this.drawWeather(ctx);
    if (this.modeSpec().seaControl) this.drawSeaControl(ctx);
    if (z >= VECTOR_ZOOM) this.drawFog(ctx, ui);
    this.drawFlips(ctx);

    this.drawNationLabels(ctx);
    this.drawProvinceMarkers(ctx, ui);
    this.drawPaths(ctx, ui);
    this.drawArmies(ctx, ui);
    this.drawLabels(ctx, ui);
    ctx.restore();
  };

  /*
   * Ground changing hands.
   *
   * A province simply became a different colour between one glance and the
   * next, which is the most consequential thing that happens in the game and
   * the easiest to miss.  For a few game hours after a capture the province is
   * washed in the new owner's colour, fading out — enough to catch the eye
   * without leaving a mark on the map afterwards.
   */
  var FLIP_HOURS = 6;

  Renderer.prototype.drawFlips = function (ctx) {
    var flips = this.state.flips;
    if (!flips) return;
    var state = this.state;
    var box = this.viewBox(2);
    ctx.save();
    this.applyCamera(ctx);
    for (var id in flips) {
      var flip = flips[id];
      var age = state.time - flip.at;
      // Expired marks are dropped here rather than swept elsewhere: this is the
      // only place that cares, and it runs every frame anyway.
      if (age < 0 || age > FLIP_HOURS) { delete flips[id]; continue; }
      var prov = state.provinces[id];
      if (!prov || !overlaps(box, prov.bbox)) continue;
      var nation = state.nationById[flip.by];
      ctx.globalAlpha = 0.55 * (1 - age / FLIP_HOURS);
      ctx.fillStyle = nation ? nation.color : '#ffffff';
      ctx.fill(this.pathFor(prov));
    }
    ctx.restore();
  };

  Renderer.prototype.drawProvinceMarkers = function (ctx, ui) {
    var state = this.state;
    var z = this.camera.zoom;
    var box = this.viewBox(4);
    for (var i = 0; i < state.landCount; i++) {
      var p = state.provinces[i];
      if (p.cx < box[0] || p.cx > box[2] || p.cy < box[1] || p.cy > box[3]) continue;
      // Thin the city dots out as the view widens, or the world view turns
      // into a field of specks.
      var major = p.isCapital || p.cityLevel >= 4;
      if (z < 1.6) { if (!p.isCapital || p.cityLevel < 5) continue; }
      else if (z < 3) { if (!p.isCapital) continue; }
      else if (z < 6) { if (!major) continue; }
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
      /*
       * A province under fire.  This was a crossed-swords emoji, which reads as
       * a label rather than as gunfire; it is now a shellburst that pulses on
       * the frame clock and fades as the hour since the last exchange runs out,
       * so a front that is actually being fought over flickers and one that has
       * gone quiet simply stops.
       */
      if (state.battleProvinces && z > 2) {
        var since = state.time - state.battleProvinces[p.id];
        if (since >= 0 && since < 1.01) {
          drawBurst(ctx, s.x, s.y, clamp(z * 0.9, 6, 17), 1 - since / 1.01, now());
        }
      }
    }
  };

  /**
   * A shellburst: a hot core, a ring going out, and rays.  Drawn from the frame
   * clock rather than the game clock so it pulses at the same rate whatever
   * speed the war is running at.
   */
  function drawBurst(ctx, x, y, size, strength, t) {
    var pulse = 0.62 + 0.38 * Math.sin(t * 0.017 + x * 0.4);
    var a = strength * pulse;
    if (a <= 0.02) return;
    ctx.save();
    ctx.translate(x, y);

    var ring = size * (1.5 - strength * 0.5);
    ctx.globalAlpha = a * 0.35;
    ctx.strokeStyle = '#e8a24a';
    ctx.lineWidth = Math.max(1, size * 0.12);
    ctx.beginPath();
    ctx.arc(0, 0, ring, 0, Math.PI * 2);
    ctx.stroke();

    ctx.globalAlpha = a * 0.9;
    ctx.strokeStyle = '#ffd489';
    ctx.lineWidth = Math.max(1, size * 0.16);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (var k = 0; k < 6; k++) {
      var ang = (k / 6) * Math.PI * 2 + t * 0.0004;
      var inner = size * 0.34, outer = size * (0.72 + 0.24 * pulse);
      ctx.moveTo(Math.cos(ang) * inner, Math.sin(ang) * inner);
      ctx.lineTo(Math.cos(ang) * outer, Math.sin(ang) * outer);
    }
    ctx.stroke();

    ctx.globalAlpha = a;
    ctx.fillStyle = '#fff2cd';
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.28 * (0.8 + 0.2 * pulse), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * March routes are drawn as a pale bed with a dashed stripe over it, so a
   * long order stays readable across terrain of any colour, and the
   * destination gets a pin.
   */
  Renderer.prototype.drawPaths = function (ctx, ui) {
    var state = this.state;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    for (var i = 0; i < state.armies.length; i++) {
      var army = state.armies[i];
      if (!army.path.length) continue;
      var isPlayer = army.ownerId === state.playerId;
      if (!isPlayer && (!ui || !ui.visible || !ui.visible[army.provinceId])) continue;
      if (!isPlayer && ui && ui.selectedArmyId !== army.id) continue;

      var selected = ui && ui.selectedArmyId === army.id;
      var nation = state.nationById[army.ownerId];
      var stripe = selected ? '#7fe3ff' : (nation ? nation.color : '#ffffff');
      var pt = this.armyPoint(army);
      var s = this.toScreen(pt.x, pt.y);
      var last = s;

      function trace(c) {
        c.beginPath();
        c.moveTo(s.x, s.y);
        for (var j = 0; j < army.path.length; j++) {
          var np = state.provinces[army.path[j]];
          var ns = this.toScreen(np.cx, np.cy);
          c.lineTo(ns.x, ns.y);
          last = ns;
        }
      }

      ctx.globalAlpha = selected ? 0.95 : 0.55;
      ctx.setLineDash([]);
      ctx.lineWidth = selected ? 6 : 4;
      ctx.strokeStyle = 'rgba(244,250,255,0.85)';
      trace.call(this, ctx);
      ctx.stroke();

      ctx.setLineDash([7, 7]);
      ctx.lineWidth = selected ? 6 : 4;
      ctx.strokeStyle = stripe;
      trace.call(this, ctx);
      ctx.stroke();

      // Destination pin.
      ctx.setLineDash([]);
      ctx.globalAlpha = selected ? 1 : 0.7;
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(last.x, last.y - 13);
      ctx.strokeStyle = 'rgba(244,250,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = stripe;
      ctx.fillRect(last.x, last.y - 13, 9, 6);
      ctx.strokeRect(last.x, last.y - 13, 9, 6);
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

    /*
     * A stack reads as a counter off a map table: a national colour bar down
     * the hoist, the leading unit's silhouette, the battalion count, and a
     * strength bar along the foot.  A stem points at the province it stands in.
     *
     * Two states have to be legible without selecting anything, because both
     * change what you should do next: a stack that is out of supply, and one
     * with an officer at its head.
     */
    function drawStack(c, army, x, y, bw, bh, uiRef) {
      var nation = state.nationById[army.ownerId];
      var strength = IA.state.armyStrength(army);
      var selected = uiRef && uiRef.selectedArmyId === army.id;
      var ratio = clamp(strength.ratio, 0, 1);
      var hoist = bw * 0.30;
      var barH = Math.max(2.5, bh * 0.16);
      var starved = army.supplied === false;
      var led = !!army.commanderId;

      c.save();
      c.translate(x, y);

      // Stem down to the province.
      c.strokeStyle = 'rgba(6,12,18,0.75)';
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(0, bh / 2);
      c.lineTo(0, bh / 2 + bh * 0.55);
      c.stroke();

      c.shadowColor = 'rgba(0,0,0,0.55)';
      c.shadowBlur = 5;
      c.shadowOffsetY = 2;
      c.fillStyle = starved ? 'rgba(46,26,22,0.96)' : 'rgba(22,26,22,0.96)';
      c.fillRect(-bw / 2, -bh / 2, bw, bh);
      c.shadowColor = 'transparent';
      c.shadowBlur = 0;
      c.shadowOffsetY = 0;

      c.fillStyle = nation ? nation.color : '#888';
      c.fillRect(-bw / 2, -bh / 2, hoist, bh);

      // Strength along the foot.
      c.fillStyle = 'rgba(0,0,0,0.45)';
      c.fillRect(-bw / 2, bh / 2 - barH, bw, barH);
      c.fillStyle = ratio > 0.6 ? '#7d9a5b' : ratio > 0.3 ? '#c98f3c' : '#b04a38';
      c.fillRect(-bw / 2, bh / 2 - barH, bw * ratio, barH);

      // The leading unit's silhouette, sitting on the national bar.  The ink
      // follows the colour underneath it: the graph colouring hands out both
      // pale yellows and near-black greens, and one ink cannot read on both.
      var lead = army.units[0];
      if (lead) {
        IA.icons.drawUnit(c, lead.typeId, -bw / 2 + hoist / 2, -barH / 2,
          Math.round(Math.min(hoist, bh - barH) * 0.94),
          inkOn(nation ? nation.color : '#888'));
      }

      c.fillStyle = starved ? '#f0b6a6' : '#ece3cd';
      c.textBaseline = 'middle';
      c.textAlign = 'center';
      c.font = 'bold ' + Math.round(bh * 0.46) + 'px "Segoe UI", system-ui, sans-serif';
      c.fillText(String(IA.state.unitCount(army)), (hoist / 2) - 1, -barH / 2);

      // A brass pip in the corner where an officer commands.
      if (led) {
        c.fillStyle = '#d9b455';
        c.beginPath();
        c.arc(bw / 2 - 3, -bh / 2 + 3, 2.4, 0, Math.PI * 2);
        c.fill();
      }

      c.strokeStyle = selected ? '#e2c37a'
        : army.inCombat ? '#b04a38'
          : starved ? 'rgba(176,74,56,0.85)' : 'rgba(10,12,8,0.9)';
      c.lineWidth = selected || army.inCombat ? 2 : 1;
      c.strokeRect(-bw / 2, -bh / 2, bw, bh);
      c.restore();
    }
  };

  /**
   * Where each country's name is written, and how big.
   *
   * A country is labelled once per connected block of territory rather than
   * once overall.  An empire's area-weighted centre is nowhere near its
   * homeland — Denmark's lands average out in the middle of Greenland and
   * France's in the Sahara — so a single label puts the name in the wrong
   * hemisphere.  Each block is instead named on the province nearest its own
   * centre and sized from its own area, which writes the home country where it
   * actually is and gives a large colony its own smaller name.
   *
   * Only the substantial blocks are kept, or every island in an empire would
   * claim the full name of it.
   */
  var MIN_BLOCK_SHARE = 0.12;      // of the nation's largest block
  var MAX_BLOCKS = 4;

  Renderer.prototype.refreshNationLabels = function () {
    var state = this.state;
    var seen = new Uint8Array(state.landCount);
    var byNation = {};
    var queue = [];
    var i, k;

    for (i = 0; i < state.landCount; i++) {
      if (seen[i] || !state.provinces[i].nationId) continue;
      var nationId = state.provinces[i].nationId;
      var capitalId = state.nationById[nationId] ? state.nationById[nationId].capitalProvince : -1;
      var hasCapital = false;
      var block = [];
      queue.length = 0;
      queue.push(i);
      seen[i] = 1;
      while (queue.length) {
        var p = state.provinces[queue.pop()];
        block.push(p);
        if (p.id === capitalId) hasCapital = true;
        for (k = 0; k < p.neighbors.length; k++) {
          var q = state.provinces[p.neighbors[k]];
          if (q.isSea || seen[q.id] || q.nationId !== nationId) continue;
          seen[q.id] = 1;
          queue.push(q.id);
        }
      }

      var sx = 0, sy = 0, area = 0;
      var x0 = Infinity, x1 = -Infinity;
      for (k = 0; k < block.length; k++) {
        var b = block[k];
        sx += b.cx * b.size;
        sy += b.cy * b.size;
        area += b.size;
        if (b.bbox[0] < x0) x0 = b.bbox[0];
        if (b.bbox[2] > x1) x1 = b.bbox[2];
      }
      var cx = sx / area, cy = sy / area;
      var best = null, bestD = Infinity;
      for (k = 0; k < block.length; k++) {
        var dx = block[k].cx - cx, dy = block[k].cy - cy;
        var d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = block[k]; }
      }
      (byNation[nationId] || (byNation[nationId] = [])).push({
        x: best.cx, y: best.cy,
        area: area,
        width: x1 - x0,
        capital: hasCapital,
        // Big countries get big type, the way an atlas sets them.
        size: Math.sqrt(area) * 0.24
      });
    }

    var labels = [];
    for (var id in byNation) {
      var nation = state.nationById[id];
      if (!nation) continue;
      var blocks = byNation[id].sort(function (a, b) { return b.area - a.area; });
      var floor = blocks[0].area * MIN_BLOCK_SHARE;
      var kept = 0;
      for (i = 0; i < blocks.length; i++) {
        // The homeland is always named, however small it is beside the
        // colonies — France belongs on France, not only on French West Africa.
        if (!blocks[i].capital) {
          if (kept >= MAX_BLOCKS || blocks[i].area < floor) continue;
          kept++;
        }
        blocks[i].text = nation.name.toUpperCase();
        labels.push(blocks[i]);
      }
    }
    this.nationLabels = labels;
  };

  Renderer.prototype.drawNationLabels = function (ctx) {
    if (!this.nationLabels) this.refreshNationLabels();
    var z = this.camera.zoom;
    var box = this.viewBox(20);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Biggest countries first, and drop any label that would collide with one
    // already placed — an atlas never stacks two names on top of each other.
    var order = this.nationLabels.slice().sort(function (a, b) { return b.size - a.size; });
    var placed = [];
    for (var i = 0; i < order.length; i++) {
      var l = order[i];
      if (l.x < box[0] || l.x > box[2] || l.y < box[1] || l.y > box[3]) continue;
      var px = Math.min(l.size * z, 96);
      if (px < 13) continue;                      // too cramped to read
      var s = this.toScreen(l.x, l.y);
      ctx.font = '600 ' + Math.round(px) + 'px "Segoe UI", system-ui, sans-serif';
      // A name never runs wider than the land it names.
      var wide = ctx.measureText(l.text).width;
      var room = l.width * z * 0.92;
      if (wide > room) {
        px = Math.floor(px * room / wide);
        if (px < 13) continue;
        ctx.font = '600 ' + px + 'px "Segoe UI", system-ui, sans-serif';
      }
      var half = ctx.measureText(l.text).width / 2;
      var boxL = [s.x - half, s.y - px * 0.6, s.x + half, s.y + px * 0.6];
      var clash = false;
      for (var q = 0; q < placed.length; q++) {
        var o = placed[q];
        if (!(boxL[2] < o[0] || boxL[0] > o[2] || boxL[3] < o[1] || boxL[1] > o[3])) { clash = true; break; }
      }
      if (clash) continue;
      placed.push(boxL);
      ctx.lineWidth = Math.max(2, px * 0.14);
      ctx.strokeStyle = 'rgba(8,16,24,0.45)';
      ctx.globalAlpha = clamp((px - 13) / 22, 0, 1) * 0.62;
      ctx.strokeText(l.text, s.x, s.y);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(l.text, s.x, s.y);
    }
    ctx.restore();
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
      // The city tier rides with the name, so the value of a province is
      // readable without selecting it.
      var text = p.cityLevel >= 2 ? p.name + '(' + p.cityLevel + ')' : p.name;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(6,12,18,0.85)';
      ctx.strokeText(text, s.x, s.y + 6);
      ctx.fillStyle = p.isCapital ? '#ffe9a8' : '#e8f2ff';
      ctx.fillText(text, s.x, s.y + 6);
    }
    ctx.restore();
  };

  Renderer.MODES = MODES;
  Renderer.MODE_ORDER = MODE_ORDER;
  IA.Renderer = Renderer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
