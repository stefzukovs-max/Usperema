/*
 * Intelligence work.
 *
 * A power can put agents into another's territory to look at what is there, to
 * break something, to take a technology it has not earned, or to make a
 * province ungovernable.  None of it is certain: every operation can be caught,
 * and being caught costs relations with the victim and standing with everyone
 * else — an agent taken in Belgrade is a diplomatic incident, not just a
 * setback.
 *
 * Operations take days rather than resolving instantly, so committing agents is
 * a real decision about where they are not.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};
  var clamp = IA.util.clamp;

  var AGENT_COST = 3200;            // money to recruit one
  var AGENT_CAP_BASE = 2;
  var COUNTER_HOURS = 30 * 24;      // how long a counter-intelligence sweep lasts
  var INTEL_HOURS = 10 * 24;        // how long what an agent saw stays current

  /*
   * `risk` is the base chance of being caught before a counter-intelligence
   * sweep is taken into account.  The operations that cost the victim most are
   * the ones most likely to end with your agent in a cell.
   */
  var OPERATIONS = [
    {
      id: 'recon', name: 'Reconnaissance', icon: '◎',
      desc: 'Report their forces, stockpiles and research for ten days.',
      cost: 2600, hours: 24, risk: 0.10, needsProvince: false
    },
    {
      id: 'sabotage', name: 'Sabotage', icon: '✸',
      desc: 'Wreck a works in their most industrial province and burn the shells stored there.',
      cost: 7000, hours: 3 * 24, risk: 0.34, needsProvince: false
    },
    {
      id: 'steal', name: 'Industrial Espionage', icon: '⎔',
      desc: 'Take the plans for something they have researched and you have not.',
      cost: 9500, hours: 4 * 24, risk: 0.30, needsProvince: false
    },
    {
      id: 'incite', name: 'Incite Unrest', icon: '☭',
      desc: 'Put a province of theirs close to revolt.',
      cost: 5200, hours: 2 * 24, risk: 0.26, needsProvince: true
    },
    {
      id: 'counter', name: 'Counter-Intelligence', icon: '⛨',
      desc: 'Sweep your own territory. Halves the chance of a foreign operation succeeding for a month.',
      cost: 4200, hours: 2 * 24, risk: 0, needsProvince: false, onSelf: true
    }
  ];

  var BY_ID = {};
  for (var i = 0; i < OPERATIONS.length; i++) BY_ID[OPERATIONS[i].id] = OPERATIONS[i];

  function agentCap(state, nation) {
    var admin = 0;
    for (var i = 0; i < nation.provinces.length; i++) {
      admin += IA.economy.buildingLevel(state.provinces[nation.provinces[i]], 'admin');
    }
    return clamp(AGENT_CAP_BASE + Math.floor(admin / 2), 2, 8);
  }

  function agentsFree(state, nation) {
    var busy = 0;
    var ops = state.operations || [];
    for (var i = 0; i < ops.length; i++) if (ops[i].byId === nation.id) busy++;
    return (nation.agents || 0) - busy;
  }

  function recruit(state, nation) {
    if ((nation.agents || 0) >= agentCap(state, nation)) {
      return { ok: false, why: 'You have no room for another agent. Build more administration.' };
    }
    if (nation.resources.money < AGENT_COST) return { ok: false, why: 'Not enough in the treasury.' };
    nation.resources.money -= AGENT_COST;
    nation.agents = (nation.agents || 0) + 1;
    return { ok: true };
  }

  /** Is what we last learned about this power still worth anything? */
  function intelOn(state, nation, targetId) {
    var until = nation.intel && nation.intel[targetId];
    return until && until > state.time ? until : 0;
  }

  function counterLevel(state, nation) {
    return nation.counterUntil && nation.counterUntil > state.time ? 0.5 : 1;
  }

  function launch(state, byId, targetId, type, provinceId) {
    var op = BY_ID[type];
    var by = state.nationById[byId];
    var target = state.nationById[op && op.onSelf ? byId : targetId];
    if (!op) return { ok: false, why: 'No such operation.' };
    if (!by || !target || !target.alive) return { ok: false, why: 'No such power.' };
    if (!op.onSelf && targetId === byId) return { ok: false, why: 'You cannot spy on yourself.' };
    if (agentsFree(state, by) < 1) return { ok: false, why: 'No agent is free.' };
    if (by.resources.money < op.cost) return { ok: false, why: 'Not enough in the treasury.' };
    if (op.needsProvince) {
      var prov = state.provinces[provinceId];
      if (!prov || prov.nationId !== target.id) return { ok: false, why: 'Choose a province they hold.' };
    }

    by.resources.money -= op.cost;
    state.operations = state.operations || [];
    state.operations.push({
      id: 'op' + (state.nextOpId = (state.nextOpId || 0) + 1),
      byId: byId, targetId: op.onSelf ? byId : targetId, type: type,
      provinceId: op.needsProvince ? provinceId : -1,
      startedAt: state.time, until: state.time + op.hours
    });
    return { ok: true };
  }

  /** Operations in flight for a nation, for the intelligence screen. */
  function pending(state, nationId) {
    var out = [];
    var ops = state.operations || [];
    for (var i = 0; i < ops.length; i++) if (ops[i].byId === nationId) out.push(ops[i]);
    return out;
  }

  function report(state, nationId, text, meta) {
    if (state.playerId !== nationId) return;
    IA.state.pushLog(state, 'intel', text, meta || {});
  }

  // --- what each operation actually does -----------------------------------

  function bestIndustrial(state, nation) {
    var best = null, score = -1;
    for (var i = 0; i < nation.provinces.length; i++) {
      var p = state.provinces[nation.provinces[i]];
      var v = IA.economy.buildingLevel(p, 'factory') * 3 +
        IA.economy.buildingLevel(p, 'workshop') * 2 +
        IA.economy.buildingLevel(p, 'railway') + p.pop * 0.01;
      if (v > score) { score = v; best = p; }
    }
    return best;
  }

  function doSabotage(state, by, target) {
    var prov = bestIndustrial(state, target);
    if (!prov) return 'found nothing worth wrecking';
    var order = ['factory', 'workshop', 'railway', 'harbour', 'airfield', 'barracks'];
    for (var i = 0; i < order.length; i++) {
      if (!prov.buildings[order[i]]) continue;
      prov.buildings[order[i]] -= 1;
      if (!prov.buildings[order[i]]) delete prov.buildings[order[i]];
      prov.construction = null;
      var burned = Math.round((target.resources.shells || 0) * 0.12);
      target.resources.shells = Math.max(0, (target.resources.shells || 0) - burned);
      return 'wrecked a ' + IA.BuildingData.BY_ID[order[i]].name.toLowerCase() +
        ' at ' + prov.name + ' and burned ' + burned + ' shells';
    }
    prov.unrest = Math.min(60, (prov.unrest || 0) + 15);
    return 'found no works at ' + prov.name + ', and left it in disorder instead';
  }

  function doSteal(state, by, target) {
    var candidates = [];
    for (var id in target.research) {
      if (target.research[id] && !by.research[id]) candidates.push(id);
    }
    if (!candidates.length) return 'found nothing they know that you do not';
    // The cheapest thing they have is the one that can actually be copied.
    candidates.sort(function (a, b) {
      return IA.ResearchData.BY_ID[a].days - IA.ResearchData.BY_ID[b].days;
    });
    var tech = IA.ResearchData.BY_ID[candidates[0]];
    by.research[tech.id] = true;
    return 'brought back the plans for ' + tech.name;
  }

  function doIncite(state, by, target, provinceId) {
    var prov = state.provinces[provinceId];
    if (!prov || prov.nationId !== target.id) return 'found the province already lost';
    prov.unrest = Math.min(70, (prov.unrest || 0) + 32);
    prov.morale = Math.max(5, prov.morale - 22);
    return 'left ' + prov.name + ' close to revolt';
  }

  function resolve(state, rng, op) {
    var by = state.nationById[op.byId];
    var target = state.nationById[op.targetId];
    var spec = BY_ID[op.type];
    if (!by || !by.alive || !target || !target.alive) return;

    if (spec.onSelf) {
      by.counterUntil = state.time + COUNTER_HOURS;
      report(state, by.id, 'Your counter-intelligence sweep is complete. Foreign agents will ' +
        'find the next month hard going.');
      return;
    }

    // Caught or not.  A sweep in the target's territory doubles the risk.
    var risk = spec.risk / counterLevel(state, target);
    if (rng.chance(clamp(risk, 0, 0.9))) {
      IA.diplomacy.adjustRelation(state, by.id, target.id, -15);
      IA.diplomacy.adjustReputation(state, by.id, -6);
      report(state, by.id, 'Your agent was taken in ' + target.name + '. The operation failed and ' +
        'the incident is public.', { nationId: target.id });
      report(state, target.id, 'An agent of ' + by.name + ' has been caught on your soil.',
        { nationId: by.id });
      return;
    }

    var what;
    if (op.type === 'recon') {
      by.intel = by.intel || {};
      by.intel[target.id] = state.time + INTEL_HOURS;
      what = 'has their order of battle';
    } else if (op.type === 'sabotage') {
      what = doSabotage(state, by, target);
    } else if (op.type === 'steal') {
      what = doSteal(state, by, target);
    } else if (op.type === 'incite') {
      what = doIncite(state, by, target, op.provinceId);
    }
    report(state, by.id, 'Your agent in ' + target.name + ' ' + what + '.', { nationId: target.id });

    // Some things cannot be hidden even when the agent gets away.
    if (op.type === 'sabotage' || op.type === 'incite') {
      IA.diplomacy.adjustRelation(state, by.id, target.id, -6);
      report(state, target.id, 'Someone is working against you inside your own borders.',
        { nationId: by.id });
    }
  }

  function tick(state, rng, hours) {
    var ops = state.operations;
    if (!ops || !ops.length) return;
    for (var i = ops.length - 1; i >= 0; i--) {
      if (ops[i].until > state.time) continue;
      var op = ops.splice(i, 1)[0];
      resolve(state, rng, op);
    }
  }

  /*
   * The AI runs operations against powers it is fighting, at a rate that keeps
   * it present without making espionage the main event.
   */
  function tickDaily(state, rng) {
    for (var i = 0; i < state.nations.length; i++) {
      var nation = state.nations[i];
      if (!nation.alive || nation.isPlayer) continue;
      if ((nation.agents || 0) < agentCap(state, nation) &&
        nation.resources.money > AGENT_COST * 4 && rng.chance(0.1)) {
        recruit(state, nation);
      }
      if (agentsFree(state, nation) < 1 || !rng.chance(0.08)) continue;
      var foes = [];
      for (var id in nation.treaties) {
        if (nation.treaties[id] !== 'war') continue;
        var foe = state.nationById[id];
        if (foe && foe.alive) foes.push(foe);
      }
      if (!foes.length) continue;
      var target = foes[rng.int(0, foes.length - 1)];
      var pick = rng.chance(0.3) ? 'counter'
        : ['recon', 'sabotage', 'steal', 'incite'][rng.int(0, 3)];
      var provinceId = -1;
      if (BY_ID[pick].needsProvince && target.provinces.length) {
        provinceId = target.provinces[rng.int(0, target.provinces.length - 1)];
      }
      launch(state, nation.id, target.id, pick, provinceId);
    }
  }

  IA.espionage = {
    OPERATIONS: OPERATIONS, BY_ID: BY_ID,
    launch: launch, tick: tick, tickDaily: tickDaily, recruit: recruit,
    resolveFor: resolve,
    pending: pending, agentsFree: agentsFree, agentCap: agentCap,
    intelOn: intelOn, counterLevel: counterLevel,
    AGENT_COST: AGENT_COST, INTEL_HOURS: INTEL_HOURS
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
