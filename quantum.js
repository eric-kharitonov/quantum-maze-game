const SERVER = 'http://localhost:5000';

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

async function bell(cell, partner) {
  const data = await postCollapse({ cell, candidates: [], type: 'bell', partner });
  return { a: data.a, b: data.b };
}

// v0.3: non-zero superposition circuit. Returns a length-k array of
// 0/1 outcomes (one per candidate wall, in input order). Never all-zero.
async function nonzero(cell, candidates) {
  const data = await postCollapse({ cell, candidates, type: 'nonzero' });
  return data.outcomes;
}

window.Quantum = { wState, bell, nonzero };
