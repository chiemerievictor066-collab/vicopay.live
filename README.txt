Wallet PIN gate - only the files that changed. Copy each into your vicopay-website folder (same names/places), replacing the old one.

wallet.html                      the wallet page: locked screen + PIN first
vico-wallet.js                   wallet history and recharge now need the PIN + email-code proof
wallet-security.js               new "wallet" action (PIN, then always an email code, 10 minute unlock)
vico-pin.js                      PIN keypad shows "To open your VicoPay Wallet"
server.js                        ONE line changed: passes walletSecurity into vico-wallet (line with: vicoWallet = require("./vico-wallet")(...))
package.json                     test script now also runs the gate test
tests/vico-wallet-gate.test.js   new test (npm run test:wallet)

No database changes and no new settings. Restart the server after copying.
