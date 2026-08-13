/*
 * Saving and loading.
 *
 * Geography comes from the compiled map and terrain is a pure function of the
 * seed, so a save only stores what the war has changed: ownership, buildings,
 * stockpiles, armies, treaties and the log.  Loading rebuilds the world from
 * the seed and replays that diff onto it, which keeps saves small.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};
  var SLOT = 'ironaccord.save.v1';

  function serialise(state) {
    var provinces = [];
    for (var i = 0; i < state.provinces.length; i++) {
      var p = state.provinces[i];
      if (p.size === 0) continue;
      provinces.push({
        id: p.id, nationId: p.nationId, morale: round2(p.morale), pop: p.pop,
        isCapital: p.isCapital, unrest: round2(p.unrest || 0),
        buildings: p.buildings, construction: p.construction, queue: p.queue,
        capture: p.capture || null, supplyDist: p.supplyDist || 0
      });
    }
    var nations = [];
    for (var j = 0; j < state.nations.length; j++) {
      var n = state.nations[j];
      nations.push({
        id: n.id, alive: n.alive, isPlayer: n.isPlayer, ai: n.ai,
        resources: n.resources, research: n.research, researching: n.researching,
        relations: n.relations, treaties: n.treaties, treatyUntil: n.treatyUntil,
        reputation: n.reputation, provinces: n.provinces,
        vp: n.vp, warCount: n.warCount || 0, nextTurn: n.nextTurn,
        capitalProvince: n.capitalProvince
      });
    }
    return {
      version: 1,
      seed: state.seed,
      playerId: state.playerId,
      time: state.time,
      speed: state.speed,
      rngState: state.rngState,
      victoryVP: state.victoryVP,
      gameOver: state.gameOver,
      market: state.market,
      offers: state.offers || [],
      log: state.log.slice(0, 120),
      armies: state.armies,
      armySeq: state.armySeq,
      provinces: provinces,
      nations: nations,
      savedAt: Date.now()
    };
  }

  function round2(v) { return Math.round(v * 100) / 100; }

  function deserialise(data) {
    var state = IA.state.createGame({ seed: data.seed, playerNation: data.playerId });
    state.time = data.time;
    state.speed = data.speed || '1x';
    state.rngState = data.rngState;
    state.victoryVP = data.victoryVP;
    state.gameOver = data.gameOver || null;
    state.market = data.market;
    state.offers = data.offers || [];
    state.log = data.log || [];
    state.armies = data.armies || [];
    state.armySeq = data.armySeq || (state.armies.length + 1);

    var i, p;
    for (i = 0; i < data.provinces.length; i++) {
      var sp = data.provinces[i];
      p = state.provinces[sp.id];
      if (!p) continue;
      p.nationId = sp.nationId;
      p.morale = sp.morale;
      p.pop = sp.pop;
      p.isCapital = sp.isCapital;
      p.unrest = sp.unrest;
      p.buildings = sp.buildings || {};
      p.construction = sp.construction || null;
      p.queue = sp.queue || [];
      p.capture = sp.capture || null;
      p.supplyDist = sp.supplyDist;
    }
    for (i = 0; i < data.nations.length; i++) {
      var sn = data.nations[i];
      var n = state.nationById[sn.id];
      if (!n) continue;
      n.alive = sn.alive;
      n.isPlayer = sn.isPlayer;
      n.ai = sn.ai;
      n.resources = sn.resources;
      n.research = sn.research || {};
      n.researching = sn.researching || null;
      n.relations = sn.relations || {};
      n.treaties = sn.treaties || {};
      n.treatyUntil = sn.treatyUntil || {};
      n.reputation = sn.reputation === undefined ? 75 : sn.reputation;
      n.provinces = sn.provinces || [];
      n.vp = sn.vp || 0;
      n.warCount = sn.warCount || 0;
      n.nextTurn = sn.nextTurn;
      n.capitalProvince = sn.capitalProvince;
    }
    state.playerId = data.playerId;
    IA.state.recomputeVP(state);
    IA.diplomacy.refreshWarCounts(state);
    // Weather and supply are both derived, so they are recomputed rather
    // than stored — weather is a pure function of the seed and the day.
    IA.weather.refresh(state);
    IA.economy.refreshSupply(state);
    state.dirtyProvinces = [];
    return state;
  }

  function save(state) {
    try {
      global.localStorage.setItem(SLOT, JSON.stringify(serialise(state)));
      return { ok: true };
    } catch (e) {
      return { ok: false, why: e && e.message ? e.message : 'Storage unavailable' };
    }
  }

  function hasSave() {
    try { return !!global.localStorage.getItem(SLOT); } catch (e) { return false; }
  }

  function peek() {
    try {
      var raw = global.localStorage.getItem(SLOT);
      if (!raw) return null;
      var data = JSON.parse(raw);
      return { seed: data.seed, playerId: data.playerId, time: data.time, savedAt: data.savedAt };
    } catch (e) { return null; }
  }

  function load() {
    try {
      var raw = global.localStorage.getItem(SLOT);
      if (!raw) return { ok: false, why: 'No save found' };
      return { ok: true, state: deserialise(JSON.parse(raw)) };
    } catch (e) {
      return { ok: false, why: e && e.message ? e.message : 'Save is corrupt' };
    }
  }

  function clear() {
    try { global.localStorage.removeItem(SLOT); } catch (e) { /* ignore */ }
  }

  IA.save = {
    save: save, load: load, clear: clear, hasSave: hasSave, peek: peek,
    serialise: serialise, deserialise: deserialise, SLOT: SLOT
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
