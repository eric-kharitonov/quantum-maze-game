// ===== Constants =====
const GRID = 15;
const CELL = 32;
const MINI = 12;

const COLOR = {
  bg: '#07070d',
  floor: '#2a2a3a',
  unvisited: '#07070d',
  solid: '#0a0a0a',
  amber: '#ffb84d',
  purple: '#b366ff',
  cyan: '#4dffdd',
};

const SIDES = ['N', 'E', 'S', 'W'];
const DIRS = {
  ArrowUp:    { dr: -1, dc:  0, side: 'N' },
  ArrowDown:  { dr:  1, dc:  0, side: 'S' },
  ArrowLeft:  { dr:  0, dc: -1, side: 'W' },
  ArrowRight: { dr:  0, dc:  1, side: 'E' },
};

// ===== Wall ID helpers =====
// H:r:c  = horizontal wall between row r and r+1, column c
//          (r = -1 .. GRID-1; r=-1 is top border, r=GRID-1 is bottom border)
// V:r:c  = vertical wall between col c and c+1, row r
//          (c = -1 .. GRID-1; c=-1 is left border, c=GRID-1 is right border / exit)
const hwallId = (r, c) => `H:${r}:${c}`;
const vwallId = (r, c) => `V:${r}:${c}`;

function cellWalls(r, c) {
  return {
    N: hwallId(r - 1, c),
    S: hwallId(r, c),
    W: vwallId(r, c - 1),
    E: vwallId(r, c),
  };
}

function sideToCoord(cell, side) {
  if (side === 'N') return { r: cell.r - 1, c: cell.c };
  if (side === 'S') return { r: cell.r + 1, c: cell.c };
  if (side === 'W') return { r: cell.r, c: cell.c - 1 };
  if (side === 'E') return { r: cell.r, c: cell.c + 1 };
}

function wallBetween(r1, c1, r2, c2) {
  if (r1 === r2) return vwallId(r1, Math.min(c1, c2));
  if (c1 === c2) return hwallId(Math.min(r1, r2), c1);
  return null;
}

// Returns a (r, c) point in cell-coordinate space describing the wall's center.
function wallCenter(id) {
  const [type, rs, cs] = id.split(':');
  const r = +rs, c = +cs;
  if (type === 'H') return { r: r + 1, c: c + 0.5 };
  return { r: r + 0.5, c: c + 1 };
}

// ===== State =====
const cells = Array.from({ length: GRID }, () =>
  Array.from({ length: GRID }, () => ({ visited: false }))
);
const walls = {};
const flashes = [];           // { kind, wallId|null, r?, c?, t, lifetime }
const player = { r: 0, c: 0, facing: 'E' };
const stats = { steps: 0, wallsCollapsed: 0, bellFlashes: 0 };

const FWD = { N: [-1, 0], E: [0, 1], S: [1, 0], W: [0, -1] };
const LEFT_OF    = { N: 'W', E: 'N', S: 'E', W: 'S' };
const RIGHT_OF   = { N: 'E', E: 'S', S: 'W', W: 'N' };
const OPPOSITE   = { N: 'S', E: 'W', S: 'N', W: 'E' };
const TURN_LEFT  = LEFT_OF;
const TURN_RIGHT = RIGHT_OF;

let inputLocked = false;
let gameOver = false;
let pulsePhase = 0;
let exitOpenedRow = null;
let exitRow = null;  // 0.2: pre-determined at start() via uniform quantum pick

// v0.4: CHSH self-test state. Tallies per (x, y) input pair.
// v0.4.2: now also fed by the maze's own Bell observations (gameplayTrials).
const chshTally = {
  trials: 0,           // total trials (background + gameplay)
  gameplayTrials: 0,   // subset contributed by maze Bell observations
  gameplaySame: 0,     // gameplay-only agreements (unbiased by background loop)
  gameplayDiffs: 0,    // gameplay-only disagreements (unbiased by background loop)
  // counts[x][y] = { same: n, diff: n }
  counts: [[{same:0, diff:0}, {same:0, diff:0}], [{same:0, diff:0}, {same:0, diff:0}]],
};
let chshSessionId = 0;          // increment on each start() to cancel old loops
let chshRunning = false;
let amplitudeBars = [];          // { wallId, marginal, t, lifetime, collapsed }

// ===== Init =====
function initWalls() {
  // Horizontal walls
  for (let r = -1; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const isBorder = (r === -1 || r === GRID - 1);
      walls[hwallId(r, c)] = {
        state: isBorder ? 'SOLID' : 'SUPERPOSED',
        bellPartner: null,
        pending: false,
        isBorder,
        isExit: false,
      };
    }
  }
  // Vertical walls
  for (let r = 0; r < GRID; r++) {
    for (let c = -1; c < GRID; c++) {
      const isLeftBorder = (c === -1);
      const isExit = (c === GRID - 1);
      walls[vwallId(r, c)] = {
        state: isLeftBorder ? 'SOLID' : 'SUPERPOSED',
        bellPartner: null,
        pending: false,
        isBorder: isLeftBorder,
        isExit,
      };
    }
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function wallDist(a, b) {
  const ca = wallCenter(a), cb = wallCenter(b);
  return Math.abs(ca.r - cb.r) + Math.abs(ca.c - cb.c);
}

// Helper: return the two cell-keys "r,c" flanking a wall ID.
function wallFlankCells(id) {
  const [type, rs, cs] = id.split(':');
  const r = +rs, c = +cs;
  if (type === 'H') return [`${r},${c}`, `${r + 1},${c}`];
  return [`${r},${c}`, `${r},${c + 1}`];
}

function assignBellPairs() {
  // v0.3 Bell pair rules:
  //   R1: at most one Bell-paired wall per cell.
  //   R2: walls adjacent to (0,0) or the pre-picked exit cell are excluded
  //       (protects against direct local sealing of either endpoint).
  //   R3: Manhattan distance between paired walls >= 5.
  //   R4: only non-border, non-exit interior walls.
  //   R5: target ~10% pair density (i.e. ~20% of interior walls entangled).
  if (exitRow === null) {
    console.warn('assignBellPairs: exitRow not yet picked; skipping');
    return;
  }
  const protectedCells = new Set(['0,0', `${exitRow},${GRID - 1}`]);
  const cellHasBellWall = new Set();

  const eligible = Object.keys(walls).filter(id => {
    const w = walls[id];
    if (w.isBorder || w.isExit) return false;
    const [a, b] = wallFlankCells(id);
    if (protectedCells.has(a) || protectedCells.has(b)) return false;
    return true;
  });
  shuffle(eligible);

  const targetPairs = Math.floor(eligible.length * 0.10);
  const used = new Set();
  let made = 0;

  for (const w of eligible) {
    if (made >= targetPairs) break;
    if (used.has(w)) continue;
    const [wa, wb] = wallFlankCells(w);
    // R1: skip if either flanking cell already has a Bell wall.
    if (cellHasBellWall.has(wa) || cellHasBellWall.has(wb)) continue;

    let best = null, bestDist = -1;
    for (const cand of eligible) {
      if (cand === w || used.has(cand)) continue;
      const [ca, cb] = wallFlankCells(cand);
      if (cellHasBellWall.has(ca) || cellHasBellWall.has(cb)) continue;
      const d = wallDist(w, cand);
      if (d > bestDist) { best = cand; bestDist = d; }
    }
    if (best && bestDist >= 5) {
      walls[w].state = 'ENTANGLED';
      walls[w].bellPartner = best;
      walls[best].state = 'ENTANGLED';
      walls[best].bellPartner = w;
      used.add(w); used.add(best);
      cellHasBellWall.add(wa); cellHasBellWall.add(wb);
      const [ba, bb] = wallFlankCells(best);
      cellHasBellWall.add(ba); cellHasBellWall.add(bb);
      made++;
    }
  }
  console.log(`[Bell] assigned ${made} pair(s), ${cellHasBellWall.size} cells touched`);
}

// ===== Algorithm =====

async function processBell(cell) {
  for (const side of SIDES) {
    const id = cellWalls(cell.r, cell.c)[side];
    const w = walls[id];
    if (!w || w.state !== 'ENTANGLED') continue;
    w.pending = true;
    render();
    let result;
    // v0.4.2: pick CHSH angles uniformly per observation. The maze's Bell
    // pairs now measure at varied bases, so cross-basis correlations show up
    // in gameplay (and feed the CHSH tally).
    const x = Math.random() < 0.5 ? 0 : 1;
    const y = Math.random() < 0.5 ? 0 : 1;
    const aliceAngle = x === 0 ? 0.0 : 45.0;
    const bobAngle = y === 0 ? 22.5 : -22.5;
    try {
      const partnerCenter = wallCenter(w.bellPartner);
      result = await Quantum.bell(
        [cell.r, cell.c],
        [Math.floor(partnerCenter.r), Math.floor(partnerCenter.c)],
        aliceAngle,
        bobAngle
      );
    } catch (e) {
      console.error('Bell call failed', e);
      w.pending = false;
      w.state = 'SOLID';
      stats.wallsCollapsed++;
      continue;
    }
    w.pending = false;
    const local = result.a === 1 ? 'OPEN' : 'SOLID';
    const remote = result.b === 1 ? 'OPEN' : 'SOLID';
    w.state = local;
    stats.wallsCollapsed++;
    const partner = walls[w.bellPartner];
    if (partner) {
      partner.state = remote;
      partner.pending = false;
      stats.wallsCollapsed++;
      const mismatch = result.a !== result.b;
      flashes.push({
        kind: mismatch ? 'bellMismatch' : 'bell',
        wallId: w.bellPartner,
        localWallId: id,
        t: 0,
        lifetime: 1400,
      });
      stats.bellFlashes++;
    }
    // v0.4.2: contribute this Bell observation to the CHSH tally.
    const c = chshTally.counts[x][y];
    if (result.a === result.b) {
      c.same++;
      chshTally.gameplaySame++;
    } else {
      c.diff++;
      chshTally.gameplayDiffs++;
    }
    chshTally.trials++;
    chshTally.gameplayTrials++;
    // v0.3: no classical override. Orphans (if any) are detected in
    // enterCell via checkExitSealed and the game ends honestly.
  }
}

// v0.3: after every cell entry, verify the exit cell is still reachable
// from the player's current position via non-SOLID walls. Returns true if
// the maze has been sealed off and the player cannot reach the exit.
function checkExitSealed() {
  if (exitRow === null) return false;
  const target = `${exitRow},${GRID - 1}`;
  const reachable = new Set([`${player.r},${player.c}`]);
  const q = [{ r: player.r, c: player.c }];
  while (q.length) {
    const cur = q.shift();
    if (`${cur.r},${cur.c}` === target) return false;
    for (const side of SIDES) {
      const id = cellWalls(cur.r, cur.c)[side];
      if (!walls[id] || walls[id].state === 'SOLID') continue;
      const t = sideToCoord(cur, side);
      if (t.r < 0 || t.r >= GRID || t.c < 0 || t.c >= GRID) continue;
      const key = `${t.r},${t.c}`;
      if (reachable.has(key)) continue;
      reachable.add(key);
      q.push(t);
    }
  }
  return true;  // exit not in reachable set
}

// v0.3: fire one non-zero superposition circuit over `candidates` (an array
// of sides like ['N','E','S']). Mutates wall states accordingly:
//   - each bit_i = 1 -> wall_i -> OPEN
//   - each bit_i = 0 -> wall_i -> SOLID
// At least one is guaranteed OPEN (k=0 should never call this).
async function processNonzeroCircuit(cell, candidates) {
  if (candidates.length === 0) return [];

  const candIds = candidates.map(s => cellWalls(cell.r, cell.c)[s]);
  const candCoords = candidates.map(s => {
    const t = sideToCoord(cell, s);
    return [t.r, t.c];
  });
  for (const id of candIds) walls[id].pending = true;
  // v0.4: spawn amplitude bars for each candidate. Marginal P(open) for the
  // non-zero superposition state is 2^(k-1) / (2^k - 1).
  const k = candidates.length;
  const marginal = Math.pow(2, k - 1) / (Math.pow(2, k) - 1);
  const barLifetime = 1200; // ms; ample time to see them pre-collapse
  const bornAt = performance.now();
  for (const id of candIds) {
    amplitudeBars.push({ wallId: id, marginal, bornAt, lifetime: barLifetime, collapsedAt: null });
  }
  render();

  let outcomes;
  try {
    outcomes = await Quantum.nonzero([cell.r, cell.c], candCoords);
  } catch (e) {
    console.error('Non-zero circuit call failed', e);
    for (const id of candIds) walls[id].pending = false;
    // Cancel bars
    for (const bar of amplitudeBars) {
      if (candIds.includes(bar.wallId)) bar.collapsedAt = performance.now();
    }
    return [];
  }

  const opened = [];
  for (let i = 0; i < candIds.length; i++) {
    const id = candIds[i];
    walls[id].pending = false;
    walls[id].state = outcomes[i] === 1 ? 'OPEN' : 'SOLID';
    stats.wallsCollapsed++;
    if (outcomes[i] === 1) opened.push(candidates[i]);
  }
  // Stamp collapse time onto the bars; the frame loop will fade them out.
  const now = performance.now();
  for (const bar of amplitudeBars) {
    if (candIds.includes(bar.wallId) && bar.collapsedAt === null) {
      bar.collapsedAt = now;
    }
  }
  console.log(`[Q] cell (${cell.r},${cell.c}) k=${k} marginal=${(marginal*100).toFixed(0)}% -> outcomes [${outcomes.join(',')}], opened: ${opened.join(',') || '(none - bug)'}`);
  return opened;
}

// v0.3: classical pre-measurement filter. For each SUPERPOSED wall at `cell`:
//   - if neighbor is visited -> SOLID (loop prevention)
//   - if neighbor is unvisited but already reachable from {visited} via
//     OPEN walls -> SOLID (cycle prevention)
// Returns the array of remaining-SUPERPOSED candidate sides for the
// non-zero circuit to measure.
function applyLoopAndCyclePrevention(cell) {
  // Step 1: BFS from visited set through OPEN walls -> reachable set.
  const reachable = new Set();
  const seedQ = [];
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      if (cells[r][c].visited) {
        reachable.add(`${r},${c}`);
        seedQ.push({ r, c });
      }
    }
  }
  while (seedQ.length) {
    const cur = seedQ.shift();
    for (const side of SIDES) {
      const id = cellWalls(cur.r, cur.c)[side];
      if (!walls[id] || walls[id].state !== 'OPEN') continue;
      const t = sideToCoord(cur, side);
      if (t.r < 0 || t.r >= GRID || t.c < 0 || t.c >= GRID) continue;
      const key = `${t.r},${t.c}`;
      if (reachable.has(key)) continue;
      reachable.add(key);
      seedQ.push(t);
    }
  }

  // Step 2: for each side of `cell`, decide.
  const candidates = [];
  for (const side of SIDES) {
    const id = cellWalls(cell.r, cell.c)[side];
    const w = walls[id];
    if (!w) continue;
    if (w.state !== 'SUPERPOSED') continue;
    if (w.isExit) continue;     // exit wall never enters the circuit
    if (w.isBorder) continue;   // border walls aren't candidates
    const t = sideToCoord(cell, side);
    if (t.r < 0 || t.r >= GRID || t.c < 0 || t.c >= GRID) continue;
    if (cells[t.r][t.c].visited) {
      walls[id].state = 'SOLID';  // loop prevention
      stats.wallsCollapsed++;
      continue;
    }
    if (reachable.has(`${t.r},${t.c}`)) {
      walls[id].state = 'SOLID';  // cycle prevention
      stats.wallsCollapsed++;
      continue;
    }
    candidates.push(side);
  }
  return candidates;
}

async function enterCell(cell) {
  inputLocked = true;
  cells[cell.r][cell.c].visited = true;
  stats.steps++;

  // v0.3 pipeline:
  // 1. Bell measurements on any ENTANGLED walls adjacent to this cell.
  //    Bell can produce OPEN outcomes that bypass cycle prevention --
  //    these are "Bell wormholes," accepted per the spec.
  await processBell(cell);

  // 2. Loop prevention + cycle prevention. Returns the surviving SUPERPOSED
  //    candidate sides to feed into the non-zero circuit.
  const candidates = applyLoopAndCyclePrevention(cell);

  // 3. Single non-zero circuit over all candidates. Guarantees >=1 OPEN
  //    if k >= 1; if k = 0 this is a structural dead end and the player
  //    walks back through the entry wall manually.
  if (candidates.length > 0) {
    await processNonzeroCircuit(cell, candidates);
  }

  // 4. If this is the pre-picked exit cell, open the exit wall deterministically.
  if (cell.r === exitRow && cell.c === GRID - 1) {
    const id = vwallId(exitRow, GRID - 1);
    if (walls[id].state !== 'OPEN') {
      walls[id].state = 'OPEN';
      stats.wallsCollapsed++;
      onExitOpened(exitRow);
    }
  }

  // 5. Orphan check. If the exit is no longer reachable, end the game
  //    honestly -- no classical override.
  if (checkExitSealed()) {
    gameOver = true;
    setStatus('★ Quantum entanglement sealed this maze. Restart for a new measurement.');
  }

  inputLocked = false;
}

function onExitOpened(r) {
  if (exitOpenedRow !== null) return;
  exitOpenedRow = r;
  setStatus(`★ Exit opened on row ${r}. Reach it and step right to escape.`);
}

// ===== Input =====
// Dungeon-crawler controls relative to facing:
//   ↑ forward, ↓ backward, ← turn left, → turn right.
function handleKey(e) {
  if (gameOver || inputLocked) return;
  const key = e.key;
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return;
  e.preventDefault();

  if (key === 'ArrowLeft')  { player.facing = TURN_LEFT[player.facing];  return; }
  if (key === 'ArrowRight') { player.facing = TURN_RIGHT[player.facing]; return; }

  const moveDir = key === 'ArrowUp' ? player.facing : OPPOSITE[player.facing];

  // Step out through the exit if moving east from col 14 onto an open exit.
  if (moveDir === 'E' && player.c === GRID - 1) {
    const id = vwallId(player.r, GRID - 1);
    if (walls[id].state === 'OPEN') {
      gameOver = true;
      setStatus('★ ESCAPED — quantum maze cleared. Refresh to play again.');
    }
    return;
  }

  const [mdr, mdc] = FWD[moveDir];
  const target = { r: player.r + mdr, c: player.c + mdc };
  if (target.r < 0 || target.r >= GRID || target.c < 0 || target.c >= GRID) return;
  const id = wallBetween(player.r, player.c, target.r, target.c);
  if (!id || walls[id].state !== 'OPEN') return;

  player.r = target.r;
  player.c = target.c;
  if (!cells[target.r][target.c].visited) {
    enterCell({ r: target.r, c: target.c });
  }
}

// ===== Rendering =====
const mainCanvas = document.getElementById('main');
const mainCtx = mainCanvas.getContext('2d');
const miniCanvas = document.getElementById('mini');
const miniCtx = miniCanvas.getContext('2d');

function drawCells(ctx, size) {
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      ctx.fillStyle = cells[r][c].visited ? COLOR.floor : COLOR.unvisited;
      ctx.fillRect(c * size, r * size, size, size);
    }
  }
}

function drawWall(ctx, id, size, minimap) {
  const w = walls[id];
  if (!w) return;
  if (minimap) {
    // Minimap shows only collapsed walls (SOLID and OPEN). Superposed and
    // entangled walls are invisible on the minimap.
    if (w.state === 'SUPERPOSED' || w.state === 'ENTANGLED') return;
  }
  const [type, rs, cs] = id.split(':');
  const r = +rs, c = +cs;
  let x1, y1, x2, y2;
  if (type === 'H') {
    x1 = c * size;
    y1 = (r + 1) * size;
    x2 = x1 + size;
    y2 = y1;
  } else {
    x1 = (c + 1) * size;
    y1 = r * size;
    x2 = x1;
    y2 = y1 + size;
  }

  const thick = Math.max(2, Math.floor(size * 0.13));

  if (w.state === 'OPEN') {
    if (minimap) {
      // Draw a faint floor stripe so the minimap shows passages, not just walls.
      ctx.strokeStyle = '#3a3a55';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    return;
  }
  if (w.state === 'SOLID') {
    ctx.strokeStyle = minimap ? '#5a5a78' : '#7a7a9a';
    ctx.lineWidth = thick;
    ctx.lineCap = 'square';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    return;
  }
  if (w.state === 'SUPERPOSED') {
    const a = 0.45 + 0.3 * Math.sin(pulsePhase);
    ctx.strokeStyle = `rgba(255, 184, 77, ${a})`;
    ctx.shadowColor = COLOR.amber;
    ctx.shadowBlur = w.pending ? 14 : 6;
    ctx.lineWidth = thick;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.shadowBlur = 0;
    return;
  }
  if (w.state === 'ENTANGLED') {
    // Rendered identically to SUPERPOSED — the observer cannot distinguish
    // entanglement from plain superposition before measurement. Entanglement
    // is revealed only by correlated outcomes (the partner flash on collapse).
    const a = 0.45 + 0.3 * Math.sin(pulsePhase);
    ctx.strokeStyle = `rgba(255, 184, 77, ${a})`;
    ctx.shadowColor = COLOR.amber;
    ctx.shadowBlur = w.pending ? 14 : 6;
    ctx.lineWidth = thick;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.shadowBlur = 0;
    return;
  }
}

function drawFlash(ctx, f, size) {
  const p = f.t / f.lifetime;
  if (p >= 1) return;
  const alpha = 1 - p;
  if (f.kind === 'bell') {
    const wc = wallCenter(f.wallId);
    const x = wc.c * size;
    const y = wc.r * size;
    ctx.beginPath();
    ctx.arc(x, y, size * (0.5 + p * 1.3), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(179, 102, 255, ${alpha * 0.85})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, size * (0.2 + p * 0.5), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(179, 102, 255, ${alpha * 0.35})`;
    ctx.fill();
  }
  if (f.kind === 'bellMismatch') {
    // v0.4.2: partners disagreed (one OPEN, one SOLID). Draw a two-color split
    // pulse — cyan + amber halves — so the non-classical disagreement is
    // visible at a glance, distinct from the matched-pair purple pulse.
    const wc = wallCenter(f.wallId);
    const x = wc.c * size;
    const y = wc.r * size;
    const rOuter = size * (0.5 + p * 1.3);
    const rInner = size * (0.2 + p * 0.5);
    // Outer ring: stroked split semicircles.
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(77, 255, 221, ${alpha * 0.9})`;
    ctx.beginPath();
    ctx.arc(x, y, rOuter, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255, 184, 77, ${alpha * 0.9})`;
    ctx.beginPath();
    ctx.arc(x, y, rOuter, Math.PI / 2, 3 * Math.PI / 2);
    ctx.stroke();
    // Inner filled split disc.
    ctx.fillStyle = `rgba(77, 255, 221, ${alpha * 0.4})`;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, rInner, -Math.PI / 2, Math.PI / 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = `rgba(255, 184, 77, ${alpha * 0.4})`;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, rInner, Math.PI / 2, 3 * Math.PI / 2);
    ctx.closePath();
    ctx.fill();
  }
  if (f.kind === 'teleport') {
    const x = f.c * size + size / 2;
    const y = f.r * size + size / 2;
    ctx.beginPath();
    ctx.arc(x, y, size * (0.4 + p * 0.9), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(77, 255, 221, ${alpha})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (f.kind === 'repair') {
    // Classical-repair walls: brief white pulse along the now-open wall.
    const [type, rs, cs] = f.wallId.split(':');
    const r = +rs, c = +cs;
    let x1, y1, x2, y2;
    if (type === 'H') { x1 = c * size; y1 = (r + 1) * size; x2 = x1 + size; y2 = y1; }
    else { x1 = (c + 1) * size; y1 = r * size; x2 = x1; y2 = y1 + size; }
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.85})`;
    ctx.lineWidth = Math.max(3, size * 0.18);
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

function drawPlayer(ctx, size) {
  const x = player.c * size + size / 2;
  const y = player.r * size + size / 2;
  ctx.save();
  ctx.shadowColor = COLOR.cyan;
  ctx.shadowBlur = size * 0.55;
  ctx.fillStyle = COLOR.cyan;
  ctx.beginPath();
  ctx.arc(x, y, size * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  // Facing indicator: short line pointing in the heading direction.
  const [fdr, fdc] = FWD[player.facing];
  ctx.strokeStyle = COLOR.cyan;
  ctx.lineWidth = Math.max(1.5, size * 0.08);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + fdc * size * 0.55, y + fdr * size * 0.55);
  ctx.stroke();
  ctx.restore();
}

// ===== First-person 3D =====
const VIEW_DEPTH = 6;
const VIEW_SHRINK = 0.62;

function viewFrame(d) {
  const W = mainCanvas.width, H = mainCanvas.height;
  const cx = W / 2, cy = H / 2;
  const k = Math.pow(VIEW_SHRINK, d);
  return { l: cx - (W / 2) * k, r: cx + (W / 2) * k, t: cy - (H / 2) * k, b: cy + (H / 2) * k };
}

function drawSurface(ctx, pts, state, pending) {
  if (state === 'OPEN') return;
  let fill, stroke, glow = false;
  if (state === 'SOLID') {
    fill = '#1c1c28'; stroke = '#5a5a78';
  } else {
    // SUPERPOSED / ENTANGLED — both rendered as amber
    const a = 0.55 + 0.3 * Math.sin(pulsePhase);
    fill = 'rgba(120, 80, 30, 0.55)';
    stroke = `rgba(255, 184, 77, ${a})`;
    glow = true;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (glow || pending) {
    ctx.shadowColor = COLOR.amber;
    ctx.shadowBlur = pending ? 16 : 8;
  }
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawMain() {
  const ctx = mainCtx;
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, mainCanvas.width, mainCanvas.height);

  const [fdr, fdc] = FWD[player.facing];
  const stops = [];
  let blocker = null;
  for (let d = 0; d < VIEW_DEPTH; d++) {
    const r = player.r + fdr * d;
    const c = player.c + fdc * d;
    if (r < 0 || r >= GRID || c < 0 || c >= GRID) {
      blocker = { d: d - 1, state: 'SOLID', pending: false };
      break;
    }
    stops.push({ r, c, d });
    const fwId = cellWalls(r, c)[player.facing];
    const fw = walls[fwId];
    if (!fw) { blocker = { d, state: 'SOLID', pending: false }; break; }
    if (fw.isExit && fw.state === 'OPEN') {
      // Looking out the exit — show a void glow at the inner frame and stop.
      const f = viewFrame(d + 1);
      const grad = ctx.createRadialGradient((f.l + f.r) / 2, (f.t + f.b) / 2, 2, (f.l + f.r) / 2, (f.t + f.b) / 2, (f.r - f.l) / 2);
      grad.addColorStop(0, 'rgba(77, 255, 221, 0.9)');
      grad.addColorStop(1, 'rgba(77, 255, 221, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(f.l, f.t, f.r - f.l, f.b - f.t);
      blocker = null;
      break;
    }
    if (fw.state !== 'OPEN') { blocker = { d, state: fw.state, pending: fw.pending }; break; }
  }

  // Render back to front: deepest cells first, so near walls overlap.
  // Painters drawing order: floor + ceiling + side walls per depth (far→near),
  // then the final blocking front-wall at its inner frame.
  for (let i = stops.length - 1; i >= 0; i--) {
    const s = stops[i];
    const o = viewFrame(s.d);
    const inn = viewFrame(s.d + 1);

    // Floor
    ctx.fillStyle = '#0e0e18';
    ctx.beginPath();
    ctx.moveTo(o.l, o.b); ctx.lineTo(inn.l, inn.b);
    ctx.lineTo(inn.r, inn.b); ctx.lineTo(o.r, o.b);
    ctx.closePath(); ctx.fill();

    // Ceiling
    ctx.fillStyle = '#06060c';
    ctx.beginPath();
    ctx.moveTo(o.l, o.t); ctx.lineTo(inn.l, inn.t);
    ctx.lineTo(inn.r, inn.t); ctx.lineTo(o.r, o.t);
    ctx.closePath(); ctx.fill();

    // Perspective floor/ceiling lines
    ctx.strokeStyle = '#1a1a2e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(o.l, o.b); ctx.lineTo(inn.l, inn.b);
    ctx.moveTo(o.r, o.b); ctx.lineTo(inn.r, inn.b);
    ctx.moveTo(o.l, o.t); ctx.lineTo(inn.l, inn.t);
    ctx.moveTo(o.r, o.t); ctx.lineTo(inn.r, inn.t);
    ctx.stroke();

    const lw = walls[cellWalls(s.r, s.c)[LEFT_OF[player.facing]]];
    if (lw) drawSurface(ctx, [[o.l, o.t], [inn.l, inn.t], [inn.l, inn.b], [o.l, o.b]], lw.state, lw.pending);
    const rw = walls[cellWalls(s.r, s.c)[RIGHT_OF[player.facing]]];
    if (rw) drawSurface(ctx, [[o.r, o.t], [inn.r, inn.t], [inn.r, inn.b], [o.r, o.b]], rw.state, rw.pending);
  }

  if (blocker) {
    const f = viewFrame(blocker.d + 1);
    drawSurface(ctx, [[f.l, f.t], [f.r, f.t], [f.r, f.b], [f.l, f.b]], blocker.state, blocker.pending);
  }

  // v0.4: amplitude-bar overlay panel. Shows P(open) for each candidate wall
  // currently in the non-zero superposition, with a labeled bar per direction.
  // Renders only while at least one bar is alive; fades out after collapse.
  drawAmplitudeOverlay(ctx);

  // Compass overlay: facing letter top-center, position bottom-left.
  ctx.save();
  ctx.font = 'bold 14px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(77, 255, 221, 0.85)';
  ctx.shadowColor = COLOR.cyan;
  ctx.shadowBlur = 6;
  ctx.fillText(`facing ${player.facing}`, mainCanvas.width / 2, 10);
  ctx.shadowBlur = 0;
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(170, 170, 200, 0.7)';
  ctx.fillText(`(${player.r},${player.c})`, 10, mainCanvas.height - 22);
  ctx.restore();
}

// v0.4: draw an amplitude-bar overlay near the top of the main view while
// at least one wall is being measured by the non-zero circuit. Each bar
// shows P(open) for one candidate wall, labeled by side (N/E/S/W). After
// collapse, each bar shrinks/jumps to its outcome (100% if OPEN, 0% if
// SOLID) and fades out.
function drawAmplitudeOverlay(ctx) {
  if (amplitudeBars.length === 0) return;
  const now = performance.now();
  // Group bars by (cell, wallId). We only show bars whose wall is adjacent
  // to the player's current cell (i.e. the cell we just entered).
  const visible = amplitudeBars.filter(bar => {
    const sides = cellWalls(player.r, player.c);
    for (const side of ['N','E','S','W']) {
      if (sides[side] === bar.wallId) return true;
    }
    return false;
  });
  if (visible.length === 0) return;

  // Card layout: top center, semi-transparent dark background.
  const padX = 10, padY = 6;
  const lineH = 14;
  const cardW = 200;
  const cardH = padY * 2 + 16 + visible.length * lineH;
  const cx = (mainCanvas.width - cardW) / 2;
  const cy = 36;

  // Overall opacity: 1 while not all bars have collapsed, fading after.
  let overlayAlpha = 1;
  if (visible.every(b => b.collapsedAt !== null)) {
    const collapsedAge = now - Math.min(...visible.map(b => b.collapsedAt));
    overlayAlpha = Math.max(0, 1 - collapsedAge / 400);
    if (overlayAlpha <= 0) {
      // Prune fully-faded bars.
      for (let i = amplitudeBars.length - 1; i >= 0; i--) {
        if (visible.includes(amplitudeBars[i])) amplitudeBars.splice(i, 1);
      }
      return;
    }
  }

  ctx.save();
  ctx.globalAlpha = overlayAlpha;
  // Background
  ctx.fillStyle = 'rgba(10, 10, 20, 0.85)';
  ctx.fillRect(cx, cy, cardW, cardH);
  ctx.strokeStyle = 'rgba(77, 255, 221, 0.4)';
  ctx.lineWidth = 1;
  ctx.strokeRect(cx, cy, cardW, cardH);

  // Title
  ctx.fillStyle = '#4dffdd';
  ctx.font = 'bold 11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const k = visible.length;
  ctx.fillText(`MEASURING k=${k}  P(open) = ${(visible[0].marginal * 100).toFixed(0)}%`, cx + cardW / 2, cy + padY);

  // Per-wall bars
  const sides = cellWalls(player.r, player.c);
  ctx.textAlign = 'left';
  ctx.font = '10px ui-monospace, monospace';
  let row = 0;
  for (const side of ['N','E','S','W']) {
    const wallId = sides[side];
    const bar = visible.find(b => b.wallId === wallId);
    if (!bar) continue;
    const y = cy + padY + 18 + row * lineH;
    const labelX = cx + padX;
    const barX = cx + padX + 28;
    const barW = cardW - padX * 2 - 28 - 32;
    // Label
    ctx.fillStyle = '#aaa';
    ctx.fillText(side, labelX, y + 2);
    // Bar background
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(barX, y, barW, 8);
    // Fill: marginal pre-collapse; outcome post-collapse.
    let fill = bar.marginal;
    let color = '#ffb84d';
    if (bar.collapsedAt !== null) {
      const w = walls[bar.wallId];
      fill = w.state === 'OPEN' ? 1 : 0;
      color = w.state === 'OPEN' ? '#4dffdd' : '#5a5a78';
    }
    ctx.fillStyle = color;
    ctx.fillRect(barX, y, barW * fill, 8);
    // Percentage text
    ctx.fillStyle = '#888';
    ctx.textAlign = 'right';
    ctx.fillText(`${(fill * 100).toFixed(0)}%`, cx + cardW - padX, y + 2);
    ctx.textAlign = 'left';
    row++;
  }
  ctx.restore();
}

// v0.4: draw a dashed thread between each currently-ENTANGLED Bell pair on
// the minimap. Makes the non-local connection visible BEFORE it fires --
// when one wall is later measured, its partner collapses simultaneously
// (the existing purple pulse), and at that moment both walls leave the
// ENTANGLED state so the thread disappears.
function drawBellThreads(ctx, size) {
  const drawn = new Set();
  ctx.save();
  ctx.strokeStyle = 'rgba(179, 102, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  for (const id in walls) {
    const w = walls[id];
    if (w.state !== 'ENTANGLED') continue;
    if (drawn.has(id)) continue;
    if (!w.bellPartner) continue;
    const a = wallCenter(id);
    const b = wallCenter(w.bellPartner);
    ctx.beginPath();
    ctx.moveTo(a.c * size, a.r * size);
    ctx.lineTo(b.c * size, b.r * size);
    ctx.stroke();
    drawn.add(id);
    drawn.add(w.bellPartner);
  }
  ctx.restore();
}

function drawMini() {
  const ctx = miniCtx;
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, miniCanvas.width, miniCanvas.height);
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      if (cells[r][c].visited) {
        ctx.fillStyle = COLOR.floor;
        ctx.fillRect(c * MINI, r * MINI, MINI, MINI);
      }
    }
  }
  // v0.4: draw Bell threads beneath everything else (so collapsed walls,
  // flashes, and the player dot sit on top).
  drawBellThreads(ctx, MINI);
  for (const id in walls) drawWall(ctx, id, MINI, true);
  for (const f of flashes) if (f.kind === 'bell' || f.kind === 'bellMismatch') drawFlash(ctx, f, MINI);
  drawPlayer(ctx, MINI);
}

function updateStats() {
  document.getElementById('s-steps').textContent = stats.steps;
  document.getElementById('s-walls').textContent = stats.wallsCollapsed;
  document.getElementById('s-bell').textContent = stats.bellFlashes;
}

// v0.4: render the CHSH self-test panel based on chshTally.
const CHSH_TSIRELSON = 2 * Math.sqrt(2);  // ~ 2.828
const chshCanvas = document.getElementById('chsh-bar');
const chshCtx = chshCanvas ? chshCanvas.getContext('2d') : null;
const chshPanel = document.getElementById('chsh-panel');

function drawChshPanel() {
  if (!chshCtx || !chshPanel) return;
  const trialsEl = document.getElementById('chsh-trials');
  const sEl = document.getElementById('chsh-s');
  const statusEl = document.getElementById('chsh-status');
  trialsEl.textContent = chshTally.trials;
  const gameplayEl = document.getElementById('chsh-gameplay');
  if (gameplayEl) gameplayEl.textContent = chshTally.gameplayTrials;
  const S = computeChshS();
  const showS = (S !== null && chshTally.trials >= 30);
  sEl.textContent = showS ? S.toFixed(3) : '—';
  // Bar
  const w = chshCanvas.width, h = chshCanvas.height;
  chshCtx.clearRect(0, 0, w, h);
  // background track
  chshCtx.fillStyle = '#1a1a2e';
  chshCtx.fillRect(0, 0, w, h);
  // classical-max tick line
  const tickX = (2.0 / CHSH_TSIRELSON) * w;
  chshCtx.strokeStyle = '#555';
  chshCtx.lineWidth = 1;
  chshCtx.setLineDash([2, 2]);
  chshCtx.beginPath();
  chshCtx.moveTo(tickX, 0);
  chshCtx.lineTo(tickX, h);
  chshCtx.stroke();
  chshCtx.setLineDash([]);
  // current S bar
  if (S !== null) {
    const sClamp = Math.max(0, Math.min(S, CHSH_TSIRELSON));
    const fillW = (sClamp / CHSH_TSIRELSON) * w;
    chshCtx.fillStyle = S >= 2.0 ? '#4dffdd' : '#ffb84d';
    chshCtx.fillRect(0, 0, fillW, h);
  }
  // Status text + class
  if (!showS) {
    statusEl.textContent = 'Accumulating measurements…';
    chshPanel.classList.remove('confirmed');
  } else if (S >= 2.0) {
    statusEl.textContent = '★ Non-locality confirmed (S > 2)';
    chshPanel.classList.add('confirmed');
  } else {
    statusEl.textContent = 'Below classical bound — keep playing';
    chshPanel.classList.remove('confirmed');
  }
}

function render() {
  drawMain();
  drawMini();
  updateStats();
  drawChshPanel();
}

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

let lastFrame = performance.now();
function frame(now) {
  const dt = now - lastFrame;
  lastFrame = now;
  pulsePhase += dt * 0.003;
  for (let i = flashes.length - 1; i >= 0; i--) {
    flashes[i].t += dt;
    if (flashes[i].t >= flashes[i].lifetime) flashes.splice(i, 1);
  }
  render();
  requestAnimationFrame(frame);
}

// ===== Boot / restart =====
function resetState() {
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      cells[r][c].visited = false;
    }
  }
  for (const id in walls) delete walls[id];
  flashes.length = 0;
  amplitudeBars.length = 0;
  player.r = 0;
  player.c = 0;
  player.facing = 'E';
  stats.steps = 0;
  stats.wallsCollapsed = 0;
  stats.bellFlashes = 0;
  inputLocked = false;
  gameOver = false;
  exitOpenedRow = null;
  exitRow = null;
  // Reset CHSH tally for the new game.
  chshTally.trials = 0;
  chshTally.gameplayTrials = 0;
  chshTally.gameplaySame = 0;
  chshTally.gameplayDiffs = 0;
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) {
    chshTally.counts[x][y].same = 0;
    chshTally.counts[x][y].diff = 0;
  }
  setStatus('');
}

// v0.4: CHSH self-test loop. Runs in the background while the player plays,
// firing one Bell-pair trial every ~2 seconds with random (x, y) inputs and
// the canonical CHSH angles. Tallies wins/losses into chshTally; the panel
// renders this on every frame. Self-cancels when chshSessionId changes
// (i.e. when the game restarts).
async function chshLoop(mySession) {
  chshRunning = true;
  // Brief delay before first trial so the start-time exitRow pick goes first.
  await sleep(1500);
  while (mySession === chshSessionId) {
    if (gameOver) { chshRunning = false; return; }
    const x = Math.random() < 0.5 ? 0 : 1;
    const y = Math.random() < 0.5 ? 0 : 1;
    const aliceAngle = x === 0 ? 0.0 : 45.0;
    const bobAngle = y === 0 ? 22.5 : -22.5;
    try {
      const { a, b } = await Quantum.chsh(aliceAngle, bobAngle);
      if (mySession !== chshSessionId) return;
      const c = chshTally.counts[x][y];
      if (a === b) c.same++;
      else c.diff++;
      chshTally.trials++;
    } catch (e) {
      console.warn('CHSH trial failed; retrying in 10s', e);
      await sleep(10000);
      continue;
    }
    await sleep(2000);
  }
  chshRunning = false;
}

// Compute the running CHSH S = E(0,0) + E(0,1) + E(1,0) - E(1,1).
// E(x,y) = (same - diff) / (same + diff). Returns null if not enough data.
function computeChshS() {
  if (chshTally.trials < 4) return null;
  const e = (x, y) => {
    const c = chshTally.counts[x][y];
    const total = c.same + c.diff;
    if (total === 0) return 0;
    return (c.same - c.diff) / total;
  };
  return e(0, 0) + e(0, 1) + e(1, 0) - e(1, 1);
}

async function start() {
  resetState();
  initWalls();
  // v0.3: pre-pick the exit row via a uniform quantum measurement over rows
  // 0..GRID-1. We reuse the W-state circuit with GRID dummy candidates --
  // the W-state collapses to exactly one |1> position with uniform
  // probability, giving us a genuinely quantum row choice. Exit row must
  // be picked BEFORE assignBellPairs so the Bell rules can exclude walls
  // adjacent to the exit cell.
  inputLocked = true;
  setStatus('Picking exit row…');
  try {
    const dummy = Array(GRID).fill([0, 0]);
    exitRow = await Quantum.wState([0, 0], dummy);
  } catch (e) {
    console.error('Exit-row pick failed, falling back to Math.random()', e);
    exitRow = Math.floor(Math.random() * GRID);
  }
  console.log(`[Q] exit pre-determined: row ${exitRow}`);
  assignBellPairs();
  setStatus('');
  // v0.4: kick off the CHSH self-test loop for this game session.
  chshSessionId++;
  chshLoop(chshSessionId);
  enterCell({ r: 0, c: 0 });
}

// v0.3: minimap click-to-teleport. Clicking a visited cell jumps the player
// there. Pure UX -- no measurements fire. Replaces the auto-backtrack
// teleport that was removed when the DFS stack went away.
miniCanvas.addEventListener('click', (e) => {
  if (inputLocked || gameOver) return;
  const rect = miniCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const c = Math.floor(x / MINI);
  const r = Math.floor(y / MINI);
  if (r < 0 || r >= GRID || c < 0 || c >= GRID) return;
  if (!cells[r][c].visited) return;
  player.r = r;
  player.c = c;
  render();
});

document.addEventListener('keydown', handleKey);
document.getElementById('restart').addEventListener('click', () => {
  if (inputLocked) return;
  start();
});
requestAnimationFrame(t => { lastFrame = t; frame(t); });
start();
