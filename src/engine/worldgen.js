/*
 * World generation.
 *
 * 1. Upsample the coarse land mask into a playable grid with smoothed,
 *    slightly ragged coastlines.
 * 2. Scatter province seeds and grow them with a multi-source BFS, so every
 *    province is a contiguous blob that never spans two landmasses.
 * 3. Do the same for the ocean, producing sea zones that use the same graph.
 * 4. Grow nations outward from the province nearest each real capital.
 */
(function (global) {
  'use strict';

  var SWW = global.SWW = global.SWW || {};
  var LandMask = SWW.LandMask;
  var NationData = SWW.NationData;
  var clamp = SWW.util.clamp;

  var GW = 256;   // grid columns (360 degrees of longitude)
  var GH = 128;   // grid rows (180 degrees of latitude)

  var TERRAIN = {
    plains: { name: 'Plains', def: 1.00, speed: 1.00, color: '#5d7a4a' },
    forest: { name: 'Forest', def: 1.15, speed: 0.85, color: '#3f6138' },
    jungle: { name: 'Jungle', def: 1.20, speed: 0.65, color: '#2f6b3c' },
    desert: { name: 'Desert', def: 0.95, speed: 0.95, color: '#a89258' },
    tundra: { name: 'Tundra', def: 1.05, speed: 0.75, color: '#6f8577' },
    mountain: { name: 'Mountains', def: 1.40, speed: 0.55, color: '#7a7568' }
  };

  function cellLat(y) { return 90 - (y + 0.5) * (180 / GH); }
  function cellLon(x) { return -180 + (x + 0.5) * (360 / GW); }
  function lonToX(lon) { return clamp(Math.floor((lon + 180) / 360 * GW), 0, GW - 1); }
  function latToY(lat) { return clamp(Math.floor((90 - lat) / 180 * GH), 0, GH - 1); }

  /** Smooth value noise on the grid, used to rough up coastlines and biomes. */
  function valueNoise(rng, w, h, scale) {
    var cw = Math.ceil(w / scale) + 2, ch = Math.ceil(h / scale) + 2;
    var g = new Float32Array(cw * ch);
    for (var i = 0; i < g.length; i++) g[i] = rng.next();
    var out = new Float32Array(w * h);
    for (var y = 0; y < h; y++) {
      var gy = y / scale, y0 = Math.floor(gy), ty = gy - y0;
      ty = ty * ty * (3 - 2 * ty);
      for (var x = 0; x < w; x++) {
        var gx = x / scale, x0 = Math.floor(gx), tx = gx - x0;
        tx = tx * tx * (3 - 2 * tx);
        var a = g[y0 * cw + x0], b = g[y0 * cw + x0 + 1];
        var c = g[(y0 + 1) * cw + x0], d = g[(y0 + 1) * cw + x0 + 1];
        out[y * w + x] = (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
      }
    }
    return out;
  }

  /** Bilinear upsample of the coarse mask, then threshold with noise. */
  function buildLandMask(rng) {
    var src = LandMask.baseField();
    var sw = LandMask.COLS, sh = LandMask.ROWS;
    var coverage = new Float32Array(GW * GH);
    for (var y = 0; y < GH; y++) {
      var fy = (y + 0.5) / GH * sh - 0.5;
      var y0 = clamp(Math.floor(fy), 0, sh - 1), y1 = clamp(y0 + 1, 0, sh - 1);
      var ty = clamp(fy - y0, 0, 1);
      for (var x = 0; x < GW; x++) {
        var fx = (x + 0.5) / GW * sw - 0.5;
        var x0 = clamp(Math.floor(fx), 0, sw - 1), x1 = clamp(x0 + 1, 0, sw - 1);
        var tx = clamp(fx - x0, 0, 1);
        var a = src[y0 * sw + x0], b = src[y0 * sw + x1];
        var c = src[y1 * sw + x0], d = src[y1 * sw + x1];
        var top = a + (b - a) * tx, bot = c + (d - c) * tx;
        coverage[y * GW + x] = top + (bot - top) * ty;
      }
    }
    var noise = valueNoise(rng, GW, GH, 7);
    var land = new Uint8Array(GW * GH);
    for (var i = 0; i < land.length; i++) {
      // Threshold near 0.5 so the coast wanders instead of following the
      // coarse grid; noise contributes only in the transition band.
      var v = coverage[i] + (noise[i] - 0.5) * 0.34;
      land[i] = v > 0.5 ? 1 : 0;
    }
    // Remove single-cell specks and fill single-cell holes.
    var cleaned = new Uint8Array(land);
    for (var yy = 1; yy < GH - 1; yy++) {
      for (var xx = 1; xx < GW - 1; xx++) {
        var idx = yy * GW + xx, n = 0;
        n += land[idx - 1] + land[idx + 1] + land[idx - GW] + land[idx + GW];
        if (land[idx] === 1 && n === 0) cleaned[idx] = 0;
        if (land[idx] === 0 && n === 4) cleaned[idx] = 1;
      }
    }
    return cleaned;
  }

  /** Greedy dart-throwing: seeds at least `minDist` apart, in shuffled order. */
  function scatterSeeds(rng, cells, target) {
    if (cells.length === 0) return [];
    // Dart throwing packs at roughly 70% efficiency, so aim tighter than the
    // ideal spacing to land near the requested province count.
    var minDist = Math.sqrt(cells.length / target) * 0.86;
    var minDist2 = minDist * minDist;
    var order = rng.shuffle(cells.slice());
    var seeds = [];
    // Bucket accepted seeds so the distance test stays local.
    var bs = Math.max(1, Math.floor(minDist));
    var bw = Math.ceil(GW / bs), bh = Math.ceil(GH / bs);
    var buckets = new Array(bw * bh);
    for (var i = 0; i < order.length && seeds.length < target; i++) {
      var idx = order[i];
      var x = idx % GW, y = (idx / GW) | 0;
      var bx = (x / bs) | 0, by = (y / bs) | 0, ok = true;
      for (var dy = -1; dy <= 1 && ok; dy++) {
        for (var dx = -1; dx <= 1 && ok; dx++) {
          var nx = bx + dx, ny = by + dy;
          if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
          var list = buckets[ny * bw + nx];
          if (!list) continue;
          for (var k = 0; k < list.length; k++) {
            var ox = list[k] % GW, oy = (list[k] / GW) | 0;
            var ddx = ox - x, ddy = oy - y;
            if (ddx * ddx + ddy * ddy < minDist2) { ok = false; break; }
          }
        }
      }
      if (!ok) continue;
      seeds.push(idx);
      var b = by * bw + bx;
      if (!buckets[b]) buckets[b] = [];
      buckets[b].push(idx);
    }
    return seeds;
  }

  /**
   * Grow regions from seeds using breadth-first expansion restricted to cells
   * of the same kind.  Equal-speed growth from all seeds gives compact,
   * contiguous regions.
   */
  function growRegions(seeds, passable, owner, startId) {
    var head = 0;
    var queue = seeds.slice();
    for (var i = 0; i < seeds.length; i++) owner[seeds[i]] = startId + i;
    while (head < queue.length) {
      var idx = queue[head++];
      var id = owner[idx];
      var x = idx % GW, y = (idx / GW) | 0;
      var cand = [];
      if (x > 0) cand.push(idx - 1);
      if (x < GW - 1) cand.push(idx + 1);
      if (y > 0) cand.push(idx - GW);
      if (y < GH - 1) cand.push(idx + GW);
      for (var ci = 0; ci < cand.length; ci++) {
        var n = cand[ci];
        if (owner[n] !== -1 || !passable[n]) continue;
        owner[n] = id;
        queue.push(n);
      }
    }
    // Any cell the BFS could not reach (an island with no seed) becomes its
    // own region so no playable cell is orphaned.
    var extra = 0;
    for (var c = 0; c < owner.length; c++) {
      if (passable[c] && owner[c] === -1) {
        var newId = startId + seeds.length + extra; extra++;
        var q2 = [c]; owner[c] = newId;
        var h2 = 0;
        while (h2 < q2.length) {
          var p = q2[h2++];
          var px = p % GW, py = (p / GW) | 0;
          var ns = [];
          if (px > 0) ns.push(p - 1);
          if (px < GW - 1) ns.push(p + 1);
          if (py > 0) ns.push(p - GW);
          if (py < GH - 1) ns.push(p + GW);
          for (var m = 0; m < ns.length; m++) {
            if (owner[ns[m]] === -1 && passable[ns[m]]) { owner[ns[m]] = newId; q2.push(ns[m]); }
          }
        }
      }
    }
    return seeds.length + extra;
  }

  function pickTerrain(rng, lat, noiseV, coastRatio) {
    var a = Math.abs(lat);
    if (rng.next() < 0.16) return 'mountain';
    if (a > 62) return 'tundra';
    if (a > 15 && a < 34 && noiseV > 0.45 && coastRatio < 0.5) return 'desert';
    if (a < 12 && noiseV > 0.35) return 'jungle';
    if (a > 42 && noiseV > 0.42) return 'forest';
    return noiseV > 0.66 ? 'forest' : 'plains';
  }

  var DEPOSIT_WEIGHTS = {
    plains: { food: 6, materials: 2, fuel: 1, chemicals: 1 },
    forest: { food: 3, materials: 6, fuel: 1, chemicals: 1 },
    jungle: { food: 3, materials: 2, fuel: 1, chemicals: 5 },
    desert: { food: 1, materials: 2, fuel: 6, chemicals: 3 },
    tundra: { food: 1, materials: 3, fuel: 5, chemicals: 2 },
    mountain: { food: 1, materials: 6, fuel: 2, chemicals: 4 }
  };

  function pickDeposit(rng, terrain) {
    var w = DEPOSIT_WEIGHTS[terrain];
    var total = 0, k;
    for (k in w) total += w[k];
    var roll = rng.next() * total;
    for (k in w) { roll -= w[k]; if (roll <= 0) return k; }
    return 'food';
  }

  function makeName(rng, region) {
    var s = NationData.SYLLABLES[region] || NationData.SYLLABLES.anglo;
    var a = rng.pick(s.a), b = rng.pick(s.b);
    return a + b;
  }

  function makeSeaName(rng) {
    return rng.pick(NationData.SEA_PREFIX) + ' ' + rng.pick(NationData.SEA_SUFFIX);
  }

  /**
   * @param {SWW.RNG} rng
   * @param {{landProvinces:number, seaZones:number}} opts
   */
  function generate(rng, opts) {
    opts = opts || {};
    var targetLand = opts.landProvinces || 220;
    var targetSea = opts.seaZones || 70;

    var land = buildLandMask(rng);
    var landCells = [], seaCells = [];
    for (var i = 0; i < land.length; i++) (land[i] ? landCells : seaCells).push(i);

    var owner = new Int32Array(GW * GH).fill(-1);
    var landPassable = land;
    var seaPassable = new Uint8Array(land.length);
    for (var j = 0; j < land.length; j++) seaPassable[j] = land[j] ? 0 : 1;

    var landSeeds = scatterSeeds(rng, landCells, targetLand);
    var nLand = growRegions(landSeeds, landPassable, owner, 0);
    var seaSeeds = scatterSeeds(rng, seaCells, targetSea);
    var nSea = growRegions(seaSeeds, seaPassable, owner, nLand);

    var count = nLand + nSea;
    var provinces = new Array(count);
    for (var p = 0; p < count; p++) {
      provinces[p] = {
        id: p, isSea: p >= nLand, name: '', cells: [],
        sumX: 0, sumY: 0, cx: 0, cy: 0, lat: 0, lon: 0,
        size: 0, coastCells: 0, coastal: false,
        neighbors: [], terrain: 'plains', deposit: null,
        nationId: null, isCapital: false,
        pop: 0, cityLevel: 0, vp: 0, morale: 100,
        buildings: {}, construction: null, queue: []
      };
    }

    var neighborSets = new Array(count);
    for (var q = 0; q < count; q++) neighborSets[q] = Object.create(null);

    for (var c2 = 0; c2 < owner.length; c2++) {
      var id = owner[c2];
      if (id < 0) continue;
      var pr = provinces[id];
      pr.cells.push(c2);
      var x = c2 % GW, y = (c2 / GW) | 0;
      pr.sumX += x; pr.sumY += y; pr.size++;
      var isLandCell = land[c2] === 1;
      var neigh = [];
      if (x > 0) neigh.push(c2 - 1);
      if (x < GW - 1) neigh.push(c2 + 1);
      if (y > 0) neigh.push(c2 - GW);
      if (y < GH - 1) neigh.push(c2 + GW);
      for (var n2 = 0; n2 < neigh.length; n2++) {
        var oid = owner[neigh[n2]];
        if (oid < 0 || oid === id) continue;
        neighborSets[id][oid] = true;
        if (isLandCell && land[neigh[n2]] === 0) pr.coastCells++;
      }
      if (x === 0 || x === GW - 1 || y === 0 || y === GH - 1) {
        if (isLandCell) pr.coastCells++;
      }
    }

    var biome = valueNoise(rng, GW, GH, 11);

    for (var pi = 0; pi < count; pi++) {
      var prov = provinces[pi];
      if (prov.size === 0) continue;
      prov.cx = prov.sumX / prov.size;
      prov.cy = prov.sumY / prov.size;
      prov.lat = cellLat(prov.cy);
      prov.lon = cellLon(prov.cx);
      prov.neighbors = Object.keys(neighborSets[pi]).map(Number);
      prov.coastal = prov.coastCells > 0;
      if (prov.isSea) {
        prov.name = makeSeaName(rng);
        prov.terrain = 'sea';
        continue;
      }
      var nv = biome[(Math.round(prov.cy) | 0) * GW + (Math.round(prov.cx) | 0)] || 0.5;
      prov.terrain = pickTerrain(rng, prov.lat, nv, prov.coastCells / Math.max(1, prov.size));
      prov.deposit = pickDeposit(rng, prov.terrain);
      prov.cityLevel = rng.int(1, 3);
      if (rng.chance(0.15)) prov.cityLevel = 4;
      var habitability = prov.terrain === 'tundra' ? 0.35
        : prov.terrain === 'desert' ? 0.45
          : prov.terrain === 'mountain' ? 0.55 : 1.0;
      prov.pop = Math.round(prov.size * rng.range(0.7, 1.5) * habitability * (0.7 + 0.22 * prov.cityLevel));
      prov.vp = 4 + prov.cityLevel * 3;
    }

    // --- Nations -----------------------------------------------------------
    var nations = [];
    var claimed = {};
    var defs = NationData.NATIONS;
    for (var d = 0; d < defs.length; d++) {
      var def = defs[d];
      var tx = lonToX(def.lon), ty = latToY(def.lat);
      var best = -1, bestD = Infinity;
      for (var s = 0; s < nLand; s++) {
        var pv = provinces[s];
        if (pv.size === 0 || claimed[s]) continue;
        var dx = pv.cx - tx, dy = pv.cy - ty;
        var dd = dx * dx + dy * dy;
        if (dd < bestD) { bestD = dd; best = s; }
      }
      if (best < 0) continue;
      var nation = {
        id: def.id, name: def.name, adj: def.adj, color: def.color, region: def.region,
        aggression: def.aggression, isPlayer: false, alive: true, ai: true,
        capitalProvince: best, capitalName: def.capital,
        provinces: [], resources: null, research: {}, researching: null,
        relations: {}, treaties: {}, morale: 100, vp: 0, defeatedAt: null
      };
      claimed[best] = true;
      provinces[best].nationId = def.id;
      provinces[best].isCapital = true;
      provinces[best].name = def.capital;
      provinces[best].cityLevel = 5;
      provinces[best].pop = Math.round(provinces[best].pop * 1.6) + 40;
      provinces[best].vp = 4 + 5 * 3 + 25;
      nations.push(nation);
    }

    /*
     * Grow nations one province at a time, round-robin, until each reaches its
     * target size.  Taking turns keeps contested borders fair, and stopping at
     * a province count (rather than a ring depth) leaves a predictable amount
     * of unclaimed land to fight over in the opening days.
     */
    var reachOf = {};
    for (var nj = 0; nj < defs.length; nj++) reachOf[defs[nj].id] = defs[nj].reach;
    var held = {};
    for (var ni = 0; ni < nations.length; ni++) held[nations[ni].id] = [nations[ni].capitalProvince];

    var growing = true;
    while (growing) {
      growing = false;
      for (var nk = 0; nk < nations.length; nk++) {
        var nat = nations[nk];
        var mine = held[nat.id];
        if (mine.length >= reachOf[nat.id]) continue;
        // Prefer the unclaimed neighbour closest to the capital so nations
        // stay compact instead of sprouting tendrils.
        var cap = provinces[nat.capitalProvince];
        var pick = null, pickD = Infinity;
        for (var f = 0; f < mine.length; f++) {
          var nb = provinces[mine[f]].neighbors;
          for (var g = 0; g < nb.length; g++) {
            var cand = provinces[nb[g]];
            if (cand.isSea || cand.nationId !== null || cand.size === 0) continue;
            var ddx = cand.cx - cap.cx, ddy = cand.cy - cap.cy;
            var d2 = ddx * ddx + ddy * ddy;
            if (d2 < pickD) { pickD = d2; pick = cand; }
          }
        }
        if (!pick) continue;
        pick.nationId = nat.id;
        mine.push(pick.id);
        growing = true;
      }
    }

    for (var pz = 0; pz < nLand; pz++) {
      var pp = provinces[pz];
      if (pp.size === 0) continue;
      if (pp.nationId) {
        var owner2 = null;
        for (var nn = 0; nn < nations.length; nn++) if (nations[nn].id === pp.nationId) owner2 = nations[nn];
        if (owner2) owner2.provinces.push(pp.id);
        if (!pp.name) pp.name = makeName(rng, owner2 ? owner2.region : 'anglo');
      } else {
        // Neutral territory: name it after whichever culture is nearest.
        var nearest = null, nd = Infinity;
        for (var nm = 0; nm < nations.length; nm++) {
          var cp = provinces[nations[nm].capitalProvince];
          var ddx = cp.cx - pp.cx, ddy = cp.cy - pp.cy;
          var dist = ddx * ddx + ddy * ddy;
          if (dist < nd) { nd = dist; nearest = nations[nm]; }
        }
        pp.name = makeName(rng, nearest ? nearest.region : 'anglo');
      }
    }

    // Deduplicate names so the province list stays unambiguous.
    var used = Object.create(null);
    for (var pu = 0; pu < count; pu++) {
      var pn = provinces[pu];
      if (pn.size === 0) continue;
      var base = pn.name, tries = 2;
      while (used[pn.name]) { pn.name = base + ' ' + roman(tries); tries++; }
      used[pn.name] = true;
    }

    return {
      grid: { w: GW, h: GH },
      land: land,
      cellOwner: owner,
      provinces: provinces,
      nations: nations,
      landCount: nLand,
      seaCount: nSea
    };
  }

  function roman(n) {
    var map = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
    return map[n] || String(n);
  }

  SWW.worldgen = {
    generate: generate, GW: GW, GH: GH, TERRAIN: TERRAIN,
    cellLat: cellLat, cellLon: cellLon, lonToX: lonToX, latToY: latToY
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
