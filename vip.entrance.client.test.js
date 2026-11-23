// Client check for vip-entrance.js with a tiny fake browser: order of videos, when the notice appears, how it moves.
const assert = require("assert"), fs = require("fs"), vm = require("vm");
const log = [];
function el(tag) {
  const e = { tag, children: [], style: {}, classList: { add() { }, remove() { } }, setAttribute() { }, parentNode: null, className: "", textContent: "",
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
    pause() { }, load() { }, removeAttribute() { }, play() { log.push("play " + this.src); const self = this; setTimeout(() => { self.onplaying && self.onplaying(); }, 5); setTimeout(() => { self.onended && self.onended(); }, 60); return Promise.resolve(); } };
  if (tag === "div") e.animate = (frames, opt) => { log.push("note " + frames[0].transform + " -> " + frames[1].transform + " hold -> " + frames[3].transform + " in " + opt.duration + "ms"); const a = {}; setTimeout(() => a.onfinish && a.onfinish(), 80); return a; };
  return e;
}
const body = el("body");
const ctx = { window: {}, document: { createElement: el, head: el("head"), body }, getComputedStyle: () => ({ position: "relative" }), setTimeout, clearTimeout, Promise };
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + "/../vip-entrance.js", "utf8"), ctx);
const host = el("div");
ctx.VicoEntrance.play({ type: "vip_join", videos: ["gift-vip-entrance-car.mp4", "gift-vip-entrance-crown.mp4", "../evil.mp4"], text: "Ada joined the exclusive room", name: "Ada" }, host);
setTimeout(() => {
  const plays = log.filter((l) => l.startsWith("play"));
  assert.deepStrictEqual(plays, ["play /gift-vip-entrance-car.mp4", "play /gift-vip-entrance-crown.mp4"]);   // car, then crown; unsafe name dropped
  const iNote = log.findIndex((l) => l.startsWith("note")), iCrown = log.findIndex((l) => l.includes("crown"));
  assert.ok(iNote > iCrown, "the notice must appear when the crown starts, not with the car");
  assert.ok(/translateX\(110%\) -> translateX\(0\).*translateX\(-110%\) in 3800ms/.test(log[iNote]), log[iNote]);  // enters from the right, leaves to the left
  assert.strictEqual(host.children.length, 0, "the overlay is removed afterwards");
  console.log(log.join("\n"));
  console.log("\nok  car first, crown second, notice right->left on the crown, overlay cleaned up");
  process.exit(0);
}, 4800);
