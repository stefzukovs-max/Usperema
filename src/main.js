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
    IA.audio.arm();
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

    var settings = buildSettings();

    doc.getElementById('startBtn').onclick = function () {
      var seed = doc.getElementById('seedInput').value.trim();
      startNewGame({
        seed: seed || String(Date.now()),
        playerNation: chosen.nation,
        settings: settings.value()
      });
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

  /*
   * Campaign settings.
   *
   * Each is a small set of named choices rather than a slider, because "a
   * fortnight" and "the whole war" are decisions a player can make and 0.7 is
   * not.  The chosen values are handed to createGame and read from state
   * everywhere afterwards, so a short brutal war and a long cautious one are
   * the same code with different numbers.
   */
  var SETTING_FIELDS = [
    {
      key: 'warYears', label: 'Length of the war',
      note: 'When the guns stop and the leader takes the peace.',
      options: [
        { label: 'Short — 1 year', value: 1 },
        { label: 'Standard', value: 'historical' },
        { label: 'Long — 8 years', value: 8 }
      ]
    },
    {
      key: 'victoryShare', label: 'Victory threshold',
      note: 'Share of the world needed to win outright.',
      options: [
        { label: 'A quarter', value: 0.25 },
        { label: 'A third', value: 0.33 },
        { label: 'Half', value: 0.5 }
      ]
    },
    {
      key: 'aggression', label: 'Appetite for war',
      note: 'How readily the other powers declare.',
      options: [
        { label: 'Cautious', value: 0.5 },
        { label: 'Ordinary', value: 1 },
        { label: 'Rapacious', value: 2 }
      ]
    },
    {
      key: 'supplies', label: 'Opening stockpiles',
      note: 'What everybody starts the war holding.',
      options: [
        { label: 'Lean', value: 0.6 },
        { label: 'Ordinary', value: 1 },
        { label: 'Ample', value: 1.8 }
      ]
    },
    {
      key: 'fogOfWar', label: 'Fog of war',
      note: 'Whether you can see what you have no eyes on.',
      options: [
        { label: 'On', value: true },
        { label: 'Off — show everything', value: false }
      ]
    }
  ];

  function buildSettings() {
    var panel = doc.getElementById('settingsPanel');
    var grid = doc.getElementById('settingsGrid');
    var toggle = doc.getElementById('settingsBtn');
    var chosen = {};
    var defaults = IA.state.DEFAULT_SETTINGS;

    function render() {
      grid.innerHTML = '';
      SETTING_FIELDS.forEach(function (field) {
        var row = doc.createElement('div');
        row.className = 'setting';
        var head = doc.createElement('div');
        head.className = 'setting-head';
        head.textContent = field.label;
        var note = doc.createElement('div');
        note.className = 'setting-note';
        note.textContent = field.note;
        var opts = doc.createElement('div');
        opts.className = 'setting-options';
        field.options.forEach(function (opt) {
          var b = doc.createElement('button');
          b.className = 'setting-opt' + (chosen[field.key] === opt.value ? ' on' : '');
          b.textContent = opt.label;
          b.onclick = function () { chosen[field.key] = opt.value; render(); };
          opts.appendChild(b);
        });
        row.appendChild(head);
        row.appendChild(note);
        row.appendChild(opts);
        grid.appendChild(row);
      });
    }

    function reset() {
      SETTING_FIELDS.forEach(function (f) { chosen[f.key] = defaults[f.key]; });
      render();
    }

    toggle.onclick = function () {
      panel.classList.toggle('show');
      toggle.textContent = panel.classList.contains('show') ? 'Hide settings' : 'Campaign settings';
    };
    doc.getElementById('settingsReset').onclick = reset;
    reset();
    return { value: function () {
      var out = {};
      for (var k in chosen) out[k] = chosen[k];
      return out;
    } };
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
      // A fresh campaign offers the lesson; a loaded one does not.
      IA.tutorial.offer(IA.UI);
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
