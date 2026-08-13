/*
 * Economy: province output, national income and upkeep, morale, construction,
 * unit production and research progress.  Everything here runs once per whole
 * game hour.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};
  var UnitData = IA.UnitData;
  var BuildingData = IA.BuildingData;
  var ResearchData = IA.ResearchData;
  var clamp = IA.util.clamp;

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
    var out = { manpower: 0, grain: 0, iron: 0, oil: 0, shells: 0, coal: 0, money: 0 };
    if (prov.isSea || !prov.nationId || prov.size === 0) return out;
    var nation = state.nationById[prov.nationId];
    if (!nation) return out;

    var mf = moraleFactor(prov);
    var pop = prov.pop;
    var prodTech = 1 + techBonus(nation, 'production');
    var industry = 1 + buildingEffect(prov, 'factory', 'deposit') +
      buildingEffect(prov, 'railway', 'deposit');

    // Every province farms; a grain deposit means it farms well.
    out.grain += pop * FARM_RATE * mf * prodTech;
    if (prov.deposit) {
      out[prov.deposit] += pop * DEPOSIT_RATE * mf * industry * prodTech;
    }
    out.money += pop * CASH_RATE * mf * (1 + buildingEffect(prov, 'factory', 'money') +
      buildingEffect(prov, 'railway', 'money') + buildingEffect(prov, 'admin', 'money')) *
      (prov.coastal ? 1.15 : 1);
    out.manpower += pop * MANPOWER_RATE * mf *
      (1 + buildingEffect(prov, 'barracks', 'manpower')) * (1 + techBonus(nation, 'manpower'));

    var arms = buildingEffect(prov, 'workshop', 'shells') + buildingEffect(prov, 'factory', 'shells');
    if (arms > 0) out.shells += arms * mf * (1 + techBonus(nation, 'shellYield'));
    return out;
  }

  /** Materials and coal burned by arms factories producing ammunition. */
  function provinceConsumption(state, prov) {
    var cons = { iron: 0, coal: 0 };
    var arms = buildingEffect(prov, 'workshop', 'shells') + buildingEffect(prov, 'factory', 'shells');
    if (arms > 0) {
      var mf = moraleFactor(prov);
      cons.iron = arms * mf * 0.55;
      cons.coal = arms * mf * 0.40;
    }
    return cons;
  }

  function nationIncome(state, nation) {
    var totals = { manpower: 0, grain: 0, iron: 0, oil: 0, shells: 0, coal: 0, money: 0 };
    for (var i = 0; i < nation.provinces.length; i++) {
      var prov = state.provinces[nation.provinces[i]];
      if (!prov || prov.nationId !== nation.id) continue;
      var o = provinceOutput(state, prov);
      for (var k in totals) totals[k] += o[k] || 0;
      var c = provinceConsumption(state, prov);
      totals.iron -= c.iron;
      totals.coal -= c.coal;
    }
    return totals;
  }

  function nationUpkeep(state, nation) {
    var totals = { grain: 0, oil: 0, money: 0 };
    var armies = IA.state.armiesOf(state, nation.id);
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

  /*
   * Supply.
   *
   * Supply flows out from the capital and from every depot, harbour and
   * railway yard, spreading province by province across ground the nation
   * holds or is allied to.  It does not pass through a province an enemy army
   * is standing in, so a cavalry raid behind the line cuts the front off
   * without having to take the ground first — which is most of the point.
   *
   * Every source has a reach.  Crossing a province spends a unit of it, less
   * where there is a railway to carry it, and what is left on arrival is that
   * province's supply.  Somewhere nothing reaches is out of supply: its morale
   * falls, and an army standing there starts to come apart.
   */
  var CAPITAL_REACH = 5;
  var RAIL_DISCOUNT = 0.45;      // a railway costs this much less to cross
  var ARMY_ATTRITION = 0.75;     // hit points an hour per battalion, unsupplied
  var UNSUPPLIED_ATTACK = 0.62;  // what an unsupplied stack's fire is worth

  /** Max-heap on remaining reach, so each province is settled from its best feed. */
  function Heap() { this.a = []; }
  Heap.prototype.push = function (id, key) {
    var a = this.a, i = a.length;
    a.push({ id: id, key: key });
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (a[p].key >= a[i].key) break;
      var t = a[p]; a[p] = a[i]; a[i] = t;
      i = p;
    }
  };
  Heap.prototype.pop = function () {
    var a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      var i = 0;
      for (;;) {
        var l = i * 2 + 1, r = l + 1, m = i;
        if (l < a.length && a[l].key > a[m].key) m = l;
        if (r < a.length && a[r].key > a[m].key) m = r;
        if (m === i) break;
        var t = a[m]; a[m] = a[i]; a[i] = t;
        i = m;
      }
    }
    return top;
  };

  function supplySources(state, nation) {
    var out = [];
    var extra = techBonus(nation, 'supply');
    var cap = state.provinces[nation.capitalProvince];
    if (cap && cap.nationId === nation.id) {
      out.push({ id: cap.id, reach: CAPITAL_REACH + extra });
    }
    for (var i = 0; i < nation.provinces.length; i++) {
      var p = state.provinces[nation.provinces[i]];
      var r = buildingEffect(p, 'warehouse', 'supply') +
        buildingEffect(p, 'harbour', 'supply') +
        buildingEffect(p, 'railway', 'supply');
      if (r > 0) out.push({ id: p.id, reach: r + extra });
    }
    return out;
  }

  /** Ground a nation's supply may cross: its own, and its allies'. */
  function carriesSupply(state, nation, prov) {
    if (prov.isSea || !prov.nationId) return false;
    if (prov.nationId === nation.id) return true;
    return IA.state.treaty(state, nation.id, prov.nationId) === 'alliance';
  }

  function anyHostile(state, id, owners) {
    for (var i = 0; i < owners.length; i++) {
      if (IA.state.isHostile(state, id, owners[i])) return true;
    }
    return false;
  }

  function spreadSupply(state, nation, occupiers) {
    var supply = nation.supply = {};
    var hops = {};
    var heap = new Heap();
    var sources = supplySources(state, nation);
    var i;
    for (i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (supply[s.id] !== undefined && supply[s.id] >= s.reach) continue;
      supply[s.id] = s.reach;
      hops[s.id] = 0;
      heap.push(s.id, s.reach);
    }
    while (heap.a.length) {
      var top = heap.pop();
      if (top.key < supply[top.id] - 1e-9) continue;              // stale entry
      var prov = state.provinces[top.id];
      var here = occupiers[prov.id];
      if (here && anyHostile(state, nation.id, here)) continue;   // the line is cut here
      for (var k = 0; k < prov.neighbors.length; k++) {
        var np = state.provinces[prov.neighbors[k]];
        if (!carriesSupply(state, nation, np)) continue;
        var left = top.key - (buildingLevel(np, 'railway') ? 1 - RAIL_DISCOUNT : 1);
        if (left < 0) continue;
        if (supply[np.id] !== undefined && supply[np.id] >= left - 1e-9) continue;
        supply[np.id] = left;
        hops[np.id] = hops[prov.id] + 1;
        heap.push(np.id, left);
      }
    }
    for (i = 0; i < nation.provinces.length; i++) {
      var p = state.provinces[nation.provinces[i]];
      p.supply = supply[p.id] || 0;
      p.inSupply = supply[p.id] !== undefined;
      // Hops still drive morale and the AI's sense of where a depot would help.
      p.supplyDist = hops[p.id] !== undefined ? hops[p.id] : 9;
    }
  }

  /**
   * Retrace supply, for every nation or for a named few.  Ground changing hands
   * has to retrace both sides at once: taking the province that was cutting
   * your line should restore it there and then, not at the next midnight.
   */
  function refreshSupply(state, only) {
    // Where troops are standing, so a line can be cut without ground changing
    // hands.  Built once and shared by every trace.
    var occupiers = {};
    for (var a = 0; a < state.armies.length; a++) {
      var army = state.armies[a];
      var list = occupiers[army.provinceId] || (occupiers[army.provinceId] = []);
      if (list.indexOf(army.ownerId) < 0) list.push(army.ownerId);
    }
    var list2 = only
      ? only.map(function (id) { return state.nationById[id]; })
      : state.nations;
    for (var n = 0; n < list2.length; n++) {
      var nation = list2[n];
      if (!nation) continue;
      if (!nation.alive) { nation.supply = {}; continue; }
      spreadSupply(state, nation, occupiers);
    }
  }

  /**
   * An army is fed by the province it stands in or by one next to it, so an
   * invasion reaches one province past its own border and must take ground to
   * push on.  Ships carry their own coal and are left out of it.
   */
  function armyInSupply(state, army) {
    var prov = state.provinces[army.provinceId];
    if (!prov || prov.isSea) return true;
    var nation = state.nationById[army.ownerId];
    if (!nation || !nation.supply) return true;
    if (nation.supply[army.provinceId] !== undefined) return true;
    for (var i = 0; i < prov.neighbors.length; i++) {
      if (nation.supply[prov.neighbors[i]] !== undefined) return true;
    }
    return false;
  }

  function tickAttrition(state, hours) {
    var hurt = false;
    for (var i = 0; i < state.armies.length; i++) {
      var army = state.armies[i];
      army.supplied = armyInSupply(state, army);
      var prov = state.provinces[army.provinceId];
      // Conditions cost men whether or not the supply is getting through; a
      // blizzard does not care that the railhead is intact.
      var rate = (army.supplied ? 0 : ARMY_ATTRITION) + IA.weather.of(prov).attrition;
      if (rate <= 0) continue;
      for (var u = 0; u < army.units.length; u++) {
        var g = army.units[u];
        if (g.count <= 0 || g.hp <= 0) continue;
        var type = UnitData.BY_ID[g.typeId];
        if (!type || type.domain !== 'land') continue;
        g.hp -= rate * g.count * hours;
        hurt = true;
      }
    }
    if (hurt) IA.combat.reconcile(state);
  }

  function moraleTarget(state, prov) {
    if (!prov.nationId) return 50;
    var nation = state.nationById[prov.nationId];
    if (!nation) return 50;
    var t = 100;
    if (!prov.inSupply) t -= 26;                       // cut off from the depots
    else t -= clamp(4 - (prov.supply || 0), 0, 4) * 3.4;   // the thin end of the line
    if (nation.warCount > 0) t -= 6 + Math.min(14, nation.warCount * 3);
    t += buildingEffect(prov, 'fort', 'morale');
    t += buildingEffect(prov, 'admin', 'morale');
    t += buildingEffect(prov, 'factory', 'morale');
    if (prov.isCapital) t += 12;
    if (prov.unrest) t -= prov.unrest;
    if (nation.shortage) t -= 12;
    t += techBonus(nation, 'morale');
    // Being surrounded by hostile territory is demoralising.
    var hostile = 0, total = 0;
    for (var i = 0; i < prov.neighbors.length; i++) {
      var np = state.provinces[prov.neighbors[i]];
      if (np.isSea) continue;
      total++;
      if (np.nationId && np.nationId !== prov.nationId &&
        IA.state.atWar(state, prov.nationId, np.nationId)) hostile++;
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
      var spread = buildingEffect(prov, 'admin', 'moraleSpread');
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
          // Only grain and money actually break an army; running out of
          // coal just stalls production.
          if (flow.net[k] < 0 && (k === 'grain' || k === 'money')) shortage = true;
        }
        nation.resources[k] = next;
      }
      nation.shortage = shortage;
      if (shortage) applyShortageAttrition(state, nation, hours);
    }
  }

  /** Starving or bankrupt armies lose strength. */
  function applyShortageAttrition(state, nation, hours) {
    var armies = IA.state.armiesOf(state, nation.id);
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
        rate *= 1 + buildingEffect(prov, 'airfield', 'airRepair') + buildingEffect(prov, 'harbour', 'navalRepair');
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
          IA.state.pushLog(state, 'build',
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
      var here = IA.state.armiesIn(state, prov.id);
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
        IA.state.spawnArmy(state, prov.nationId, prov.id, [{ typeId: job.typeId, count: 1 }]);
      }
      var nation = state.nationById[prov.nationId];
      if (nation && nation.isPlayer) {
        IA.state.pushLog(state, 'build', type.name + ' ready in ' + prov.name + '.', { provinceId: prov.id });
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
          IA.state.pushLog(state, 'research',
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

  IA.economy = {
    techBonus: techBonus, hasTech: hasTech, buildingLevel: buildingLevel,
    buildingEffect: buildingEffect, moraleFactor: moraleFactor,
    provinceOutput: provinceOutput, provinceConsumption: provinceConsumption,
    nationIncome: nationIncome, nationUpkeep: nationUpkeep, netIncome: netIncome,
    refreshSupply: refreshSupply, armyInSupply: armyInSupply,
    tickAttrition: tickAttrition, UNSUPPLIED_ATTACK: UNSUPPLIED_ATTACK,
    moraleTarget: moraleTarget,
    tickMorale: tickMorale, tickResources: tickResources, tickRepair: tickRepair,
    tickEntrench: tickEntrench, tickConstruction: tickConstruction,
    tickProduction: tickProduction, tickResearch: tickResearch,
    payCost: payCost, canAfford: canAfford, refundCost: refundCost,
    unlockedUnits: unlockedUnits, canBuildUnitHere: canBuildUnitHere,
    unitBuildTime: unitBuildTime
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
