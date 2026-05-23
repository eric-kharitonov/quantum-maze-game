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
const stack = [];
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

function assignBellPairs() {
  // Walls touching the start cell (0,0) are ineligible for entanglement —
  // they're the only path out of (0,0), and Bell measurements collapsing both
  // to SOLID would orphan the start cell on turn 1.
  const startCellWalls = new Set([hwallId(0, 0), vwallId(0, 0)]);
  const eligible = Object.keys(walls).filter(id => {
    const w = walls[id];
    if (w.isBorder || w.isExit) return false;
    if (startCellWalls.has(id)) return false;
    return true;
  });
  shuffle(eligible);
  // Target ~20% of walls as entangled (i.e. ~10% of walls as pairs).
  const targetPairs = Math.floor(eligible.length * 0.10);
  const used = new Set();
  let made = 0;
  for (const w of eligible) {
    if (made >= targetPairs) break;
    if (used.has(w)) continue;
    let best = null, bestDist = -1;
    for (const cand of eligible) {
      if (cand === w || used.has(cand)) continue;
      const d = wallDist(w, cand);
      if (d > bestDist) { best = cand; bestDist = d; }
    }
    if (best && bestDist >= 5) {
      walls[w].state = 'ENTANGLED';
      walls[w].bellPartner = best;
      walls[best].state = 'ENTANGLED';
      walls[best].bellPartner = w;
      used.add(w); used.add(best);
      made++;
    }
  }
}

// ===== Algorithm =====

// A side `s` is a valid W-state candidate at `cell` iff its wall is SUPERPOSED
// and the neighbor on the other side is either unvisited or off-grid-and-exit.
function isValidCandidate(cell, side) {
  const id = cellWalls(cell.r, cell.c)[side];
  const w = walls[id];
  if (!w) return false;
  if (w.state !== 'SUPERPOSED') return false;
  // Exit candidate: right border at col 14
  if (w.isExit) return exitOpenedRow === null && cell.c === GRID - 1 && side === 'E';
  if (w.isBorder) return false;
  const t = sideToCoord(cell, side);
  if (t.r < 0 || t.r >= GRID || t.c < 0 || t.c >= GRID) return false;
  return !cells[t.r][t.c].visited;
}

function validCandidates(cell) {
  return SIDES.filter(s => isValidCandidate(cell, s));
}

async function processBell(cell) {
  for (const side of SIDES) {
    const id = cellWalls(cell.r, cell.c)[side];
    const w = walls[id];
    if (!w || w.state !== 'ENTANGLED') continue;
    w.pending = true;
    render();
    let result;
    try {
      const partnerCenter = wallCenter(w.bellPartner);
      result = await Quantum.bell(
        [cell.r, cell.c],
        [Math.floor(partnerCenter.r), Math.floor(partnerCenter.c)]
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
      flashes.push({ kind: 'bell', wallId: w.bellPartner, t: 0, lifetime: 1400 });
      stats.bellFlashes++;
    }
  }
}

async function processWState(cell) {
  const cands = validCandidates(cell);
  if (cands.length === 0) return null;

  const candIds = cands.map(s => cellWalls(cell.r, cell.c)[s]);
  const candCoords = cands.map(s => {
    const t = sideToCoord(cell, s);
    return [t.r, t.c];
  });
  for (const id of candIds) walls[id].pending = true;
  render();

  let chosen;
  try {
    chosen = await Quantum.wState([cell.r, cell.c], candCoords);
  } catch (e) {
    console.error('W-state call failed', e);
    for (const id of candIds) walls[id].pending = false;
    return null;
  }

  for (const id of candIds) walls[id].pending = false;
  const chosenSide = cands[chosen];
  const chosenId = cellWalls(cell.r, cell.c)[chosenSide];
  walls[chosenId].state = 'OPEN';
  stats.wallsCollapsed++;
  console.log(`[Q] cell (${cell.r},${cell.c}) k=${cands.length} → opened ${chosenSide} (${chosenId})`);
  if (walls[chosenId].isExit) onExitOpened(cell.r);
  return chosenSide;
}

async function enterCell(cell) {
  inputLocked = true;
  cells[cell.r][cell.c].visited = true;
  stack.push({ r: cell.r, c: cell.c });
  stats.steps++;

  // Walls between this cell and adjacent already-visited cells (other than the
  // entry wall, which is already OPEN) become SOLID — those connections would
  // form loops, so they're permanently closed.
  for (const side of SIDES) {
    const id = cellWalls(cell.r, cell.c)[side];
    if (!walls[id] || walls[id].state !== 'SUPERPOSED') continue;
    const t = sideToCoord(cell, side);
    if (t.r < 0 || t.r >= GRID || t.c < 0 || t.c >= GRID) continue;
    if (cells[t.r][t.c].visited) {
      walls[id].state = 'SOLID';
      stats.wallsCollapsed++;
    }
  }

  await processBell(cell);
  await processWState(cell);

  if (validCandidates(cell).length === 0 && !canMoveFromHere(cell)) {
    await tryBacktrack();
  }

  inputLocked = false;
}

// Can the player still progress to an unvisited cell directly from `cell`
// through any currently-OPEN wall? (Used to decide if we should auto-backtrack.)
function canMoveFromHere(cell) {
  for (const side of SIDES) {
    const id = cellWalls(cell.r, cell.c)[side];
    if (!walls[id] || walls[id].state !== 'OPEN') continue;
    if (walls[id].isExit && side === 'E' && cell.c === GRID - 1) return true;
    const t = sideToCoord(cell, side);
    if (t.r < 0 || t.r >= GRID || t.c < 0 || t.c >= GRID) continue;
    if (!cells[t.r][t.c].visited) return true;
  }
  return false;
}

// Is `cell` a useful place for the generation stack to re-enter? Either a
// fresh W-state can fire here, or a Bell-opened wall already leads somewhere new.
function canMakeProgressFrom(cell) {
  if (validCandidates(cell).length > 0) return true;
  return canMoveFromHere(cell);
}

async function tryBacktrack() {
  // Pop the current cell (it has no more progress to offer).
  const dead = stack.pop();
  if (dead) markCellDone(dead);

  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (canMakeProgressFrom(top)) {
      flashes.push({ kind: 'teleport', r: top.r, c: top.c, t: 0, lifetime: 700 });
      player.r = top.r;
      player.c = top.c;
      render();
      await sleep(450);
      // If a W-state can still fire here, run it; otherwise the player is
      // arriving at a Bell-opened wormhole and can just walk forward.
      if (validCandidates(top).length > 0) await processWState(top);
      if (!canMakeProgressFrom(top)) {
        const d2 = stack.pop();
        markCellDone(d2);
        continue;
      }
      return;
    }
    const d2 = stack.pop();
    markCellDone(d2);
  }
  await endGeneration();
}

function markCellDone(cell) {
  // A col-14 cell whose right-border wall is still superposed will never re-fire,
  // so that wall is now definitively SOLID. This drives the "exit forced" rule.
  if (cell.c === GRID - 1) {
    const id = vwallId(cell.r, GRID - 1);
    if (walls[id].state === 'SUPERPOSED') {
      walls[id].state = 'SOLID';
      stats.wallsCollapsed++;
      checkExitForced();
    }
  }
}

function checkExitForced() {
  if (exitOpenedRow !== null) return;
  const unresolved = [];
  for (let r = 0; r < GRID; r++) {
    const w = walls[vwallId(r, GRID - 1)];
    if (w.state === 'SUPERPOSED') unresolved.push(r);
  }
  if (unresolved.length === 1) {
    const r = unresolved[0];
    walls[vwallId(r, GRID - 1)].state = 'OPEN';
    stats.wallsCollapsed++;
    onExitOpened(r);
  }
}

function onExitOpened(r) {
  if (exitOpenedRow !== null) return;
  exitOpenedRow = r;
  setStatus(`★ Exit opened on row ${r}. Reach it and step right to escape.`);
}

async function endGeneration() {
  if (exitOpenedRow === null) {
    // Force any remaining right-border wall open as the exit.
    const candidates = [];
    for (let r = 0; r < GRID; r++) {
      const w = walls[vwallId(r, GRID - 1)];
      if (w.state === 'SUPERPOSED' || w.state === 'ENTANGLED') candidates.push(r);
    }
    if (candidates.length > 0) {
      const r = candidates[Math.floor(Math.random() * candidates.length)];
      walls[vwallId(r, GRID - 1)].state = 'OPEN';
      stats.wallsCollapsed++;
      onExitOpened(r);
    }
  }
  // Cascade-collapse any leftover superposed/entangled walls to solid.
  for (const id in walls) {
    if (walls[id].state === 'SUPERPOSED' || walls[id].state === 'ENTANGLED') {
      walls[id].state = 'SOLID';
      stats.wallsCollapsed++;
    }
  }
  // Post-collapse classical repair: if quantum measurements happened to leave
  // the exit cell disconnected from the start, force open the minimum set of
  // walls along the shortest geometric path. This is a classical step distinct
  // from the W-state and Bell measurements — those are never overridden.
  if (exitOpenedRow !== null) repairConnectivity({ r: 0, c: 0 }, { r: exitOpenedRow, c: GRID - 1 });
  setStatus(`Generation complete. ${exitOpenedRow !== null ? `Exit on row ${exitOpenedRow}.` : ''}`);
}

function repairConnectivity(from, to) {
  const reachable = new Set([`${from.r},${from.c}`]);
  const q = [from];
  while (q.length) {
    const cur = q.shift();
    for (const side of SIDES) {
      const id = cellWalls(cur.r, cur.c)[side];
      if (!walls[id] || walls[id].state !== 'OPEN') continue;
      const t = sideToCoord(cur, side);
      if (t.r < 0 || t.r >= GRID || t.c < 0 || t.c >= GRID) continue;
      const key = `${t.r},${t.c}`;
      if (reachable.has(key)) continue;
      reachable.add(key);
      q.push(t);
    }
  }
  if (reachable.has(`${to.r},${to.c}`)) return;

  // Disconnected. Dijkstra: OPEN walls cost 0, SOLID interior walls cost 1,
  // borders are impassable. Walk back from `to`, force-open each SOLID wall.
  const dist = new Map();
  const parent = new Map();
  const startKey = `${from.r},${from.c}`;
  dist.set(startKey, 0);
  const queue = [[0, from.r, from.c]];
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, r, c] = queue.shift();
    if (d !== dist.get(`${r},${c}`)) continue;
    if (r === to.r && c === to.c) break;
    for (const side of SIDES) {
      const id = cellWalls(r, c)[side];
      if (!walls[id] || walls[id].isBorder || walls[id].isExit) continue;
      const t = sideToCoord({ r, c }, side);
      if (t.r < 0 || t.r >= GRID || t.c < 0 || t.c >= GRID) continue;
      const cost = walls[id].state === 'OPEN' ? 0 : 1;
      const nd = d + cost;
      const key = `${t.r},${t.c}`;
      if (!dist.has(key) || dist.get(key) > nd) {
        dist.set(key, nd);
        parent.set(key, { from: { r, c }, wallId: id });
        queue.push([nd, t.r, t.c]);
      }
    }
  }
  let broke = 0;
  let cur = { r: to.r, c: to.c };
  while (parent.has(`${cur.r},${cur.c}`)) {
    const p = parent.get(`${cur.r},${cur.c}`);
    if (walls[p.wallId].state === 'SOLID') {
      walls[p.wallId].state = 'OPEN';
      flashes.push({ kind: 'repair', wallId: p.wallId, t: 0, lifetime: 1800 });
      broke++;
    }
    cur = p.from;
  }
  if (broke > 0) {
    console.log(`[Q] post-collapse repair: forced ${broke} wall(s) open to connect start to exit`);
    setStatus(`★ Quantum collapse left a disconnected maze — ${broke} wall(s) classically repaired.`);
  }
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
  for (const id in walls) drawWall(ctx, id, MINI, true);
  for (const f of flashes) if (f.kind === 'bell') drawFlash(ctx, f, MINI);
  drawPlayer(ctx, MINI);
}

function updateStats() {
  document.getElementById('s-steps').textContent = stats.steps;
  document.getElementById('s-walls').textContent = stats.wallsCollapsed;
  document.getElementById('s-bell').textContent = stats.bellFlashes;
}

function render() {
  drawMain();
  drawMini();
  updateStats();
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
  stack.length = 0;
  flashes.length = 0;
  player.r = 0;
  player.c = 0;
  player.facing = 'E';
  stats.steps = 0;
  stats.wallsCollapsed = 0;
  stats.bellFlashes = 0;
  inputLocked = false;
  gameOver = false;
  exitOpenedRow = null;
  setStatus('');
}

function start() {
  resetState();
  initWalls();
  assignBellPairs();
  enterCell({ r: 0, c: 0 });
}

document.addEventListener('keydown', handleKey);
document.getElementById('restart').addEventListener('click', () => {
  if (inputLocked) return;
  start();
});
requestAnimationFrame(t => { lastFrame = t; frame(t); });
start();
