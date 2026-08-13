/*
 * Diplomacy: relations, treaties and the offer inbox.
 *
 * Treaty values: 'peace' (default), 'nap' (non-aggression), 'alliance', 'war'.
 * Relations run -100..100 and drive what the AI is willing to sign.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};
  var clamp = IA.util.clamp;

  var TREATY_LABEL = {
    peace: 'Peace', nap: 'Non-Aggression Pact', alliance: 'Alliance', war: 'At War'
  };

  /*
   * Pacts run out.
   *
   * A treaty that lasts for ever is a treaty nobody has to think about: sign
   * once with each neighbour and the map is settled.  Terms instead expire, and
   * letting one lapse is free while tearing one up early is not — which is the
   * whole difference between a hard bargainer and a treacherous one.
   */
  var TERM = { nap: 90 * 24, alliance: 180 * 24 };

  /*
   * Standing.
   *
   * Reputation runs 0..100 and starts at 75.  Attacking someone you had signed
   * with, or someone who had given you no cause, costs standing with everyone
   * who hears about it — not just the victim.  It recovers, slowly, if you
   * behave.
   */
  var REPUTATION_FLOOR = 0;
  var REPUTATION_BASE = 75;      // what standing decays back toward
  var REPUTATION_RECOVERY = 0.09;   // points a day

  var BETRAYAL = { alliance: 34, nap: 22 };
  var UNPROVOKED = 12;

  /** Standing in words, for the diplomacy screen. */
  function reputationLabel(value) {
    if (value >= 85) return 'Impeccable';
    if (value >= 68) return 'Trusted';
    if (value >= 50) return 'Watched';
    if (value >= 30) return 'Untrustworthy';
    return 'Treacherous';
  }

  function reputation(state, id) {
    var n = state.nationById[id];
    return n && n.reputation !== undefined ? n.reputation : REPUTATION_BASE;
  }

  function adjustReputation(state, id, delta) {
    var n = state.nationById[id];
    if (!n) return;
    n.reputation = clamp((n.reputation === undefined ? REPUTATION_BASE : n.reputation) + delta,
      REPUTATION_FLOOR, 100);
  }

  /** When the pact between `a` and `b` runs out, or 0 if it does not. */
  function treatyExpiry(state, a, b) {
    var na = state.nationById[a];
    return (na && na.treatyUntil && na.treatyUntil[b]) || 0;
  }

  function setExpiry(state, a, b, until) {
    if (state.nationById[a]) state.nationById[a].treatyUntil[b] = until;
    if (state.nationById[b]) state.nationById[b].treatyUntil[a] = until;
  }

  function clearExpiry(state, a, b) {
    if (state.nationById[a]) delete state.nationById[a].treatyUntil[b];
    if (state.nationById[b]) delete state.nationById[b].treatyUntil[a];
  }

  /**
   * Pacts whose term has run lapse back to plain peace.  Letting one go is not
   * a betrayal, so it costs no standing — only a little warmth.
   */
  function expireTreaties(state) {
    for (var i = 0; i < state.nations.length; i++) {
      var n = state.nations[i];
      if (!n.alive || !n.treatyUntil) continue;
      for (var id in n.treatyUntil) {
        if (n.treatyUntil[id] > state.time) continue;
        if (id < n.id) continue;                  // each pair handled once
        var other = state.nationById[id];
        var t = IA.state.treaty(state, n.id, id);
        clearExpiry(state, n.id, id);
        if (t !== 'nap' && t !== 'alliance') continue;
        setTreaty(state, n.id, id, 'peace');
        adjustRelation(state, n.id, id, -4);
        if (other) {
          IA.state.pushLog(state, 'diplomacy',
            'The ' + TREATY_LABEL[t].toLowerCase() + ' between ' + n.name + ' and ' +
            other.name + ' has run its term and lapsed.',
            { nationId: n.id, otherId: id });
        }
      }
    }
  }

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
    if (IA.state.treaty(state, a, b) === 'war') return { ok: false, why: 'Already at war.' };
    var na = state.nationById[a], nb = state.nationById[b];
    if (!na || !nb || !na.alive || !nb.alive) return { ok: false, why: 'Nation no longer exists.' };

    /*
     * What kind of war this is decides what it costs you.  Turning on a power
     * you had signed with is the worst of it; falling on one that had given you
     * no cause is next; joining a war already running is neither.
     */
    var had = IA.state.treaty(state, a, b);
    var betrayal = BETRAYAL[had] || 0;
    var unprovoked = !betrayal && relation(state, a, b) > -25 && !(nb.warCount > 0);
    var repCost = betrayal || (unprovoked ? UNPROVOKED : 0);
    if (repCost) adjustReputation(state, a, -repCost);

    setTreaty(state, a, b, 'war');
    clearExpiry(state, a, b);
    setRelation(state, a, b, Math.min(relation(state, a, b), -60));
    // Breaking a pact costs standing with the neighbours and with anyone
    // already bound to the victim.
    var watchers = {};
    (na.contacts || []).forEach(function (id) { watchers[id] = true; });
    (nb.contacts || []).forEach(function (id) { watchers[id] = true; });
    Object.keys(nb.treaties).forEach(function (id) { watchers[id] = true; });
    for (var wi = 0, wk = Object.keys(watchers); wi < wk.length; wi++) {
      var third = state.nationById[wk[wi]];
      if (!third || !third.alive || third.id === a || third.id === b) continue;
      /*
       * How badly this reads to everyone watching.  The graduation is centred
       * below the flat penalty it replaced, not above it: with fifty-four
       * powers a declaration touches a great many watchers, and making an
       * unprovoked war cost more relations everywhere chilled the world into a
       * general war inside a fortnight — it spread wars rather than deterring
       * them.  Deterrence belongs in reputation, which is weighed once, by the
       * power deciding whether to sign.
       */
      adjustRelation(state, a, third.id, betrayal ? -10 : unprovoked ? -6 : -4);
      if (IA.state.treaty(state, third.id, b) === 'alliance') {
        // Allies of the victim are dragged in.
        if (IA.state.treaty(state, third.id, a) !== 'war') {
          setTreaty(state, third.id, a, 'war');
          IA.state.pushLog(state, 'diplomacy',
            third.name + ' honours its alliance and joins the war against ' + na.name + '.',
            { nationId: third.id });
        }
      }
    }
    IA.state.pushLog(state, 'diplomacy',
      na.name + ' declares war on ' + nb.name + (reason ? ' — ' + reason : '') + '.',
      { nationId: a, otherId: b });
    if (betrayal) {
      IA.state.pushLog(state, 'diplomacy',
        na.name + ' has torn up its ' + TREATY_LABEL[had].toLowerCase() + ' with ' +
        nb.name + '. Its word is worth less everywhere.', { nationId: a, otherId: b });
    }
    refreshWarCounts(state);
    return { ok: true };
  }

  function makePeace(state, a, b) {
    if (IA.state.treaty(state, a, b) !== 'war') return { ok: false, why: 'Not at war.' };
    setTreaty(state, a, b, 'peace');
    clearExpiry(state, a, b);
    setRelation(state, a, b, Math.max(relation(state, a, b), -20));
    IA.state.pushLog(state, 'diplomacy',
      state.nationById[a].name + ' and ' + state.nationById[b].name + ' have signed a ceasefire.',
      { nationId: a, otherId: b });
    refreshWarCounts(state);
    return { ok: true };
  }

  function refreshWarCounts(state) {
    for (var i = 0; i < state.nations.length; i++) {
      var n = state.nations[i], c = 0;
      for (var id in n.treaties) {
        if (n.treaties[id] !== 'war') continue;
        var other = state.nationById[id];
        if (other && other.alive) c++;
      }
      n.warCount = c;
    }
  }

  /**
   * Who each nation actually shares a border with.  With nearly two hundred
   * nations, scanning provinces for every diplomatic question is far too slow,
   * so the border graph is rebuilt once a day and everything reads that.
   */
  function refreshContacts(state) {
    var sets = {};
    var i;
    for (i = 0; i < state.nations.length; i++) sets[state.nations[i].id] = Object.create(null);
    for (i = 0; i < state.landCount; i++) {
      var p = state.provinces[i];
      if (!p.nationId || !sets[p.nationId]) continue;
      for (var j = 0; j < p.neighbors.length; j++) {
        var np = state.provinces[p.neighbors[j]];
        if (np.isSea || !np.nationId || np.nationId === p.nationId) continue;
        if (!sets[np.nationId]) continue;
        sets[p.nationId][np.nationId] = true;
        sets[np.nationId][p.nationId] = true;
      }
    }
    for (i = 0; i < state.nations.length; i++) {
      var n = state.nations[i];
      n.contacts = Object.keys(sets[n.id] || {});
      n.contactSet = sets[n.id] || Object.create(null);
    }
  }

  /** Does `a` share a land border with `b`? */
  function areNeighbours(state, a, b) {
    var na = state.nationById[a];
    if (!na || !na.contactSet) return false;
    return !!na.contactSet[b];
  }

  /** How willing is `evaluator` to accept `type` from `from`? */
  function evaluateOffer(state, evaluator, fromId, type) {
    var me = state.nationById[evaluator];
    var them = state.nationById[fromId];
    if (!me || !them || !me.alive || !them.alive) return false;
    var rel = relation(state, evaluator, fromId);
    var myPower = IA.state.nationPower(state, evaluator) + me.vp * 2;
    var theirPower = IA.state.nationPower(state, fromId) + them.vp * 2;
    var ratio = theirPower / Math.max(1, myPower);

    /*
     * What their word is worth.  A power that has torn up pacts before gets a
     * colder hearing on anything that depends on it keeping this one — which is
     * everything except a ceasefire, where the fighting is the point and the
     * paper is secondary.
     */
    var standing = reputation(state, fromId) - REPUTATION_BASE;

    if (type === 'peace') {
      // Losing badly, or fighting on several fronts, makes peace attractive.
      var pressure = (me.warCount || 0) * 12 + (ratio - 1) * 45;
      if (me.shortage) pressure += 20;
      return pressure + rel * 0.4 + standing * 0.15 > 18;
    }
    if (type === 'nap') {
      return rel + standing * 0.5 > -25 && (ratio > 0.75 || rel > 10);
    }
    if (type === 'alliance') {
      if (IA.state.treaty(state, evaluator, fromId) === 'war') return false;
      return rel + standing * 0.8 > 45 && (me.warCount > 0 || ratio > 0.6);
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
    if (type === 'peace' && IA.state.treaty(state, fromId, toId) !== 'war') {
      return { ok: false, why: 'You are not at war with them.' };
    }
    if (type !== 'peace' && IA.state.treaty(state, fromId, toId) === 'war') {
      return { ok: false, why: 'End the war first.' };
    }
    if (to.isPlayer) {
      state.offers = state.offers || [];
      state.offers.push({
        id: 'o' + state.time.toFixed(2) + '_' + state.offers.length,
        from: fromId, to: toId, type: type, at: state.time
      });
      IA.state.pushLog(state, 'diplomacy',
        state.nationById[fromId].name + ' proposes a ' + TREATY_LABEL[type].toLowerCase() + '.',
        { nationId: fromId, offer: true });
      return { ok: true, pending: true };
    }
    var accepted = evaluateOffer(state, toId, fromId, type);
    if (accepted) applyTreaty(state, fromId, toId, type);
    else {
      adjustRelation(state, fromId, toId, -2);
      if (state.playerId === fromId) {
        IA.state.pushLog(state, 'diplomacy', to.name + ' rejects your proposal.', { nationId: toId });
      }
    }
    return { ok: true, accepted: accepted };
  }

  function applyTreaty(state, a, b, type) {
    if (type === 'peace') { makePeace(state, a, b); return; }
    setTreaty(state, a, b, type);
    if (TERM[type]) setExpiry(state, a, b, state.time + TERM[type]);
    if (type === 'alliance') adjustRelation(state, a, b, 15);
    if (type === 'nap') adjustRelation(state, a, b, 8);
    IA.state.pushLog(state, 'diplomacy',
      state.nationById[a].name + ' and ' + state.nationById[b].name + ' agree to a ' +
      TREATY_LABEL[type].toLowerCase() + ' for ' + Math.round(TERM[type] / 24) + ' days.',
      { nationId: a, otherId: b });
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
    var t = IA.state.treaty(state, a, b);
    if (t === 'peace' || t === 'war') return { ok: false, why: 'No treaty to cancel.' };
    setTreaty(state, a, b, 'peace');
    clearExpiry(state, a, b);
    adjustRelation(state, a, b, -25);
    // Walking out before the term is up is not the same as letting it lapse.
    adjustReputation(state, a, -Math.round(BETRAYAL[t] * 0.5));
    IA.state.pushLog(state, 'diplomacy',
      state.nationById[a].name + ' withdraws from its ' + TREATY_LABEL[t].toLowerCase() +
      ' with ' + state.nationById[b].name + '.', { nationId: a, otherId: b });
    return { ok: true };
  }

  /**
   * Relations drift only between nations with something between them: a shared
   * border, a treaty, or a history.  Two countries on opposite sides of the
   * world simply have no opinion until they meet.
   */
  function tickRelations(state, rng, hours) {
    var nations = state.nations;
    for (var i = 0; i < nations.length; i++) {
      var a = nations[i];
      if (!a.alive) continue;
      var seen = Object.create(null);
      var partners = (a.contacts || []).concat(Object.keys(a.treaties), Object.keys(a.relations));
      for (var k = 0; k < partners.length; k++) {
        var id = partners[k];
        if (seen[id] || id === a.id) continue;
        seen[id] = true;
        var b = state.nationById[id];
        if (!b || !b.alive) continue;
        if (b.id < a.id) continue;      // each pair is handled once, from one side
        var t = IA.state.treaty(state, a.id, b.id);
        var delta = 0;
        if (t === 'war') delta -= 0.4 * hours;
        else if (t === 'alliance') delta += 0.15 * hours;
        else if (t === 'nap') delta += 0.06 * hours;
        else {
          var v = relation(state, a.id, b.id);
          delta += (0 - v) * 0.004 * hours;                            // drift toward neutral
          if (a.contactSet && a.contactSet[b.id]) delta -= 0.05 * hours;  // border friction
        }
        /*
         * Nobody warms to a power that cannot be trusted, and standing is
         * public, so it colours every relationship at once.  The coefficient is
         * deliberately small: at a fifteenth of this it was enough to chill the
         * whole world into a general war inside a fortnight, because each new
         * war cost standing, which chilled relations further.
         */
        delta += (reputation(state, a.id) - REPUTATION_BASE) * 0.0004 * hours;
        delta += (reputation(state, b.id) - REPUTATION_BASE) * 0.0004 * hours;
        delta += (rng.next() - 0.5) * 0.08 * hours;
        if (delta) adjustRelation(state, a.id, b.id, delta);
      }
    }
    // Standing recovers if you behave, but slowly: it takes a year of good
    // conduct to work off tearing up one alliance.
    for (var r = 0; r < nations.length; r++) {
      var nr = nations[r];
      if (!nr.alive || nr.reputation === undefined) continue;
      if (nr.reputation < REPUTATION_BASE) {
        nr.reputation = Math.min(REPUTATION_BASE,
          nr.reputation + REPUTATION_RECOVERY * (hours / 24));
      }
    }

    // Offers older than two days lapse.
    if (state.offers && state.offers.length) {
      state.offers = state.offers.filter(function (o) { return state.time - o.at < 48; });
    }
  }

  IA.diplomacy = {
    relation: relation, setRelation: setRelation, adjustRelation: adjustRelation,
    setTreaty: setTreaty, declareWar: declareWar, makePeace: makePeace,
    proposeTreaty: proposeTreaty, respondToOffer: respondToOffer, breakTreaty: breakTreaty,
    evaluateOffer: evaluateOffer, tickRelations: tickRelations, areNeighbours: areNeighbours,
    refreshWarCounts: refreshWarCounts, refreshContacts: refreshContacts,
    reputation: reputation, adjustReputation: adjustReputation, reputationLabel: reputationLabel,
    treatyExpiry: treatyExpiry, expireTreaties: expireTreaties,
    TREATY_LABEL: TREATY_LABEL, TERM: TERM, REPUTATION_BASE: REPUTATION_BASE
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
