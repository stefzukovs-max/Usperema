/*
 * Entry point: the start menu, the real-time loop that drives the simulation,
 * and the wiring between them.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};
  var doc = global.document;
  var el = IA.el;
  var clear = IA.clearNode;

  var game = {
    state: null,
    running: false,
    lastFrame: 0,
    lastAutosave: 0
  };

  var SPEED_BY_ID = {};
  IA.state.SPEEDS.forEach(function (s) { SPEED_BY_ID[s.id] = s; });

  // --- menu ----------------------------------------------------------------

  function showMenu() {
    game.running = false;
    game.state = null;
    doc.getElementById('game').classList.remove('show');
    doc.getElementById('gameOver').classList.remove('show');
    doc.getElementById('menu').classList.add('show');
    IA.UI.gameOverShown = false;
    buildMenu();
  }

  /** Every country on the map, largest first, with its size and capital. */
  function nationChoices() {
    var map = IA.mapdata.load();
    var counts = {};
    var capitals = {};
    var i;
    for (i = 0; i < map.landProvinceCount; i++) {
      var p = map.provinces[i];
      if (p.nationIndex < 0) continue;
      counts[p.nationIndex] = (counts[p.nationIndex] || 0) + 1;
    }
    var out = [];
    for (i = 0; i < map.nations.length; i++) {
      var n = map.nations[i];
      if (n.capital < 0) continue;
      capitals[i] = map.provinces[n.capital].name;
      out.push({
        id: n.iso, name: n.name, color: n.colour,
        provinces: counts[i] || 0, capital: capitals[i], pop: n.pop
      });
    }
    out.sort(function (a, b) { return b.provinces - a.provinces || b.pop - a.pop; });
    return out;
  }

  function buildMenu() {
    var chosen = { nation: null };
    var grid = doc.getElementById('nationGrid');
    var search = doc.getElementById('nationSearch');
    var choices = nationChoices();
    doc.getElementById('nationCount').textContent = choices.length + ' countries';

    function render(filter) {
      clear(grid);
      var q = (filter || '').trim().toLowerCase();
      grid.appendChild(el('button', {
        class: 'nation-card random' + (chosen.nation === null ? ' selected' : ''),
        onclick: function (e) { pick(e.currentTarget, null); }
      }, [
        el('span', { class: 'nc-chip', style: 'background:linear-gradient(135deg,#7fe3ff,#3f7fd6)' }),
        el('span', { class: 'nc-name', text: 'Random Power' }),
        el('span', { class: 'nc-meta', text: 'Let the war decide' })
      ]));

      var shown = 0;
      choices.forEach(function (n) {
        if (q && n.name.toLowerCase().indexOf(q) < 0 && n.capital.toLowerCase().indexOf(q) < 0) return;
        shown++;
        grid.appendChild(el('button', {
          class: 'nation-card' + (chosen.nation === n.id ? ' selected' : ''),
          onclick: function (e) { pick(e.currentTarget, n.id); }
        }, [
          el('span', { class: 'nc-chip', style: 'background:' + n.color }),
          el('span', { class: 'nc-name', text: n.name }),
          el('span', {
            class: 'nc-meta',
            text: n.capital + ' · ' + n.provinces + (n.provinces === 1 ? ' province' : ' provinces')
          })
        ]));
      });
      if (!shown && q) {
        grid.appendChild(el('div', { class: 'muted small', text: 'No country matches “' + filter + '”.' }));
      }
    }

    function pick(node, id) {
      chosen.nation = id;
      var cards = grid.childNodes;
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].classList) cards[i].classList.toggle('selected', cards[i] === node);
      }
    }

    search.value = '';
    search.oninput = function () { render(search.value); };
    render('');

    doc.getElementById('startBtn').onclick = function () {
      var seed = doc.getElementById('seedInput').value.trim();
      startNewGame({ seed: seed || String(Date.now()), playerNation: chosen.nation });
    };

    var info = IA.save.peek();
    var cont = doc.getElementById('continueBtn');
    if (info) {
      cont.style.display = '';
      cont.textContent = 'Continue — day ' + (Math.floor(info.time / 24) + 1);
      cont.onclick = function () {
        var r = IA.save.load();
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
        state = IA.state.createGame(opts);
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
    IA.UI.gameOverShown = false;
    IA.UI.init(state);
    game.lastFrame = global.performance ? global.performance.now() : Date.now();
    game.lastAutosave = state.time;
    game.running = true;
  }

  /** Swap in a freshly loaded state without tearing down the page. */
  function replaceState(state) {
    game.running = false;
    enterGame(state);
    IA.UI.toast('Save loaded.', 'ok');
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
      IA.loop.advance(state, dt * speed.hoursPerSecond);
      if (state.time - game.lastAutosave >= 48) {
        game.lastAutosave = state.time;
        IA.save.save(state);
      }
    }
    IA.UI.frame();
  }

  IA.game = {
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
