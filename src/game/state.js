/*
 * Game state construction and the small query helpers everything else builds
 * on.  The state object is plain data so it can be serialised for saves.
 */
(function (global) {
  'use strict';

  var SWW = global.SWW = global.SWW || {};
  var UnitData = SWW.UnitData;

  var START_RESOURCES = {
    manpower: 5300, food: 14000, materials: 11000, fuel: 5300,
    ammo: 4000, chemicals: 3900, cash: 53000, gold: 57
  };

  /*
   * Everyone opens with the same core stockpile so a small nation is playable,
   * plus a modest bonus scaled to how much territory it actually holds.
   */
  function startingResources(nation) {
    var out = {};
    var scale = 1 + Math.min(1.4, Math.sqrt(Math.max(1, nation.provinces.length)) * 0.16);
    for (var k in START_RESOURCES) {
      out[k] = k === 'gold' ? START_RESOURCES[k] : Math.round(START_RESOURCES[k] * scale);
    }
    return out;
  }

  var SPEEDS = [
    { id: 'pause', label: 'Paused', hoursPerSecond: 0 },
    { id: '1x', label: '1x', hoursPerSecond: 1 / 3 },
    { id: '4x', label: '4x', hoursPerSecond: 4 / 3 },
    { id: '16x', label: '16x', hoursPerSecond: 16 / 3 }
  ];

  function createGame(opts) {
    opts = opts || {};
    var seed = opts.seed != null ? opts.seed : String(Date.now());
    var rng = new SWW.RNG(seed);
    var world = SWW.worldgen.generate(rng, opts.world);

    var state = {
      seed: String(seed),
      version: 2,
      time: 6,               // start at 06:00 on day 1
      speed: '1x',
      mapW: world.mapW,
      mapH: world.mapH,
      runs: world.runs,
      provinces: world.provinces,
      landCount: world.landCount,
      nations: world.nations,
      nationById: {},
      armies: [],
      armySeq: 1,
      armyEpoch: 1,          // bumped whenever an army appears, dies or moves
      log: [],
      market: null,
      playerId: null,
      victoryVP: 0,
      totalVP: 0,
      gameOver: null,
      rngState: rng.s
    };

    var i, n;
    for (i = 0; i < state.nations.length; i++) {
      n = state.nations[i];
      state.nationById[n.id] = n;
      n.resources = startingResources(n);
      n.research = {};
      n.researching = null;
      // Relations and treaties are sparse: an absent entry means "neutral" and
      // "at peace".  With nearly two hundred nations a dense matrix would be
      // thirty thousand pointless entries in every save.
      n.relations = {};
      n.treaties = {};
      n.income = null;
      n.upkeep = null;
      n.power = 0;
      n.contacts = [];
    }

    // Choose the player's nation.
    var playerId = opts.playerNation;
    if (!playerId || !state.nationById[playerId]) {
      playerId = state.nations[rng.int(0, state.nations.length - 1)].id;
    }
    state.playerId = playerId;
    state.nationById[playerId].isPlayer = true;
    state.nationById[playerId].ai = false;

    /*
     * Starting garrisons scale with the country.  A one-province nation cannot
     * feed a field army, so it opens with a single battalion rather than
     * starving on day one.
     */
    for (i = 0; i < state.nations.length; i++) {
      n = state.nations[i];
      var size = n.provinces.length;
      var capitalStack = size >= 6 ? 3 : size >= 3 ? 2 : 1;
      spawnArmy(state, n.id, n.capitalProvince, [{ typeId: 'infantry', count: capitalStack }]);
      var owned = n.provinces.filter(function (id) { return id !== n.capitalProvince; });
      rng.shuffle(owned);
      var garrisons = Math.round(owned.length * 0.35);
      for (var g = 0; g < garrisons; g++) {
        spawnArmy(state, n.id, owned[g], [{ typeId: 'infantry', count: 1 }]);
      }
    }

    SWW.market.init(state, rng);
    recomputeVP(state);
    // Taking a third of the world's victory points is already a colossal war;
    // outlasting everyone else is the other way to win.
    state.victoryVP = Math.round(state.totalVP * 0.33);
    SWW.diplomacy.refreshContacts(state);
    state.rngState = rng.s;

    pushLog(state, 'world', 'The war begins. ' + state.nationById[playerId].name +
      ' mobilises as tensions collapse into open conflict.');
    return state;
  }

  /** Create an army stack; `groups` is [{typeId, count}]. */
  function spawnArmy(state, nationId, provinceId, groups) {
    var units = [];
    for (var i = 0; i < groups.length; i++) {
      var t = UnitData.BY_ID[groups[i].typeId];
      if (!t) continue;
      units.push({ typeId: t.id, count: groups[i].count, hp: t.hp * groups[i].count });
    }
    if (!units.length) return null;
    var army = {
      id: 'a' + (state.armySeq++),
      ownerId: nationId,
      provinceId: provinceId,
      units: units,
      path: [],
      legRemaining: 0,
      legTotal: 0,
      order: null,          // {type:'move'|'attack', target:provinceId}
      inCombat: false,
      entrench: 0,          // 0..1, builds while stationary in own territory
      name: null,
      fuelStarved: false
    };
    army.name = defaultArmyName(state, army);
    state.armies.push(army);
    touchArmies(state);
    return army;
  }

  function defaultArmyName(state, army) {
    var ordinals = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th',
      '11th', '12th', '13th', '14th', '15th', '16th', '17th', '18th', '19th', '20th'];
    var count = 0;
    for (var i = 0; i < state.armies.length; i++) {
      if (state.armies[i].ownerId === army.ownerId) count++;
    }
    var idx = count % ordinals.length;
    var dominant = army.units[0] ? UnitData.BY_ID[army.units[0].typeId] : null;
    var kind = !dominant ? 'Battalion'
      : dominant.cat === 'arm' ? 'Armoured Battalion'
        : dominant.cat === 'air' ? 'Air Wing'
          : dominant.cat === 'sea' ? 'Naval Squadron'
            : dominant.id === 'artillery' ? 'Artillery Regiment'
              : 'Infantry Battalion';
    return ordinals[idx] + ' ' + kind;
  }

  // --- queries -------------------------------------------------------------

  function province(state, id) { return state.provinces[id]; }
  function nation(state, id) { return state.nationById[id] || null; }

  /**
   * Province id -> armies standing there, rebuilt only when something has
   * actually changed.  Without it, the per-hour AI and combat passes degrade to
   * a full scan of every army for every lookup.
   */
  function armyIndex(state) {
    if (state._armyIndexEpoch === state.armyEpoch && state._armyIndex) return state._armyIndex;
    var index = {};
    for (var i = 0; i < state.armies.length; i++) {
      var a = state.armies[i];
      (index[a.provinceId] || (index[a.provinceId] = [])).push(a);
    }
    state._armyIndex = index;
    state._armyIndexEpoch = state.armyEpoch;
    return index;
  }

  function touchArmies(state) { state.armyEpoch++; }

  /** Armies holding position in a province (those in transit are excluded). */
  function armiesIn(state, provinceId) {
    var here = armyIndex(state)[provinceId];
    if (!here) return [];
    var out = [];
    for (var i = 0; i < here.length; i++) if (!here[i].path.length) out.push(here[i]);
    return out;
  }

  /** Includes armies currently in transit out of the province. */
  function allArmiesAt(state, provinceId) {
    return armyIndex(state)[provinceId] || [];
  }

  function armiesOf(state, nationId) {
    if (state._armiesByNationEpoch !== state.armyEpoch) {
      var map = {};
      for (var i = 0; i < state.armies.length; i++) {
        var a = state.armies[i];
        (map[a.ownerId] || (map[a.ownerId] = [])).push(a);
      }
      state._armiesByNation = map;
      state._armiesByNationEpoch = state.armyEpoch;
    }
    return state._armiesByNation[nationId] || [];
  }

  function armyById(state, id) {
    for (var i = 0; i < state.armies.length; i++) if (state.armies[i].id === id) return state.armies[i];
    return null;
  }

  function armyStrength(army) {
    var hp = 0, max = 0;
    for (var i = 0; i < army.units.length; i++) {
      var t = UnitData.BY_ID[army.units[i].typeId];
      hp += army.units[i].hp;
      max += t.hp * army.units[i].count;
    }
    return { hp: hp, max: max, ratio: max > 0 ? hp / max : 0 };
  }

  function unitCount(army) {
    var c = 0;
    for (var i = 0; i < army.units.length; i++) c += army.units[i].count;
    return c;
  }

  /** Rough single number for AI comparisons and the ranking screen. */
  function armyPower(army) {
    var p = 0;
    for (var i = 0; i < army.units.length; i++) {
      var g = army.units[i];
      var t = UnitData.BY_ID[g.typeId];
      var atk = (t.atk.inf + t.atk.arm + t.atk.air + t.atk.sea) / 4;
      var def = (t.def.inf + t.def.arm + t.def.air + t.def.sea) / 4;
      p += (atk + def) * (g.hp / t.hp);
    }
    return p;
  }

  /** Cached each hour by the loop; the AI compares it constantly. */
  function nationPower(state, nationId) {
    var n = state.nationById[nationId];
    if (n && n.powerEpoch === state.armyEpoch) return n.power;
    var p = 0, list = armiesOf(state, nationId);
    for (var i = 0; i < list.length; i++) p += armyPower(list[i]);
    if (n) { n.power = p; n.powerEpoch = state.armyEpoch; }
    return p;
  }

  function treaty(state, a, b) {
    if (a === b) return 'self';
    var na = state.nationById[a];
    if (!na) return 'peace';
    return na.treaties[b] || 'peace';
  }

  function atWar(state, a, b) { return a !== b && treaty(state, a, b) === 'war'; }

  function isHostile(state, a, b) {
    if (!a || !b || a === b) return false;
    return atWar(state, a, b);
  }

  function recomputeVP(state) {
    var i, totals = {};
    for (i = 0; i < state.nations.length; i++) totals[state.nations[i].id] = 0;
    var total = 0;
    for (i = 0; i < state.landCount; i++) {
      var p = state.provinces[i];
      if (p.size === 0) continue;
      total += p.vp;
      if (p.nationId && totals[p.nationId] !== undefined) totals[p.nationId] += p.vp;
    }
    for (i = 0; i < state.nations.length; i++) state.nations[i].vp = totals[state.nations[i].id];
    state.totalVP = total;
    return totals;
  }

  function pushLog(state, kind, text, meta) {
    state.log.unshift({
      t: state.time, kind: kind, text: text,
      meta: meta || null, read: false, id: 'e' + state.time.toFixed(2) + '_' + state.log.length
    });
    if (state.log.length > 400) state.log.length = 400;
  }

  SWW.state = {
    createGame: createGame, spawnArmy: spawnArmy, province: province, nation: nation,
    armiesIn: armiesIn, allArmiesAt: allArmiesAt, armiesOf: armiesOf, armyById: armyById,
    armyStrength: armyStrength, armyPower: armyPower, nationPower: nationPower,
    armyIndex: armyIndex, touchArmies: touchArmies,
    unitCount: unitCount, treaty: treaty, atWar: atWar, isHostile: isHostile,
    recomputeVP: recomputeVP, pushLog: pushLog, defaultArmyName: defaultArmyName,
    START_RESOURCES: START_RESOURCES, SPEEDS: SPEEDS
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
