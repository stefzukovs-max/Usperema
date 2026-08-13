/*
 * The opening lesson.
 *
 * Every step is a question asked of the real game: has a province been
 * selected, is there something in the build queue, does a stack have a march
 * order, is a technology being researched.  Nothing here is staged, nothing is
 * faked, and there is no scripted path — the player can do the steps in any
 * order they like and can ignore the whole thing.  If they happen to have done
 * a step already, it is ticked off the moment the lesson reaches it.
 *
 * That is the only way a tutorial is worth having in a game like this: what it
 * teaches has to be the thing that actually works.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};
  var doc = global.document;
  var STORE = 'ia.tutorial.done';

  var STEPS = [
    {
      id: 'select',
      title: 'Your capital',
      text: 'The map is the game. Tap your capital — the province with the pale dot ' +
        'and the star — to open it.',
      done: function (state, ui) {
        var p = state.provinces[ui.selectedProvinceId];
        return !!p && p.nationId === state.playerId;
      }
    },
    {
      id: 'build',
      title: 'Build something',
      text: 'A province with no works produces nothing but grain and taxes. In the ' +
        'panel below, start a Barracks or a Workshop. Everything you can build is ' +
        'paid for up front and takes time.',
      done: function (state) {
        var me = state.nationById[state.playerId];
        for (var i = 0; i < me.provinces.length; i++) {
          var p = state.provinces[me.provinces[i]];
          if (p.construction || (p.queue && p.queue.length)) return true;
        }
        return false;
      }
    },
    {
      id: 'research',
      title: 'Choose a doctrine',
      text: 'Open Research and start one. The tree runs the length of the war — the ' +
        'things that break a stalemate are deliberately late and expensive, so ' +
        'choose what you will need, not what is cheap.',
      done: function (state) {
        var me = state.nationById[state.playerId];
        return !!me.researching || Object.keys(me.research).length > 0;
      }
    },
    {
      id: 'move',
      title: 'Move an army',
      text: 'Tap one of your stacks, then Move, then a province. It cannot march ' +
        'through a country you are at peace with, and it slows in mud, mountains ' +
        'and snow.',
      done: function (state) {
        for (var i = 0; i < state.armies.length; i++) {
          var a = state.armies[i];
          if (a.ownerId === state.playerId && (a.path.length || a.order)) return true;
        }
        return false;
      }
    },
    {
      id: 'supply',
      title: 'Reach further',
      text: 'Every province panel shows a supply line. Supply runs from your capital ' +
        'and your depots through ground you hold, and an enemy standing across it ' +
        'cuts it — a stack out of supply loses men every hour and fights at two ' +
        'thirds strength. Start a Supply Depot or a Railway Yard to push it further.',
      done: function (state) {
        var me = state.nationById[state.playerId];
        for (var i = 0; i < me.provinces.length; i++) {
          var p = state.provinces[me.provinces[i]];
          if (p.buildings.warehouse || p.buildings.railway) return true;
          var c = p.construction;
          if (c && (c.buildingId === 'warehouse' || c.buildingId === 'railway')) return true;
        }
        return false;
      }
    },
    {
      id: 'aims',
      title: 'Know how you win',
      text: 'Open More and look at War aims. There are six ways this war can end and ' +
        'you can see how far along each of them you are. You do not have to win the ' +
        'one everybody else is playing for.',
      done: function (state, ui) { return ui.sawWarAims === true; }
    }
  ];

  var active = false;
  var index = 0;
  var node = null;
  var uiRef = null;

  function finished() {
    try {
      return global.localStorage && global.localStorage.getItem(STORE) === '1';
    } catch (e) { return false; }
  }

  function markFinished() {
    try {
      if (global.localStorage) global.localStorage.setItem(STORE, '1');
    } catch (e) { /* private mode: it will simply offer again */ }
  }

  function ensureNode() {
    if (node) return node;
    node = doc.getElementById('tutorial');
    return node;
  }

  function render() {
    var host = ensureNode();
    if (!host) return;
    if (!active) { host.classList.remove('show'); return; }
    var step = STEPS[index];
    host.classList.add('show');
    host.innerHTML = '';

    var head = doc.createElement('div');
    head.className = 'tut-head';
    var title = doc.createElement('span');
    title.className = 'tut-title';
    title.textContent = step.title;
    var count = doc.createElement('span');
    count.className = 'tut-count';
    count.textContent = (index + 1) + ' of ' + STEPS.length;
    head.appendChild(title);
    head.appendChild(count);

    var body = doc.createElement('div');
    body.className = 'tut-text';
    body.textContent = step.text;

    var actions = doc.createElement('div');
    actions.className = 'tut-actions';
    var skip = doc.createElement('button');
    skip.className = 'ghost';
    skip.textContent = 'Skip this step';
    skip.onclick = function () { advance(true); };
    var quit = doc.createElement('button');
    quit.className = 'ghost';
    quit.textContent = 'Close';
    quit.onclick = function () { stop(true); };
    actions.appendChild(skip);
    actions.appendChild(quit);

    host.appendChild(head);
    host.appendChild(body);
    host.appendChild(actions);
  }

  function advance(silent) {
    index++;
    if (index >= STEPS.length) {
      if (!silent && uiRef) uiRef.toast('That is the whole of it. The war is yours to run.', 'ok');
      stop(true);
      return;
    }
    if (!silent) IA.audio.play('build');
    render();
  }

  function start(ui) {
    uiRef = ui;
    active = true;
    index = 0;
    render();
  }

  function stop(remember) {
    active = false;
    if (remember) markFinished();
    render();
  }

  /** Called every frame: the current step is simply asked whether it is done. */
  function frame(state, ui) {
    if (!active) return;
    uiRef = ui;
    var step = STEPS[index];
    var ok = false;
    try {
      ok = !!step.done(state, ui);
    } catch (e) {
      ok = false;
    }
    if (ok) advance(false);
  }

  /** Offer it on a fresh campaign, unless the player has been through it. */
  function offer(ui) {
    if (finished()) return;
    start(ui);
  }

  IA.tutorial = {
    start: start, stop: stop, frame: frame, offer: offer,
    finished: finished, isActive: function () { return active; },
    steps: function () { return STEPS; }, stepIndex: function () { return index; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
