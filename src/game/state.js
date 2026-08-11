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
      version: 1,
      time: 6,               // start at 06:00 on day 1
      speed: '1x',
      grid: world.grid,
      land: world.land,
      cellOwner: world.cellOwner,
      provinces: world.provinces,
      landCount: world.landCount,
      nations: world.nations,
      nationById: {},
      armies: [],
      armySeq: 1,
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
      n.resources = Object.assign({}, START_RESOURCES);
      n.research = {};
      n.researching = null;
      n.relations = {};
      n.treaties = {};
      n.income = null;
      n.upkeep = null;
    }
    for (i = 0; i < state.nations.length; i++) {
      for (var j = 0; j < state.nations.length; j++) {
        if (i === j) continue;
        state.nations[i].relations[state.nations[j].id] = 0;
        state.nations[i].treaties[state.nations[j].id] = 'peace';
      }
    }

    // Choose the player's nation.
    var playerId = opts.playerNation;
    if (!playerId || !state.nationById[playerId]) {
      playerId = state.nations[rng.int(0, state.nations.length - 1)].id;
    }
    state.playerId = playerId;
    state.nationById[playerId].isPlayer = true;
    state.nationById[playerId].ai = false;

    // Starting garrisons: a real force at the capital, a screen elsewhere.
    for (i = 0; i < state.nations.length; i++) {
      n = state.nations[i];
      spawnArmy(state, n.id, n.capitalProvince, [{ typeId: 'infantry', count: 3 }]);
      var owned = n.provinces.slice();
      rng.shuffle(owned);
      var garrisons = Math.min(owned.length, Math.max(1, Math.round(owned.length * 0.45)));
      for (var g = 0; g < garrisons; g++) {
        spawnArmy(state, n.id, owned[g], [{ typeId: 'infantry', count: rng.int(1, 2) }]);
      }
    }

    SWW.market.init(state, rng);
    recomputeVP(state);
    state.victoryVP = Math.round(state.totalVP * 0.45);
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

  function armiesIn(state, provinceId) {
    var out = [];
    for (var i = 0; i < state.armies.length; i++) {
      if (state.armies[i].provinceId === provinceId && !state.armies[i].path.length) out.push(state.armies[i]);
    }
    return out;
  }

  /** Includes armies currently in transit out of the province. */
  function allArmiesAt(state, provinceId) {
    var out = [];
    for (var i = 0; i < state.armies.length; i++) {
      if (state.armies[i].provinceId === provinceId) out.push(state.armies[i]);
    }
    return out;
  }

  function armiesOf(state, nationId) {
    var out = [];
    for (var i = 0; i < state.armies.length; i++) {
      if (state.armies[i].ownerId === nationId) out.push(state.armies[i]);
    }
    return out;
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

  function nationPower(state, nationId) {
    var p = 0, list = armiesOf(state, nationId);
    for (var i = 0; i < list.length; i++) p += armyPower(list[i]);
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
    unitCount: unitCount, treaty: treaty, atWar: atWar, isHostile: isHostile,
    recomputeVP: recomputeVP, pushLog: pushLog, defaultArmyName: defaultArmyName,
    START_RESOURCES: START_RESOURCES, SPEEDS: SPEEDS
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
