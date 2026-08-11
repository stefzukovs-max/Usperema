/*
 * Decoder for the compiled map in src/data/worldmap.js.
 *
 * The build tool emits delta-encoded integer streams; this turns them back
 * into province outlines, adjacency and country records.  Geometry is static —
 * it is decoded once and shared by every game started in the session.
 */
(function (global) {
  'use strict';

  var SWW = global.SWW = global.SWW || {};
  var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-';

  var CODE = {};
  for (var c = 0; c < ALPHABET.length; c++) CODE[ALPHABET.charAt(c)] = c;

  /** Zigzag varint, five payload bits per character. */
  function decodeInts(str) {
    var out = [], acc = 0, shift = 1;
    for (var i = 0; i < str.length; i++) {
      var v = CODE[str.charAt(i)];
      acc += (v & 31) * shift;
      if (v & 32) { shift *= 32; continue; }
      out.push(acc % 2 ? -(acc + 1) / 2 : acc / 2);
      acc = 0; shift = 1;
    }
    return out;
  }

  var cached = null;

  function load() {
    if (cached) return cached;
    var raw = SWW.WorldMap;
    if (!raw) throw new Error('worldmap.js has not been loaded');
    var sub = raw.sub;

    // --- border runs, converted from build-grid units to map units ---------
    var runMeta = decodeInts(raw.runMeta);
    var points = decodeInts(raw.points);
    var runs = new Array(runMeta.length / 3);
    var cursor = 0;
    for (var r = 0; r < runs.length; r++) {
      var a = runMeta[r * 3], b = runMeta[r * 3 + 1], n = runMeta[r * 3 + 2];
      var pts = new Float32Array(n * 2);
      // Deltas restart at each run, so the first point of a run is absolute.
      var px = 0, py = 0;
      for (var i = 0; i < n; i++) {
        px += points[cursor++];
        py += points[cursor++];
        pts[i * 2] = px / sub;
        pts[i * 2 + 1] = py / sub;
      }
      runs[r] = { a: a, b: b, pts: pts };
    }

    // --- provinces --------------------------------------------------------
    var meta = decodeInts(raw.provinceMeta);
    var adj = decodeInts(raw.adjacency);
    var loopData = decodeInts(raw.loops);
    var provinces = new Array(raw.provinceCount);
    var adjCursor = 0, loopCursor = 0;

    var META_FIELDS = 12;
    for (var p = 0; p < raw.provinceCount; p++) {
      var m = p * META_FIELDS;
      var neighbors = new Array(adj[adjCursor++]);
      for (var k = 0; k < neighbors.length; k++) neighbors[k] = adj[adjCursor++];

      var loopCount = loopData[loopCursor++];
      var loops = new Array(loopCount);
      for (var l = 0; l < loopCount; l++) {
        var refCount = loopData[loopCursor++];
        var refs = new Int32Array(refCount);
        for (var q = 0; q < refCount; q++) refs[q] = loopData[loopCursor++];
        loops[l] = refs;
      }

      provinces[p] = {
        id: p,
        isSea: meta[m] === 1,
        nationIndex: meta[m + 1],
        cx: meta[m + 2] / sub,
        cy: meta[m + 3] / sub,
        size: meta[m + 4],
        coastal: meta[m + 5] === 1,
        bbox: [meta[m + 6] / sub, meta[m + 7] / sub, meta[m + 8] / sub, meta[m + 9] / sub],
        people: meta[m + 10],            // inhabitants in thousands
        topCity: meta[m + 11],           // largest city in thousands
        neighbors: neighbors,
        loops: loops,
        name: raw.provinceNames[p]
      };
    }

    cached = {
      mapW: raw.mapW,
      mapH: raw.mapH,
      latMax: raw.latMax,
      latMin: raw.latMin,
      landProvinceCount: raw.landProvinceCount,
      provinceCount: raw.provinceCount,
      provinces: provinces,
      runs: runs,
      nations: raw.nations
    };
    return cached;
  }

  /** Latitude of a map-unit y coordinate; used for climate and terrain. */
  function latAt(y) {
    var raw = SWW.WorldMap;
    var yTop = millerY(raw.latMax), yBot = millerY(raw.latMin);
    var m = yTop - (y / raw.mapH) * (yTop - yBot);
    return (Math.atan(Math.exp(m / 1.25)) - Math.PI / 4) / 0.4 * 180 / Math.PI;
  }

  function lonAt(x) {
    return (x / SWW.WorldMap.mapW) * 360 - 180;
  }

  function millerY(lat) {
    var p = lat * Math.PI / 180;
    return 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * p));
  }

  /** Flatten one province loop into a polyline of map-unit coordinates. */
  function loopPoints(map, refs) {
    var out = [];
    for (var r = 0; r < refs.length; r++) {
      var run = map.runs[refs[r] >> 1];
      var reversed = refs[r] & 1;
      var n = run.pts.length / 2;
      for (var i = 0; i < n; i++) {
        var j = reversed ? (n - 1 - i) : i;
        if (r > 0 && i === 0) continue;               // shared with the previous run
        out.push(run.pts[j * 2], run.pts[j * 2 + 1]);
      }
    }
    return out;
  }

  SWW.mapdata = { load: load, latAt: latAt, lonAt: lonAt, loopPoints: loopPoints, decodeInts: decodeInts };
})(typeof globalThis !== 'undefined' ? globalThis : this);
