// Works out WHICH coin package a Paystack payment was for.
//
// Your Paystack account is set so the CUSTOMER pays Paystack's fee. So for the ₦10,000 package the customer is
// really charged ₦10,000 + fee (e.g. ₦10,155), and Paystack reports that bigger total. The old code only accepted
// the exact package price, so every such payment was refused even though the customer had been charged.
//
// Rules (a customer can never get a package they did not pay for):
//   * the amount paid must be AT LEAST the package price; paying less never matches
//   * the extra must look like a Paystack fee (at most 4.5% + ₦200; real fees are about 1.5% to 4.1% + ₦100)
//   * if Paystack tells us the amount we originally asked for (requested_amount), that is used first
"use strict";

// The most extra money a normal Paystack fee could add on top of a package price.
const maxFeeFor = (price) => Math.ceil(price * 0.045) + 200;
const round2 = (n) => Math.round(n * 100) / 100;

function packageForPayment(coinPackages, payment) {
  const paid = Number(payment && payment.amount) / 100;                // Paystack sends kobo
  if (!(paid > 0)) return null;
  const prices = Object.keys(coinPackages).map(Number).sort((a, b) => a - b);
  const make = (price) => ({ price, coins: coinPackages[price], paid: round2(paid), fee: round2(paid - price) });

  // 1) Paystack remembers the amount we asked for when the payment was started: the most exact answer
  const asked = Number(payment.requested_amount) / 100;
  if (asked > 0 && coinPackages[asked] && paid >= asked && paid - asked <= maxFeeFor(asked)) return make(asked);

  // 2) paid exactly the price (fee not added, e.g. a small payment)
  if (coinPackages[paid]) return make(paid);

  // 3) the biggest package not above what was paid, if the extra is only a believable fee
  let best = null;
  for (const p of prices) if (p <= paid) best = p;
  if (best !== null && paid - best <= maxFeeFor(best)) return make(best);
  return null;
}

// ------------------------------------------------------------------------------------------------------------------
// DOLLAR (USD) payments.  A package is still identified by its naira price (the key of coinPackages, e.g. 10000), and
// its dollar price is that naira price divided by NGN_PER_USD, rounded to cents. Packages that would cost less than
// minUsd dollars are not offered in dollars. Returns { "10000": 6.67, ... }.
function usdPackages(coinPackages, ngnPerUsd, minUsd) {
  const out = {};
  const rate = Number(ngnPerUsd) > 0 ? Number(ngnPerUsd) : 1428.57;
  for (const key of Object.keys(coinPackages)) {
    const usd = round2(Number(key) / rate);
    if (usd >= (Number(minUsd) || 0)) out[key] = usd;
  }
  return out;
}

// The most extra money a normal Paystack fee could add on top of a dollar price (6% + $1 is generous).
const maxUsdFeeFor = (usd) => round2(usd * 0.06 + 1);

// Works out which package a USD payment was for. The package is the one OUR server put in the payment's metadata when
// it started the payment (a customer cannot change that), and the amount actually paid must be at least its dollar
// price and only a believable Paystack fee above it.
function packageForUsdPayment(coinPackages, usdTable, payment) {
  if (!payment || String(payment.currency || "").toUpperCase() !== "USD") return null;
  const paid = Number(payment.amount) / 100;
  if (!(paid > 0)) return null;
  const key = String(Number(payment.metadata && payment.metadata.packagePrice));
  if (!Object.prototype.hasOwnProperty.call(usdTable, key) || !coinPackages[key]) return null;
  const price = usdTable[key];
  if (paid < price - 0.005 || paid - price > maxUsdFeeFor(price)) return null;
  return { price: Number(key), coins: coinPackages[key], usd: price, paid: round2(paid), fee: round2(paid - price), currency: "USD" };
}

module.exports = { packageForPayment, maxFeeFor, usdPackages, packageForUsdPayment, maxUsdFeeFor };
