/*
 * Diplomacy: relations, treaties and the offer inbox.
 *
 * Treaty values: 'peace' (default), 'nap' (non-aggression), 'alliance', 'war'.
 * Relations run -100..100 and drive what the AI is willing to sign.
 */
(function (global) {
  'use strict';

  var SWW = global.SWW = global.SWW || {};
  var clamp = SWW.util.clamp;

  var TREATY_LABEL = {
    peace: 'Peace', nap: 'Non-Aggression Pact', alliance: 'Alliance', war: 'At War'
  };

  function relation(state, a, b) {
    var na = state.nationById[a];
    if (!na) return 0;
    var v = na.relations[b];
    return v === undefined ? 0 : v;
  }

  function setRelation(state, a, b, value) {
    var v = clamp(value, -100, 100);
    if (state.nationById[a]) state.nationById[a].relations[b] = v;
    if (state.nationById[b]) state.nationById[b].relations[a] = v;
  }

  function adjustRelation(state, a, b, delta) {
    setRelation(state, a, b, relation(state, a, b) + delta);
  }

  function setTreaty(state, a, b, type) {
    if (state.nationById[a]) state.nationById[a].treaties[b] = type;
    if (state.nationById[b]) state.nationById[b].treaties[a] = type;
  }

  function declareWar(state, a, b, reason) {
    if (a === b) return { ok: false, why: 'Cannot declare war on yourself.' };
    if (SWW.state.treaty(state, a, b) === 'war') return { ok: false, why: 'Already at war.' };
    var na = state.nationById[a], nb = state.nationById[b];
    if (!na || !nb || !na.alive || !nb.alive) return { ok: false, why: 'Nation no longer exists.' };
    setTreaty(state, a, b, 'war');
    setRelation(state, a, b, Math.min(relation(state, a, b), -60));
    // Breaking a pact costs standing with everyone watching.
    for (var i = 0; i < state.nations.length; i++) {
      var third = state.nations[i];
      if (third.id === a || third.id === b) continue;
      adjustRelation(state, a, third.id, -6);
      if (SWW.state.treaty(state, third.id, b) === 'alliance') {
        // Allies of the victim are dragged in.
        if (SWW.state.treaty(state, third.id, a) !== 'war') {
          setTreaty(state, third.id, a, 'war');
          SWW.state.pushLog(state, 'diplomacy',
            third.name + ' honours its alliance and joins the war against ' + na.name + '.',
            { nationId: third.id });
        }
      }
    }
    SWW.state.pushLog(state, 'diplomacy',
      na.name + ' declares war on ' + nb.name + (reason ? ' — ' + reason : '') + '.',
      { nationId: a, otherId: b });
    refreshWarCounts(state);
    return { ok: true };
  }

  function makePeace(state, a, b) {
    if (SWW.state.treaty(state, a, b) !== 'war') return { ok: false, why: 'Not at war.' };
    setTreaty(state, a, b, 'peace');
    setRelation(state, a, b, Math.max(relation(state, a, b), -20));
    SWW.state.pushLog(state, 'diplomacy',
      state.nationById[a].name + ' and ' + state.nationById[b].name + ' have signed a ceasefire.',
      { nationId: a, otherId: b });
    refreshWarCounts(state);
    return { ok: true };
  }

  function refreshWarCounts(state) {
    for (var i = 0; i < state.nations.length; i++) {
      var n = state.nations[i], c = 0;
      for (var j = 0; j < state.nations.length; j++) {
        if (i === j) continue;
        if (n.treaties[state.nations[j].id] === 'war' && state.nations[j].alive) c++;
      }
      n.warCount = c;
    }
  }

  /** Does `a` share a land border with `b`? */
  function areNeighbours(state, a, b) {
    var na = state.nationById[a];
    if (!na) return false;
    for (var i = 0; i < na.provinces.length; i++) {
      var p = state.provinces[na.provinces[i]];
      for (var j = 0; j < p.neighbors.length; j++) {
        var np = state.provinces[p.neighbors[j]];
        if (!np.isSea && np.nationId === b) return true;
      }
    }
    return false;
  }

  /** How willing is `evaluator` to accept `type` from `from`? */
  function evaluateOffer(state, evaluator, fromId, type) {
    var me = state.nationById[evaluator];
    var them = state.nationById[fromId];
    if (!me || !them || !me.alive || !them.alive) return false;
    var rel = relation(state, evaluator, fromId);
    var myPower = SWW.state.nationPower(state, evaluator) + me.vp * 2;
    var theirPower = SWW.state.nationPower(state, fromId) + them.vp * 2;
    var ratio = theirPower / Math.max(1, myPower);

    if (type === 'peace') {
      // Losing badly, or fighting on several fronts, makes peace attractive.
      var pressure = (me.warCount || 0) * 12 + (ratio - 1) * 45;
      if (me.shortage) pressure += 20;
      return pressure + rel * 0.4 > 18;
    }
    if (type === 'nap') {
      return rel > -25 && (ratio > 0.75 || rel > 10);
    }
    if (type === 'alliance') {
      if (SWW.state.treaty(state, evaluator, fromId) === 'war') return false;
      return rel > 45 && (me.warCount > 0 || ratio > 0.6);
    }
    return false;
  }

  /**
   * Send a treaty proposal.  AI recipients answer immediately; the player gets
   * an entry in the offer inbox.
   */
  function proposeTreaty(state, fromId, toId, type) {
    var to = state.nationById[toId];
    if (!to || !to.alive) return { ok: false, why: 'Nation no longer exists.' };
    if (type === 'peace' && SWW.state.treaty(state, fromId, toId) !== 'war') {
      return { ok: false, why: 'You are not at war with them.' };
    }
    if (type !== 'peace' && SWW.state.treaty(state, fromId, toId) === 'war') {
      return { ok: false, why: 'End the war first.' };
    }
    if (to.isPlayer) {
      state.offers = state.offers || [];
      state.offers.push({
        id: 'o' + state.time.toFixed(2) + '_' + state.offers.length,
        from: fromId, to: toId, type: type, at: state.time
      });
      SWW.state.pushLog(state, 'diplomacy',
        state.nationById[fromId].name + ' proposes a ' + TREATY_LABEL[type].toLowerCase() + '.',
        { nationId: fromId, offer: true });
      return { ok: true, pending: true };
    }
    var accepted = evaluateOffer(state, toId, fromId, type);
    if (accepted) applyTreaty(state, fromId, toId, type);
    else {
      adjustRelation(state, fromId, toId, -2);
      if (state.playerId === fromId) {
        SWW.state.pushLog(state, 'diplomacy', to.name + ' rejects your proposal.', { nationId: toId });
      }
    }
    return { ok: true, accepted: accepted };
  }

  function applyTreaty(state, a, b, type) {
    if (type === 'peace') { makePeace(state, a, b); return; }
    setTreaty(state, a, b, type);
    if (type === 'alliance') adjustRelation(state, a, b, 15);
    if (type === 'nap') adjustRelation(state, a, b, 8);
    SWW.state.pushLog(state, 'diplomacy',
      state.nationById[a].name + ' and ' + state.nationById[b].name + ' agree to a ' +
      TREATY_LABEL[type].toLowerCase() + '.', { nationId: a, otherId: b });
  }

  function respondToOffer(state, offerId, accept) {
    state.offers = state.offers || [];
    var idx = -1;
    for (var i = 0; i < state.offers.length; i++) if (state.offers[i].id === offerId) idx = i;
    if (idx < 0) return { ok: false, why: 'Offer expired.' };
    var offer = state.offers.splice(idx, 1)[0];
    if (accept) applyTreaty(state, offer.from, offer.to, offer.type);
    else adjustRelation(state, offer.from, offer.to, -5);
    return { ok: true };
  }

  function breakTreaty(state, a, b) {
    var t = SWW.state.treaty(state, a, b);
    if (t === 'peace' || t === 'war') return { ok: false, why: 'No treaty to cancel.' };
    setTreaty(state, a, b, 'peace');
    adjustRelation(state, a, b, -25);
    SWW.state.pushLog(state, 'diplomacy',
      state.nationById[a].name + ' withdraws from its ' + TREATY_LABEL[t].toLowerCase() +
      ' with ' + state.nationById[b].name + '.', { nationId: a, otherId: b });
    return { ok: true };
  }

  /** Slow relation drift; hostility near borders, warmth between allies. */
  function tickRelations(state, rng, hours) {
    var nations = state.nations;
    for (var i = 0; i < nations.length; i++) {
      var a = nations[i];
      if (!a.alive) continue;
      for (var j = i + 1; j < nations.length; j++) {
        var b = nations[j];
        if (!b.alive) continue;
        var t = SWW.state.treaty(state, a.id, b.id);
        var delta = 0;
        if (t === 'war') delta -= 0.4 * hours;
        else if (t === 'alliance') delta += 0.15 * hours;
        else if (t === 'nap') delta += 0.06 * hours;
        else {
          var v = relation(state, a.id, b.id);
          delta += (0 - v) * 0.004 * hours;                      // drift toward neutral
          if (areNeighbours(state, a.id, b.id)) delta -= 0.05 * hours;   // border friction
        }
        delta += (rng.next() - 0.5) * 0.08 * hours;
        if (delta) adjustRelation(state, a.id, b.id, delta);
      }
    }
    // Offers older than two days lapse.
    if (state.offers && state.offers.length) {
      state.offers = state.offers.filter(function (o) { return state.time - o.at < 48; });
    }
  }

  SWW.diplomacy = {
    relation: relation, setRelation: setRelation, adjustRelation: adjustRelation,
    setTreaty: setTreaty, declareWar: declareWar, makePeace: makePeace,
    proposeTreaty: proposeTreaty, respondToOffer: respondToOffer, breakTreaty: breakTreaty,
    evaluateOffer: evaluateOffer, tickRelations: tickRelations, areNeighbours: areNeighbours,
    refreshWarCounts: refreshWarCounts, TREATY_LABEL: TREATY_LABEL
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
