// ponytail: repro harness — forces a 10x round, cashes at ~2x, asserts the hero
// multiplier keeps climbing after cashout and shows the crash point at bust.
(async () => {
  const real = window.crashFromHash;
  window.crashFromHash = () => 10.0; // force a known-high crash point

  // wait for BET phase
  while (G.phase !== 'bet') await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 200));

  // place slot 0 bet
  const card0 = document.getElementById('bets').children[0];
  card0.querySelector('.betbtn').click();

  // wait for flight
  while (G.phase !== 'fly') await new Promise(r => setTimeout(r, 100));

  // wait for mult >= 2
  let w = 0;
  while (G.mult < 2 && w < 5000) { await new Promise(r => setTimeout(r, 80)); w += 80; }
  const cashMult = +G.mult.toFixed(2);
  doCashOut(G.bets[0]);
  const heroAtCash = document.getElementById('mult').textContent;

  // let it climb past the cash point
  await new Promise(r => setTimeout(r, 800));
  const heroAfter = document.getElementById('mult').textContent;
  const climbingAfterCash = parseFloat(heroAfter) > cashMult;

  // force crash
  G.mult = 10.0;
  if (G.phase === 'fly') doCrash();
  await new Promise(r => setTimeout(r, 50));
  const heroAtBust = document.getElementById('mult').textContent;
  const subAtBust = document.getElementById('multSub').textContent;

  window.crashFromHash = real;

  window.__testResult = {
    cashMult,
    heroAtCash,
    heroAfter_0_8s: heroAfter,
    climbingAfterCash,
    heroAtBust,
    subAtBust,
    bustShowsCrashPoint: heroAtBust.includes('10.00'),
    bustShowsCashValue: heroAtBust.includes(cashMult.toFixed(2)),
  };
  console.log('TEST RESULT', JSON.stringify(window.__testResult, null, 2));
})();
