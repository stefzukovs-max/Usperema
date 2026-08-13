/*
 * Officers.
 *
 * Every power keeps a short list of named commanders.  One can be given to a
 * stack, where his traits and his rank change how it fights, how fast it moves
 * and how well it holds together — and where he can be lost with it.
 *
 * The point is that armies stop being interchangeable.  A stack under a
 * methodical sapper is a different proposition from the same battalions under
 * an aggressive one, and losing the second is worse than losing the men.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};
  var Data = IA.CommanderData;
  var clamp = IA.util.clamp;

  var XP_PER_BATTLE_HOUR = 0.55;
  var PROMOTE_COST = 2200;          // money, to bring a new officer forward
  var LOSS_KILLED = 0.5;            // chance an officer goes down with his stack

  function capFor(nation) {
    return clamp(2 + Math.floor(nation.provinces.length / 8), 2, 6);
  }

  function poolFor(nationId) {
    return Data.SURNAMES[Data.POOL_OF[nationId] || 'anglo'] || Data.SURNAMES.anglo;
  }

  function rankAt(xp) {
    var r = 0;
    for (var i = 0; i < Data.RANKS.length; i++) if (xp >= Data.RANKS[i].xp) r = i;
    return r;
  }

  /** Everything the simulation needs to know about who is leading a stack. */
  function effectOf(state, army) {
    var blank = {
      attack: 1, defence: 1, speed: 1, artillery: 1,
      entrench: 1, attrition: 1, damageTaken: 1, resolve: 0
    };
    if (!army || !army.commanderId || !state.commanders) return blank;
    var c = state.commanderById[army.commanderId];
    if (!c) return blank;
    var out = blank;
    // Rank is worth a steady few per cent either way on its own.
    var rankBonus = c.rank * 0.03;
    out.attack += rankBonus;
    out.defence += rankBonus;
    for (var i = 0; i < c.traits.length; i++) {
      var t = Data.TRAIT_BY_ID[c.traits[i]];
      if (!t) continue;
      if (t.attack) out.attack += t.attack;
      if (t.defence) out.defence += t.defence;
      if (t.speed) out.speed += t.speed;
      if (t.artillery) out.artillery += t.artillery;
      if (t.entrench) out.entrench += t.entrench;
      if (t.attrition) out.attrition += t.attrition;
      if (t.damageTaken) out.damageTaken += t.damageTaken;
      if (t.resolve) out.resolve += t.resolve;
    }
    return out;
  }

  function commanderOf(state, army) {
    if (!army || !army.commanderId || !state.commanderById) return null;
    return state.commanderById[army.commanderId] || null;
  }

  function titleOf(c) {
    return Data.RANKS[c.rank].name + ' ' + c.name;
  }

  function index(state) {
    state.commanderById = {};
    for (var i = 0; i < state.commanders.length; i++) {
      state.commanderById[state.commanders[i].id] = state.commanders[i];
    }
  }

  function create(state, rng, nationId) {
    var pool = poolFor(nationId);
    var used = {};
    for (var i = 0; i < state.commanders.length; i++) {
      if (state.commanders[i].nationId === nationId) used[state.commanders[i].name] = true;
    }
    var name = null;
    for (var tries = 0; tries < 40 && !name; tries++) {
      var pick = pool[rng.int(0, pool.length - 1)];
      if (!used[pick]) name = pick;
    }
    if (!name) name = pool[rng.int(0, pool.length - 1)] + ' the Younger';

    var traits = [Data.TRAITS[rng.int(0, Data.TRAITS.length - 1)].id];
    var c = {
      id: 'c' + (state.nextCommanderId = (state.nextCommanderId || 0) + 1),
      nationId: nationId, name: name, xp: 0, rank: 0,
      traits: traits, battles: 0, armyId: null
    };
    state.commanders.push(c);
    state.commanderById[c.id] = c;
    return c;
  }

  function init(state, rng) {
    state.commanders = [];
    state.commanderById = {};
    state.nextCommanderId = 0;
    for (var i = 0; i < state.nations.length; i++) {
      var nation = state.nations[i];
      if (!nation.alive) continue;
      var want = capFor(nation);
      for (var k = 0; k < want; k++) create(state, rng, nation.id);
    }
  }

  function unassigned(state, nationId) {
    var out = [];
    for (var i = 0; i < state.commanders.length; i++) {
      var c = state.commanders[i];
      if (c.nationId === nationId && !c.armyId) out.push(c);
    }
    return out;
  }

  function commandersOf(state, nationId) {
    var out = [];
    for (var i = 0; i < state.commanders.length; i++) {
      if (state.commanders[i].nationId === nationId) out.push(state.commanders[i]);
    }
    return out;
  }

  function assign(state, commanderId, army) {
    var c = state.commanderById[commanderId];
    if (!c) return { ok: false, why: 'No such officer.' };
    if (!army) return { ok: false, why: 'No such army.' };
    if (c.nationId !== army.ownerId) return { ok: false, why: 'He does not serve you.' };
    if (IA.orders.armyDomain(army) === 'sea') return { ok: false, why: 'A fleet is not his to command.' };
    // An officer commands one stack, and a stack answers to one officer.
    if (c.armyId) release(state, c.armyId);
    var held = state.commanderById[army.commanderId];
    if (held) held.armyId = null;
    c.armyId = army.id;
    army.commanderId = c.id;
    return { ok: true };
  }

  function release(state, armyId) {
    detach(state, IA.state.armyById(state, armyId));
  }

  /**
   * Break the link both ways.  Every place a stack stops existing has to call
   * this, or an officer is left pointing at a command that is not there.
   */
  function detach(state, army) {
    if (!army || !army.commanderId || !state.commanderById) return null;
    var c = state.commanderById[army.commanderId];
    if (c) c.armyId = null;
    army.commanderId = null;
    return c;
  }

  /** A stack is merging into another: its officer goes with it if there is room. */
  function transfer(state, from, to) {
    var c = detach(state, from);
    if (!c || !to || to.commanderId) return;
    c.armyId = to.id;
    to.commanderId = c.id;
  }

  /** A power is gone, and so are its officers. */
  function disband(state, nationId) {
    if (!state.commanders) return;
    for (var i = state.commanders.length - 1; i >= 0; i--) {
      var c = state.commanders[i];
      if (c.nationId !== nationId) continue;
      var army = c.armyId ? IA.state.armyById(state, c.armyId) : null;
      if (army) army.commanderId = null;
      state.commanders.splice(i, 1);
      delete state.commanderById[c.id];
    }
  }

  /**
   * A stack has been wiped out.  Its officer went down with it, or got away —
   * either way he is not commanding anything for the moment.
   */
  function armyLost(state, rng, army) {
    if (!army || !army.commanderId || !state.commanderById) return;
    var c = state.commanderById[army.commanderId];
    army.commanderId = null;
    if (!c) return;
    c.armyId = null;
    if (rng.chance(LOSS_KILLED)) {
      var at = state.commanders.indexOf(c);
      if (at >= 0) state.commanders.splice(at, 1);
      delete state.commanderById[c.id];
      if (c.nationId === state.playerId) {
        IA.state.pushLog(state, 'combat', titleOf(c) + ' was lost with his command.');
      }
    } else {
      // Got out, and rather less sure of himself for it.
      c.xp = Math.max(0, c.xp * 0.7);
      c.rank = rankAt(c.xp);
      if (c.nationId === state.playerId) {
        IA.state.pushLog(state, 'combat', titleOf(c) + ' escaped the destruction of his command.');
      }
    }
  }

  /** Hours under fire are what makes an officer, so experience accrues in battle. */
  function tick(state, rng, hours) {
    if (!state.commanders) return;
    for (var i = 0; i < state.commanders.length; i++) {
      var c = state.commanders[i];
      if (!c.armyId) continue;
      var army = IA.state.armyById(state, c.armyId);
      if (!army) { c.armyId = null; continue; }
      if (!army.inCombat) continue;
      c.xp += XP_PER_BATTLE_HOUR * hours;
      var rank = rankAt(c.xp);
      if (rank <= c.rank) continue;
      c.rank = rank;
      // Room for another speciality as he rises.
      var room = Data.RANKS[rank].traits;
      if (c.traits.length < room) {
        for (var tries = 0; tries < 20; tries++) {
          var t = Data.TRAITS[rng.int(0, Data.TRAITS.length - 1)];
          if (c.traits.indexOf(t.id) < 0) { c.traits.push(t.id); break; }
        }
      }
      if (c.nationId === state.playerId) {
        IA.state.pushLog(state, 'combat', c.name + ' is promoted to ' + Data.RANKS[rank].name + '.');
      }
    }
  }

  /**
   * Daily housekeeping: bring officers forward where a power is short of them,
   * and let the AI put the ones it has to work.
   */
  function tickDaily(state, rng) {
    if (!state.commanders) return;
    for (var i = 0; i < state.nations.length; i++) {
      var nation = state.nations[i];
      if (!nation.alive) continue;
      var mine = commandersOf(state, nation.id);
      if (mine.length < capFor(nation) && nation.resources.money >= PROMOTE_COST) {
        nation.resources.money -= PROMOTE_COST;
        var made = create(state, rng, nation.id);
        if (nation.isPlayer) {
          IA.state.pushLog(state, 'world', made.name + ' has been brought forward to command.');
        }
      }
      if (!nation.isPlayer) autoAssign(state, nation);
    }
  }

  /** The AI gives its officers to its biggest stacks and leaves them there. */
  function autoAssign(state, nation) {
    var free = unassigned(state, nation.id);
    if (!free.length) return;
    var armies = IA.state.armiesOf(state, nation.id).filter(function (a) {
      return !a.commanderId && IA.orders.armyDomain(a) === 'land';
    });
    if (!armies.length) return;
    armies.sort(function (a, b) {
      return IA.state.armyStrength(b).hp - IA.state.armyStrength(a).hp;
    });
    for (var i = 0; i < free.length && i < armies.length; i++) {
      assign(state, free[i].id, armies[i]);
    }
  }

  IA.commanders = {
    init: init, tick: tick, tickDaily: tickDaily, index: index,
    effectOf: effectOf, commanderOf: commanderOf, titleOf: titleOf,
    assign: assign, release: release, detach: detach, transfer: transfer,
    disband: disband, armyLost: armyLost,
    unassigned: unassigned, commandersOf: commandersOf, capFor: capFor,
    rankAt: rankAt, PROMOTE_COST: PROMOTE_COST
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
