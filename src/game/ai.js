/*
 * Opponent AI.
 *
 * Each AI nation gets a turn every few game hours (staggered so the work is
 * spread out).  A turn runs five short passes: research, construction,
 * production, trade, then military and diplomacy.
 */
(function (global) {
  'use strict';

  var SWW = global.SWW = global.SWW || {};
  var UnitData = SWW.UnitData;
  var BuildingData = SWW.BuildingData;
  var ResearchData = SWW.ResearchData;

  var TURN_INTERVAL = 6;      // game hours between turns for one nation

  var TECH_PRIORITY = [
    'conscription', 'small_arms', 'logistics', 'armour', 'artillery',
    'war_economy', 'mech_inf', 'air_defence', 'body_armour', 'field_hospitals',
    'rotary_wing', 'guided_shells', 'naval_doctrine', 'mbt', 'reactive_armour',
    'jet_engine', 'total_mobilisation', 'urban_warfare', 'amphibious',
    'submarine_warfare', 'strategic_bombing', 'stealth', 'rocketry',
    'satellites', 'carrier_ops'
  ];

  function tick(state, rng, hours) {
    for (var i = 0; i < state.nations.length; i++) {
      var nation = state.nations[i];
      if (!nation.alive || !nation.ai) continue;
      nation.nextTurn = nation.nextTurn === undefined
        ? state.time + (i % TURN_INTERVAL)
        : nation.nextTurn;
      if (state.time < nation.nextTurn) continue;
      nation.nextTurn = state.time + TURN_INTERVAL;
      takeTurn(state, rng, nation);
    }
  }

  function takeTurn(state, rng, nation) {
    doResearch(state, nation);
    doConstruction(state, rng, nation);
    doProduction(state, rng, nation);
    doTrade(state, nation);
    doMilitary(state, rng, nation);
    doDiplomacy(state, rng, nation);
  }

  // --- research ------------------------------------------------------------

  function doResearch(state, nation) {
    if (nation.researching) return;
    for (var i = 0; i < TECH_PRIORITY.length; i++) {
      var tech = ResearchData.BY_ID[TECH_PRIORITY[i]];
      if (!tech || !SWW.orders.techAvailable(nation, tech)) continue;
      if (!SWW.economy.canAfford(nation, tech.cost)) continue;
      // Keep a cash cushion so the war effort does not stall.
      if (nation.resources.cash - (tech.cost.cash || 0) < 6000) continue;
      SWW.orders.startResearch(state, nation, tech.id);
      return;
    }
  }

  // --- construction --------------------------------------------------------

  function borderPressure(state, prov) {
    var pressure = 0;
    for (var i = 0; i < prov.neighbors.length; i++) {
      var np = state.provinces[prov.neighbors[i]];
      if (np.isSea || !np.nationId || np.nationId === prov.nationId) continue;
      pressure += SWW.state.atWar(state, prov.nationId, np.nationId) ? 3 : 1;
    }
    return pressure;
  }

  function doConstruction(state, rng, nation) {
    if (nation.resources.cash < 6000) return;
    var best = null;
    for (var i = 0; i < nation.provinces.length; i++) {
      var prov = state.provinces[nation.provinces[i]];
      if (!prov || prov.construction) continue;
      var choice = pickBuilding(state, nation, prov);
      if (!choice) continue;
      var cost = BuildingData.costFor(choice.id, (prov.buildings[choice.id] || 0) + 1);
      if (!SWW.economy.canAfford(nation, cost)) continue;
      if (!best || choice.score > best.score) best = { prov: prov, id: choice.id, score: choice.score };
    }
    if (best) SWW.orders.startConstruction(state, best.prov, best.id);
  }

  function pickBuilding(state, nation, prov) {
    var lvl = function (id) { return prov.buildings[id] || 0; };
    var options = [];
    var pressure = borderPressure(state, prov);

    if (lvl('recruiting') < 1) options.push({ id: 'recruiting', score: 100 });
    if (prov.isCapital && lvl('arms_factory') < 1) options.push({ id: 'arms_factory', score: 95 });
    if (lvl('industry') < 3) options.push({ id: 'industry', score: 70 + prov.pop * 0.2 - lvl('industry') * 12 });
    if (lvl('recruiting') < 2 && prov.pop > 40) options.push({ id: 'recruiting', score: 60 });
    if (pressure >= 3 && lvl('bunker') < 2) options.push({ id: 'bunker', score: 65 + pressure * 4 });
    if (lvl('arms_factory') < 2 && nation.provinces.length > 6 && prov.pop > 45) {
      options.push({ id: 'arms_factory', score: 55 });
    }
    if (prov.morale < 60 && lvl('propaganda') < 2) options.push({ id: 'propaganda', score: 58 });
    if (lvl('airbase') < 1 && prov.isCapital && SWW.economy.hasTech(nation, 'rotary_wing')) {
      options.push({ id: 'airbase', score: 50 });
    }
    if (prov.coastal && lvl('naval_base') < 1 && SWW.economy.hasTech(nation, 'naval_doctrine')) {
      options.push({ id: 'naval_base', score: 45 });
    }

    var best = null;
    for (var i = 0; i < options.length; i++) {
      var b = BuildingData.BY_ID[options[i].id];
      if (b.coastalOnly && !prov.coastal) continue;
      if ((prov.buildings[options[i].id] || 0) >= b.maxLevel) continue;
      if (!best || options[i].score > best.score) best = options[i];
    }
    return best;
  }

  // --- production ----------------------------------------------------------

  /*
   * What the nation wants, capped by what it can actually feed and pay for.
   * Without the second half, small countries at war raise armies that starve
   * themselves within a week.
   */
  function desiredArmySize(state, nation) {
    var want = Math.round(3 + nation.provinces.length * 1.4 + (nation.warCount || 0) * 4);
    var income = nation.income;
    if (income) {
      // Roughly the running cost of one infantry battalion, with headroom.
      var byFood = income.food / 3.6;
      var byCash = income.cash / 7.5;
      want = Math.min(want, Math.floor(Math.min(byFood, byCash)));
    }
    return Math.max(1, want);
  }

  function doProduction(state, rng, nation) {
    // Never dig the hole deeper while already running a deficit.
    var net = nation.net;
    if (net && (net.food < 0 || net.cash < 0)) return;

    var armies = SWW.state.armiesOf(state, nation.id);
    var battalions = 0;
    for (var i = 0; i < armies.length; i++) battalions += SWW.state.unitCount(armies[i]);
    var queued = 0;
    for (var q = 0; q < nation.provinces.length; q++) queued += state.provinces[nation.provinces[q]].queue.length;
    if (battalions + queued >= desiredArmySize(state, nation)) return;

    var wishlist = buildWishlist(state, nation);
    for (var w = 0; w < wishlist.length; w++) {
      var typeId = wishlist[w];
      var type = UnitData.BY_ID[typeId];
      if (!SWW.economy.canAfford(nation, type.cost)) continue;
      var prov = pickProductionProvince(state, nation, type);
      if (!prov) continue;
      var res = SWW.orders.queueUnit(state, prov, typeId);
      if (res.ok) return;
    }
  }

  function buildWishlist(state, nation) {
    var list = [];
    var r = nation.resources;
    if (SWW.economy.hasTech(nation, 'mbt') && r.cash > 30000) list.push('mbt');
    if (SWW.economy.hasTech(nation, 'armour') && r.cash > 14000) list.push('light_tank');
    if (SWW.economy.hasTech(nation, 'artillery') && r.cash > 12000) list.push('artillery');
    if (SWW.economy.hasTech(nation, 'mech_inf') && r.cash > 10000) list.push('mech_inf');
    if (SWW.economy.hasTech(nation, 'air_defence') && r.cash > 20000) list.push('sam');
    list.push('infantry');
    return list;
  }

  function pickProductionProvince(state, nation, type) {
    var best = null;
    for (var i = 0; i < nation.provinces.length; i++) {
      var prov = state.provinces[nation.provinces[i]];
      if (!prov || prov.queue.length >= 3) continue;
      if (!SWW.economy.canBuildUnitHere(state, prov, type).ok) continue;
      var score = 100 - prov.queue.length * 20 - (prov.supplyDist || 0) * 3 + prov.pop * 0.1;
      if (!best || score > best.score) best = { prov: prov, score: score };
    }
    return best ? best.prov : null;
  }

  // --- trade ---------------------------------------------------------------

  function doTrade(state, nation) {
    var market = SWW.market;
    var r = nation.resources;
    var income = nation.net || {};
    for (var i = 0; i < market.TRADED.length; i++) {
      var res = market.TRADED[i];
      var flow = income[res] || 0;
      var lowWater = res === 'food' ? 3000 : 900;
      if (r[res] < lowWater && flow < 0 && r.cash > 8000) {
        market.buy(state, nation, res, Math.min(1200, Math.floor(r.cash * 0.25 / market.buyPrice(state, res))));
      } else if (r[res] > 22000 && flow > 0) {
        market.sell(state, nation, res, Math.floor((r[res] - 18000) * 0.5));
      }
    }
  }

  // --- military ------------------------------------------------------------

  function estimateDefence(state, provinceId, attackerId) {
    var defenders = SWW.state.allArmiesAt(state, provinceId).filter(function (a) {
      return SWW.state.isHostile(state, attackerId, a.ownerId) ||
        (state.provinces[provinceId].nationId && a.ownerId === state.provinces[provinceId].nationId);
    });
    var power = 0;
    for (var i = 0; i < defenders.length; i++) power += SWW.state.armyPower(defenders[i]);
    var prov = state.provinces[provinceId];
    if (!prov.isSea) {
      power *= 1 + SWW.economy.buildingEffect(prov, 'bunker', 'defence');
      power *= SWW.worldgen.TERRAIN[prov.terrain] ? SWW.worldgen.TERRAIN[prov.terrain].def : 1;
    }
    return power;
  }

  /** Provinces this nation would like to take, nearest first. */
  function findObjectives(state, nation) {
    var seen = {}, out = [];
    for (var i = 0; i < nation.provinces.length; i++) {
      var prov = state.provinces[nation.provinces[i]];
      for (var j = 0; j < prov.neighbors.length; j++) {
        var np = state.provinces[prov.neighbors[j]];
        if (np.isSea || seen[np.id]) continue;
        if (np.nationId === nation.id) continue;
        if (np.nationId && !SWW.state.atWar(state, nation.id, np.nationId)) continue;
        seen[np.id] = true;
        out.push(np);
      }
    }
    return out;
  }

  function doMilitary(state, rng, nation) {
    var armies = SWW.state.armiesOf(state, nation.id);
    var objectives = findObjectives(state, nation);

    // Consolidate: merge idle stacks that share a province.
    var byProv = {};
    for (var i = 0; i < armies.length; i++) {
      var a = armies[i];
      if (a.path.length || a.inCombat) continue;
      (byProv[a.provinceId] || (byProv[a.provinceId] = [])).push(a);
    }
    for (var pid in byProv) {
      var group = byProv[pid];
      for (var g = 1; g < group.length; g++) {
        if (SWW.state.unitCount(group[0]) >= 8) break;
        if (SWW.orders.canMerge(state, group[0], group[g])) {
          SWW.orders.mergeArmies(state, group[0], group[g]);
        }
      }
    }

    armies = SWW.state.armiesOf(state, nation.id);
    var claimed = {};
    for (var k = 0; k < armies.length; k++) {
      var army = armies[k];
      if (army.path.length || army.inCombat) continue;
      var power = SWW.state.armyPower(army);
      var domain = SWW.orders.armyDomain(army);

      // Artillery and other ranged stacks shell rather than charge.
      var reach = SWW.combat.maxRange(state, army);
      if (reach > 0 && domain !== 'sea') {
        var shellTarget = pickBombardTarget(state, nation, army, reach);
        if (shellTarget) { SWW.orders.issueBombard(state, army, shellTarget); continue; }
      }

      if (domain === 'sea') { patrol(state, rng, army); continue; }

      /*
       * Score every objective with cheap straight-line distance first, then
       * pathfind only for the best few.  Running a full route search for every
       * candidate is what made the AI the most expensive part of the tick.
       */
      var here = state.provinces[army.provinceId];
      var ranked = [];
      for (var o = 0; o < objectives.length; o++) {
        var target = objectives[o];
        if (claimed[target.id] && claimed[target.id] > 1) continue;
        if (!SWW.orders.canEnter(state, army, target)) continue;
        var defence = estimateDefence(state, target.id, nation.id);
        if (power < defence * 1.15 + 4) continue;
        var dx = target.cx - here.cx, dy = target.cy - here.cy;
        var crow = Math.sqrt(dx * dx + dy * dy);
        ranked.push({ target: target, score: target.vp + (target.nationId ? 6 : 0) - crow * 0.25 });
      }
      ranked.sort(function (x, y) { return y.score - x.score; });

      var chosen = null;
      for (var c = 0; c < ranked.length && c < 3; c++) {
        var path = SWW.orders.findPath(state, army, army.provinceId, ranked[c].target.id);
        if (path) { chosen = ranked[c].target; break; }
      }
      if (chosen) {
        claimed[chosen.id] = (claimed[chosen.id] || 0) + 1;
        SWW.orders.issueMove(state, army, chosen.id);
        continue;
      }

      // Nothing worth attacking: garrison the most exposed province.
      var threat = mostThreatenedProvince(state, nation);
      if (threat && threat.id !== army.provinceId && SWW.state.armiesIn(state, threat.id).length < 2) {
        SWW.orders.issueMove(state, army, threat.id);
      }
    }
  }

  function pickBombardTarget(state, nation, army, reach) {
    var prov = state.provinces[army.provinceId];
    var best = null;
    for (var i = 0; i < prov.neighbors.length; i++) {
      var np = state.provinces[prov.neighbors[i]];
      var enemies = SWW.state.allArmiesAt(state, np.id).filter(function (o) {
        return SWW.state.isHostile(state, nation.id, o.ownerId);
      });
      if (!enemies.length) continue;
      var power = 0;
      for (var e = 0; e < enemies.length; e++) power += SWW.state.armyPower(enemies[e]);
      if (!best || power > best.power) best = { id: np.id, power: power };
    }
    return best ? best.id : null;
  }

  function mostThreatenedProvince(state, nation) {
    var best = null;
    for (var i = 0; i < nation.provinces.length; i++) {
      var prov = state.provinces[nation.provinces[i]];
      var threat = 0;
      for (var j = 0; j < prov.neighbors.length; j++) {
        var np = state.provinces[prov.neighbors[j]];
        var enemies = SWW.state.allArmiesAt(state, np.id).filter(function (o) {
          return SWW.state.isHostile(state, nation.id, o.ownerId);
        });
        for (var e = 0; e < enemies.length; e++) threat += SWW.state.armyPower(enemies[e]);
      }
      threat += prov.isCapital ? 20 : 0;
      if (threat <= 0) continue;
      if (!best || threat > best.threat) best = { id: prov.id, threat: threat };
    }
    return best ? state.provinces[best.id] : null;
  }

  function patrol(state, rng, army) {
    var prov = state.provinces[army.provinceId];
    if (!prov.neighbors.length) return;
    var options = prov.neighbors.filter(function (id) {
      return state.provinces[id].isSea;
    });
    if (!options.length) return;
    if (rng.chance(0.4)) SWW.orders.issueMove(state, army, rng.pick(options));
  }

  // --- diplomacy -----------------------------------------------------------

  function doDiplomacy(state, rng, nation) {
    var i, other;
    // Sue for peace when the war is going badly.
    if (nation.warCount > 0) {
      var enemies = Object.keys(nation.treaties);
      for (i = 0; i < enemies.length; i++) {
        other = state.nationById[enemies[i]];
        if (!other || !other.alive || other.id === nation.id) continue;
        if (nation.treaties[other.id] !== 'war') continue;
        var mine = SWW.state.nationPower(state, nation.id) + nation.vp * 2;
        var theirs = SWW.state.nationPower(state, other.id) + other.vp * 2;
        if (theirs > mine * 1.5 || nation.warCount >= 3 || nation.shortage) {
          if (rng.chance(0.3)) SWW.diplomacy.proposeTreaty(state, nation.id, other.id, 'peace');
        }
      }
      return;
    }

    // Otherwise look for an opportunity, or a friend.  Nobody shoots first in
    // the opening days; the map needs time to settle.
    var mayDeclare = state.time > 72;      // a few days of calm before the first shot
    var contacts = nation.contacts || [];
    if (mayDeclare && contacts.length && rng.chance(nation.aggression * 0.16)) {
      var prey = null;
      // Only bordering nations are worth a war; there is no way to reach the
      // rest without a navy and a reason.
      for (i = 0; i < contacts.length; i++) {
        other = state.nationById[contacts[i]];
        if (!other || !other.alive || other.id === nation.id) continue;
        var t = SWW.state.treaty(state, nation.id, other.id);
        if (t === 'alliance' || t === 'nap' || t === 'war') continue;
        var rel = SWW.diplomacy.relation(state, nation.id, other.id);
        if (rel > 25) continue;
        var myP = SWW.state.nationPower(state, nation.id);
        var theirP = SWW.state.nationPower(state, other.id);
        if (theirP > myP * 0.75) continue;
        var score = (myP - theirP) + other.vp - rel;
        if (!prey || score > prey.score) prey = { id: other.id, score: score };
      }
      if (prey) SWW.diplomacy.declareWar(state, nation.id, prey.id, 'territorial claims');
      return;
    }

    if (rng.chance(0.12) && contacts.length) {
      var friend = null;
      for (i = 0; i < contacts.length; i++) {
        other = state.nationById[contacts[i]];
        if (!other || !other.alive || other.id === nation.id) continue;
        if (SWW.state.treaty(state, nation.id, other.id) !== 'peace') continue;
        var r = SWW.diplomacy.relation(state, nation.id, other.id);
        if (r < 10) continue;
        if (!friend || r > friend.rel) friend = { id: other.id, rel: r };
      }
      if (friend) {
        SWW.diplomacy.proposeTreaty(state, nation.id, friend.id, friend.rel > 45 ? 'alliance' : 'nap');
      }
    }
  }

  SWW.ai = { tick: tick, takeTurn: takeTurn, findObjectives: findObjectives, TURN_INTERVAL: TURN_INTERVAL };
})(typeof globalThis !== 'undefined' ? globalThis : this);
