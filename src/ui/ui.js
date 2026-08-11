/*
 * User interface: HUD, map input, the selection panel and every modal screen.
 * All game mutations go through SWW.orders / SWW.diplomacy / SWW.market so the
 * player is bound by exactly the same rules as the AI.
 */
(function (global) {
  'use strict';

  var SWW = global.SWW = global.SWW || {};
  var doc = global.document;
  var UnitData = SWW.UnitData;
  var BuildingData = SWW.BuildingData;
  var ResearchData = SWW.ResearchData;
  var util = SWW.util;
  var fmt = util.fmt;
  var clamp = util.clamp;

  var RES_ORDER = ['food', 'materials', 'fuel', 'ammo', 'chemicals', 'manpower', 'cash'];

  function el(tag, attrs, kids) {
    var node = doc.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'style') node.setAttribute('style', attrs[k]);
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      }
    }
    if (kids) {
      if (!Array.isArray(kids)) kids = [kids];
      for (var i = 0; i < kids.length; i++) {
        if (kids[i] === null || kids[i] === undefined || kids[i] === false) continue;
        node.appendChild(typeof kids[i] === 'string' ? doc.createTextNode(kids[i]) : kids[i]);
      }
    }
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  var UI = {
    state: null,
    renderer: null,
    selectedProvinceId: null,
    selectedArmyId: null,
    targeting: null,          // 'move' | 'attack' | 'bombard' | 'missile'
    visible: {},
    visibleStamp: 0,
    lastVisibility: -99,
    lastHud: -99,
    modal: null
  };

  // --- boot ----------------------------------------------------------------

  UI.init = function (state) {
    this.state = state;
    this.canvas = doc.getElementById('map');
    this.renderer = new SWW.Renderer(this.canvas, state);
    this.renderer.resize();
    this.renderer.centerOn(state.nationById[state.playerId].capitalProvince, 8);
    this.bindInput();
    this.buildChrome();
    this.recomputeVisibility(true);
    this.refreshHud(true);
    this.selectProvince(state.nationById[state.playerId].capitalProvince);
  };

  UI.buildChrome = function () {
    var self = this;
    var nav = doc.getElementById('bottomNav');
    clear(nav);
    var items = [
      { id: 'diplomacy', label: 'Diplomacy', icon: '☮' },
      { id: 'market', label: 'Market', icon: '\u{1F6D2}' },
      { id: 'cities', label: 'Cities', icon: '\u{1F3E2}' },
      { id: 'research', label: 'Research', icon: '\u{1F52C}' },
      { id: 'more', label: 'More', icon: '☰' }
    ];
    items.forEach(function (item) {
      var badge = el('span', { class: 'nav-badge', id: 'badge-' + item.id });
      badge.style.display = 'none';
      nav.appendChild(el('button', {
        class: 'nav-btn', 'data-nav': item.id,
        onclick: function () { self.openModal(item.id); }
      }, [el('span', { class: 'nav-icon', text: item.icon }), el('span', { class: 'nav-label', text: item.label }), badge]));
    });

    var speeds = doc.getElementById('speedControls');
    clear(speeds);
    SWW.state.SPEEDS.forEach(function (sp) {
      speeds.appendChild(el('button', {
        class: 'speed-btn' + (self.state.speed === sp.id ? ' active' : ''),
        'data-speed': sp.id,
        text: sp.id === 'pause' ? '❚❚' : sp.label,
        title: sp.label,
        onclick: function () { self.setSpeed(sp.id); }
      }));
    });

    doc.getElementById('closePanel').addEventListener('click', function () { self.clearSelection(); });
    doc.getElementById('modalClose').addEventListener('click', function () { self.closeModal(); });
    doc.getElementById('modalBackdrop').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) self.closeModal();
    });
    doc.getElementById('cancelTargeting').addEventListener('click', function () { self.setTargeting(null); });
  };

  UI.setSpeed = function (id) {
    this.state.speed = id;
    var btns = doc.querySelectorAll('#speedControls .speed-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-speed') === id);
    }
  };

  // --- input ---------------------------------------------------------------

  UI.bindInput = function () {
    var self = this, canvas = this.canvas;
    var dragging = false, moved = 0, lastX = 0, lastY = 0, pointers = {}, pinchDist = 0;

    function localPos(e) {
      var rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    canvas.addEventListener('pointerdown', function (e) {
      canvas.setPointerCapture(e.pointerId);
      pointers[e.pointerId] = localPos(e);
      if (Object.keys(pointers).length === 1) {
        dragging = true; moved = 0;
        var p = pointers[e.pointerId];
        lastX = p.x; lastY = p.y;
      } else {
        dragging = false;
        pinchDist = pinchDistance(pointers);
      }
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!(e.pointerId in pointers)) return;
      var p = localPos(e);
      pointers[e.pointerId] = p;
      var ids = Object.keys(pointers);
      if (ids.length >= 2) {
        var d = pinchDistance(pointers);
        if (pinchDist > 0 && d > 0) {
          var mid = pinchMid(pointers);
          self.renderer.zoomAt(d / pinchDist, mid.x, mid.y);
        }
        pinchDist = d;
        return;
      }
      if (!dragging) return;
      var dx = p.x - lastX, dy = p.y - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      self.renderer.panBy(dx, dy);
      lastX = p.x; lastY = p.y;
    });

    function release(e) {
      var was = pointers[e.pointerId];
      delete pointers[e.pointerId];
      if (Object.keys(pointers).length < 2) pinchDist = 0;
      if (!dragging || !was) { dragging = false; return; }
      dragging = false;
      if (moved < 8) self.handleTap(was.x, was.y);
    }
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', function (e) { delete pointers[e.pointerId]; dragging = false; });

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = localPos(e);
      self.renderer.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
    }, { passive: false });

    global.addEventListener('resize', function () { self.renderer.resize(); });

    doc.addEventListener('keydown', function (e) {
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      if (e.key === 'Escape') {
        if (self.targeting) self.setTargeting(null);
        else if (self.modal) self.closeModal();
        else self.clearSelection();
      }
      if (e.key === ' ') {
        e.preventDefault();
        self.setSpeed(self.state.speed === 'pause' ? '1x' : 'pause');
      }
      if (e.key === '1') self.setSpeed('1x');
      if (e.key === '2') self.setSpeed('4x');
      if (e.key === '3') self.setSpeed('16x');
    });

    function pinchDistance(map) {
      var ids = Object.keys(map);
      if (ids.length < 2) return 0;
      var a = map[ids[0]], b = map[ids[1]];
      return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
    }
    function pinchMid(map) {
      var ids = Object.keys(map);
      var a = map[ids[0]], b = map[ids[1]];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  };

  UI.handleTap = function (sx, sy) {
    var prov = this.renderer.provinceAt(sx, sy);
    if (this.targeting && prov) { this.resolveTargeting(prov); return; }
    var army = this.armyAt(sx, sy);
    if (army) { this.selectArmy(army.id); return; }
    if (prov) this.selectProvince(prov.id);
    else this.clearSelection();
  };

  /** Hit-test army markers, which are drawn above the province centre. */
  UI.armyAt = function (sx, sy) {
    var state = this.state, r = this.renderer;
    var z = r.camera.zoom;
    var h = clamp(z * 2.2, 14, 30), w = h * 1.6;
    var groups = {};
    var i;
    for (i = 0; i < state.armies.length; i++) {
      var a = state.armies[i];
      if (a.ownerId !== state.playerId && !this.visible[a.provinceId]) continue;
      var key = a.path.length ? a.id : a.provinceId;
      (groups[key] || (groups[key] = [])).push(a);
    }
    var best = null;
    for (var key in groups) {
      var list = groups[key];
      for (var k = 0; k < list.length; k++) {
        var army = list[k];
        var pt = r.armyPoint(army);
        var s = r.toScreen(pt.x, pt.y);
        var x = s.x + (k - (list.length - 1) / 2) * (w * 0.55);
        var y = s.y - h * 0.9;
        if (sx >= x - w / 2 - 3 && sx <= x + w / 2 + 3 && sy >= y - h / 2 - 3 && sy <= y + h / 2 + 3) {
          // Prefer the player's own stacks when markers overlap.
          if (!best || army.ownerId === state.playerId) best = army;
        }
      }
    }
    return best;
  };

  // --- selection -----------------------------------------------------------

  UI.selectProvince = function (id) {
    this.selectedProvinceId = id;
    this.selectedArmyId = null;
    this.renderPanel();
  };

  UI.selectArmy = function (id) {
    var army = SWW.state.armyById(this.state, id);
    if (!army) return;
    this.selectedArmyId = id;
    this.selectedProvinceId = army.provinceId;
    this.renderPanel();
  };

  UI.clearSelection = function () {
    this.selectedProvinceId = null;
    this.selectedArmyId = null;
    this.setTargeting(null);
    doc.getElementById('panel').classList.remove('open');
  };

  UI.setTargeting = function (mode) {
    this.targeting = mode;
    var bar = doc.getElementById('targetingBar');
    if (!mode) { bar.classList.remove('show'); return; }
    var labels = {
      move: 'Select a destination province',
      attack: 'Select a province to attack',
      bombard: 'Select a province to bombard',
      missile: 'Select a missile target'
    };
    doc.getElementById('targetingText').textContent = labels[mode] || 'Select a target';
    bar.classList.add('show');
  };

  UI.resolveTargeting = function (prov) {
    var army = SWW.state.armyById(this.state, this.selectedArmyId);
    if (!army) { this.setTargeting(null); return; }
    var res;
    if (this.targeting === 'bombard') res = SWW.orders.issueBombard(this.state, army, prov.id);
    else if (this.targeting === 'missile') {
      var rng = new SWW.RNG(this.state.rngState);
      res = SWW.combat.launchMissile(this.state, rng, army, prov.id);
      this.state.rngState = rng.s;
    } else res = SWW.orders.issueMove(this.state, army, prov.id);

    if (!res.ok) this.toast(res.why, 'warn');
    else if (res.hours) this.toast('Moving to ' + prov.name + ' — ' + util.fmtDuration(res.hours) + '.');
    this.setTargeting(null);
    this.renderPanel();
  };

  // --- HUD -----------------------------------------------------------------

  UI.refreshHud = function (force) {
    var state = this.state;
    if (!force && state.time - this.lastHud < 0.25) return;
    this.lastHud = state.time;
    var nation = state.nationById[state.playerId];
    var t = util.fmtTime(state.time);

    doc.getElementById('hudNation').textContent = nation.name;
    doc.getElementById('hudFlag').style.background = nation.color;
    doc.getElementById('hudDay').textContent = String(t.day);
    doc.getElementById('hudClock').textContent = t.clock;
    doc.getElementById('hudVp').textContent = nation.vp + '/' + state.victoryVP + ' VP';

    var strip = doc.getElementById('resourceStrip');
    if (!strip.childNodes.length) {
      RES_ORDER.concat(['gold']).forEach(function (res) {
        var meta = UnitData.RESOURCE_META[res];
        strip.appendChild(el('div', { class: 'res' + (res === 'gold' ? ' res-gold' : ''), 'data-res': res, title: meta.name }, [
          el('span', { class: 'res-icon', text: meta.icon }),
          el('span', { class: 'res-val', id: 'res-' + res, text: '0' }),
          el('span', { class: 'res-rate', id: 'rate-' + res, text: '' })
        ]));
      });
    }
    var net = nation.net || {};
    RES_ORDER.forEach(function (res) {
      doc.getElementById('res-' + res).textContent = fmt(nation.resources[res] || 0);
      var rateNode = doc.getElementById('rate-' + res);
      var r = net[res];
      if (r === undefined) { rateNode.textContent = ''; return; }
      rateNode.textContent = util.fmtRate(r * 24) + '/d';
      rateNode.className = 'res-rate ' + (r < -0.01 ? 'neg' : r > 0.01 ? 'pos' : '');
    });
    doc.getElementById('res-gold').textContent = fmt(nation.resources.gold || 0);

    var offers = (state.offers || []).length;
    this.setBadge('diplomacy', offers);
    var avail = 0;
    if (!nation.researching) {
      for (var i = 0; i < ResearchData.TECHS.length; i++) {
        var tech = ResearchData.TECHS[i];
        if (SWW.orders.techAvailable(nation, tech) && SWW.economy.canAfford(nation, tech.cost)) avail++;
      }
    }
    this.setBadge('research', avail);
    var idle = 0;
    for (var j = 0; j < nation.provinces.length; j++) {
      var p = state.provinces[nation.provinces[j]];
      if (p && !p.construction && !p.queue.length) idle++;
    }
    this.setBadge('cities', idle);
  };

  UI.setBadge = function (nav, count) {
    var node = doc.getElementById('badge-' + nav);
    if (!node) return;
    if (count > 0) { node.textContent = count > 99 ? '99' : String(count); node.style.display = ''; }
    else node.style.display = 'none';
  };

  UI.recomputeVisibility = function (force) {
    var state = this.state;
    if (!force && state.time - this.lastVisibility < 0.5) return;
    this.lastVisibility = state.time;
    var vis = {};
    var nation = state.nationById[state.playerId];
    var reach = 1 + SWW.economy.techBonus(nation, 'vision');
    var seeds = [];
    var i, j;
    for (i = 0; i < nation.provinces.length; i++) { vis[nation.provinces[i]] = true; seeds.push(nation.provinces[i]); }
    for (i = 0; i < state.armies.length; i++) {
      if (state.armies[i].ownerId !== state.playerId) continue;
      vis[state.armies[i].provinceId] = true;
      seeds.push(state.armies[i].provinceId);
    }
    for (var step = 0; step < reach; step++) {
      var next = [];
      for (i = 0; i < seeds.length; i++) {
        var nb = state.provinces[seeds[i]].neighbors;
        for (j = 0; j < nb.length; j++) {
          if (vis[nb[j]]) continue;
          vis[nb[j]] = true;
          next.push(nb[j]);
        }
      }
      seeds = next;
    }
    // Allies share what they can see of their own borders.
    for (i = 0; i < state.nations.length; i++) {
      var other = state.nations[i];
      if (other.id === nation.id || !other.alive) continue;
      if (SWW.state.treaty(state, nation.id, other.id) !== 'alliance') continue;
      for (j = 0; j < other.provinces.length; j++) vis[other.provinces[j]] = true;
    }
    // Cheap signature so the renderer only rebuilds fog when the set moves.
    var sig = 0, n = 0;
    for (var id in vis) { sig = (sig ^ (+id * 2654435761)) >>> 0; n++; }
    var stamp = sig + n * 7919;
    if (stamp !== this.visibleStamp) this.visibleStamp = stamp;
    this.visible = vis;
  };

  // --- selection panel -----------------------------------------------------

  UI.renderPanel = function () {
    var panel = doc.getElementById('panel');
    var body = doc.getElementById('panelBody');
    var title = doc.getElementById('panelTitle');
    var sub = doc.getElementById('panelSub');
    clear(body);

    if (this.selectedArmyId) {
      var army = SWW.state.armyById(this.state, this.selectedArmyId);
      if (!army) { this.selectedArmyId = null; this.renderPanel(); return; }
      title.textContent = army.name;
      var owner = this.state.nationById[army.ownerId];
      sub.textContent = owner.name + ' — ' + this.state.provinces[army.provinceId].name;
      body.appendChild(this.buildArmyPanel(army));
      panel.classList.add('open');
      return;
    }
    if (this.selectedProvinceId === null) { panel.classList.remove('open'); return; }

    var prov = this.state.provinces[this.selectedProvinceId];
    title.textContent = prov.name;
    var ownerName = prov.isSea ? 'Open water'
      : prov.nationId ? this.state.nationById[prov.nationId].name : 'Unclaimed territory';
    sub.textContent = ownerName + (prov.isSea ? '' : ' — ' + SWW.worldgen.TERRAIN[prov.terrain].name);
    body.appendChild(this.buildProvincePanel(prov));
    panel.classList.add('open');
  };

  UI.buildProvincePanel = function (prov) {
    var self = this, state = this.state;
    var wrap = el('div', { class: 'panel-sections' });
    var isMine = prov.nationId === state.playerId;

    if (!prov.isSea) {
      var meta = UnitData.RESOURCE_META[prov.deposit] || { name: '—', icon: '' };
      wrap.appendChild(el('div', { class: 'stat-grid' }, [
        stat('Population', String(prov.pop)),
        stat('City level', String(prov.cityLevel) + (prov.isCapital ? ' ★' : '')),
        stat('Morale', Math.round(prov.morale) + '%'),
        stat('Deposit', meta.icon + ' ' + meta.name),
        stat('Victory points', String(prov.vp)),
        stat('Terrain', SWW.worldgen.TERRAIN[prov.terrain].name)
      ]));
      if (prov.capture) {
        var by = state.nationById[prov.capture.by];
        wrap.appendChild(el('div', { class: 'notice warn' },
          'Being occupied by ' + (by ? by.name : 'enemy forces') + ' — ' +
          Math.round(prov.capture.progress / prov.capture.needed * 100) + '%'));
      }
    }

    var garrison = SWW.state.allArmiesAt(state, prov.id).filter(function (a) {
      return a.ownerId === state.playerId || self.visible[prov.id];
    });
    if (garrison.length) {
      var list = el('div', { class: 'stack-list' });
      garrison.forEach(function (army) {
        var n = state.nationById[army.ownerId];
        var st = SWW.state.armyStrength(army);
        list.appendChild(el('button', {
          class: 'stack-row', onclick: function () { self.selectArmy(army.id); }
        }, [
          el('span', { class: 'chip', style: 'background:' + n.color }),
          el('span', { class: 'stack-name', text: army.name }),
          el('span', { class: 'stack-meta', text: SWW.state.unitCount(army) + ' bn · ' + Math.round(st.ratio * 100) + '%' })
        ]));
      });
      wrap.appendChild(section('Forces present', list));
    }

    if (isMine) {
      wrap.appendChild(section('Construction', this.buildBuildingList(prov)));
      wrap.appendChild(section('Production', this.buildProductionList(prov)));
    } else if (!prov.isSea) {
      var owned = [];
      for (var b in prov.buildings) {
        if (prov.buildings[b]) owned.push(BuildingData.BY_ID[b].name + ' L' + prov.buildings[b]);
      }
      if (owned.length) wrap.appendChild(section('Known installations', el('div', { class: 'muted', text: owned.join(', ') })));
      if (prov.nationId && prov.nationId !== state.playerId) {
        var rel = SWW.state.treaty(state, state.playerId, prov.nationId);
        wrap.appendChild(el('div', { class: 'notice' + (rel === 'war' ? ' warn' : '') },
          'Relations: ' + SWW.diplomacy.TREATY_LABEL[rel]));
      }
    }
    return wrap;
  };

  UI.buildBuildingList = function (prov) {
    var self = this, state = this.state;
    var nation = state.nationById[state.playerId];
    var host = el('div', { class: 'build-list' });

    if (prov.construction) {
      var c = prov.construction;
      var b = BuildingData.BY_ID[c.buildingId];
      host.appendChild(el('div', { class: 'progress-row' }, [
        el('div', { class: 'progress-label', text: b.name + ' L' + c.level }),
        progressBar(1 - c.remaining / c.total),
        el('div', { class: 'progress-time', text: util.fmtDuration(c.remaining) }),
        el('button', {
          class: 'mini gold', text: '⚡ ' + Math.max(1, Math.ceil(c.remaining / 2)),
          title: 'Finish instantly with gold',
          onclick: function () {
            var r = SWW.orders.rushWithGold(state, nation, 'construction', prov);
            self.toast(r.ok ? 'Construction rushed.' : r.why, r.ok ? 'ok' : 'warn');
            self.renderPanel();
          }
        }),
        el('button', {
          class: 'mini danger', text: '✕', title: 'Cancel (60% refund)',
          onclick: function () { SWW.orders.cancelConstruction(state, prov); self.renderPanel(); }
        })
      ]));
    }

    BuildingData.BUILDINGS.forEach(function (b) {
      var level = prov.buildings[b.id] || 0;
      var next = level + 1;
      var maxed = level >= b.maxLevel;
      var blocked = b.coastalOnly && !prov.coastal;
      var cost = maxed ? null : BuildingData.costFor(b.id, next);
      var afford = cost ? SWW.economy.canAfford(nation, cost) : false;
      var row = el('div', { class: 'build-row' + (maxed ? ' done' : '') }, [
        el('span', { class: 'b-icon', text: b.icon }),
        el('div', { class: 'b-main' }, [
          el('div', { class: 'b-name', text: b.name + (level ? '  L' + level : '') }),
          el('div', { class: 'b-desc', text: blocked ? 'Coastal provinces only' : b.desc })
        ]),
        maxed || blocked ? el('span', { class: 'b-max', text: maxed ? 'MAX' : '—' })
          : el('button', {
            class: 'build-btn' + (afford ? '' : ' disabled'),
            onclick: function () {
              var r = SWW.orders.startConstruction(state, prov, b.id);
              self.toast(r.ok ? b.name + ' L' + next + ' started.' : r.why, r.ok ? 'ok' : 'warn');
              self.renderPanel();
            }
          }, [
            el('span', { text: 'Build L' + next }),
            el('span', { class: 'cost', text: costText(cost) }),
            el('span', { class: 'cost dim', text: util.fmtDuration(BuildingData.timeFor(b.id, next)) })
          ])
      ]);
      host.appendChild(row);
    });
    return host;
  };

  UI.buildProductionList = function (prov) {
    var self = this, state = this.state;
    var nation = state.nationById[state.playerId];
    var host = el('div', { class: 'build-list' });

    prov.queue.forEach(function (job, i) {
      var type = UnitData.BY_ID[job.typeId];
      host.appendChild(el('div', { class: 'progress-row' }, [
        el('div', { class: 'progress-label', text: type.icon + ' ' + type.name }),
        i === 0 ? progressBar(1 - job.remaining / job.total) : el('div', { class: 'progress-label dim', text: 'queued' }),
        el('div', { class: 'progress-time', text: util.fmtDuration(job.remaining) }),
        i === 0 ? el('button', {
          class: 'mini gold', text: '⚡ ' + Math.max(1, Math.ceil(job.remaining / 2)),
          onclick: function () {
            var r = SWW.orders.rushWithGold(state, nation, 'unit', prov);
            self.toast(r.ok ? 'Production rushed.' : r.why, r.ok ? 'ok' : 'warn');
            self.renderPanel();
          }
        }) : null,
        el('button', {
          class: 'mini danger', text: '✕',
          onclick: function () { SWW.orders.cancelQueued(state, prov, i); self.renderPanel(); }
        })
      ]));
    });

    UnitData.UNITS.forEach(function (type) {
      if (type.req.tech && !SWW.economy.hasTech(nation, type.req.tech)) return;
      var check = SWW.economy.canBuildUnitHere(state, prov, type);
      var afford = SWW.economy.canAfford(nation, type.cost);
      host.appendChild(el('div', { class: 'build-row' }, [
        el('span', { class: 'b-icon', text: type.icon }),
        el('div', { class: 'b-main' }, [
          el('div', { class: 'b-name', text: type.name }),
          el('div', { class: 'b-desc', text: check.ok ? type.desc : check.why })
        ]),
        el('button', {
          class: 'build-btn' + (check.ok && afford ? '' : ' disabled'),
          onclick: function () {
            var r = SWW.orders.queueUnit(state, prov, type.id);
            self.toast(r.ok ? type.name + ' queued.' : r.why, r.ok ? 'ok' : 'warn');
            self.renderPanel();
          }
        }, [
          el('span', { text: 'Build' }),
          el('span', { class: 'cost', text: costText(type.cost) }),
          el('span', { class: 'cost dim', text: util.fmtDuration(SWW.economy.unitBuildTime(state, nation, type)) })
        ])
      ]));
    });
    return host;
  };

  UI.buildArmyPanel = function (army) {
    var self = this, state = this.state;
    var mine = army.ownerId === state.playerId;
    var wrap = el('div', { class: 'panel-sections' });
    var st = SWW.state.armyStrength(army);
    var prov = state.provinces[army.provinceId];

    var statusText = army.path.length
      ? 'Moving to ' + state.provinces[army.path[army.path.length - 1]].name +
        ' — ' + util.fmtDuration(army.legRemaining + SWW.orders.estimateTravel(state, army, army.path.slice(1)))
      : army.order && army.order.type === 'bombard'
        ? 'Bombarding ' + state.provinces[army.order.target].name
        : army.inCombat ? 'In combat' : 'Holding position';

    wrap.appendChild(el('div', { class: 'stat-grid' }, [
      stat('Strength', Math.round(st.hp) + ' / ' + Math.round(st.max)),
      stat('Battalions', String(SWW.state.unitCount(army))),
      stat('Entrenched', Math.round(army.entrench * 100) + '%'),
      stat('Status', statusText)
    ]));

    if (mine) {
      var reach = SWW.combat.maxRange(state, army);
      var hasMissile = army.units.some(function (g) { return g.typeId === 'ballistic_missile'; });
      var actions = el('div', { class: 'action-row' }, [
        el('button', { class: 'act move', onclick: function () { self.setTargeting('move'); } },
          [el('span', { text: '»' }), el('span', { text: 'Move' })]),
        el('button', { class: 'act attack', onclick: function () { self.setTargeting('attack'); } },
          [el('span', { text: '⌖' }), el('span', { text: 'Attack' })]),
        reach > 0 ? el('button', { class: 'act bombard', onclick: function () { self.setTargeting('bombard'); } },
          [el('span', { text: '✲' }), el('span', { text: 'Bombard' })]) : null,
        hasMissile ? el('button', { class: 'act missile', onclick: function () { self.setTargeting('missile'); } },
          [el('span', { text: '↑' }), el('span', { text: 'Launch' })]) : null,
        (army.path.length || army.order) ? el('button', {
          class: 'act stop',
          onclick: function () { SWW.orders.stopArmy(state, army); self.renderPanel(); }
        }, [el('span', { text: '⦸' }), el('span', { text: 'Stop' })]) : null
      ]);
      wrap.appendChild(actions);

      var others = SWW.state.armiesIn(state, army.provinceId).filter(function (o) {
        return o.id !== army.id && SWW.orders.canMerge(state, army, o);
      });
      if (others.length) {
        var mergeRow = el('div', { class: 'inline-actions' });
        others.forEach(function (o) {
          mergeRow.appendChild(el('button', {
            class: 'ghost', text: 'Merge ' + o.name,
            onclick: function () {
              SWW.orders.mergeArmies(state, army, o);
              self.toast('Stacks merged.');
              self.renderPanel();
            }
          }));
        });
        wrap.appendChild(section('Consolidate', mergeRow));
      }
    }

    var unitList = el('div', { class: 'unit-list' });
    army.units.forEach(function (g) {
      var type = UnitData.BY_ID[g.typeId];
      var ratio = clamp(g.hp / (type.hp * g.count), 0, 1);
      unitList.appendChild(el('div', { class: 'unit-row' }, [
        el('span', { class: 'u-icon', text: type.icon }),
        el('div', { class: 'u-main' }, [
          el('div', { class: 'u-name', text: type.name + ' ×' + g.count }),
          progressBar(ratio, ratio > 0.6 ? 'ok' : ratio > 0.3 ? 'warn' : 'bad')
        ]),
        el('div', { class: 'u-stats' }, [
          el('div', { text: 'A ' + type.atk.inf.toFixed(0) + '/' + type.atk.arm.toFixed(0) + '/' + type.atk.air.toFixed(0) }),
          el('div', { class: 'dim', text: 'D ' + type.def.inf.toFixed(0) + '/' + type.def.arm.toFixed(0) + '/' + type.def.air.toFixed(0) })
        ]),
        mine && army.units.length > 1 ? el('button', {
          class: 'mini', text: 'Split', title: 'Detach into a new stack',
          onclick: function () {
            var r = SWW.orders.splitArmy(state, army, [{ typeId: g.typeId, count: 1 }]);
            self.toast(r.ok ? 'Detached ' + type.name + '.' : r.why, r.ok ? 'ok' : 'warn');
            self.renderPanel();
          }
        }) : null
      ]));
    });
    wrap.appendChild(section('Order of battle', unitList));

    if (!prov.isSea && prov.nationId && prov.nationId !== army.ownerId) {
      wrap.appendChild(el('div', { class: 'notice' }, 'Occupying enemy ground takes ' +
        util.fmtDuration(SWW.combat.captureHours(prov)) + ' without opposition.'));
    }
    return wrap;
  };

  // --- modals --------------------------------------------------------------

  UI.openModal = function (id) {
    this.modal = id;
    var backdrop = doc.getElementById('modalBackdrop');
    var body = doc.getElementById('modalBody');
    clear(body);
    var titles = {
      diplomacy: 'Diplomacy', market: 'Resource Market', cities: 'Provinces',
      research: 'Research', more: 'Command'
    };
    doc.getElementById('modalTitle').textContent = titles[id] || '';
    var builder = {
      diplomacy: this.buildDiplomacy, market: this.buildMarket, cities: this.buildCities,
      research: this.buildResearch, more: this.buildMore
    }[id];
    if (builder) body.appendChild(builder.call(this));
    backdrop.classList.add('show');
  };

  UI.closeModal = function () {
    this.modal = null;
    doc.getElementById('modalBackdrop').classList.remove('show');
  };

  UI.refreshModal = function () { if (this.modal) this.openModal(this.modal); };

  UI.buildDiplomacy = function () {
    var self = this, state = this.state;
    var me = state.nationById[state.playerId];
    var wrap = el('div', { class: 'modal-sections' });

    var offers = state.offers || [];
    if (offers.length) {
      var inbox = el('div', { class: 'offer-list' });
      offers.forEach(function (offer) {
        var from = state.nationById[offer.from];
        inbox.appendChild(el('div', { class: 'offer' }, [
          el('span', { class: 'chip', style: 'background:' + from.color }),
          el('div', { class: 'offer-text' }, [
            el('strong', { text: from.name }),
            el('span', { text: ' proposes ' + SWW.diplomacy.TREATY_LABEL[offer.type].toLowerCase() })
          ]),
          el('button', {
            class: 'ok-btn', text: 'Accept',
            onclick: function () { SWW.diplomacy.respondToOffer(state, offer.id, true); self.refreshModal(); }
          }),
          el('button', {
            class: 'ghost', text: 'Decline',
            onclick: function () { SWW.diplomacy.respondToOffer(state, offer.id, false); self.refreshModal(); }
          })
        ]));
      });
      wrap.appendChild(section('Incoming proposals', inbox));
    }

    var rows = el('div', { class: 'nation-list' });
    var others = state.nations.filter(function (n) { return n.id !== me.id && n.alive; })
      .sort(function (a, b) { return b.vp - a.vp; });
    others.forEach(function (n) {
      var rel = SWW.diplomacy.relation(state, me.id, n.id);
      var treaty = SWW.state.treaty(state, me.id, n.id);
      var neighbour = SWW.diplomacy.areNeighbours(state, me.id, n.id);
      var actions = el('div', { class: 'nation-actions' });
      if (treaty === 'war') {
        actions.appendChild(el('button', {
          class: 'ghost', text: 'Offer peace',
          onclick: function () {
            var r = SWW.diplomacy.proposeTreaty(state, me.id, n.id, 'peace');
            self.toast(r.accepted ? n.name + ' accepts the ceasefire.' : n.name + ' fights on.',
              r.accepted ? 'ok' : 'warn');
            self.refreshModal();
          }
        }));
      } else {
        if (treaty === 'peace') {
          actions.appendChild(el('button', {
            class: 'ghost', text: 'Non-aggression',
            onclick: function () {
              var r = SWW.diplomacy.proposeTreaty(state, me.id, n.id, 'nap');
              self.toast(r.accepted ? n.name + ' signs a non-aggression pact.' : n.name + ' declines.',
                r.accepted ? 'ok' : 'warn');
              self.refreshModal();
            }
          }));
        }
        if (treaty === 'peace' || treaty === 'nap') {
          actions.appendChild(el('button', {
            class: 'ghost', text: 'Alliance',
            onclick: function () {
              var r = SWW.diplomacy.proposeTreaty(state, me.id, n.id, 'alliance');
              self.toast(r.accepted ? n.name + ' joins your alliance.' : n.name + ' declines.',
                r.accepted ? 'ok' : 'warn');
              self.refreshModal();
            }
          }));
        }
        if (treaty === 'nap' || treaty === 'alliance') {
          actions.appendChild(el('button', {
            class: 'ghost', text: 'Withdraw',
            onclick: function () { SWW.diplomacy.breakTreaty(state, me.id, n.id); self.refreshModal(); }
          }));
        }
        actions.appendChild(el('button', {
          class: 'danger-btn', text: 'Declare war',
          onclick: function () {
            if (!global.confirm('Declare war on ' + n.name + '?')) return;
            SWW.diplomacy.declareWar(state, me.id, n.id, 'a formal declaration');
            self.refreshModal();
          }
        }));
      }

      rows.appendChild(el('div', { class: 'nation-row' }, [
        el('span', { class: 'chip big', style: 'background:' + n.color }),
        el('div', { class: 'nation-main' }, [
          el('div', { class: 'nation-name' }, [
            el('span', { text: n.name }),
            el('span', { class: 'tag ' + treaty, text: SWW.diplomacy.TREATY_LABEL[treaty] }),
            neighbour ? el('span', { class: 'tag dim', text: 'border' }) : null
          ]),
          el('div', { class: 'nation-meta', text: n.vp + ' VP · ' + n.provinces.length + ' prov · ' +
            Math.round(SWW.state.nationPower(state, n.id)) + ' mil' }),
          relationBar(rel)
        ]),
        actions
      ]));
    });
    wrap.appendChild(section('Powers of the world', rows));
    return wrap;
  };

  UI.buildMarket = function () {
    var self = this, state = this.state;
    var nation = state.nationById[state.playerId];
    var wrap = el('div', { class: 'modal-sections' });
    var amountRef = { value: 500 };

    var picker = el('div', { class: 'amount-picker' });
    [100, 500, 1000, 5000].forEach(function (n) {
      picker.appendChild(el('button', {
        class: 'ghost' + (n === amountRef.value ? ' active' : ''), text: String(n),
        onclick: function (e) {
          amountRef.value = n;
          var sibs = e.currentTarget.parentNode.childNodes;
          for (var i = 0; i < sibs.length; i++) sibs[i].classList.toggle('active', sibs[i] === e.currentTarget);
        }
      }));
    });
    wrap.appendChild(section('Trade size', picker));

    var list = el('div', { class: 'market-list' });
    SWW.market.TRADED.forEach(function (res) {
      var meta = UnitData.RESOURCE_META[res];
      var price = state.market.prices[res];
      var base = state.market.base[res];
      var delta = (price / base - 1) * 100;
      list.appendChild(el('div', { class: 'market-row' }, [
        el('span', { class: 'm-icon', text: meta.icon }),
        el('div', { class: 'm-main' }, [
          el('div', { class: 'm-name', text: meta.name }),
          el('div', { class: 'm-stock', text: 'Stock ' + fmt(nation.resources[res]) })
        ]),
        sparkline(state.market.history[res]),
        el('div', { class: 'm-price' }, [
          el('div', { text: '$' + price.toFixed(2) }),
          el('div', { class: 'm-delta ' + (delta >= 0 ? 'pos' : 'neg'), text: (delta >= 0 ? '+' : '') + delta.toFixed(1) + '%' })
        ]),
        el('div', { class: 'm-actions' }, [
          el('button', {
            class: 'ok-btn', text: 'Buy',
            title: 'Buy at $' + SWW.market.buyPrice(state, res).toFixed(2),
            onclick: function () {
              var r = SWW.market.buy(state, nation, res, amountRef.value);
              self.toast(r.ok ? 'Bought ' + amountRef.value + ' ' + meta.name.toLowerCase() +
                ' for $' + Math.round(r.cost) : r.why, r.ok ? 'ok' : 'warn');
              self.refreshModal();
            }
          }),
          el('button', {
            class: 'ghost', text: 'Sell',
            title: 'Sell at $' + SWW.market.sellPrice(state, res).toFixed(2),
            onclick: function () {
              var r = SWW.market.sell(state, nation, res, amountRef.value);
              self.toast(r.ok ? 'Sold ' + amountRef.value + ' ' + meta.name.toLowerCase() +
                ' for $' + Math.round(r.gain) : r.why, r.ok ? 'ok' : 'warn');
              self.refreshModal();
            }
          })
        ])
      ]));
    });
    wrap.appendChild(section('Exchange · treasury $' + fmt(nation.resources.cash), list));
    wrap.appendChild(el('div', { class: 'muted small' },
      'Prices drift hourly and move against large orders. The spread is ' +
      Math.round(SWW.market.SPREAD * 200) + '%.'));
    return wrap;
  };

  UI.buildCities = function () {
    var self = this, state = this.state;
    var nation = state.nationById[state.playerId];
    var wrap = el('div', { class: 'modal-sections' });
    var list = el('div', { class: 'city-list' });

    var provs = nation.provinces.map(function (id) { return state.provinces[id]; })
      .sort(function (a, b) { return b.pop - a.pop; });

    provs.forEach(function (p) {
      var busy = p.construction ? BuildingData.BY_ID[p.construction.buildingId].name + ' L' + p.construction.level
        : p.queue.length ? UnitData.BY_ID[p.queue[0].typeId].name : null;
      var out = SWW.economy.provinceOutput(state, p);
      var depositMeta = UnitData.RESOURCE_META[p.deposit];
      list.appendChild(el('button', {
        class: 'city-row' + (busy ? '' : ' idle'),
        onclick: function () {
          self.closeModal();
          self.selectProvince(p.id);
          self.renderer.centerOn(p.id, Math.max(self.renderer.camera.zoom, 9));
        }
      }, [
        el('div', { class: 'c-main' }, [
          el('div', { class: 'c-name' }, [
            el('span', { text: p.name }),
            p.isCapital ? el('span', { class: 'tag', text: 'capital' }) : null,
            !busy ? el('span', { class: 'tag warn', text: 'idle' }) : null
          ]),
          el('div', { class: 'c-meta', text: 'Pop ' + p.pop + ' · morale ' + Math.round(p.morale) +
            '% · ' + depositMeta.icon + ' ' + fmt(out[p.deposit] * 24) + '/d' })
        ]),
        el('div', { class: 'c-status', text: busy || 'No orders' })
      ]));
    });
    wrap.appendChild(section(nation.provinces.length + ' provinces', list));
    return wrap;
  };

  UI.buildResearch = function () {
    var self = this, state = this.state;
    var nation = state.nationById[state.playerId];
    var wrap = el('div', { class: 'modal-sections' });

    if (nation.researching) {
      var tech = ResearchData.BY_ID[nation.researching.techId];
      wrap.appendChild(section('In progress', el('div', { class: 'progress-row' }, [
        el('div', { class: 'progress-label', text: tech.name }),
        progressBar(1 - nation.researching.remaining / nation.researching.total),
        el('div', { class: 'progress-time', text: util.fmtDuration(nation.researching.remaining) }),
        el('button', {
          class: 'mini gold', text: '⚡ ' + Math.max(1, Math.ceil(nation.researching.remaining / 3)),
          onclick: function () {
            var r = SWW.orders.rushWithGold(state, nation, 'research', null);
            self.toast(r.ok ? 'Research rushed.' : r.why, r.ok ? 'ok' : 'warn');
            self.refreshModal();
          }
        }),
        el('button', {
          class: 'mini danger', text: '✕',
          onclick: function () { SWW.orders.cancelResearch(state, nation); self.refreshModal(); }
        })
      ])));
    }

    ResearchData.BRANCHES.forEach(function (branch) {
      var techs = ResearchData.TECHS.filter(function (t) { return t.branch === branch.id; });
      var list = el('div', { class: 'tech-list' });
      techs.forEach(function (t) {
        var done = !!nation.research[t.id];
        var active = !!nation.researching && nation.researching.techId === t.id;
        var open = SWW.orders.techAvailable(nation, t);
        var afford = SWW.economy.canAfford(nation, t.cost);
        var missing = t.req.filter(function (r) { return !nation.research[r]; })
          .map(function (r) { return ResearchData.BY_ID[r].name; });
        list.appendChild(el('div', { class: 'tech-row ' + (done ? 'done' : active ? 'active' : open ? 'open' : 'locked') }, [
          el('div', { class: 'tech-main' }, [
            el('div', { class: 'tech-name', text: t.name }),
            el('div', {
              class: 'tech-desc',
              text: done ? 'Researched'
                : active ? 'In progress — ' + util.fmtDuration(nation.researching.remaining) + ' remaining'
                  : missing.length ? 'Requires ' + missing.join(', ') : t.desc
            })
          ]),
          done ? el('span', { class: 'tech-done', text: '✓' })
            : active ? el('span', { class: 'tech-active', text: '⏳' })
              : el('button', {
              class: 'build-btn' + (open && afford && !nation.researching ? '' : ' disabled'),
              onclick: function () {
                var r = SWW.orders.startResearch(state, nation, t.id);
                self.toast(r.ok ? 'Researching ' + t.name + '.' : r.why, r.ok ? 'ok' : 'warn');
                self.refreshModal();
              }
            }, [
              el('span', { text: 'Research' }),
              el('span', { class: 'cost', text: costText(t.cost) }),
              el('span', { class: 'cost dim', text: t.days + 'd' })
            ])
        ]));
      });
      wrap.appendChild(section(branch.icon + '  ' + branch.name, list));
    });
    return wrap;
  };

  UI.buildMore = function () {
    var self = this, state = this.state;
    var wrap = el('div', { class: 'modal-sections' });

    var tabs = el('div', { class: 'tabs' });
    var host = el('div', { class: 'tab-host' });
    var views = {
      Log: function () { return self.buildLogView(); },
      Ranking: function () { return self.buildRanking(); },
      Army: function () { return self.buildArmyOverview(); },
      Game: function () { return self.buildGameMenu(); },
      Help: function () { return self.buildHelp(); }
    };
    Object.keys(views).forEach(function (name, i) {
      tabs.appendChild(el('button', {
        class: 'tab' + (i === 0 ? ' active' : ''), text: name,
        onclick: function (e) {
          var sibs = e.currentTarget.parentNode.childNodes;
          for (var k = 0; k < sibs.length; k++) sibs[k].classList.toggle('active', sibs[k] === e.currentTarget);
          clear(host);
          host.appendChild(views[name]());
        }
      }));
    });
    host.appendChild(views.Log());
    wrap.appendChild(tabs);
    wrap.appendChild(host);
    return wrap;
  };

  UI.buildLogView = function () {
    var state = this.state;
    var list = el('div', { class: 'log-list' });
    state.log.slice(0, 80).forEach(function (entry) {
      var t = util.fmtTime(entry.t);
      list.appendChild(el('div', { class: 'log-row kind-' + entry.kind }, [
        el('span', { class: 'log-time', text: 'D' + t.day + ' ' + t.clock }),
        el('span', { class: 'log-text', text: entry.text })
      ]));
    });
    if (!state.log.length) list.appendChild(el('div', { class: 'muted', text: 'Nothing has happened yet.' }));
    return list;
  };

  UI.buildRanking = function () {
    var state = this.state;
    var list = el('div', { class: 'rank-list' });
    var nations = state.nations.slice().sort(function (a, b) { return b.vp - a.vp; });
    nations.forEach(function (n, i) {
      list.appendChild(el('div', { class: 'rank-row' + (n.isPlayer ? ' me' : '') + (n.alive ? '' : ' dead') }, [
        el('span', { class: 'rank-pos', text: '#' + (i + 1) }),
        el('span', { class: 'chip', style: 'background:' + n.color }),
        el('span', { class: 'rank-name', text: n.name + (n.alive ? '' : ' (defeated)') }),
        el('span', { class: 'rank-vp', text: n.vp + ' VP' }),
        el('span', { class: 'rank-meta', text: n.provinces.length + 'p · ' + Math.round(SWW.state.nationPower(state, n.id)) })
      ]));
    });
    return list;
  };

  UI.buildArmyOverview = function () {
    var self = this, state = this.state;
    var list = el('div', { class: 'stack-list' });
    var armies = SWW.state.armiesOf(state, state.playerId);
    armies.sort(function (a, b) { return SWW.state.armyPower(b) - SWW.state.armyPower(a); });
    armies.forEach(function (army) {
      var st = SWW.state.armyStrength(army);
      var prov = state.provinces[army.provinceId];
      list.appendChild(el('button', {
        class: 'stack-row',
        onclick: function () {
          self.closeModal();
          self.selectArmy(army.id);
          self.renderer.centerOn(army.provinceId, Math.max(self.renderer.camera.zoom, 9));
        }
      }, [
        el('span', { class: 'stack-name', text: army.name }),
        el('span', { class: 'stack-meta', text: prov.name + ' · ' + SWW.state.unitCount(army) + ' bn · ' +
          Math.round(st.ratio * 100) + '%' + (army.path.length ? ' · moving' : army.inCombat ? ' · fighting' : '') })
      ]));
    });
    if (!armies.length) list.appendChild(el('div', { class: 'muted', text: 'You have no forces in the field.' }));
    return list;
  };

  UI.buildGameMenu = function () {
    var self = this, state = this.state;
    var wrap = el('div', { class: 'menu-list' });
    var info = SWW.save.peek();
    wrap.appendChild(el('div', { class: 'muted small', text: 'Seed: ' + state.seed }));
    wrap.appendChild(el('button', {
      class: 'ok-btn wide', text: 'Save game',
      onclick: function () {
        var r = SWW.save.save(state);
        self.toast(r.ok ? 'Game saved.' : 'Save failed: ' + r.why, r.ok ? 'ok' : 'warn');
      }
    }));
    wrap.appendChild(el('button', {
      class: 'ghost wide' + (info ? '' : ' disabled'),
      text: info ? 'Load last save (day ' + (Math.floor(info.time / 24) + 1) + ')' : 'No save found',
      onclick: function () {
        if (!info) return;
        if (!global.confirm('Load the last save? Unsaved progress is lost.')) return;
        var r = SWW.save.load();
        if (!r.ok) { self.toast('Load failed: ' + r.why, 'warn'); return; }
        SWW.game.replaceState(r.state);
        self.closeModal();
      }
    }));
    wrap.appendChild(el('button', {
      class: 'danger-btn wide', text: 'Abandon and start a new war',
      onclick: function () {
        if (!global.confirm('Leave this war and return to the menu?')) return;
        SWW.game.toMenu();
      }
    }));
    return wrap;
  };

  UI.buildHelp = function () {
    return el('div', { class: 'help' }, [
      el('h4', { text: 'Winning' }),
      el('p', { text: 'Provinces are worth victory points; cities and capitals are worth more. ' +
        'Reach the victory threshold shown in the top bar, or be the last nation standing.' }),
      el('h4', { text: 'Economy' }),
      el('p', { text: 'Every province farms and pays tax. Its deposit yields one of materials, fuel or ' +
        'chemicals. Ammunition only comes from arms factories, which burn materials and chemicals to make it. ' +
        'Run out of food or cash and your army starts to fall apart.' }),
      el('h4', { text: 'Fighting' }),
      el('p', { text: 'Move a stack onto a hostile province to attack it. Stacks in the same province ' +
        'exchange fire every hour; the survivor grinds down the occupation timer. Artillery, SAMs, ' +
        'destroyers and carriers can bombard a neighbouring province without entering it.' }),
      el('h4', { text: 'Terrain and morale' }),
      el('p', { text: 'Mountains and jungle slow attackers and shelter defenders. Provinces far from your ' +
        'capital lose morale, and low morale cuts production and combat strength. Bunkers and propaganda help.' }),
      el('h4', { text: 'Controls' }),
      el('p', { text: 'Drag to pan, scroll or pinch to zoom, tap a province or stack to select it. ' +
        'Space pauses, 1/2/3 set game speed, Escape cancels.' })
    ]);
  };

  // --- toasts and overlays -------------------------------------------------

  UI.toast = function (text, kind) {
    var host = doc.getElementById('toasts');
    var node = el('div', { class: 'toast ' + (kind || ''), text: text });
    host.appendChild(node);
    global.setTimeout(function () {
      node.classList.add('out');
      global.setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 400);
    }, 3200);
    while (host.childNodes.length > 4) host.removeChild(host.firstChild);
  };

  /** Surface newly logged events the player should notice. */
  UI.drainLog = function () {
    var state = this.state;
    var fresh = [];
    for (var i = 0; i < state.log.length; i++) {
      if (state.log[i].read) break;
      state.log[i].read = true;
      fresh.push(state.log[i]);
    }
    var important = { capture: 1, combat: 1, diplomacy: 1, research: 1 };
    fresh.reverse();
    for (var j = 0; j < fresh.length; j++) {
      if (!important[fresh[j].kind]) continue;
      this.toast(fresh[j].text, fresh[j].kind === 'capture' ? 'ok' : '');
    }
  };

  UI.showGameOver = function () {
    var state = this.state;
    if (!state.gameOver || this.gameOverShown) return;
    this.gameOverShown = true;
    var over = doc.getElementById('gameOver');
    var win = state.gameOver.result === 'victory';
    var winner = state.gameOver.winner ? state.nationById[state.gameOver.winner] : null;
    doc.getElementById('overTitle').textContent = win ? 'Victory' : 'Defeat';
    doc.getElementById('overText').textContent = win
      ? 'Your nation dominates the world after ' + Math.ceil(state.time / 24) + ' days of war.'
      : (winner ? winner.name + ' has won the war on day ' + Math.ceil(state.time / 24) + '.'
        : 'Your nation has been erased from the map.');
    over.classList.add('show');
    doc.getElementById('overRestart').onclick = function () { SWW.game.toMenu(); };
    doc.getElementById('overWatch').onclick = function () { over.classList.remove('show'); };
    this.setSpeed('pause');
  };

  // --- per-frame -----------------------------------------------------------

  UI.frame = function () {
    this.recomputeVisibility();
    this.refreshHud();
    this.drainLog();
    if (this.state.gameOver) this.showGameOver();
    this.renderer.draw(this);
    if (this.panelStale()) this.renderPanel();
  };

  UI.panelStale = function () {
    // Cheap refresh: repaint the panel about once a game hour so timers move.
    var now = Math.floor(this.state.time * 4);
    if (now === this.lastPanel) return false;
    this.lastPanel = now;
    return this.selectedProvinceId !== null || this.selectedArmyId !== null;
  };

  // --- small builders ------------------------------------------------------

  function section(title, content) {
    return el('div', { class: 'section' }, [el('h3', { text: title }), content]);
  }

  function stat(label, value) {
    return el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label', text: label }),
      el('div', { class: 'stat-value', text: value })
    ]);
  }

  function progressBar(ratio, tone) {
    var fill = el('div', { class: 'bar-fill ' + (tone || '') });
    fill.style.width = clamp(ratio, 0, 1) * 100 + '%';
    return el('div', { class: 'bar' }, fill);
  }

  /** Relation meter centred on zero: green to the right, red to the left. */
  function relationBar(value) {
    var track = el('div', { class: 'rel-bar' });
    var fill = el('div', { class: 'rel-fill ' + (value >= 0 ? 'pos' : 'neg') });
    fill.style.width = Math.abs(value) / 2 + '%';
    fill.style.left = value >= 0 ? '50%' : (50 - Math.abs(value) / 2) + '%';
    track.appendChild(fill);
    return el('div', { class: 'rel-row' }, [
      track,
      el('span', { class: 'rel-val', text: (value > 0 ? '+' : '') + Math.round(value) })
    ]);
  }

  function costText(cost) {
    if (!cost) return '';
    var parts = [];
    for (var k in cost) {
      var meta = UnitData.RESOURCE_META[k];
      parts.push((meta ? meta.icon : '') + fmt(cost[k]));
    }
    return parts.join(' ');
  }

  function sparkline(series) {
    var w = 62, h = 22;
    var node = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    node.setAttribute('class', 'spark');
    if (!series || series.length < 2) return node;
    var min = Math.min.apply(null, series), max = Math.max.apply(null, series);
    var span = Math.max(1e-6, max - min);
    var pts = series.map(function (v, i) {
      var x = i / (series.length - 1) * w;
      var y = h - ((v - min) / span) * (h - 4) - 2;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    var line = doc.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', pts);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', series[series.length - 1] >= series[0] ? '#6fe08a' : '#e0706f');
    line.setAttribute('stroke-width', '1.5');
    node.appendChild(line);
    return node;
  }

  SWW.UI = UI;
  SWW.el = el;
  SWW.clearNode = clear;
})(typeof globalThis !== 'undefined' ? globalThis : this);
