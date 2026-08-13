/*
 * World setup.
 *
 * The geography — borders, provinces, adjacency, names, population — is fixed
 * and comes from the compiled map.  This module layers the per-game, seeded
 * parts on top: climate and terrain, which deposit each province works, how
 * developed it is, and the roster of nations with their starting temperaments.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};
  var clamp = IA.util.clamp;

  var TERRAIN = {
    plains: { name: 'Plains', def: 1.00, speed: 1.00, color: '#9aa06a' },
    farmland: { name: 'Farmland', def: 0.95, speed: 1.05, color: '#b0ac6a'},
    forest: { name: 'Forest', def: 1.15, speed: 0.85, color: '#6d7f55' },
    jungle: { name: 'Jungle', def: 1.20, speed: 0.65, color: '#5f7c53' },
    desert: { name: 'Desert', def: 0.95, speed: 0.95, color: '#cfc08a' },
    steppe: { name: 'Steppe', def: 1.00, speed: 1.00, color: '#b3ae78' },
    tundra: { name: 'Tundra', def: 1.05, speed: 0.75, color: '#a3a894' },
    taiga: { name: 'Taiga', def: 1.12, speed: 0.80, color: '#78876a' },
    mountain: { name: 'Mountains', def: 1.40, speed: 0.55, color: '#9c927f' },
    urban: { name: 'Urban', def: 1.30, speed: 0.90, color: '#948d84' },
    sea: { name: 'Open water', def: 1.00, speed: 1.00, color: '#2b3a44' }
  };

  /*
   * Real-world climate and relief, described as longitude/latitude boxes.
   * Coarse, but it puts the Sahara, the Amazon, the Himalaya and Siberia
   * where players expect to find them.
   */
  function box(lon0, lat0, lon1, lat1) { return [lon0, lat0, lon1, lat1]; }

  var MOUNTAINS = [
    box(-125, 32, -105, 60),    // Rockies
    box(-79, -55, -66, 10),     // Andes
    box(5, 43, 16, 48),         // Alps
    box(36, 38, 50, 44),        // Caucasus
    box(55, 25, 75, 40),        // Zagros / Hindu Kush
    box(72, 26, 96, 40),        // Himalaya and Tibet
    box(58, 50, 68, 68),        // Urals
    box(85, 42, 110, 55),       // Altai and Sayan
    box(125, 33, 142, 45),      // Japanese ranges
    box(28, -3, 40, 12),        // Ethiopian highlands
    box(-8, 28, 10, 36),        // Atlas
    box(166, -46, 175, -40)     // Southern Alps
  ];

  var DESERTS = [
    box(-17, 15, 34, 31),       // Sahara
    box(34, 13, 60, 32),        // Arabian
    box(44, 35, 62, 46),        // Karakum and Kyzylkum
    box(68, 23, 76, 30),        // Thar
    box(88, 36, 112, 48),       // Gobi and Taklamakan
    box(-118, 24, -103, 40),    // Sonoran, Mojave, Great Basin
    box(-72, -30, -66, -18),    // Atacama
    box(-71, -50, -64, -34),    // Patagonian
    box(113, -32, 143, -20),    // Australian interior
    box(11, -28, 25, -18)       // Namib and Kalahari
  ];

  var JUNGLES = [
    box(-78, -14, -46, 6),      // Amazon
    box(8, -6, 31, 6),          // Congo
    box(-92, 7, -77, 18),       // Central America
    box(-16, 4, 12, 11),        // West African coast
    box(72, 5, 108, 24),        // South and South-East Asia
    box(95, -11, 155, 8),       // Indonesia and New Guinea
    box(42, -26, 50, -12)       // Madagascar
  ];

  var STEPPES = [
    box(-108, 30, -95, 50),     // Great Plains
    box(28, 44, 90, 56),        // Pontic-Caspian and Kazakh steppe
    box(100, 40, 122, 50),      // Mongolian steppe
    box(-66, -40, -56, -28),    // Pampas
    box(18, -30, 32, -22)       // Highveld
  ];

  function inAny(boxes, lon, lat) {
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]) return true;
    }
    return false;
  }

  function pickTerrain(rng, lon, lat, prov) {
    var a = Math.abs(lat);
    // Dense cities read as urban regardless of the surrounding climate.
    if (prov.topCity >= 3000) return 'urban';
    if (inAny(MOUNTAINS, lon, lat) && rng.chance(0.62)) return 'mountain';
    if (rng.chance(0.05)) return 'mountain';
    if (inAny(DESERTS, lon, lat) && rng.chance(0.85)) return 'desert';
    if (inAny(JUNGLES, lon, lat) && rng.chance(0.8)) return 'jungle';
    if (inAny(STEPPES, lon, lat) && rng.chance(0.7)) return 'steppe';
    if (a >= 69) return 'tundra';
    if (a >= 55) return rng.chance(0.7) ? 'taiga' : 'tundra';
    if (a >= 45) return rng.chance(0.5) ? 'forest' : 'farmland';
    if (a >= 30) return rng.chance(0.45) ? 'farmland' : (rng.chance(0.5) ? 'forest' : 'plains');
    if (a >= 12) return rng.chance(0.4) ? 'plains' : 'farmland';
    return rng.chance(0.5) ? 'jungle' : 'plains';
  }

  /*
   * What the ground gives up.  Coal and iron sit in the hills, timber in the
   * forests, grain on the plains, and oil almost nowhere — which is precisely
   * why 1914's armies still ran on horses and coal.
   */
  var DEPOSIT_WEIGHTS = {
    plains: { grain: 7, timber: 2, coal: 2, iron: 2, oil: 1 },
    farmland: { grain: 10, timber: 1, coal: 1, iron: 1, oil: 1 },
    forest: { grain: 2, timber: 9, coal: 2, iron: 2, oil: 1 },
    taiga: { grain: 1, timber: 9, coal: 2, iron: 2, oil: 2 },
    jungle: { grain: 3, timber: 7, coal: 1, iron: 2, oil: 1 },
    desert: { grain: 1, timber: 1, coal: 1, iron: 2, oil: 5 },
    steppe: { grain: 6, timber: 1, coal: 2, iron: 2, oil: 2 },
    tundra: { grain: 1, timber: 3, coal: 2, iron: 3, oil: 3 },
    mountain: { grain: 1, timber: 3, coal: 7, iron: 7, oil: 1 },
    urban: { grain: 2, timber: 1, coal: 5, iron: 5, oil: 1 }
  };

  /* Real oil provinces get oil, because a oil map that ignores the Gulf is a
   * strange kind of realism. */
  var OIL = [
    box(35, 20, 58, 34),        // Gulf
    box(45, 45, 78, 68),        // West Siberia and the Caspian
    box(-100, 25, -88, 33),     // Texas and the Gulf of Mexico
    box(-72, 4, -60, 12),       // Venezuela
    box(0, 3, 10, 8),           // Niger delta
    box(10, 25, 30, 33),        // Libya and Algeria
    box(-120, 55, -105, 62)     // Alberta
  ];

  function pickDeposit(rng, terrain, lon, lat) {
    if (inAny(OIL, lon, lat) && rng.chance(0.7)) return 'oil';
    var w = DEPOSIT_WEIGHTS[terrain] || DEPOSIT_WEIGHTS.plains;
    var total = 0, k;
    for (k in w) total += w[k];
    var roll = rng.next() * total;
    for (k in w) { roll -= w[k]; if (roll <= 0) return k; }
    return 'grain';
  }

  function cityLevelFor(topCity) {
    if (topCity >= 5000) return 5;
    if (topCity >= 1500) return 4;
    if (topCity >= 500) return 3;
    if (topCity >= 120) return 2;
    return 1;
  }

  /*
   * Real populations span four orders of magnitude, which would make the
   * economy unplayable. This compresses them: a densely populated province is
   * worth a lot more than an empty one, but not a thousand times more.
   */
  function gamePop(prov) {
    var people = prov.people;                      // thousands
    var fromPeople = Math.pow(people, 0.45) * 2.4;
    var fromLand = Math.sqrt(prov.size) * 0.6;
    return clamp(Math.round(fromPeople + fromLand), 8, 260);
  }

  /**
   * Build the per-game world.  Geometry is shared with every other game; only
   * the mutable, seeded fields are fresh.
   */
  function generate(rng) {
    var map = IA.mapdata.load();
    var provinces = new Array(map.provinceCount);
    var i;

    for (i = 0; i < map.provinceCount; i++) {
      var src = map.provinces[i];
      var lon = IA.mapdata.lonAt(src.cx);
      var lat = IA.mapdata.latAt(src.cy);
      var prov = {
        id: i,
        isSea: src.isSea,
        name: src.name,
        cx: src.cx, cy: src.cy,
        lon: lon, lat: lat,
        bbox: src.bbox,
        size: src.size,
        coastal: src.coastal,
        neighbors: src.neighbors,
        loops: src.loops,
        nationId: null,
        isCapital: false,
        terrain: 'sea',
        deposit: null,
        people: src.people,
        pop: 0,
        cityLevel: 0,
        vp: 0,
        morale: 100,
        unrest: 0,
        supplyDist: 0,
        buildings: {},
        construction: null,
        queue: [],
        capture: null
      };
      if (!src.isSea) {
        prov.terrain = pickTerrain(rng, lon, lat, src);
        prov.deposit = pickDeposit(rng, prov.terrain, lon, lat);
        prov.cityLevel = cityLevelFor(src.topCity);
        prov.pop = gamePop(src);
        prov.vp = 3 + prov.cityLevel * 3;
      }
      provinces[i] = prov;
    }

    // --- nations ----------------------------------------------------------
    var nations = [];
    for (i = 0; i < map.nations.length; i++) {
      var row = map.nations[i];
      var capital = provinces[row.capital];
      if (!capital || capital.isSea) continue;
      var nation = {
        id: row.iso,
        name: row.name,
        color: row.colour,
        bloc: row.bloc || 'neutral',
        isPlayer: false,
        alive: true,
        ai: true,
        capitalProvince: row.capital,
        capitalName: capital.name,
        provinces: [],
        // Temperament varies per game, nudged up for the larger powers so the
        // world does not settle into a stalemate.
        aggression: 0,
        resources: null,
        research: {},
        researching: null,
        relations: {},
        treaties: {},
        vp: 0,
        warCount: 0,
        defeatedAt: null
      };
      nations.push(nation);
    }

    var byIndex = {};
    for (i = 0; i < map.nations.length; i++) byIndex[i] = map.nations[i].iso;

    for (i = 0; i < map.provinceCount; i++) {
      var p = provinces[i];
      if (p.isSea) continue;
      var iso = byIndex[map.provinces[i].nationIndex];
      if (iso === undefined) continue;               // disputed ground stays neutral
      p.nationId = iso;
    }

    var nationById = {};
    for (i = 0; i < nations.length; i++) nationById[nations[i].id] = nations[i];
    for (i = 0; i < map.provinceCount; i++) {
      var pr = provinces[i];
      if (pr.isSea || !pr.nationId) continue;
      var owner = nationById[pr.nationId];
      if (!owner) { pr.nationId = null; continue; }
      owner.provinces.push(i);
    }

    // Capitals: bigger, better defended, worth taking.
    for (i = 0; i < nations.length; i++) {
      var n = nations[i];
      if (!n.provinces.length) { n.alive = false; continue; }
      if (n.provinces.indexOf(n.capitalProvince) < 0) n.capitalProvince = n.provinces[0];
      var cap = provinces[n.capitalProvince];
      cap.isCapital = true;
      cap.cityLevel = Math.max(cap.cityLevel, 4);
      cap.pop = Math.round(cap.pop * 1.25);
      cap.vp = 3 + cap.cityLevel * 3 + 20;
      var weight = clamp(n.provinces.length / 12, 0, 1);
      n.aggression = clamp(rng.range(0.22, 0.62) + weight * 0.18, 0.15, 0.85);
    }
    nations = nations.filter(function (x) { return x.alive; });

    return {
      mapW: map.mapW,
      mapH: map.mapH,
      provinces: provinces,
      nations: nations,
      landCount: map.landProvinceCount,
      runs: map.runs
    };
  }

  IA.worldgen = { generate: generate, TERRAIN: TERRAIN, gamePop: gamePop, cityLevelFor: cityLevelFor };
})(typeof globalThis !== 'undefined' ? globalThis : this);
