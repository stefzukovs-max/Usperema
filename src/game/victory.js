/*
 * How the war can be won.
 *
 * Six ways, deliberately pulling in different directions: one rewards taking
 * ground, one rewards taking the right ground, one rewards holding a coalition
 * together, one rewards building rather than fighting, one is simply outlasting
 * everybody, and the last is the clock running out with you ahead.  A player
 * who cannot see a path to one of them should be able to see a path to another.
 *
 * Each condition reports progress as well as whether it is met, because a
 * victory condition nobody can see the state of is a victory condition nobody
 * plays toward.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  var CAPITALS_NEEDED = 6;
  var COALITION_SHARE = 0.5;
  var INDUSTRY_SHARE = 1 / 3;
  var INDUSTRY_DAYS = 30;

  /** War material a nation turns out in an hour: what actually feeds an army. */
  function industry(nation) {
    var inc = nation.income;
    if (!inc) return 0;
    return (inc.shells || 0) * 10 + (inc.iron || 0) + (inc.coal || 0) + (inc.oil || 0);
  }

  function alliesOf(state, nation) {
    var out = [nation];
    for (var id in nation.treaties) {
      if (nation.treaties[id] !== 'alliance') continue;
      var other = state.nationById[id];
      if (other && other.alive) out.push(other);
    }
    return out;
  }

  /** Enemy capitals this nation is currently sitting on. */
  function capitalsHeld(state, nation) {
    var held = 0;
    for (var i = 0; i < state.nations.length; i++) {
      var other = state.nations[i];
      if (other.id === nation.id) continue;
      var cap = state.provinces[other.capitalProvince];
      if (cap && cap.nationId === nation.id) held++;
    }
    return held;
  }

  function livingCount(state) {
    var n = 0;
    for (var i = 0; i < state.nations.length; i++) if (state.nations[i].alive) n++;
    return n;
  }

  function leaderOf(state) {
    var best = null;
    for (var i = 0; i < state.nations.length; i++) {
      var n = state.nations[i];
      if (!n.alive) continue;
      if (!best || n.vp > best.vp) best = n;
    }
    return best;
  }

  var CONDITIONS = [
    {
      id: 'domination',
      name: 'Domination',
      detail: 'Hold a third of the world’s victory points.',
      status: function (state, n) {
        return { progress: n.vp / Math.max(1, state.victoryVP), note: n.vp + ' of ' + state.victoryVP + ' VP' };
      },
      met: function (state, n) { return n.vp >= state.victoryVP; },
      won: function (state, n) { return n.name + ' holds a third of the world and dictates the peace.'; }
    },
    {
      id: 'capitals',
      name: 'The Capitals',
      detail: 'Hold the capitals of six other powers at once.',
      status: function (state, n) {
        var held = capitalsHeld(state, n);
        return { progress: held / CAPITALS_NEEDED, note: held + ' of ' + CAPITALS_NEEDED + ' taken' };
      },
      met: function (state, n) { return capitalsHeld(state, n) >= CAPITALS_NEEDED; },
      won: function (state, n) {
        return n.name + ' has taken six capitals. There is nobody left to sign for the other side.';
      }
    },
    {
      id: 'coalition',
      name: 'Coalition',
      detail: 'Lead an alliance holding half the world’s victory points.',
      status: function (state, n) {
        var bloc = alliesOf(state, n);
        var sum = 0, biggest = true;
        for (var i = 0; i < bloc.length; i++) {
          sum += bloc[i].vp;
          if (bloc[i].id !== n.id && bloc[i].vp > n.vp) biggest = false;
        }
        var need = state.totalVP * COALITION_SHARE;
        return {
          progress: biggest ? sum / Math.max(1, need) : 0,
          note: bloc.length < 2 ? 'no allies'
            : biggest ? Math.round(sum) + ' of ' + Math.round(need) + ' VP across ' + bloc.length + ' powers'
              : 'a larger ally leads this bloc'
        };
      },
      met: function (state, n) {
        var bloc = alliesOf(state, n);
        if (bloc.length < 2) return false;
        var sum = 0;
        for (var i = 0; i < bloc.length; i++) {
          if (bloc[i].id !== n.id && bloc[i].vp > n.vp) return false;
          sum += bloc[i].vp;
        }
        return sum >= state.totalVP * COALITION_SHARE;
      },
      won: function (state, n) {
        return n.name + ' leads a coalition that holds half the world. The other side sues for terms.';
      }
    },
    {
      id: 'industry',
      name: 'Industrial Supremacy',
      detail: 'Turn out a third of the world’s war material for thirty straight days.',
      status: function (state, n) {
        var days = n.industryStreak || 0;
        return {
          progress: days / INDUSTRY_DAYS,
          note: days > 0 ? days + ' of ' + INDUSTRY_DAYS + ' days'
            : Math.round((n.industryShare || 0) * 100) + '% of world output, need ' +
              Math.round(INDUSTRY_SHARE * 100) + '%'
        };
      },
      met: function (state, n) { return (n.industryStreak || 0) >= INDUSTRY_DAYS; },
      won: function (state, n) {
        return n.name + ' out-produces the rest of the world combined. The others cannot replace what they lose.';
      }
    },
    {
      id: 'conquest',
      name: 'Conquest',
      detail: 'Be the last power standing.',
      status: function (state) {
        var left = livingCount(state);
        return { progress: left <= 1 ? 1 : 1 / left, note: left + ' powers still in the war' };
      },
      met: function (state, n) { return n.alive && livingCount(state) === 1; },
      won: function (state, n) { return n.name + ' stands alone. The war is over.'; }
    },
    {
      id: 'armistice',
      name: 'Armistice',
      detail: 'Lead on victory points when the guns fall silent.',
      // The date moves with the campaign settings, so it cannot be a fixed
      // string: a one-year war does not end in November 1918.
      detailFor: function (state) {
        var end = new Date(IA.weather.START + armisticeDay(state) * 86400000);
        return 'Lead on victory points when the guns fall silent on ' +
          end.getUTCDate() + ' ' + MONTHS[end.getUTCMonth()] + ' ' + end.getUTCFullYear() + '.';
      },
      status: function (state, n) {
        var day = IA.weather.dayOfWar(state);
        var end = armisticeDay(state);
        var leader = leaderOf(state);
        return {
          progress: day / end,
          note: Math.max(0, end - day) + ' days to the armistice' +
            (leader && leader.id === n.id ? ', and you lead' : '')
        };
      },
      met: function (state, n) {
        if (IA.weather.dayOfWar(state) < armisticeDay(state)) return false;
        var leader = leaderOf(state);
        return !!leader && leader.id === n.id;
      },
      won: function (state, n) {
        return 'The guns fall silent. ' + n.name + ' ends the war ahead and takes the peace.';
      }
    }
  ];

  var BY_ID = {};
  for (var c = 0; c < CONDITIONS.length; c++) BY_ID[CONDITIONS[c].id] = CONDITIONS[c];

  /** The armistice date, or whatever the campaign was set up with instead. */
  function armisticeDay(state) {
    if (state.settings && state.settings.armisticeDay) return state.settings.armisticeDay;
    return IA.weather.dayOfDate(1918, 10, 11);
  }

  /**
   * Industrial share is a running streak, so it has to be maintained daily
   * rather than worked out on demand.
   */
  function tickDaily(state) {
    var total = 0, i;
    for (i = 0; i < state.nations.length; i++) {
      if (state.nations[i].alive) total += industry(state.nations[i]);
    }
    for (i = 0; i < state.nations.length; i++) {
      var n = state.nations[i];
      if (!n.alive) { n.industryStreak = 0; n.industryShare = 0; continue; }
      n.industryShare = total > 0 ? industry(n) / total : 0;
      n.industryStreak = n.industryShare >= INDUSTRY_SHARE ? (n.industryStreak || 0) + 1 : 0;
    }
  }

  /** Every condition's state for one nation, for the war-aims screen. */
  function report(state, nation) {
    var out = [];
    for (var i = 0; i < CONDITIONS.length; i++) {
      var cond = CONDITIONS[i];
      var st = cond.status(state, nation);
      out.push({
        id: cond.id, name: cond.name,
        detail: cond.detailFor ? cond.detailFor(state) : cond.detail,
        progress: Math.max(0, Math.min(1, st.progress || 0)),
        note: st.note,
        met: cond.met(state, nation)
      });
    }
    return out;
  }

  /**
   * Has anybody won?  Conditions are tested in order and nations in order, so
   * the answer does not depend on who happens to be checked first.
   */
  function check(state) {
    for (var c = 0; c < CONDITIONS.length; c++) {
      var cond = CONDITIONS[c];
      for (var i = 0; i < state.nations.length; i++) {
        var n = state.nations[i];
        if (!n.alive) continue;
        if (!cond.met(state, n)) continue;
        return {
          result: n.isPlayer ? 'victory' : 'defeat',
          winner: n.id, at: state.time,
          condition: cond.id, reason: cond.name.toLowerCase(),
          message: cond.won(state, n)
        };
      }
    }
    return null;
  }

  IA.victory = {
    CONDITIONS: CONDITIONS, BY_ID: BY_ID,
    check: check, report: report, tickDaily: tickDaily,
    armisticeDay: armisticeDay, industry: industry, capitalsHeld: capitalsHeld,
    CAPITALS_NEEDED: CAPITALS_NEEDED, INDUSTRY_DAYS: INDUSTRY_DAYS
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
