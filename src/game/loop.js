/*
 * The simulation clock.  `advance` walks the world forward in whole game
 * hours; everything downstream assumes it is called with hours <= 1.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};

  var DAILY_GOLD = 3;

  function advance(state, hours) {
    if (state.gameOver) return;
    var rng = new IA.RNG(state.rngState);
    var remaining = hours;
    var guard = 0;
    while (remaining > 0.0001 && guard++ < 512) {
      var step = Math.min(1, remaining);
      var dayBefore = Math.floor(state.time / 24);
      state.time += step;
      stepHour(state, rng, step);
      if (Math.floor(state.time / 24) !== dayBefore) stepDay(state, rng);
      remaining -= step;
      if (state.gameOver) break;
    }
    state.rngState = rng.s;
  }

  function stepHour(state, rng, hours) {
    IA.orders.tickMovement(state, hours);
    IA.combat.tick(state, rng, hours);
    IA.economy.tickResources(state, hours);
    IA.economy.tickConstruction(state, hours);
    IA.economy.tickProduction(state, hours);
    IA.economy.tickResearch(state, hours);
    IA.economy.tickRepair(state, hours);
    IA.economy.tickEntrench(state, hours);
    IA.economy.tickMorale(state, hours);
    IA.market.tick(state, rng, hours);
    IA.diplomacy.tickRelations(state, rng, hours);
    IA.ai.tick(state, rng, hours);
  }

  function stepDay(state, rng) {
    for (var i = 0; i < state.nations.length; i++) {
      var nation = state.nations[i];
      if (!nation.alive) continue;
      IA.economy.refreshSupplyDistance(state, nation);
      if (nation.isPlayer) nation.resources.gold += DAILY_GOLD;
    }
    IA.diplomacy.refreshWarCounts(state);
    IA.diplomacy.refreshContacts(state);
    IA.state.recomputeVP(state);
    checkVictory(state);
  }

  function checkVictory(state) {
    var alive = [];
    for (var i = 0; i < state.nations.length; i++) {
      var n = state.nations[i];
      if (n.alive && n.provinces.length === 0) IA.combat.checkElimination(state, n.id);
      if (n.alive) alive.push(n);
    }
    var player = state.nationById[state.playerId];
    if (player && !player.alive) {
      state.gameOver = { result: 'defeat', winner: null, at: state.time };
      IA.state.pushLog(state, 'world', 'Your nation has been overrun. The war is lost.');
      return;
    }
    var leader = null;
    for (var j = 0; j < alive.length; j++) {
      if (!leader || alive[j].vp > leader.vp) leader = alive[j];
    }
    if (leader && leader.vp >= state.victoryVP) {
      state.gameOver = {
        result: leader.isPlayer ? 'victory' : 'defeat',
        winner: leader.id, at: state.time, reason: 'victory points'
      };
      IA.state.pushLog(state, 'world', leader.name + ' has reached the victory threshold and wins the war.');
      return;
    }
    if (alive.length === 1) {
      state.gameOver = {
        result: alive[0].isPlayer ? 'victory' : 'defeat',
        winner: alive[0].id, at: state.time, reason: 'last nation standing'
      };
      IA.state.pushLog(state, 'world', alive[0].name + ' stands alone. The war is over.');
    }
  }

  IA.loop = { advance: advance, checkVictory: checkVictory, DAILY_GOLD: DAILY_GOLD };
})(typeof globalThis !== 'undefined' ? globalThis : this);
