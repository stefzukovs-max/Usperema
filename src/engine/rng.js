/* Deterministic, seedable RNG (mulberry32) plus a few sampling helpers. */
(function (global) {
  'use strict';

  function hashString(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function RNG(seed) {
    if (typeof seed === 'string') seed = hashString(seed);
    this.s = (seed >>> 0) || 1;
  }

  RNG.prototype.next = function () {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    var t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** Float in [a, b). */
  RNG.prototype.range = function (a, b) { return a + (b - a) * this.next(); };

  /** Integer in [a, b] inclusive. */
  RNG.prototype.int = function (a, b) { return Math.floor(a + (b - a + 1) * this.next()); };

  RNG.prototype.pick = function (arr) { return arr[Math.floor(this.next() * arr.length)]; };

  RNG.prototype.chance = function (p) { return this.next() < p; };

  RNG.prototype.shuffle = function (arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(this.next() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  };

  global.SWW = global.SWW || {};
  global.SWW.RNG = RNG;
  global.SWW.hashString = hashString;
})(typeof globalThis !== 'undefined' ? globalThis : this);
