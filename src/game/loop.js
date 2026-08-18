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
    // combat.reconcile is called from several places that have no rng of their
    // own, and losing a stack has to decide the fate of its officer.
    state.lossRng = rng;
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
    state.lossRng = null;
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
    IA.economy.tickAttrition(state, hours);
    IA.economy.tickMorale(state, hours);
    IA.market.tick(state, rng, hours);
    IA.diplomacy.tickRelations(state, rng, hours);
    IA.commanders.tick(state, rng, hours);
    IA.espionage.tick(state, rng, hours);
    IA.ai.tick(state, rng, hours);
  }

  function stepDay(state, rng) {
    IA.weather.refresh(state);
    IA.economy.refreshSupply(state);
    IA.naval.tickDaily(state);
    IA.commanders.tickDaily(state, rng);
    IA.espionage.tickDaily(state, rng);
    for (var i = 0; i < state.nations.length; i++) {
      var nation = state.nations[i];
      if (!nation.alive) continue;
      if (nation.isPlayer) nation.resources.gold += DAILY_GOLD;
    }
    IA.diplomacy.expireTreaties(state);
    IA.diplomacy.refreshWarCounts(state);
    IA.diplomacy.refreshContacts(state);
    IA.state.recomputeVP(state);
    IA.victory.tickDaily(state);
    checkVictory(state);
  }

  function checkVictory(state) {
    for (var i = 0; i < state.nations.length; i++) {
      var n = state.nations[i];
      if (n.alive && n.provinces.length === 0) IA.combat.checkElimination(state, n.id);
    }
    var player = state.nationById[state.playerId];
    if (player && !player.alive) {
      state.gameOver = { result: 'defeat', winner: null, at: state.time, reason: 'overrun' };
      IA.state.cue(state, 'defeat');
      IA.state.pushLog(state, 'world', 'Your nation has been overrun. The war is lost.');
      return;
    }
    var won = IA.victory.check(state);
    if (!won) return;
    state.gameOver = won;
    IA.state.cue(state, won.result === 'victory' ? 'victory' : 'defeat');
    IA.state.pushLog(state, 'world', won.message);
  }

  IA.loop = { advance: advance, checkVictory: checkVictory, DAILY_GOLD: DAILY_GOLD };
})(typeof globalThis !== 'undefined' ? globalThis : this);
