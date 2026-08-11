/*
 * Entry point: the start menu, the real-time loop that drives the simulation,
 * and the wiring between them.
 */
(function (global) {
  'use strict';

  var SWW = global.SWW = global.SWW || {};
  var doc = global.document;
  var el = SWW.el;
  var clear = SWW.clearNode;

  var game = {
    state: null,
    running: false,
    lastFrame: 0,
    lastAutosave: 0
  };

  var SPEED_BY_ID = {};
  SWW.state.SPEEDS.forEach(function (s) { SPEED_BY_ID[s.id] = s; });

  // --- menu ----------------------------------------------------------------

  function showMenu() {
    game.running = false;
    game.state = null;
    doc.getElementById('game').classList.remove('show');
    doc.getElementById('gameOver').classList.remove('show');
    doc.getElementById('menu').classList.add('show');
    SWW.UI.gameOverShown = false;
    buildMenu();
  }

  function buildMenu() {
    var chosen = { nation: null };
    var grid = doc.getElementById('nationGrid');
    clear(grid);

    var randomBtn = el('button', {
      class: 'nation-card random selected',
      onclick: function (e) { pick(e.currentTarget, null); }
    }, [
      el('span', { class: 'nc-chip', style: 'background:linear-gradient(135deg,#7fe3ff,#3f7fd6)' }),
      el('span', { class: 'nc-name', text: 'Random Power' }),
      el('span', { class: 'nc-meta', text: 'Let the war decide' })
    ]);
    grid.appendChild(randomBtn);

    SWW.NationData.NATIONS.forEach(function (n) {
      grid.appendChild(el('button', {
        class: 'nation-card',
        onclick: function (e) { pick(e.currentTarget, n.id); }
      }, [
        el('span', { class: 'nc-chip', style: 'background:' + n.color }),
        el('span', { class: 'nc-name', text: n.name }),
        el('span', { class: 'nc-meta', text: n.capital + ' · ' + n.reach + ' provinces' })
      ]));
    });

    function pick(node, id) {
      chosen.nation = id;
      var cards = grid.childNodes;
      for (var i = 0; i < cards.length; i++) cards[i].classList.toggle('selected', cards[i] === node);
    }

    doc.getElementById('startBtn').onclick = function () {
      var seed = doc.getElementById('seedInput').value.trim();
      startNewGame({ seed: seed || String(Date.now()), playerNation: chosen.nation });
    };

    var info = SWW.save.peek();
    var cont = doc.getElementById('continueBtn');
    if (info) {
      cont.style.display = '';
      cont.textContent = 'Continue — day ' + (Math.floor(info.time / 24) + 1);
      cont.onclick = function () {
        var r = SWW.save.load();
        if (!r.ok) { global.alert('Could not load the save: ' + r.why); return; }
        enterGame(r.state);
      };
    } else {
      cont.style.display = 'none';
    }
  }

  function startNewGame(opts) {
    var overlay = doc.getElementById('loading');
    overlay.classList.add('show');
    // Let the browser paint the overlay before the (synchronous) worldgen.
    global.setTimeout(function () {
      var state;
      try {
        state = SWW.state.createGame(opts);
      } catch (e) {
        overlay.classList.remove('show');
        global.alert('World generation failed: ' + (e && e.message ? e.message : e));
        throw e;
      }
      overlay.classList.remove('show');
      enterGame(state);
    }, 30);
  }

  function enterGame(state) {
    game.state = state;
    doc.getElementById('menu').classList.remove('show');
    doc.getElementById('gameOver').classList.remove('show');
    doc.getElementById('game').classList.add('show');
    SWW.UI.gameOverShown = false;
    SWW.UI.init(state);
    game.lastFrame = global.performance ? global.performance.now() : Date.now();
    game.lastAutosave = state.time;
    game.running = true;
  }

  /** Swap in a freshly loaded state without tearing down the page. */
  function replaceState(state) {
    game.running = false;
    enterGame(state);
    SWW.UI.toast('Save loaded.', 'ok');
  }

  // --- loop ----------------------------------------------------------------

  function frame(now) {
    global.requestAnimationFrame(frame);
    if (!game.running || !game.state) return;
    var state = game.state;
    var dt = Math.min(0.25, (now - game.lastFrame) / 1000);
    game.lastFrame = now;

    var speed = SPEED_BY_ID[state.speed] || SPEED_BY_ID['1x'];
    if (speed.hoursPerSecond > 0 && !state.gameOver) {
      SWW.loop.advance(state, dt * speed.hoursPerSecond);
      if (state.time - game.lastAutosave >= 48) {
        game.lastAutosave = state.time;
        SWW.save.save(state);
      }
    }
    SWW.UI.frame();
  }

  SWW.game = {
    start: startNewGame,
    toMenu: showMenu,
    replaceState: replaceState,
    get current() { return game.state; }
  };

  doc.addEventListener('DOMContentLoaded', function () {
    showMenu();
    global.requestAnimationFrame(frame);
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
