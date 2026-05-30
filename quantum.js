// Empty SERVER => relative URL, served from the same origin as the page.
// Local dev works when you serve index.html from server.py (visit
// http://localhost:5000) instead of via `python -m http.server`.
const SERVER = '';

async function postCollapse(body) {
  const res = await fetch(`${SERVER}/collapse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Server ${res.status}`);
  return res.json();
}

async function wState(cell, candidates) {
  const data = await postCollapse({ cell, candidates, type: 'w_state' });
  return data.chosen;
}

async function bell(cell, partner, aliceAngleDeg = 0, bobAngleDeg = 0) {
  const data = await postCollapse({
    cell,
    candidates: [],
    type: 'bell',
    partner,
    alice_angle_deg: aliceAngleDeg,
    bob_angle_deg: bobAngleDeg,
  });
  return { a: data.a, b: data.b };
}

// v0.3: non-zero superposition circuit. Returns a length-k array of
// 0/1 outcomes (one per candidate wall, in input order). Never all-zero.
async function nonzero(cell, candidates) {
  const data = await postCollapse({ cell, candidates, type: 'nonzero' });
  return data.outcomes;
}

// v0.4: CHSH measurement. Prepares a Bell pair, rotates Alice's and Bob's
// qubits to the specified measurement axes (in degrees), measures both,
// returns {a, b}.
async function chsh(aliceAngleDeg, bobAngleDeg) {
  const data = await postCollapse({
    type: 'chsh',
    alice_angle_deg: aliceAngleDeg,
    bob_angle_deg: bobAngleDeg,
  });
  return { a: data.a, b: data.b };
}

window.Quantum = { wState, bell, nonzero, chsh };
