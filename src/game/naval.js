/*
 * The sea.
 *
 * Two things happen out there, and both come out of the same question: who is
 * standing in a given stretch of water.
 *
 * A convoy lane is supply crossing the sea between two of a nation's ports.  It
 * is what makes an empire an empire — Britain feeds Egypt from London and not
 * from anywhere nearer — and a hostile fleet sitting on the water cuts it, the
 * same way an army standing in a province cuts a road.  Escorts count: a lane
 * stays open while the ships defending it are worth as much as the ships
 * hunting it.
 *
 * A blockade is what is left when a port has no open water at all.  Its trade
 * stops, its imported nitrates stop with it, and the city knows about it.
 * Nobody declares a blockade here; it is simply the state of a harbour whose
 * every approach is held by someone else.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};

  var TRADE_BITE = 0.45;      // revenue a shut port loses
  var SHELL_BITE = 0.30;      // shell output, once the imports stop
  var MORALE_BITE = 7;        // morale a blockaded city loses

  /**
   * What a stack is worth in a fight for the sea lane.  Troopships are cargo,
   * not escorts, and count for nothing here even though they float.
   */
  function warshipPower(army) {
    var power = 0;
    for (var i = 0; i < army.units.length; i++) {
      var g = army.units[i];
      var t = IA.UnitData.BY_ID[g.typeId];
      if (!t || t.domain !== 'sea' || t.id === 'transport') continue;
      power += (t.atk.inf + t.def.inf) * 0.5 * (g.hp / t.hp);
    }
    return power;
  }

  /**
   * Warship strength per power in every sea zone that has any.  Ships under way
   * count: a fleet steaming through the Channel is in the Channel.
   */
  function refreshControl(state) {
    var control = state.seaControl = {};
    for (var i = 0; i < state.armies.length; i++) {
      var army = state.armies[i];
      var prov = state.provinces[army.provinceId];
      if (!prov || !prov.isSea) continue;
      var guns = warshipPower(army);
      if (guns <= 0) continue;            // a transport does not fight for the lane
      var slot = control[prov.id] || (control[prov.id] = {});
      slot[army.ownerId] = (slot[army.ownerId] || 0) + guns;
    }
    return control;
  }

  /**
   * May this nation's shipping cross this water?  Only if what is hunting it
   * there is not worth more than what is escorting it.
   */
  function passable(state, nationId, seaId) {
    var slot = state.seaControl && state.seaControl[seaId];
    if (!slot) return true;
    var hostile = 0, friendly = 0;
    for (var id in slot) {
      if (id === nationId) { friendly += slot[id]; continue; }
      if (IA.state.isHostile(state, nationId, id)) hostile += slot[id];
      else if (IA.state.treaty(state, nationId, id) === 'alliance') friendly += slot[id];
    }
    return hostile <= friendly;
  }

  /** The powers with warships in a sea zone, strongest first. */
  function fleetsIn(state, seaId) {
    var slot = state.seaControl && state.seaControl[seaId];
    if (!slot) return [];
    var out = [];
    for (var id in slot) out.push({ nationId: id, power: slot[id] });
    out.sort(function (a, b) { return b.power - a.power; });
    return out;
  }

  /**
   * Mark every coastal province with whether it still has a way out to sea.
   * Everything the blockade does downstream reads `prov.blockaded`.
   */
  function refresh(state) {
    refreshControl(state);
    for (var i = 0; i < state.landCount; i++) {
      var prov = state.provinces[i];
      prov.blockaded = false;
      if (!prov.seaport || !prov.nationId) continue;
      var open = false;
      for (var k = 0; k < prov.neighbors.length; k++) {
        var np = state.provinces[prov.neighbors[k]];
        if (!np.isSea || np.isLake) continue;          // a lake is not a way out
        if (passable(state, prov.nationId, np.id)) { open = true; break; }
      }
      prov.blockaded = !open;
    }
  }

  /**
   * How much of a nation's coast is shut, weighted by the people behind it —
   * closing a fishing village is not closing Hamburg.  This is the number the
   * interface reports and the one the AI reads to decide it is being strangled.
   */
  function blockadeOf(state, nation) {
    var shut = 0, all = 0;
    for (var i = 0; i < nation.provinces.length; i++) {
      var p = state.provinces[nation.provinces[i]];
      if (!p || !p.seaport) continue;
      all += p.pop;
      if (p.blockaded) shut += p.pop;
    }
    return all > 0 ? shut / all : 0;
  }

  /** Ports of a nation that are currently shut, worst first. */
  function blockadedPorts(state, nation) {
    var out = [];
    for (var i = 0; i < nation.provinces.length; i++) {
      var p = state.provinces[nation.provinces[i]];
      if (p && p.blockaded) out.push(p);
    }
    out.sort(function (a, b) { return b.pop - a.pop; });
    return out;
  }

  /*
   * A blockade is a slow thing that never announces itself, which makes it the
   * easiest disaster in the game to miss.  Once a day, whoever has just been
   * shut in — or just broken out — is reported.
   */
  var SHUT = 0.5;
  var FREE = 0.2;

  function tickDaily(state) {
    for (var i = 0; i < state.nations.length; i++) {
      var nation = state.nations[i];
      if (!nation.alive) continue;
      var now = blockadeOf(state, nation);
      var was = nation.blockade === undefined ? now : nation.blockade;
      nation.blockade = now;
      if (now >= SHUT && was < SHUT) {
        IA.state.pushLog(state, nation.isPlayer ? 'war' : 'world',
          nation.isPlayer
            ? 'Your coast is blockaded. Trade through your ports has stopped.'
            : nation.name + '\u2019s coast has been blockaded.',
          { nationId: nation.id });
        if (nation.isPlayer) IA.state.cue(state, 'war', nation.id);
      } else if (now <= FREE && was > SHUT) {
        IA.state.pushLog(state, nation.isPlayer ? 'war' : 'world',
          nation.isPlayer
            ? 'The blockade of your coast has been broken.'
            : nation.name + ' has broken the blockade of its coast.',
          { nationId: nation.id });
      }
    }
  }

  IA.naval = {
    tickDaily: tickDaily,
    refresh: refresh, refreshControl: refreshControl, passable: passable,
    warshipPower: warshipPower,
    fleetsIn: fleetsIn, blockadeOf: blockadeOf, blockadedPorts: blockadedPorts,
    TRADE_BITE: TRADE_BITE, SHELL_BITE: SHELL_BITE, MORALE_BITE: MORALE_BITE
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
