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

module.exports = { packageForPayment, maxFeeFor };
