/*
 * Global resource exchange.  Prices mean-revert to a base value, wander a
 * little each hour, and move against you when you trade in size.
 */
(function (global) {
  'use strict';

  var SWW = global.SWW = global.SWW || {};
  var clamp = SWW.util.clamp;

  var BASE_PRICE = {
    manpower: 4.2, food: 1.9, materials: 3.1, fuel: 4.0, ammo: 5.2, chemicals: 6.4
  };
  var TRADED = Object.keys(BASE_PRICE);
  var SPREAD = 0.06;        // half-spread around the mid price
  var LIQUIDITY = 9000;     // units that move the price by ~1x its value
  var HISTORY = 96;         // hours of price history kept for the chart

  function init(state, rng) {
    var m = { prices: {}, history: {}, base: {} };
    for (var i = 0; i < TRADED.length; i++) {
      var k = TRADED[i];
      var p = BASE_PRICE[k] * (rng ? rng.range(0.92, 1.08) : 1);
      m.base[k] = BASE_PRICE[k];
      m.prices[k] = p;
      m.history[k] = [p];
    }
    state.market = m;
    return m;
  }

  function tick(state, rng, hours) {
    var m = state.market;
    if (!m) return;
    for (var i = 0; i < TRADED.length; i++) {
      var k = TRADED[i];
      var base = m.base[k];
      var drift = (rng.next() - 0.5) * 0.035 * hours;
      var revert = (base - m.prices[k]) / base * 0.05 * hours;
      m.prices[k] = clamp(m.prices[k] * (1 + drift + revert), base * 0.35, base * 3.2);
      var h = m.history[k];
      h.push(m.prices[k]);
      if (h.length > HISTORY) h.shift();
    }
  }

  function buyPrice(state, res) { return state.market.prices[res] * (1 + SPREAD); }
  function sellPrice(state, res) { return state.market.prices[res] * (1 - SPREAD); }

  function quoteBuy(state, res, amount) { return buyPrice(state, res) * amount; }
  function quoteSell(state, res, amount) { return sellPrice(state, res) * amount; }

  function impact(state, res, signedAmount) {
    var m = state.market;
    var factor = 1 + signedAmount / LIQUIDITY;
    m.prices[res] = clamp(m.prices[res] * factor, m.base[res] * 0.35, m.base[res] * 3.2);
  }

  /** Spend cash to receive `amount` of `res`. */
  function buy(state, nation, res, amount) {
    if (!TRADED.length || BASE_PRICE[res] === undefined) return { ok: false, why: 'Not traded' };
    amount = Math.max(0, Math.round(amount));
    if (amount <= 0) return { ok: false, why: 'Nothing to buy' };
    var cost = quoteBuy(state, res, amount);
    if (nation.resources.cash < cost) return { ok: false, why: 'Not enough cash' };
    nation.resources.cash -= cost;
    nation.resources[res] += amount;
    impact(state, res, amount * 0.6);
    return { ok: true, cost: cost };
  }

  /** Sell `amount` of `res` for cash. */
  function sell(state, nation, res, amount) {
    if (BASE_PRICE[res] === undefined) return { ok: false, why: 'Not traded' };
    amount = Math.max(0, Math.round(amount));
    if (amount <= 0) return { ok: false, why: 'Nothing to sell' };
    if (nation.resources[res] < amount) return { ok: false, why: 'Not enough ' + res };
    var gain = quoteSell(state, res, amount);
    nation.resources[res] -= amount;
    nation.resources.cash += gain;
    impact(state, res, -amount * 0.6);
    return { ok: true, gain: gain };
  }

  SWW.market = {
    init: init, tick: tick, buy: buy, sell: sell,
    buyPrice: buyPrice, sellPrice: sellPrice,
    quoteBuy: quoteBuy, quoteSell: quoteSell,
    TRADED: TRADED, BASE_PRICE: BASE_PRICE, SPREAD: SPREAD
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
