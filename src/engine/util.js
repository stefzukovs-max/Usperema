/* Small shared helpers: formatting, clamping, priority queue, time display. */
(function (global) {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** Compact resource formatting: 1234 -> "1.2k", 1250000 -> "1.3M". */
  function fmt(n) {
    var v = Math.floor(n);
    var abs = Math.abs(v);
    if (abs >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (abs >= 10000) return Math.round(v / 1000) + 'k';
    if (abs >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(v);
  }

  /** Signed rate, e.g. "+12" / "-4". */
  function fmtRate(n) {
    var s = n >= 0 ? '+' : '-';
    return s + fmt(Math.abs(n));
  }

  /** Game hours -> "Day 3  14:00". */
  function fmtTime(hours) {
    var day = Math.floor(hours / 24) + 1;
    var h = Math.floor(hours % 24);
    var m = Math.floor((hours % 1) * 60);
    return { day: day, clock: pad2(h) + ':' + pad2(m) };
  }

  /** Duration in game hours -> "2d 04h" / "6h 30m". */
  function fmtDuration(hours) {
    if (hours >= 24) {
      var d = Math.floor(hours / 24);
      return d + 'd ' + pad2(Math.floor(hours % 24)) + 'h';
    }
    if (hours >= 1) {
      return Math.floor(hours) + 'h ' + pad2(Math.floor((hours % 1) * 60)) + 'm';
    }
    return Math.max(1, Math.round(hours * 60)) + 'm';
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /** Binary-heap priority queue used by pathfinding. */
  function Heap(cmp) { this.a = []; this.cmp = cmp || function (x, y) { return x - y; }; }
  Heap.prototype.push = function (v) {
    var a = this.a; a.push(v);
    var i = a.length - 1;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (this.cmp(a[i], a[p]) >= 0) break;
      var t = a[i]; a[i] = a[p]; a[p] = t; i = p;
    }
  };
  Heap.prototype.pop = function () {
    var a = this.a;
    if (a.length === 0) return undefined;
    var top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      var i = 0;
      for (;;) {
        var l = i * 2 + 1, r = l + 1, m = i;
        if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        var t = a[i]; a[i] = a[m]; a[m] = t; i = m;
      }
    }
    return top;
  };
  Object.defineProperty(Heap.prototype, 'size', { get: function () { return this.a.length; } });

  global.SWW = global.SWW || {};
  global.SWW.util = {
    clamp: clamp, fmt: fmt, fmtRate: fmtRate, fmtTime: fmtTime,
    fmtDuration: fmtDuration, pad2: pad2, Heap: Heap
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
