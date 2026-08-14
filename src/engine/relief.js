/*
 * Relief.
 *
 * The map is flat colour with a terrain hatch over it, which reads as a
 * diagram rather than as ground.  This builds a shaded relief the renderer lays
 * over the political fills, so the Alps, the Carpathians and the Caucasus have
 * shape and the plains between them read as plains.
 *
 * There is no elevation model in the map data and adding one would mean another
 * source dataset and another megabyte.  Instead the terrain each province was
 * already assigned is treated as a description of its ground: a base height and
 * a roughness.  Those are painted into a field, fractal noise is added in
 * proportion to the roughness, and the field is lit from the north-west — which
 * is where map light has come from since the first shaded atlases, because the
 * eye reads it as raised rather than sunken.
 *
 * The whole thing is built once at startup and never changes: geography is the
 * one part of the world a war does not move.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};

  /*
   * How high each terrain sits and how broken it is.  These are not metres —
   * they are what the shading should say about the ground.
   */
  var GROUND = {
    plains: { height: 0.14, rough: 0.10 },
    farmland: { height: 0.11, rough: 0.05 },
    steppe: { height: 0.19, rough: 0.11 },
    desert: { height: 0.20, rough: 0.20 },
    forest: { height: 0.28, rough: 0.17 },
    taiga: { height: 0.31, rough: 0.19 },
    jungle: { height: 0.24, rough: 0.14 },
    tundra: { height: 0.22, rough: 0.12 },
    mountain: { height: 0.78, rough: 0.60 },
    urban: { height: 0.17, rough: 0.07 },
    sea: { height: 0, rough: 0 }
  };

  var LIGHT_X = -0.72;          // from the north-west, as an atlas is lit
  var LIGHT_Y = -0.69;
  var RELIEF = 2.6;             // how hard the shading bites
  var NOISE_SCALE = 0.038;      // features per map unit at the coarsest octave

  /*
   * Shading is scaled by how broken the ground is, not applied evenly.  Lit
   * evenly, farmland picks up as much relief as the Alps and the whole map goes
   * pale and mottled; the point of relief is that flat country looks flat.
   */
  var FLOOR = 0.14;             // the least any ground is shaded
  var LIT_MAX = 120;            // alpha, sunlit slope
  var DARK_MAX = 190;           // alpha, shadowed slope

  function hash2(x, y, seed) {
    var h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ seed;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /** Value noise: cheap, smooth enough once four octaves are stacked. */
  function noise(x, y, seed) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf);
    var v = yf * yf * (3 - 2 * yf);
    var a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
    var c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  function fractal(x, y, seed) {
    var sum = 0, amp = 1, freq = 1, norm = 0;
    for (var o = 0; o < 4; o++) {
      sum += noise(x * freq, y * freq, seed + o * 7919) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.07;
    }
    return sum / norm;
  }

  /**
   * Paint the ground description into a field: red carries base height, green
   * carries roughness, and the sea is left transparent so nothing is shaded
   * out at sea.  Province edges blend, which is what you want — one terrain
   * should run into the next rather than step.
   */
  function paintGround(state, w, h) {
    var canvas = global.document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.scale(w / state.mapW, h / state.mapH);
    var map = IA.mapdata.load();
    for (var i = 0; i < state.provinces.length; i++) {
      var prov = state.provinces[i];
      if (prov.isSea || prov.size === 0) continue;
      var g = GROUND[prov.terrain] || GROUND.plains;
      var path = new global.Path2D();
      for (var l = 0; l < prov.loops.length; l++) {
        var pts = IA.mapdata.loopPoints(map, prov.loops[l]);
        if (pts.length < 6) continue;
        path.moveTo(pts[0], pts[1]);
        for (var k = 2; k < pts.length; k += 2) path.lineTo(pts[k], pts[k + 1]);
        path.closePath();
      }
      ctx.fillStyle = 'rgb(' + Math.round(g.height * 255) + ',' +
        Math.round(g.rough * 255) + ',255)';
      ctx.fill(path);
    }
    ctx.restore();
    return canvas;
  }

  /**
   * Build the shaded relief.  Returns a canvas the renderer can blit in map
   * coordinates: dark where the ground falls away from the light, pale where it
   * catches it, and clear where the ground is flat or there is no ground.
   */
  function build(state, seedString) {
    var w = Math.round(state.mapW);
    var h = Math.round(state.mapH);
    var seed = IA.hashString(String(seedString || state.seed || 'relief')) >>> 0;

    var ground = paintGround(state, w, h);
    var src = ground.getContext('2d').getImageData(0, 0, w, h).data;

    // Height field, with noise in proportion to how broken the ground is.
    var elev = new Float32Array(w * h);
    var bite = new Float32Array(w * h);
    var land = new Uint8Array(w * h);
    var x, y, i;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        var p = i * 4;
        if (src[p + 3] < 8) continue;                  // open water
        land[i] = 1;
        var base = src[p] / 255;
        var rough = src[p + 1] / 255;
        elev[i] = base + (fractal(x * NOISE_SCALE, y * NOISE_SCALE, seed) - 0.5) * rough * 1.9;
        bite[i] = FLOOR + (1 - FLOOR) * Math.min(1, rough / 0.55);
      }
    }

    var out = global.document.createElement('canvas');
    out.width = w; out.height = h;
    var octx = out.getContext('2d');
    var img = octx.createImageData(w, h);
    var data = img.data;

    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (!land[i]) continue;
        // Central differences, clamped at the edges of the field.
        var xm = x > 0 ? elev[i - 1] : elev[i];
        var xp = x < w - 1 ? elev[i + 1] : elev[i];
        var ym = y > 0 ? elev[i - w] : elev[i];
        var yp = y < h - 1 ? elev[i + w] : elev[i];
        var dx = (xp - xm) * RELIEF;
        var dy = (yp - ym) * RELIEF;
        // Slope facing the light is lit, slope facing away is shadowed.
        var shade = (dx * LIGHT_X + dy * LIGHT_Y) * bite[i];
        var q = i * 4;
        if (shade >= 0) {
          var lit = Math.min(1, shade * 3.6);
          data[q] = 255; data[q + 1] = 248; data[q + 2] = 226;
          data[q + 3] = Math.round(lit * LIT_MAX);
        } else {
          var dark = Math.min(1, -shade * 3.6);
          data[q] = 12; data[q + 1] = 11; data[q + 2] = 7;
          data[q + 3] = Math.round(dark * DARK_MAX);
        }
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  IA.relief = { build: build, GROUND: GROUND };
})(typeof globalThis !== 'undefined' ? globalThis : this);
