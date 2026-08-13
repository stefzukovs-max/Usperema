/*
 * Sound.
 *
 * Every sound here is synthesised at play time from oscillators and shaped
 * noise — there is not a single sampled asset in the game, which keeps it
 * original and keeps the download at nothing.
 *
 * The palette is deliberately narrow and dry: a wooden click for selection, a
 * two-note signal for an order, a filtered thump for gunfire, a small brass
 * chord for something finished, and a low horn for a declaration of war.  A
 * strategy map is looked at for a long time, so nothing here is allowed to be
 * bright or repetitive.
 *
 * Browsers will not start an audio context until the player has touched the
 * page, so the context is created on the first gesture and everything before
 * that is silently dropped.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};
  var STORE = 'ia.volume';

  var ctx = null;
  var master = null;
  var ready = false;
  var volume = 0.6;
  var lastAt = {};

  function load() {
    try {
      var v = global.localStorage && global.localStorage.getItem(STORE);
      if (v !== null && v !== undefined && v !== '') volume = Math.max(0, Math.min(1, Number(v)));
    } catch (e) { /* private mode; keep the default */ }
  }
  load();

  function start() {
    if (ready) return true;
    var Ctor = global.AudioContext || global.webkitAudioContext;
    if (!Ctor) return false;
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
      ready = true;
    } catch (e) {
      ready = false;
    }
    return ready;
  }

  function resume() {
    if (!start()) return;
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    if (master) master.gain.value = volume;
    try {
      if (global.localStorage) global.localStorage.setItem(STORE, String(volume));
    } catch (e) { /* nothing to be done about it */ }
  }

  function getVolume() { return volume; }

  /** One shaped oscillator note. */
  function tone(opts) {
    var t0 = ctx.currentTime + (opts.delay || 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.from, t0);
    if (opts.to && opts.to !== opts.from) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), t0 + opts.dur);
    }
    var peak = (opts.gain === undefined ? 0.25 : opts.gain);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.02, opts.dur * 0.3));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.02);
  }

  /** A burst of noise through a filter: everything percussive is made of this. */
  function noise(opts) {
    var t0 = ctx.currentTime + (opts.delay || 0);
    var len = Math.max(1, Math.floor(ctx.sampleRate * opts.dur));
    var buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < len; i++) {
      // Fades across the buffer so the tail is never a click.
      data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    var src = ctx.createBufferSource();
    src.buffer = buffer;
    var filter = ctx.createBiquadFilter();
    filter.type = opts.filter || 'lowpass';
    filter.frequency.setValueAtTime(opts.freq || 800, t0);
    if (opts.freqTo) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqTo), t0 + opts.dur);
    }
    var gain = ctx.createGain();
    gain.gain.setValueAtTime(opts.gain === undefined ? 0.3 : opts.gain, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    src.start(t0);
  }

  /*
   * The sounds themselves.  Kept in one table so the whole palette can be read
   * at a glance and nothing drifts apart.
   */
  var SOUNDS = {
    select: function () {
      noise({ dur: 0.045, freq: 2400, freqTo: 900, gain: 0.16, filter: 'bandpass' });
    },
    order: function () {
      tone({ from: 420, to: 620, dur: 0.09, gain: 0.16, type: 'triangle' });
      tone({ from: 620, to: 700, dur: 0.10, gain: 0.12, type: 'triangle', delay: 0.07 });
    },
    deny: function () {
      tone({ from: 260, to: 150, dur: 0.16, gain: 0.18, type: 'sawtooth' });
    },
    battle: function () {
      noise({ dur: 0.36, freq: 620, freqTo: 90, gain: 0.30 });
      tone({ from: 90, to: 44, dur: 0.30, gain: 0.20, type: 'sine' });
    },
    build: function () {
      tone({ from: 330, dur: 0.16, gain: 0.13, type: 'triangle' });
      tone({ from: 440, dur: 0.20, gain: 0.11, type: 'triangle', delay: 0.06 });
    },
    research: function () {
      tone({ from: 523, dur: 0.10, gain: 0.11, type: 'sine' });
      tone({ from: 659, dur: 0.10, gain: 0.10, type: 'sine', delay: 0.07 });
      tone({ from: 784, dur: 0.18, gain: 0.10, type: 'sine', delay: 0.14 });
    },
    war: function () {
      // A low horn: two detuned voices so it beats slightly.
      tone({ from: 138, dur: 0.85, gain: 0.20, type: 'sawtooth' });
      tone({ from: 139.6, dur: 0.85, gain: 0.16, type: 'sawtooth' });
      tone({ from: 92, dur: 0.95, gain: 0.14, type: 'sine' });
    },
    treaty: function () {
      tone({ from: 392, dur: 0.22, gain: 0.12, type: 'triangle' });
      tone({ from: 494, dur: 0.26, gain: 0.11, type: 'triangle', delay: 0.05 });
      tone({ from: 587, dur: 0.34, gain: 0.10, type: 'triangle', delay: 0.10 });
    },
    victory: function () {
      [392, 494, 587, 784].forEach(function (f, i) {
        tone({ from: f, dur: 0.9 - i * 0.1, gain: 0.16, type: 'triangle', delay: i * 0.13 });
      });
    },
    defeat: function () {
      [330, 294, 247, 165].forEach(function (f, i) {
        tone({ from: f, dur: 0.9, gain: 0.16, type: 'sawtooth', delay: i * 0.18 });
      });
    }
  };

  /*
   * Minimum gap between two of the same sound, in milliseconds.  A war of this
   * size can produce a dozen engagements a second at 16x, and without a throttle
   * the gunfire becomes a single flat roar.
   */
  var GAP = { battle: 260, select: 40, order: 60, build: 200, research: 200 };

  function play(name) {
    if (!ready || !SOUNDS[name] || volume <= 0) return;
    var now = global.performance ? global.performance.now() : Date.now();
    var gap = GAP[name] || 0;
    if (gap && lastAt[name] && now - lastAt[name] < gap) return;
    lastAt[name] = now;
    try {
      SOUNDS[name]();
    } catch (e) { /* an unplayable sound is never worth breaking a frame for */ }
  }

  /** Wire the first real gesture to starting the context. */
  function arm(target) {
    var node = target || global.document;
    var once = function () {
      resume();
      node.removeEventListener('pointerdown', once);
      node.removeEventListener('keydown', once);
    };
    node.addEventListener('pointerdown', once);
    node.addEventListener('keydown', once);
  }

  IA.audio = {
    arm: arm, play: play, resume: resume,
    setVolume: setVolume, getVolume: getVolume,
    isReady: function () { return ready; },
    names: function () { return Object.keys(SOUNDS); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
