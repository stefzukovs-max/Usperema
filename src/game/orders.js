/*
 * Orders: pathfinding, movement, stack management, construction and the
 * production/research queues.  Anything the player or the AI can *do* lives
 * here so both go through identical rules.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};
  var UnitData = IA.UnitData;
  var BuildingData = IA.BuildingData;
  var ResearchData = IA.ResearchData;
  var TERRAIN = IA.worldgen.TERRAIN;
  var Heap = IA.util.Heap;

  /*
   * Ships are the fastest thing on this map, and have to be: a sea zone spans
   * far more ground than a province, so at a marching pace a squadron spends a
   * month reaching its station and the naval war never happens at all.
   */
  var SEA_TRANSPORT_SPEED = 1.7;

  /** 'land' | 'sea' | 'air' — what kind of terrain this stack operates on. */
  function armyDomain(army) {
    var hasSea = false, hasLand = false, allAir = true;
    for (var i = 0; i < army.units.length; i++) {
      var t = UnitData.BY_ID[army.units[i].typeId];
      if (t.domain === 'sea') hasSea = true;
      else if (t.domain === 'land') { hasLand = true; allAir = false; }
      if (t.domain !== 'air') allAir = false;
    }
    if (allAir && army.units.length) return 'air';
    if (hasSea && !hasLand) return 'sea';
    return 'land';
  }

  function isTransported(state, army) {
    return armyDomain(army) === 'land' && state.provinces[army.provinceId].isSea;
  }

  /** May this army legally stand in this province? */
  function canEnter(state, army, prov) {
    if (!prov || prov.size === 0) return false;
    var domain = armyDomain(army);
    if (domain === 'sea' && !prov.isSea) return false;
    if (domain === 'land' && prov.isSea) {
      // Land forces cross water as transports.
      return true;
    }
    if (prov.isSea) return true;
    if (!prov.nationId) return true;
    if (prov.nationId === army.ownerId) return true;
    var rel = IA.state.treaty(state, army.ownerId, prov.nationId);
    return rel === 'war' || rel === 'alliance';
  }

  function armySpeed(state, army, destProv) {
    var nation = state.nationById[army.ownerId];
    var base = Infinity;
    for (var i = 0; i < army.units.length; i++) {
      var t = UnitData.BY_ID[army.units[i].typeId];
      if (t.speed < base) base = t.speed;
    }
    if (!isFinite(base) || base <= 0) return 0;
    var domain = armyDomain(army);
    if (domain === 'land') {
      base *= 1 + IA.economy.techBonus(nation, 'speed');
      if (destProv.isSea) {
        base = SEA_TRANSPORT_SPEED * (1 + IA.economy.techBonus(nation, 'seaSpeed'));
      } else {
        base *= TERRAIN[destProv.terrain] ? TERRAIN[destProv.terrain].speed : 1;
      }
      base *= IA.weather.of(destProv).speed;
      base *= IA.commanders.effectOf(state, army).speed;
    }
    return base;
  }

  function edgeDistance(state, aId, bId) {
    var a = state.provinces[aId], b = state.provinces[bId];
    var dx = a.cx - b.cx, dy = a.cy - b.cy;
    return Math.max(1.5, Math.sqrt(dx * dx + dy * dy));
  }

  function legHours(state, army, fromId, toId) {
    var speed = armySpeed(state, army, state.provinces[toId]);
    if (speed <= 0) return Infinity;
    return edgeDistance(state, fromId, toId) / speed;
  }

  /** Dijkstra over the province graph, weighted by travel time. */
  function findPath(state, army, fromId, toId) {
    if (fromId === toId) return [];
    var dist = {}, prev = {}, done = {};
    dist[fromId] = 0;
    var heap = new Heap(function (x, y) { return x.d - y.d; });
    heap.push({ id: fromId, d: 0 });
    while (heap.size) {
      var cur = heap.pop();
      if (done[cur.id]) continue;
      done[cur.id] = true;
      if (cur.id === toId) break;
      var nb = state.provinces[cur.id].neighbors;
      for (var i = 0; i < nb.length; i++) {
        var nid = nb[i];
        var np = state.provinces[nid];
        if (done[nid]) continue;
        if (!canEnter(state, army, np)) continue;
        var w = legHours(state, army, cur.id, nid);
        if (!isFinite(w)) continue;
        var nd = cur.d + w;
        if (dist[nid] === undefined || nd < dist[nid]) {
          dist[nid] = nd;
          prev[nid] = cur.id;
          heap.push({ id: nid, d: nd });
        }
      }
    }
    if (dist[toId] === undefined) return null;
    var path = [], walk = toId;
    while (walk !== fromId) { path.unshift(walk); walk = prev[walk]; }
    return path;
  }

  function issueMove(state, army, targetProvinceId, opts) {
    opts = opts || {};
    if (army.provinceId === targetProvinceId) {
      army.path = []; army.order = null; return { ok: true };
    }
    var target = state.provinces[targetProvinceId];
    if (!canEnter(state, army, target)) return { ok: false, why: 'That army cannot enter ' + target.name + '.' };
    var path = findPath(state, army, army.provinceId, targetProvinceId);
    if (!path) return { ok: false, why: 'No route to ' + target.name + '.' };
    army.path = path;
    army.order = { type: opts.retreat ? 'retreat' : 'move', target: targetProvinceId };
    army.entrench = 0;
    startLeg(state, army);
    return { ok: true, hours: estimateTravel(state, army, path) };
  }

  function estimateTravel(state, army, path) {
    var total = 0, from = army.provinceId;
    for (var i = 0; i < path.length; i++) {
      total += legHours(state, army, from, path[i]);
      from = path[i];
    }
    return total;
  }

  function startLeg(state, army) {
    if (!army.path.length) { army.legRemaining = 0; army.legTotal = 0; return; }
    var h = legHours(state, army, army.provinceId, army.path[0]);
    army.legTotal = h;
    army.legRemaining = h;
  }

  function issueBombard(state, army, targetProvinceId) {
    var reach = IA.combat.maxRange(state, army);
    if (reach <= 0) return { ok: false, why: 'This stack has no ranged weapons.' };
    var d = IA.combat.provinceDistance(state, army.provinceId, targetProvinceId, reach);
    if (d > reach) return { ok: false, why: 'Target is out of range.' };
    army.path = [];
    army.order = { type: 'bombard', target: targetProvinceId };
    return { ok: true };
  }

  function stopArmy(state, army) {
    army.path = [];
    army.legRemaining = 0;
    army.order = null;
  }

  function tickMovement(state, hours) {
    var moved = false;
    for (var i = 0; i < state.armies.length; i++) {
      var army = state.armies[i];
      if (!army.path.length) continue;
      var remaining = hours;
      var guard = 0;
      while (remaining > 0 && army.path.length && guard++ < 40) {
        if (army.legRemaining > remaining) { army.legRemaining -= remaining; remaining = 0; break; }
        remaining -= army.legRemaining;
        var next = army.path.shift();
        var nextProv = state.provinces[next];
        if (!canEnter(state, army, nextProv)) {
          // Circumstances changed mid-march (a treaty, a lost claim).
          stopArmy(state, army);
          break;
        }
        army.provinceId = next;
        army.entrench = 0;
        moved = true;
        if (!army.path.length) {
          army.legRemaining = 0;
          army.legTotal = 0;
          onArrive(state, army);
          break;
        }
        startLeg(state, army);
      }
    }
    // One invalidation for the whole pass: bumping per step would rebuild the
    // army index hundreds of times an hour.
    if (moved) IA.state.touchArmies(state);
  }

  function onArrive(state, army) {
    var prov = state.provinces[army.provinceId];
    var nation = state.nationById[army.ownerId];
    if (army.order && army.order.type !== 'bombard') army.order = null;
    if (nation && nation.isPlayer) {
      IA.state.pushLog(state, 'move', army.name + ' has arrived in ' + prov.name + '.',
        { provinceId: prov.id, armyId: army.id });
    }
  }

  // --- stack management ----------------------------------------------------

  function canMerge(state, a, b) {
    if (a.ownerId !== b.ownerId) return false;
    if (a.provinceId !== b.provinceId) return false;
    if (a.path.length || b.path.length) return false;
    if (armyDomain(a) !== armyDomain(b)) return false;
    return true;
  }

  function mergeArmies(state, target, source) {
    if (!canMerge(state, target, source)) return { ok: false, why: 'These stacks cannot merge.' };
    for (var i = 0; i < source.units.length; i++) {
      var g = source.units[i], found = null;
      for (var j = 0; j < target.units.length; j++) {
        if (target.units[j].typeId === g.typeId) { found = target.units[j]; break; }
      }
      if (found) { found.count += g.count; found.hp += g.hp; }
      else target.units.push({ typeId: g.typeId, count: g.count, hp: g.hp });
    }
    // The officer comes across with his men if the receiving stack has none.
    IA.commanders.transfer(state, source, target);
    IA.state.removeArmy(state, source);
    target.entrench = Math.min(target.entrench, source.entrench);
    return { ok: true };
  }

  /** Detach `groups` ([{typeId, count}]) into a new stack in the same province. */
  function splitArmy(state, army, groups) {
    if (army.path.length) return { ok: false, why: 'Cannot split a moving stack.' };
    var taken = [];
    for (var i = 0; i < groups.length; i++) {
      var want = groups[i];
      for (var j = 0; j < army.units.length; j++) {
        var g = army.units[j];
        if (g.typeId !== want.typeId) continue;
        var n = Math.min(g.count, want.count);
        if (n <= 0) continue;
        var perHp = g.hp / g.count;
        g.count -= n;
        g.hp -= perHp * n;
        taken.push({ typeId: g.typeId, count: n, hp: perHp * n });
      }
    }
    army.units = army.units.filter(function (g) { return g.count > 0; });
    if (!taken.length) return { ok: false, why: 'Nothing selected.' };
    if (!army.units.length) {
      // Everything was taken; nothing to split.
      army.units = taken;
      return { ok: false, why: 'Cannot split the entire stack.' };
    }
    var fresh = {
      id: 'a' + (state.armySeq++), ownerId: army.ownerId, provinceId: army.provinceId,
      units: taken, path: [], legRemaining: 0, legTotal: 0, order: null,
      inCombat: false, entrench: army.entrench, name: null, fuelStarved: false
    };
    fresh.name = IA.state.defaultArmyName(state, fresh);
    state.armies.push(fresh);
    IA.state.touchArmies(state);
    return { ok: true, army: fresh };
  }

  // --- province actions ----------------------------------------------------

  function startConstruction(state, prov, buildingId) {
    var nation = state.nationById[prov.nationId];
    if (!nation) return { ok: false, why: 'Not your province.' };
    if (prov.construction) return { ok: false, why: 'Already building here.' };
    var b = BuildingData.BY_ID[buildingId];
    if (!b) return { ok: false, why: 'Unknown building.' };
    if (b.coastalOnly && !prov.coastal) return { ok: false, why: 'Coastal provinces only.' };
    var level = (prov.buildings[buildingId] || 0) + 1;
    if (level > b.maxLevel) return { ok: false, why: 'Already at maximum level.' };
    var cost = BuildingData.costFor(buildingId, level);
    if (!IA.economy.canAfford(nation, cost)) return { ok: false, why: 'Insufficient resources.' };
    IA.economy.payCost(nation, cost);
    var time = BuildingData.timeFor(buildingId, level);
    prov.construction = { buildingId: buildingId, level: level, remaining: time, total: time, cost: cost };
    return { ok: true };
  }

  function cancelConstruction(state, prov) {
    if (!prov.construction) return { ok: false, why: 'Nothing under construction.' };
    var nation = state.nationById[prov.nationId];
    if (nation) IA.economy.refundCost(nation, prov.construction.cost, 0.6);
    prov.construction = null;
    return { ok: true };
  }

  function queueUnit(state, prov, typeId) {
    var nation = state.nationById[prov.nationId];
    if (!nation) return { ok: false, why: 'Not your province.' };
    var type = UnitData.BY_ID[typeId];
    if (!type) return { ok: false, why: 'Unknown unit.' };
    var check = IA.economy.canBuildUnitHere(state, prov, type);
    if (!check.ok) return { ok: false, why: check.why };
    if (prov.queue.length >= 5) return { ok: false, why: 'Production queue is full.' };
    if (!IA.economy.canAfford(nation, type.cost)) return { ok: false, why: 'Insufficient resources.' };
    IA.economy.payCost(nation, type.cost);
    var time = IA.economy.unitBuildTime(state, nation, type);
    prov.queue.push({ typeId: typeId, remaining: time, total: time, cost: type.cost });
    return { ok: true };
  }

  function cancelQueued(state, prov, index) {
    if (index < 0 || index >= prov.queue.length) return { ok: false, why: 'No such job.' };
    var job = prov.queue.splice(index, 1)[0];
    var nation = state.nationById[prov.nationId];
    if (nation) IA.economy.refundCost(nation, job.cost, 0.7);
    return { ok: true };
  }

  function techAvailable(nation, tech) {
    if (nation.research[tech.id]) return false;
    for (var i = 0; i < tech.req.length; i++) if (!nation.research[tech.req[i]]) return false;
    return true;
  }

  function startResearch(state, nation, techId) {
    if (nation.researching) return { ok: false, why: 'Already researching ' + ResearchData.BY_ID[nation.researching.techId].name + '.' };
    var tech = ResearchData.BY_ID[techId];
    if (!tech) return { ok: false, why: 'Unknown technology.' };
    if (!techAvailable(nation, tech)) return { ok: false, why: 'Prerequisites not met.' };
    if (!IA.economy.canAfford(nation, tech.cost)) return { ok: false, why: 'Insufficient resources.' };
    IA.economy.payCost(nation, tech.cost);
    var hours = tech.days * 24;
    nation.researching = { techId: techId, remaining: hours, total: hours, cost: tech.cost };
    return { ok: true };
  }

  function cancelResearch(state, nation) {
    if (!nation.researching) return { ok: false, why: 'Nothing in progress.' };
    IA.economy.refundCost(nation, nation.researching.cost, 0.5);
    nation.researching = null;
    return { ok: true };
  }

  /** Gold shortcut: finish whatever this province is working on. */
  function rushWithGold(state, nation, kind, ref) {
    var cost;
    if (kind === 'construction') {
      if (!ref.construction) return { ok: false, why: 'Nothing under construction.' };
      cost = Math.max(1, Math.ceil(ref.construction.remaining / 2));
      if (nation.resources.gold < cost) return { ok: false, why: 'Not enough gold (' + cost + ' needed).' };
      nation.resources.gold -= cost;
      ref.construction.remaining = 0.01;
      return { ok: true, cost: cost };
    }
    if (kind === 'unit') {
      if (!ref.queue.length) return { ok: false, why: 'Nothing in production.' };
      cost = Math.max(1, Math.ceil(ref.queue[0].remaining / 2));
      if (nation.resources.gold < cost) return { ok: false, why: 'Not enough gold (' + cost + ' needed).' };
      nation.resources.gold -= cost;
      ref.queue[0].remaining = 0.01;
      return { ok: true, cost: cost };
    }
    if (kind === 'research') {
      if (!nation.researching) return { ok: false, why: 'Nothing being researched.' };
      cost = Math.max(1, Math.ceil(nation.researching.remaining / 3));
      if (nation.resources.gold < cost) return { ok: false, why: 'Not enough gold (' + cost + ' needed).' };
      nation.resources.gold -= cost;
      nation.researching.remaining = 0.01;
      return { ok: true, cost: cost };
    }
    return { ok: false, why: 'Nothing to rush.' };
  }

  IA.orders = {
    armyDomain: armyDomain, canEnter: canEnter, armySpeed: armySpeed, legHours: legHours,
    findPath: findPath, issueMove: issueMove, issueBombard: issueBombard, stopArmy: stopArmy,
    estimateTravel: estimateTravel, tickMovement: tickMovement, canMerge: canMerge,
    mergeArmies: mergeArmies, splitArmy: splitArmy, startConstruction: startConstruction,
    cancelConstruction: cancelConstruction, queueUnit: queueUnit, cancelQueued: cancelQueued,
    startResearch: startResearch, cancelResearch: cancelResearch, techAvailable: techAvailable,
    rushWithGold: rushWithGold, isTransported: isTransported, edgeDistance: edgeDistance
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
