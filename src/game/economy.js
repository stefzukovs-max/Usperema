/*
 * Economy: province output, national income and upkeep, morale, construction,
 * unit production and research progress.  Everything here runs once per whole
 * game hour.
 */
(function (global) {
  'use strict';

  var SWW = global.SWW = global.SWW || {};
  var UnitData = SWW.UnitData;
  var BuildingData = SWW.BuildingData;
  var ResearchData = SWW.ResearchData;
  var clamp = SWW.util.clamp;

  /*
   * Yields per hour, per point of province population.  Calibrated so a mid
   * sized nation can sustain twenty-odd battalions and add one or two a day —
   * fast enough to recover from a bad battle, slow enough that losing an army
   * hurts.
   */
  var DEPOSIT_RATE = 0.19;
  var FARM_RATE = 0.085;     // baseline agriculture every province produces
  var CASH_RATE = 0.26;
  var MANPOWER_RATE = 0.024;

  /** Sum of a named bonus across every researched tech. */
  function techBonus(nation, key) {
    var total = 0;
    for (var id in nation.research) {
      if (!nation.research[id]) continue;
      var t = ResearchData.BY_ID[id];
      if (t && t.bonus && t.bonus[key]) total += t.bonus[key];
    }
    return total;
  }

  function hasTech(nation, id) { return !!nation.research[id]; }

  function buildingLevel(prov, id) { return prov.buildings[id] || 0; }

  function buildingEffect(prov, id, key) {
    var lvl = buildingLevel(prov, id);
    if (!lvl) return 0;
    var e = BuildingData.BY_ID[id].effect(lvl);
    return e[key] || 0;
  }

  function moraleFactor(prov) { return 0.35 + 0.65 * (prov.morale / 100); }

  /** Per-hour gross output of a single province. */
  function provinceOutput(state, prov) {
    var out = { manpower: 0, food: 0, materials: 0, fuel: 0, ammo: 0, chemicals: 0, cash: 0 };
    if (prov.isSea || !prov.nationId || prov.size === 0) return out;
    var nation = state.nationById[prov.nationId];
    if (!nation) return out;

    var mf = moraleFactor(prov);
    var pop = prov.pop;
    var prodTech = 1 + techBonus(nation, 'production');
    var industry = 1 + buildingEffect(prov, 'industry', 'deposit');

    // Every province farms; a food deposit means it farms well.
    out.food += pop * FARM_RATE * mf * prodTech;
    if (prov.deposit) {
      out[prov.deposit] += pop * DEPOSIT_RATE * mf * industry * prodTech;
    }
    out.cash += pop * CASH_RATE * mf * (1 + buildingEffect(prov, 'industry', 'cash')) *
      (prov.coastal ? 1.15 : 1);
    out.manpower += pop * MANPOWER_RATE * mf *
      (1 + buildingEffect(prov, 'recruiting', 'manpower')) * (1 + techBonus(nation, 'manpower'));

    var arms = buildingEffect(prov, 'arms_factory', 'ammo');
    if (arms > 0) out.ammo += arms * mf;
    return out;
  }

  /** Materials and chemicals burned by arms factories producing ammunition. */
  function provinceConsumption(state, prov) {
    var cons = { materials: 0, chemicals: 0 };
    var arms = buildingEffect(prov, 'arms_factory', 'ammo');
    if (arms > 0) {
      var mf = moraleFactor(prov);
      cons.materials = arms * mf * 0.5;
      cons.chemicals = arms * mf * 0.15;
    }
    return cons;
  }

  function nationIncome(state, nation) {
    var totals = { manpower: 0, food: 0, materials: 0, fuel: 0, ammo: 0, chemicals: 0, cash: 0 };
    for (var i = 0; i < nation.provinces.length; i++) {
      var prov = state.provinces[nation.provinces[i]];
      if (!prov || prov.nationId !== nation.id) continue;
      var o = provinceOutput(state, prov);
      for (var k in totals) totals[k] += o[k] || 0;
      var c = provinceConsumption(state, prov);
      totals.materials -= c.materials;
      totals.chemicals -= c.chemicals;
    }
    return totals;
  }

  function nationUpkeep(state, nation) {
    var totals = { food: 0, fuel: 0, cash: 0 };
    var armies = SWW.state.armiesOf(state, nation.id);
    for (var i = 0; i < armies.length; i++) {
      var army = armies[i];
      for (var j = 0; j < army.units.length; j++) {
        var g = army.units[j];
        var t = UnitData.BY_ID[g.typeId];
        var live = g.hp / t.hp;                    // damaged units cost less
        for (var k in t.upkeep) totals[k] = (totals[k] || 0) + t.upkeep[k] * live;
      }
    }
    // Buildings under construction and queued units do not add upkeep; they
    // were paid for up front.
    return totals;
  }

  function netIncome(state, nation) {
    var inc = nationIncome(state, nation);
    var up = nationUpkeep(state, nation);
    var net = {};
    for (var k in inc) net[k] = inc[k] - (up[k] || 0);
    return { income: inc, upkeep: up, net: net };
  }

  /** Distance in provinces from the capital, through own territory. */
  function refreshSupplyDistance(state, nation) {
    var dist = {};
    var cap = nation.capitalProvince;
    var capProv = state.provinces[cap];
    if (!capProv || capProv.nationId !== nation.id) {
      // Capital lost: everything is poorly supplied.
      for (var i = 0; i < nation.provinces.length; i++) {
        state.provinces[nation.provinces[i]].supplyDist = 6;
      }
      return;
    }
    dist[cap] = 0;
    var queue = [cap], head = 0;
    while (head < queue.length) {
      var pid = queue[head++];
      var p = state.provinces[pid];
      for (var n = 0; n < p.neighbors.length; n++) {
        var np = state.provinces[p.neighbors[n]];
        if (np.nationId !== nation.id) continue;
        if (dist[np.id] !== undefined) continue;
        dist[np.id] = dist[pid] + 1;
        queue.push(np.id);
      }
    }
    for (var q = 0; q < nation.provinces.length; q++) {
      var prov = state.provinces[nation.provinces[q]];
      prov.supplyDist = dist[prov.id] !== undefined ? dist[prov.id] : 8;
    }
  }

  function moraleTarget(state, prov) {
    if (!prov.nationId) return 50;
    var nation = state.nationById[prov.nationId];
    if (!nation) return 50;
    var t = 100;
    t -= (prov.supplyDist || 0) * 3.2;
    if (nation.warCount > 0) t -= 6 + Math.min(14, nation.warCount * 3);
    t += buildingEffect(prov, 'bunker', 'morale');
    t += buildingEffect(prov, 'propaganda', 'morale');
    t += buildingEffect(prov, 'industry', 'morale');
    if (prov.isCapital) t += 12;
    if (prov.unrest) t -= prov.unrest;
    if (nation.shortage) t -= 12;
    // Being surrounded by hostile territory is demoralising.
    var hostile = 0, total = 0;
    for (var i = 0; i < prov.neighbors.length; i++) {
      var np = state.provinces[prov.neighbors[i]];
      if (np.isSea) continue;
      total++;
      if (np.nationId && np.nationId !== prov.nationId &&
        SWW.state.atWar(state, prov.nationId, np.nationId)) hostile++;
    }
    if (total > 0) t -= (hostile / total) * 15;
    return clamp(t, 5, 100);
  }

  function tickMorale(state, hours) {
    for (var i = 0; i < state.landCount; i++) {
      var prov = state.provinces[i];
      if (prov.size === 0 || !prov.nationId) continue;
      var target = moraleTarget(state, prov);
      prov.moraleTarget = target;
      var rate = (target > prov.morale ? 0.22 : 0.32) * hours;   // decays faster than it recovers
      var spread = buildingEffect(prov, 'propaganda', 'moraleSpread');
      if (spread) rate *= 1 + spread * 0.2;
      if (Math.abs(target - prov.morale) < rate) prov.morale = target;
      else prov.morale += (target > prov.morale ? rate : -rate);
      if (prov.unrest) prov.unrest = Math.max(0, prov.unrest - 0.35 * hours);
    }
  }

  function payCost(nation, cost) {
    for (var k in cost) {
      if ((nation.resources[k] || 0) < cost[k]) return false;
    }
    for (var j in cost) nation.resources[j] -= cost[j];
    return true;
  }

  function canAfford(nation, cost) {
    for (var k in cost) if ((nation.resources[k] || 0) < cost[k]) return false;
    return true;
  }

  function refundCost(nation, cost, ratio) {
    for (var k in cost) nation.resources[k] = (nation.resources[k] || 0) + cost[k] * ratio;
  }

  /** Apply income/upkeep and flag shortages. */
  function tickResources(state, hours) {
    for (var i = 0; i < state.nations.length; i++) {
      var nation = state.nations[i];
      if (!nation.alive) continue;
      var flow = netIncome(state, nation);
      nation.income = flow.income;
      nation.upkeep = flow.upkeep;
      nation.net = flow.net;
      var shortage = false;
      for (var k in flow.net) {
        var next = nation.resources[k] + flow.net[k] * hours;
        if (next < 0) {
          next = 0;
          // Only food and money actually break an army; running out of
          // chemicals just stalls production.
          if (flow.net[k] < 0 && (k === 'food' || k === 'cash')) shortage = true;
        }
        nation.resources[k] = next;
      }
      nation.shortage = shortage;
      if (shortage) applyShortageAttrition(state, nation, hours);
    }
  }

  /** Starving or bankrupt armies lose strength. */
  function applyShortageAttrition(state, nation, hours) {
    var armies = SWW.state.armiesOf(state, nation.id);
    for (var i = 0; i < armies.length; i++) {
      var army = armies[i];
      for (var j = 0; j < army.units.length; j++) {
        var g = army.units[j];
        var t = UnitData.BY_ID[g.typeId];
        g.hp = Math.max(t.hp * 0.25 * g.count, g.hp - t.hp * g.count * 0.005 * hours);
      }
    }
  }

  /** Repair damaged units sitting still in friendly supplied territory. */
  function tickRepair(state, hours) {
    for (var i = 0; i < state.armies.length; i++) {
      var army = state.armies[i];
      if (army.inCombat || army.path.length) continue;
      var prov = state.provinces[army.provinceId];
      var nation = state.nationById[army.ownerId];
      if (!nation) continue;
      var friendly = prov.isSea || prov.nationId === army.ownerId;
      if (!friendly) continue;
      var rate = 0.9 * (1 + techBonus(nation, 'repair')) * hours;
      if (!prov.isSea) {
        rate *= 1 + buildingEffect(prov, 'airbase', 'airRepair') + buildingEffect(prov, 'naval_base', 'navalRepair');
      }
      for (var j = 0; j < army.units.length; j++) {
        var g = army.units[j];
        var t = UnitData.BY_ID[g.typeId];
        var max = t.hp * g.count;
        if (g.hp < max) g.hp = Math.min(max, g.hp + rate);
      }
    }
  }

  /** Entrenchment builds while an army holds position. */
  function tickEntrench(state, hours) {
    for (var i = 0; i < state.armies.length; i++) {
      var army = state.armies[i];
      if (army.path.length || army.inCombat) { army.entrench = Math.max(0, army.entrench - 0.25 * hours); continue; }
      army.entrench = Math.min(1, army.entrench + 0.035 * hours);
    }
  }

  function tickConstruction(state, hours) {
    for (var i = 0; i < state.landCount; i++) {
      var prov = state.provinces[i];
      if (prov.size === 0 || !prov.construction) continue;
      prov.construction.remaining -= hours;
      if (prov.construction.remaining <= 0) {
        var b = prov.construction;
        prov.buildings[b.buildingId] = b.level;
        prov.construction = null;
        var nation = state.nationById[prov.nationId];
        if (nation && nation.isPlayer) {
          SWW.state.pushLog(state, 'build',
            BuildingData.BY_ID[b.buildingId].name + ' level ' + b.level + ' completed in ' + prov.name + '.',
            { provinceId: prov.id });
        }
      }
    }
  }

  function unitBuildTime(state, nation, type) {
    return type.time / (1 + techBonus(nation, 'buildSpeed'));
  }

  function tickProduction(state, hours) {
    for (var i = 0; i < state.landCount; i++) {
      var prov = state.provinces[i];
      if (prov.size === 0 || !prov.queue || prov.queue.length === 0) continue;
      var job = prov.queue[0];
      job.remaining -= hours;
      if (job.remaining > 0) continue;
      prov.queue.shift();
      var type = UnitData.BY_ID[job.typeId];
      // Join a stack already sitting here — preferring one that already fields
      // this unit type — rather than littering the province with singletons.
      var here = SWW.state.armiesIn(state, prov.id);
      var host = null, hostGroup = null;
      for (var a = 0; a < here.length && !hostGroup; a++) {
        var cand = here[a];
        if (cand.ownerId !== prov.nationId || cand.inCombat) continue;
        for (var u = 0; u < cand.units.length; u++) {
          if (cand.units[u].typeId === job.typeId) { host = cand; hostGroup = cand.units[u]; break; }
        }
        if (!host && cand.units.length < 6) host = cand;
      }
      if (hostGroup) {
        hostGroup.count += 1;
        hostGroup.hp += type.hp;
      } else if (host) {
        host.units.push({ typeId: job.typeId, count: 1, hp: type.hp });
      } else {
        SWW.state.spawnArmy(state, prov.nationId, prov.id, [{ typeId: job.typeId, count: 1 }]);
      }
      var nation = state.nationById[prov.nationId];
      if (nation && nation.isPlayer) {
        SWW.state.pushLog(state, 'build', type.name + ' ready in ' + prov.name + '.', { provinceId: prov.id });
      }
    }
  }

  function tickResearch(state, hours) {
    for (var i = 0; i < state.nations.length; i++) {
      var nation = state.nations[i];
      if (!nation.researching) continue;
      nation.researching.remaining -= hours;
      if (nation.researching.remaining <= 0) {
        var techId = nation.researching.techId;
        nation.research[techId] = true;
        nation.researching = null;
        if (nation.isPlayer) {
          SWW.state.pushLog(state, 'research',
            'Research complete: ' + ResearchData.BY_ID[techId].name + '.', { techId: techId });
        }
      }
    }
  }

  /** Units this nation is allowed to build right now (ignoring buildings). */
  function unlockedUnits(nation) {
    var out = [];
    for (var i = 0; i < UnitData.UNITS.length; i++) {
      var t = UnitData.UNITS[i];
      if (t.req.tech && !hasTech(nation, t.req.tech)) continue;
      out.push(t);
    }
    return out;
  }

  function canBuildUnitHere(state, prov, type) {
    if (!prov.nationId) return { ok: false, why: 'Not your territory' };
    var nation = state.nationById[prov.nationId];
    if (type.req.tech && !hasTech(nation, type.req.tech)) {
      return { ok: false, why: 'Requires ' + ResearchData.BY_ID[type.req.tech].name };
    }
    var need = type.req.building, lvl = type.req.level || 1;
    if (need && buildingLevel(prov, need) < lvl) {
      return { ok: false, why: 'Requires ' + BuildingData.BY_ID[need].name + ' L' + lvl };
    }
    return { ok: true };
  }

  SWW.economy = {
    techBonus: techBonus, hasTech: hasTech, buildingLevel: buildingLevel,
    buildingEffect: buildingEffect, moraleFactor: moraleFactor,
    provinceOutput: provinceOutput, provinceConsumption: provinceConsumption,
    nationIncome: nationIncome, nationUpkeep: nationUpkeep, netIncome: netIncome,
    refreshSupplyDistance: refreshSupplyDistance, moraleTarget: moraleTarget,
    tickMorale: tickMorale, tickResources: tickResources, tickRepair: tickRepair,
    tickEntrench: tickEntrench, tickConstruction: tickConstruction,
    tickProduction: tickProduction, tickResearch: tickResearch,
    payCost: payCost, canAfford: canAfford, refundCost: refundCost,
    unlockedUnits: unlockedUnits, canBuildUnitHere: canBuildUnitHere,
    unitBuildTime: unitBuildTime
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
