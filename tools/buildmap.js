#!/usr/bin/env node
/*
 * Map compiler.
 *
 * Turns Natural Earth vector data into the playable map shipped in
 * src/data/worldmap.js.  Run it with:
 *
 *   npm run build:map
 *
 * Pipeline:
 *   1. download (and cache) Natural Earth admin-0 countries, lakes and cities
 *   2. project every polygon with the Miller cylindrical projection
 *   3. rasterise countries, then lakes, onto a fine build grid
 *   4. cut each country into playable provinces, and the water into sea zones
 *   5. trace the region boundaries, simplify them, and work out adjacency
 *   6. name provinces after the largest real city inside them
 *   7. colour countries so no two neighbours share a colour
 *   8. emit a compact, delta-encoded data file
 *
 * The output is committed, so playing the game never needs this script.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var CACHE = path.join(__dirname, 'geodata');
var OUT = path.join(ROOT, 'src', 'data', 'worldmap.js');

var SOURCES = {
  countries: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson',
  lakes: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_lakes.geojson',
  cities: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson'
};

// --- projection ------------------------------------------------------------
// Miller cylindrical: the familiar wall-map look, finite at the poles, far
// kinder to high latitudes than Mercator.  Antarctica is cut away entirely.

var MAP_W = 1024;
var LAT_MAX = 83;
var LAT_MIN = -60;
var SUB = 2;                       // build cells per map unit

function millerY(lat) {
  var p = lat * Math.PI / 180;
  return 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * p));
}
var Y_TOP = millerY(LAT_MAX);
var Y_BOT = millerY(LAT_MIN);
var MAP_H = Math.round(MAP_W * (Y_TOP - Y_BOT) / (2 * Math.PI));
var GW = MAP_W * SUB;
var GH = MAP_H * SUB;

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** Longitude/latitude to build-grid coordinates. */
function project(lon, lat) {
  var x = (lon + 180) / 360 * GW;
  var y = (Y_TOP - millerY(clamp(lat, LAT_MIN, LAT_MAX))) / (Y_TOP - Y_BOT) * GH;
  return [x, y];
}

// --- sources ---------------------------------------------------------------

function ensureSource(name) {
  if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });
  var file = path.join(CACHE, name + '.geojson');
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return file;
  process.stdout.write('  downloading ' + name + '… ');
  // curl rather than https.request so the sandbox proxy settings are honoured.
  cp.execSync('curl -sS -f -o ' + JSON.stringify(file) + ' ' + JSON.stringify(SOURCES[name]),
    { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log((fs.statSync(file).size / 1024).toFixed(0) + ' KB');
  return file;
}

function readGeo(name) { return JSON.parse(fs.readFileSync(ensureSource(name), 'utf8')); }

// --- rasterising -----------------------------------------------------------

/** Each GeoJSON polygon becomes a list of rings of projected points. */
function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function projectRings(rings) {
  var out = [];
  for (var r = 0; r < rings.length; r++) {
    var ring = rings[r], pts = new Array(ring.length);
    for (var i = 0; i < ring.length; i++) pts[i] = project(ring[i][0], ring[i][1]);
    out.push(pts);
  }
  return out;
}

/**
 * Even-odd scanline fill of one polygon (outer ring plus holes) into `target`.
 * Samples at pixel centres, which keeps shared borders from double-filling.
 */
function fillPolygon(target, rings, value, only) {
  var minY = Infinity, maxY = -Infinity, r, i;
  for (r = 0; r < rings.length; r++) {
    for (i = 0; i < rings[r].length; i++) {
      var y = rings[r][i][1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  var y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(GH - 1, Math.ceil(maxY));
  var xs = [];
  for (var py = y0; py <= y1; py++) {
    var sy = py + 0.5;
    xs.length = 0;
    for (r = 0; r < rings.length; r++) {
      var ring = rings[r];
      for (i = 0; i < ring.length - 1; i++) {
        var ay = ring[i][1], by = ring[i + 1][1];
        if ((ay > sy) === (by > sy)) continue;
        var ax = ring[i][0], bx = ring[i + 1][0];
        xs.push(ax + (sy - ay) / (by - ay) * (bx - ax));
      }
    }
    if (xs.length < 2) continue;
    xs.sort(function (a, b) { return a - b; });
    for (i = 0; i + 1 < xs.length; i += 2) {
      var sx = Math.max(0, Math.ceil(xs[i] - 0.5));
      var ex = Math.min(GW - 1, Math.floor(xs[i + 1] - 0.5));
      var row = py * GW;
      for (var px = sx; px <= ex; px++) {
        if (only !== undefined && target[row + px] !== only) continue;
        target[row + px] = value;
      }
    }
  }
}

// --- region growth ---------------------------------------------------------

function Rng(seed) { this.s = seed >>> 0 || 1; }
Rng.prototype.next = function () {
  this.s = (this.s + 0x6d2b79f5) >>> 0;
  var t = this.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
Rng.prototype.shuffle = function (a) {
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(this.next() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
};

/** Seeds at least `minDist` apart, chosen from `cells` in shuffled order. */
function scatter(rng, cells, target) {
  if (target <= 1 || cells.length === 0) return cells.length ? [cells[Math.floor(cells.length / 2)]] : [];
  var minDist = Math.sqrt(cells.length / target) * 0.82;
  var min2 = minDist * minDist;
  var order = rng.shuffle(cells.slice());
  var seeds = [];
  for (var i = 0; i < order.length && seeds.length < target; i++) {
    var x = order[i] % GW, y = (order[i] / GW) | 0, ok = true;
    for (var k = 0; k < seeds.length; k++) {
      var dx = (seeds[k] % GW) - x, dy = ((seeds[k] / GW) | 0) - y;
      if (dx * dx + dy * dy < min2) { ok = false; break; }
    }
    if (ok) seeds.push(order[i]);
  }
  if (!seeds.length) seeds.push(order[0]);
  return seeds;
}

/**
 * Grow regions from seeds by equal-speed BFS, restricted to cells whose
 * `domain` value matches.  Returns the number of regions created, including
 * extra ones for pockets the seeds could not reach (islands).
 */
function growRegions(seeds, domain, domainValue, region, nextId, minIslandCells) {
  var queue = seeds.slice(), head = 0, i;
  for (i = 0; i < seeds.length; i++) region[seeds[i]] = nextId + i;
  var made = seeds.length;
  while (head < queue.length) {
    var idx = queue[head++];
    var id = region[idx];
    var x = idx % GW, y = (idx / GW) | 0;
    if (x > 0) claim(idx - 1);
    if (x < GW - 1) claim(idx + 1);
    if (y > 0) claim(idx - GW);
    if (y < GH - 1) claim(idx + GW);
    function claim(n) {
      if (region[n] !== -1 || domain[n] !== domainValue) return;
      region[n] = id;
      queue.push(n);
    }
  }
  // Unreached pockets: small ones join their nearest region, big ones stand alone.
  for (var c = 0; c < region.length; c++) {
    if (domain[c] !== domainValue || region[c] !== -1) continue;
    var blob = [c], h2 = 0;
    region[c] = -2;
    while (h2 < blob.length) {
      var p = blob[h2++];
      var px = p % GW, py = (p / GW) | 0;
      var ns = [];
      if (px > 0) ns.push(p - 1);
      if (px < GW - 1) ns.push(p + 1);
      if (py > 0) ns.push(p - GW);
      if (py < GH - 1) ns.push(p + GW);
      for (var m = 0; m < ns.length; m++) {
        if (region[ns[m]] === -1 && domain[ns[m]] === domainValue) { region[ns[m]] = -2; blob.push(ns[m]); }
      }
    }
    if (blob.length >= minIslandCells || made === 0) {
      var id2 = nextId + made; made++;
      for (i = 0; i < blob.length; i++) region[blob[i]] = id2;
    } else {
      // Attach to whichever of this domain's regions has the nearest centre.
      var bx = 0, by = 0;
      for (i = 0; i < blob.length; i++) { bx += blob[i] % GW; by += (blob[i] / GW) | 0; }
      bx /= blob.length; by /= blob.length;
      var best = -1, bestD = Infinity;
      for (i = 0; i < seeds.length; i++) {
        var dx = (seeds[i] % GW) - bx, dy = ((seeds[i] / GW) | 0) - by;
        var d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = region[seeds[i]]; }
      }
      if (best < 0) { best = nextId + made; made++; }
      for (i = 0; i < blob.length; i++) region[blob[i]] = best;
    }
  }
  return made;
}

// --- boundary tracing ------------------------------------------------------

/**
 * Walk the outline of every region as closed loops of unit edges, split each
 * loop into runs sharing the same neighbour, and simplify the runs.
 *
 * Every run is stored once and referenced by both regions that touch it, so a
 * border can be drawn exactly once with the right weight for the two sides.
 */
function traceBoundaries(region, regionCount, tolerance) {
  var edgesByStart = new Map();          // "x,y" -> [edge, …]
  var edges = [];

  function addEdge(x0, y0, x1, y1, owner, other) {
    var e = { x0: x0, y0: y0, x1: x1, y1: y1, owner: owner, other: other, used: false, id: edges.length };
    edges.push(e);
    var key = x0 * 100000 + y0;
    var list = edgesByStart.get(key);
    if (!list) edgesByStart.set(key, [e]);
    else list.push(e);
  }

  for (var y = 0; y < GH; y++) {
    for (var x = 0; x < GW; x++) {
      var i = y * GW + x;
      var r = region[i];
      if (r < 0) continue;
      var up = y > 0 ? region[i - GW] : -1;
      var down = y < GH - 1 ? region[i + GW] : -1;
      var left = x > 0 ? region[i - 1] : -1;
      var right = x < GW - 1 ? region[i + 1] : -1;
      // Clockwise winding in screen space keeps every loop consistently ordered.
      if (up !== r) addEdge(x, y, x + 1, y, r, up);
      if (right !== r) addEdge(x + 1, y, x + 1, y + 1, r, right);
      if (down !== r) addEdge(x + 1, y + 1, x, y + 1, r, down);
      if (left !== r) addEdge(x, y + 1, x, y, r, left);
    }
  }

  var loopsOf = new Array(regionCount);
  for (var q = 0; q < regionCount; q++) loopsOf[q] = [];

  for (var e = 0; e < edges.length; e++) {
    var start = edges[e];
    if (start.used) continue;
    var loop = [];
    var cur = start;
    while (cur && !cur.used) {
      cur.used = true;
      loop.push(cur);
      var list = edgesByStart.get(cur.x1 * 100000 + cur.y1);
      var next = null;
      if (list) {
        for (var k = 0; k < list.length; k++) {
          var cand = list[k];
          if (cand.used || cand.owner !== cur.owner) continue;
          // At a four-way vertex prefer continuing along the same neighbour,
          // which keeps runs whole instead of splintering them.
          if (!next || cand.other === cur.other) next = cand;
        }
      }
      cur = next;
    }
    if (loop.length >= 3) loopsOf[start.owner].push(loop);
  }

  // Split loops into same-neighbour runs and simplify.
  var runs = [];
  var runKey = new Map();               // dedupe key -> run index
  var provinceLoops = new Array(regionCount);
  for (var p = 0; p < regionCount; p++) provinceLoops[p] = [];

  for (var rp = 0; rp < regionCount; rp++) {
    for (var li = 0; li < loopsOf[rp].length; li++) {
      var lp = loopsOf[rp][li];
      // Rotate so the loop starts at a change of neighbour.
      var startAt = 0;
      for (var s = 0; s < lp.length; s++) {
        var prev = lp[(s - 1 + lp.length) % lp.length];
        if (prev.other !== lp[s].other) { startAt = s; break; }
      }
      var refs = [];
      var cursor = 0;
      while (cursor < lp.length) {
        var idx0 = (startAt + cursor) % lp.length;
        var other = lp[idx0].other;
        var pts = [[lp[idx0].x0, lp[idx0].y0]];
        var len = 0;
        while (cursor + len < lp.length) {
          var idx = (startAt + cursor + len) % lp.length;
          if (lp[idx].other !== other) break;
          pts.push([lp[idx].x1, lp[idx].y1]);
          len++;
        }
        cursor += len;
        var simple = simplify(pts, tolerance);
        var head = simple[0], tail = simple[simple.length - 1];
        // Two provinces can share several separate borders (enclaves, island
        // chains), so the key carries the endpoints and length as well as the
        // pair, and the match is verified geometrically before being reused.
        var ends = [head[0] + ',' + head[1], tail[0] + ',' + tail[1]].sort();
        var key = (other < 0 ? 'edge:' + rp : Math.min(rp, other) + ':' + Math.max(rp, other)) +
          '|' + ends.join('|') + '|' + simple.length;
        var existing = runKey.get(key);
        if (existing !== undefined && runs[existing].a !== rp && sameBorder(runs[existing].pts, simple)) {
          // The same border seen from the other side: reference it reversed.
          refs.push((existing << 1) | 1);
        } else {
          var ri = runs.length;
          runs.push({ a: rp, b: other, pts: simple });
          if (existing === undefined) runKey.set(key, ri);
          refs.push(ri << 1);
        }
      }
      provinceLoops[rp].push(refs);
    }
  }
  return { runs: runs, loops: provinceLoops };
}

/** True when `b` is `a` walked backwards — i.e. the same border, other side. */
function sameBorder(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0, j = b.length - 1; i < a.length; i++, j--) {
    if (a[i][0] !== b[j][0] || a[i][1] !== b[j][1]) return false;
  }
  return true;
}

/** Douglas-Peucker, iterative so deep polylines cannot blow the stack. */
function simplify(pts, tol) {
  if (pts.length <= 2) return pts;
  var keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  var stack = [[0, pts.length - 1]];
  var tol2 = tol * tol;
  while (stack.length) {
    var seg = stack.pop();
    var first = seg[0], last = seg[1];
    if (last <= first + 1) continue;
    var ax = pts[first][0], ay = pts[first][1];
    var bx = pts[last][0], by = pts[last][1];
    var dx = bx - ax, dy = by - ay;
    var norm = dx * dx + dy * dy;
    var bestI = -1, bestD = -1;
    for (var i = first + 1; i < last; i++) {
      var px = pts[i][0] - ax, py = pts[i][1] - ay;
      var d;
      if (norm === 0) d = px * px + py * py;
      else {
        var t = clamp((px * dx + py * dy) / norm, 0, 1);
        var ex = px - t * dx, ey = py - t * dy;
        d = ex * ex + ey * ey;
      }
      if (d > bestD) { bestD = d; bestI = i; }
    }
    if (bestD > tol2 && bestI > 0) {
      keep[bestI] = 1;
      stack.push([first, bestI], [bestI, last]);
    }
  }
  var out = [];
  for (var k = 0; k < pts.length; k++) if (keep[k]) out.push(pts[k]);
  return out;
}

// --- compact encoding ------------------------------------------------------

var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-';

/** Zigzag varint in base 64, five payload bits per character. */
function encodeInts(values) {
  var out = '';
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    var z = v < 0 ? (-v * 2 - 1) : v * 2;
    do {
      var chunk = z & 31;
      z = Math.floor(z / 32);
      out += ALPHABET[z > 0 ? chunk | 32 : chunk];
    } while (z > 0);
  }
  return out;
}

function decodeInts(str) {
  var out = [], acc = 0, shift = 1, i;
  for (i = 0; i < str.length; i++) {
    var c = ALPHABET.indexOf(str[i]);
    acc += (c & 31) * shift;
    if (c & 32) { shift *= 32; continue; }
    out.push(acc % 2 ? -(acc + 1) / 2 : acc / 2);
    acc = 0; shift = 1;
  }
  return out;
}

// --- naming and colour -----------------------------------------------------

var NAME_2026 = {
  Turkey: 'Türkiye', 'Czech Rep.': 'Czechia', 'Czech Republic': 'Czechia',
  Swaziland: 'Eswatini', Macedonia: 'North Macedonia', 'North Macedonia': 'North Macedonia',
  'Cape Verde': 'Cabo Verde', 'Ivory Coast': "Côte d'Ivoire", Burma: 'Myanmar',
  'East Timor': 'Timor-Leste', 'Dem. Rep. Congo': 'DR Congo', 'Congo': 'Republic of the Congo',
  'Central African Rep.': 'Central African Republic', 'Dominican Rep.': 'Dominican Republic',
  'Eq. Guinea': 'Equatorial Guinea', 'S. Sudan': 'South Sudan', 'Bosnia and Herz.': 'Bosnia and Herzegovina',
  'Solomon Is.': 'Solomon Islands', 'Falkland Is.': 'Falkland Islands', 'Fr. S. Antarctic Lands': null,
  'United States of America': 'United States', 'W. Sahara': 'Western Sahara',
  'Antigua and Barb.': 'Antigua and Barbuda', 'St. Vin. and Gren.': 'Saint Vincent and the Grenadines',
  'Marshall Is.': 'Marshall Islands', 'St. Kitts and Nevis': 'Saint Kitts and Nevis',
  'Sao Tome and Principe': 'São Tomé and Príncipe', 'Br. Indian Ocean Ter.': null,
  'N. Cyprus': 'Northern Cyprus', 'Somaliland': 'Somaliland', 'Fr. Polynesia': 'French Polynesia',
  'S. Geo. and the Is.': null, 'Heard I. and McDonald Is.': null, 'Fr. S. and Antarctic Lands': null
};

/* Twenty-four map colours chosen to stay distinct on a dark background. */
var PALETTE = [
  '#c0453f', '#3f7fd6', '#4fae7a', '#d4913c', '#8f5fd0', '#4fb8c0',
  '#c9584f', '#5f8fe0', '#6fbf5f', '#dfae4f', '#bf5f9f', '#3f9f8f',
  '#d0685f', '#7f9fd6', '#8fc04f', '#c9a24a', '#a06fc0', '#5fa8bf',
  '#b04f6f', '#4f6fbf', '#5fc08a', '#e0c04a', '#9f6f8f', '#6fa08f'
];

function hueOf(hex) {
  var n = parseInt(hex.slice(1), 16);
  var r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  var h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function hueGap(a, b) {
  var d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Colour the country graph so no two neighbours look alike.  Plain greedy
 * colouring satisfies "not equal" but happily puts two similar greens side by
 * side, so each choice maximises the hue distance to already-coloured
 * neighbours instead.
 */
function colourCountries(countries, adjacency) {
  var hues = PALETTE.map(hueOf);
  // Colour the most constrained countries first.
  var order = countries.map(function (c, i) { return i; }).sort(function (a, b) {
    return (adjacency[b] ? adjacency[b].size : 0) - (adjacency[a] ? adjacency[a].size : 0);
  });
  var assigned = new Array(countries.length).fill(-1);
  for (var oi = 0; oi < order.length; oi++) {
    var ci = order[oi];
    var neighbourHues = [];
    if (adjacency[ci]) {
      adjacency[ci].forEach(function (nb) {
        if (assigned[nb] >= 0) neighbourHues.push(hues[assigned[nb]]);
      });
    }
    var best = 0, bestScore = -1;
    for (var t = 0; t < PALETTE.length; t++) {
      // Rotate the starting point per country so equal scores spread out.
      var cand = (ci * 7 + t) % PALETTE.length;
      var worst = 360;
      for (var k = 0; k < neighbourHues.length; k++) {
        worst = Math.min(worst, hueGap(hues[cand], neighbourHues[k]));
      }
      if (worst > bestScore) { bestScore = worst; best = cand; }
      if (bestScore >= 60) break;         // good enough, stop looking
    }
    assigned[ci] = best;
  }
  return assigned.map(function (i) { return PALETTE[i]; });
}

// --- main ------------------------------------------------------------------

function main() {
  console.log('Map compiler — Miller projection, ' + MAP_W + '×' + MAP_H +
    ' map units, ' + GW + '×' + GH + ' build grid');

  var countriesGeo = readGeo('countries');
  var lakesGeo = readGeo('lakes');
  var citiesGeo = readGeo('cities');

  // 1. Decide which features belong to which nation.
  var nations = [];         // {iso, name, features:[], capitalCity}
  var nationByIso = {};
  var features = [];        // {rings, nationIndex or -1}

  /*
   * Natural Earth groups territories under a sovereignty code (FR1, US1, DN1),
   * which is not an ISO country code.  For each group the "home" feature — the
   * one whose ADMIN matches its SOVEREIGNT — supplies the real ISO code and the
   * country's name; its dependencies fold in behind it.
   */
  var groups = {};
  countriesGeo.features.forEach(function (f) {
    var p = f.properties;
    if (p.ADM0_A3 === 'ATA' || p.ISO_A3 === 'ATA') return;               // Antarctica
    if (p.TYPE === 'Disputed' || p.TYPE === 'Indeterminate') return;
    if (NAME_2026[p.ADMIN] === null || NAME_2026[p.SOVEREIGNT] === null) return;
    var key = p.SOV_A3 || p.ADM0_A3;
    (groups[key] || (groups[key] = [])).push(f);
  });
  Object.keys(groups).forEach(function (key) {
    var list = groups[key];
    var home = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].properties.ADMIN === list[i].properties.SOVEREIGNT) { home = list[i]; break; }
    }
    if (!home) home = list[0];
    var hp = home.properties;
    var iso = hp.ISO_A3_EH && hp.ISO_A3_EH !== '-99' ? hp.ISO_A3_EH
      : (hp.ISO_A3 && hp.ISO_A3 !== '-99' ? hp.ISO_A3 : hp.ADM0_A3);
    var name = NAME_2026[hp.ADMIN] || hp.ADMIN;
    nationByIso[key] = nations.length;
    nations.push({ iso: iso, name: name, area: 0, cells: [], capitalCity: null, pop: 0 });
  });

  countriesGeo.features.forEach(function (f) {
    var p = f.properties;
    if (p.ADM0_A3 === 'ATA' || p.ISO_A3 === 'ATA') return;
    if (NAME_2026[p.ADMIN] === null || NAME_2026[p.SOVEREIGNT] === null) return;
    var disputed = p.TYPE === 'Disputed' || p.TYPE === 'Indeterminate';
    var nationIndex = -1;
    if (!disputed) {
      nationIndex = nationByIso[p.SOV_A3 || p.ADM0_A3];
      if (nationIndex === undefined) return;
      nations[nationIndex].pop += (p.POP_EST || 0);
    }
    polygonsOf(f.geometry).forEach(function (poly) {
      features.push({ rings: projectRings(poly), nation: nationIndex });
    });
  });
  console.log('  ' + nations.length + ' nations from ' + features.length + ' polygons');

  // 2. Rasterise: water = -1, disputed land = -2, otherwise the nation index.
  var owner = new Int16Array(GW * GH).fill(-1);
  features.forEach(function (f) {
    fillPolygon(owner, f.rings, f.nation < 0 ? -2 : f.nation);
  });

  // Lakes are cut back out of the land so the map reads correctly.
  var lakeCells = 0;
  lakesGeo.features.forEach(function (f) {
    polygonsOf(f.geometry).forEach(function (poly) {
      fillPolygon(owner, projectRings(poly), -1);
    });
  });

  var landCells = 0;
  for (var i = 0; i < owner.length; i++) {
    if (owner[i] >= 0) { nations[owner[i]].area++; landCells++; }
    else if (owner[i] === -2) landCells++;
  }
  console.log('  raster: ' + landCells + ' land cells (' +
    (landCells / owner.length * 100).toFixed(1) + '% of the map)');

  // 3. Allocate provinces per country by area, then grow them.
  var TARGET_PROVINCES = 700;
  var totalArea = nations.reduce(function (a, n) { return a + n.area; }, 0);
  var perProvince = totalArea / TARGET_PROVINCES;
  var rng = new Rng(20260101);

  for (i = 0; i < owner.length; i++) { /* index cells per nation */ }
  var cellsOf = nations.map(function () { return []; });
  var disputedCells = [];
  for (i = 0; i < owner.length; i++) {
    if (owner[i] >= 0) cellsOf[owner[i]].push(i);
    else if (owner[i] === -2) disputedCells.push(i);
  }

  var region = new Int32Array(GW * GH).fill(-1);
  var provinces = [];       // {nation, cells}
  var nextId = 0;

  nations.forEach(function (nation, ni) {
    var cells = cellsOf[ni];
    if (!cells.length) { nation.dead = true; return; }
    var want = clamp(Math.round(cells.length / perProvince), 1, 46);
    var seeds = scatter(rng, cells, want);
    var domain = owner;
    var made = growRegions(seeds, domain, ni, region, nextId, Math.max(6, perProvince * 0.12));
    for (var k = 0; k < made; k++) provinces.push({ nation: ni, cells: [], sea: false });
    nextId += made;
  });

  // Disputed ground belongs to nobody and is fought over.
  if (disputedCells.length) {
    var dWant = clamp(Math.round(disputedCells.length / perProvince), 1, 12);
    var dSeeds = scatter(rng, disputedCells, dWant);
    var dMade = growRegions(dSeeds, owner, -2, region, nextId, Math.max(6, perProvince * 0.12));
    for (var d = 0; d < dMade; d++) provinces.push({ nation: -1, cells: [], sea: false });
    nextId += dMade;
  }
  var landProvinceCount = provinces.length;

  // 4. Sea zones over the remaining water.
  var waterCells = [];
  for (i = 0; i < owner.length; i++) if (owner[i] === -1) waterCells.push(i);
  var seaSeeds = scatter(rng, waterCells, 150);
  var seaMade = growRegions(seaSeeds, owner, -1, region, nextId, 40);
  for (var sm = 0; sm < seaMade; sm++) provinces.push({ nation: -1, cells: [], sea: true });
  nextId += seaMade;

  console.log('  ' + landProvinceCount + ' land provinces, ' + seaMade + ' sea zones');

  // 5. Province geometry, adjacency and coastline flags.
  var neighbourSets = provinces.map(function () { return new Set(); });
  var sumX = new Float64Array(provinces.length);
  var sumY = new Float64Array(provinces.length);
  var counts = new Int32Array(provinces.length);
  var coast = new Uint8Array(provinces.length);
  var minX = new Int32Array(provinces.length).fill(1e9);
  var minY = new Int32Array(provinces.length).fill(1e9);
  var maxX = new Int32Array(provinces.length).fill(-1e9);
  var maxY = new Int32Array(provinces.length).fill(-1e9);

  for (var yy = 0; yy < GH; yy++) {
    for (var xx = 0; xx < GW; xx++) {
      var idx = yy * GW + xx;
      var rid = region[idx];
      if (rid < 0) continue;
      sumX[rid] += xx; sumY[rid] += yy; counts[rid]++;
      if (xx < minX[rid]) minX[rid] = xx;
      if (yy < minY[rid]) minY[rid] = yy;
      if (xx > maxX[rid]) maxX[rid] = xx;
      if (yy > maxY[rid]) maxY[rid] = yy;
      var ns = [];
      if (xx > 0) ns.push(idx - 1);
      if (xx < GW - 1) ns.push(idx + 1);
      if (yy > 0) ns.push(idx - GW);
      if (yy < GH - 1) ns.push(idx + GW);
      for (var n = 0; n < ns.length; n++) {
        var other = region[ns[n]];
        if (other < 0 || other === rid) continue;
        neighbourSets[rid].add(other);
        if (!provinces[rid].sea && provinces[other].sea) coast[rid] = 1;
      }
    }
  }

  // 6. Names from the largest real city inside each province.
  var cityOf = new Array(provinces.length).fill(null);
  var capitalCityOf = new Array(provinces.length).fill(null);
  var placed = [];                       // every city, for the nearest-match fallback
  var provPop = new Float64Array(provinces.length);     // summed city population
  var topCity = new Float64Array(provinces.length);     // largest city population
  citiesGeo.features.forEach(function (f) {
    var p = f.properties;
    var lat = p.latitude, lon = p.longitude;
    if (lat > LAT_MAX || lat < LAT_MIN) return;
    var xy = project(lon, lat);
    var cx = Math.floor(xy[0]), cy = Math.floor(xy[1]);
    if (cx < 0 || cy < 0 || cx >= GW || cy >= GH) return;
    var rid = region[cy * GW + cx];
    if (rid < 0 || provinces[rid].sea) return;
    var pop = p.pop_max || p.pop_min || 0;
    var name = p.name || p.nameascii;
    if (!name) return;
    provPop[rid] += pop;
    if (pop > topCity[rid]) topCity[rid] = pop;
    if (!cityOf[rid] || pop > cityOf[rid].pop) cityOf[rid] = { name: name, pop: pop };
    if (p.adm0cap === 1 && !capitalCityOf[rid]) capitalCityOf[rid] = { name: name, iso: p.adm0_a3, pop: pop };
    placed.push({ x: xy[0], y: xy[1], name: name, adm1: p.adm1name, nation: provinces[rid].nation });
  });

  // Each nation's capital is the province holding its capital city, else its
  // largest province.
  nations.forEach(function (nation, ni) {
    var best = -1, bestScore = -1;
    for (var pi = 0; pi < landProvinceCount; pi++) {
      if (provinces[pi].nation !== ni) continue;
      var score = counts[pi];
      var cap = capitalCityOf[pi];
      if (cap) score += 1e6;
      if (score > bestScore) { bestScore = score; best = pi; }
    }
    nation.capital = best;
    if (best >= 0 && capitalCityOf[best]) cityOf[best] = capitalCityOf[best];
  });

  var namesUsed = Object.create(null);
  var unnamed = 0;
  provinces.forEach(function (prov, pi) {
    if (prov.sea) { prov.name = ''; return; }
    var base = cityOf[pi] ? cityOf[pi].name : null;
    if (!base) {
      // No city inside: borrow the administrative region of the nearest city
      // in the same country, which is still a real place name.
      var cx = sumX[pi] / Math.max(1, counts[pi]), cy = sumY[pi] / Math.max(1, counts[pi]);
      var near = null, nearD = Infinity;
      for (var ci = 0; ci < placed.length; ci++) {
        if (placed[ci].nation !== prov.nation) continue;
        var dx = placed[ci].x - cx, dy = placed[ci].y - cy;
        var dd = dx * dx + dy * dy;
        if (dd < nearD) { nearD = dd; near = placed[ci]; }
      }
      base = near && near.adm1 ? near.adm1
        : near ? near.name + ' Territory'
          : (prov.nation >= 0 ? nations[prov.nation].name : 'Disputed') + ' Marches';
      unnamed++;
    }
    var name = base, n = 2;
    while (namesUsed[name]) { name = base + ' ' + roman(n); n++; }
    namesUsed[name] = true;
    prov.name = name;
  });
  console.log('  ' + (landProvinceCount - unnamed) + '/' + landProvinceCount +
    ' provinces named after a real city');

  nameSeaZones(provinces, landProvinceCount, sumX, sumY, counts);

  // 7. Country colours from the country adjacency graph.
  var countryAdj = nations.map(function () { return new Set(); });
  for (var pa = 0; pa < landProvinceCount; pa++) {
    if (provinces[pa].nation < 0) continue;
    neighbourSets[pa].forEach(function (nb) {
      if (nb >= landProvinceCount || provinces[nb].nation < 0) return;
      if (provinces[nb].nation === provinces[pa].nation) return;
      countryAdj[provinces[pa].nation].add(provinces[nb].nation);
    });
  }
  var colours = colourCountries(nations, countryAdj);

  // 8. Trace, simplify, encode.
  verifyCapitals(nations, provinces, region, landProvinceCount);

  console.log('  tracing boundaries…');
  var traced = traceBoundaries(region, provinces.length, 0.9);
  var pointCount = traced.runs.reduce(function (a, r) { return a + r.pts.length; }, 0);
  console.log('  ' + traced.runs.length + ' border runs, ' + pointCount + ' points');
  validateLoops(traced, provinces.length);

  var totalPop = 0;
  for (var tp = 0; tp < landProvinceCount; tp++) totalPop += provPop[tp];
  console.log('  ' + (totalPop / 1e9).toFixed(2) + 'bn people placed across the land provinces');

  emit({
    nations: nations, colours: colours, provinces: provinces, traced: traced,
    landProvinceCount: landProvinceCount, counts: counts, coast: coast,
    sumX: sumX, sumY: sumY, neighbourSets: neighbourSets,
    minX: minX, minY: minY, maxX: maxX, maxY: maxY,
    provPop: provPop, topCity: topCity
  });
}

/*
 * A spot check that the raster, the province split and the nation table all
 * agree: these cities must land inside a province owned by this country.
 */
var CAPITAL_CHECKS = [
  ['France', 2.35, 48.86], ['Germany', 13.40, 52.52], ['Japan', 139.69, 35.69],
  ['Brazil', -47.93, -15.78], ['Egypt', 31.24, 30.04], ['India', 77.21, 28.61],
  ['China', 116.40, 39.90], ['United States', -77.04, 38.91], ['Australia', 149.13, -35.28],
  ['Russia', 37.62, 55.75], ['Nigeria', 7.49, 9.06], ['Mexico', -99.13, 19.43],
  ['Kazakhstan', 71.43, 51.16], ['Chile', -70.65, -33.44], ['Norway', 10.75, 59.91]
];

function verifyCapitals(nations, provinces, region, landCount) {
  var bad = [];
  CAPITAL_CHECKS.forEach(function (row) {
    var xy = project(row[1], row[2]);
    var rid = region[Math.floor(xy[1]) * GW + Math.floor(xy[0])];
    if (rid < 0 || rid >= landCount) { bad.push(row[0] + ': not on land'); return; }
    var ni = provinces[rid].nation;
    var got = ni >= 0 ? nations[ni].name : 'neutral';
    if (got !== row[0]) bad.push(row[0] + ': province ' + rid + ' belongs to ' + got);
  });
  if (bad.length) throw new Error('capital placement check failed —\n    ' + bad.join('\n    '));
  console.log('  ' + CAPITAL_CHECKS.length + ' capital cities verified in the right country');
}

/**
 * Every province outline must be a closed chain: each run has to start exactly
 * where the previous one ended.  A break here would show up as a hole in the
 * map, so it fails the build rather than shipping.
 */
function validateLoops(traced, regionCount) {
  var checked = 0;
  for (var p = 0; p < regionCount; p++) {
    var loops = traced.loops[p] || [];
    for (var li = 0; li < loops.length; li++) {
      var refs = loops[li];
      var pts = [];
      for (var r = 0; r < refs.length; r++) {
        var run = traced.runs[refs[r] >> 1];
        var seq = (refs[r] & 1) ? run.pts.slice().reverse() : run.pts;
        if (pts.length) {
          var last = pts[pts.length - 1];
          if (last[0] !== seq[0][0] || last[1] !== seq[0][1]) {
            throw new Error('province ' + p + ' loop ' + li + ' breaks at run ' + r +
              ': ' + last + ' -> ' + seq[0]);
          }
          for (var k = 1; k < seq.length; k++) pts.push(seq[k]);
        } else {
          for (var m = 0; m < seq.length; m++) pts.push(seq[m]);
        }
      }
      var first = pts[0], end = pts[pts.length - 1];
      if (first[0] !== end[0] || first[1] !== end[1]) {
        throw new Error('province ' + p + ' loop ' + li + ' does not close');
      }
      checked++;
    }
  }
  console.log('  ' + checked + ' outlines validated as closed');
}

function roman(n) {
  var map = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV'];
  return map[n] || String(n);
}

var SEA_NAMES = [
  'Northern Reach', 'Western Approaches', 'Eastern Approaches', 'Southern Reach',
  'Cobalt Deep', 'Iron Straits', 'Coral Shelf', 'Storm Basin', 'Amber Waters',
  'Grey Passage', 'Broken Sound', 'Pale Gulf', 'Azure Deep', 'Black Shelf'
];

function nameSeaZones(provinces, landCount, sumX, sumY, counts) {
  var seaIndex = 0;
  for (var i = landCount; i < provinces.length; i++) {
    provinces[i].name = SEA_NAMES[seaIndex % SEA_NAMES.length] +
      (seaIndex >= SEA_NAMES.length ? ' ' + roman(Math.floor(seaIndex / SEA_NAMES.length) + 1) : '');
    seaIndex++;
  }
}

function emit(d) {
  var provinces = d.provinces;
  var out = [];

  // Points: delta-encoded per run, in build-grid units.
  var pointStream = [];
  var runMeta = [];
  d.traced.runs.forEach(function (run) {
    runMeta.push(run.a, run.b, run.pts.length);
    var px = 0, py = 0;
    for (var i = 0; i < run.pts.length; i++) {
      pointStream.push(run.pts[i][0] - px, run.pts[i][1] - py);
      px = run.pts[i][0]; py = run.pts[i][1];
    }
  });

  var loopStream = [];
  provinces.forEach(function (prov, pi) {
    var loops = d.traced.loops[pi] || [];
    loopStream.push(loops.length);
    loops.forEach(function (refs) {
      loopStream.push(refs.length);
      for (var i = 0; i < refs.length; i++) loopStream.push(refs[i]);
    });
  });

  var provMeta = [];
  provinces.forEach(function (prov, pi) {
    provMeta.push(
      prov.sea ? 1 : 0,
      prov.nation,
      Math.round(d.sumX[pi] / Math.max(1, d.counts[pi])),
      Math.round(d.sumY[pi] / Math.max(1, d.counts[pi])),
      d.counts[pi],
      d.coast[pi],
      d.minX[pi], d.minY[pi], d.maxX[pi], d.maxY[pi],
      Math.round(d.provPop[pi] / 1000),        // inhabitants, in thousands
      Math.round(d.topCity[pi] / 1000)         // largest city, in thousands
    );
  });

  var adjStream = [];
  provinces.forEach(function (prov, pi) {
    var list = Array.from(d.neighbourSets[pi]).sort(function (a, b) { return a - b; });
    adjStream.push(list.length);
    for (var i = 0; i < list.length; i++) adjStream.push(list[i]);
  });

  /*
   * Emitted in full, including any nation that ended up with no land: every
   * province stores the index of its nation in THIS array, so filtering here
   * would silently reassign provinces to the wrong countries.  Landless
   * entries carry capital -1 and are skipped at load.
   */
  var nationRows = d.nations.map(function (n, i) {
    return {
      iso: n.iso, name: n.name, colour: d.colours[i],
      capital: n.capital === undefined ? -1 : n.capital, pop: Math.round(n.pop)
    };
  });
  var landless = nationRows.filter(function (n) { return n.capital < 0; }).length;
  var body =
    '/*\n' +
    ' * Generated by tools/buildmap.js — do not edit by hand.\n' +
    ' *\n' +
    ' * Real country borders from Natural Earth (admin-0 countries and lakes,\n' +
    ' * 1:50m), projected with the Miller cylindrical projection and cut into\n' +
    ' * playable provinces.  Province names come from Natural Earth populated\n' +
    ' * places.  Coordinates are in build-grid units; divide by SUB for map units.\n' +
    ' */\n' +
    '(function (global) {\n' +
    "  'use strict';\n" +
    '  global.SWW = global.SWW || {};\n' +
    '  global.SWW.WorldMap = {\n' +
    '    mapW: ' + MAP_W + ', mapH: ' + MAP_H + ', sub: ' + SUB + ',\n' +
    '    latMax: ' + LAT_MAX + ', latMin: ' + LAT_MIN + ',\n' +
    '    landProvinceCount: ' + d.landProvinceCount + ',\n' +
    '    provinceCount: ' + provinces.length + ',\n' +
    '    nations: ' + JSON.stringify(nationRows) + ',\n' +
    '    provinceNames: ' + JSON.stringify(provinces.map(function (p) { return p.name; })) + ',\n' +
    '    provinceMeta: \'' + encodeInts(provMeta) + '\',\n' +
    '    adjacency: \'' + encodeInts(adjStream) + '\',\n' +
    '    runMeta: \'' + encodeInts(runMeta) + '\',\n' +
    '    points: \'' + encodeInts(pointStream) + '\',\n' +
    '    loops: \'' + encodeInts(loopStream) + '\'\n' +
    '  };\n' +
    "})(typeof globalThis !== 'undefined' ? globalThis : this);\n";

  fs.writeFileSync(OUT, body);
  console.log('  wrote ' + path.relative(ROOT, OUT) + ' (' + (body.length / 1024).toFixed(0) + ' KB, ' +
    (nationRows.length - landless) + ' playable nations, ' + landless + ' landless)');

  // Round-trip check: the encoder is the only thing standing between the build
  // and the game, so verify it here rather than discovering it in the browser.
  var back = decodeInts(encodeInts(pointStream));
  if (back.length !== pointStream.length) throw new Error('point stream length mismatch');
  for (var i = 0; i < back.length; i++) {
    if (back[i] !== pointStream[i]) throw new Error('point stream mismatch at ' + i);
  }
  console.log('  encoder round-trip verified over ' + pointStream.length + ' values');
}

main();
