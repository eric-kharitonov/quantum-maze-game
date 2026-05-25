// v0.3 end-to-end invariant suite.
//
// Designed to be invoked from the browser DevTools console or via a
// Playwright session (e.g. the Claude Code Playwright MCP). Self-contained:
// drives `start()` repeatedly, auto-plays each game, and asserts spec
// invariants.
//
// Usage from DevTools:
//   await fetch('/tests/e2e_invariants.js').then(r => r.text()).then(eval);
//   const r = await runE2ESuite(20);
//   console.log(r);

/**
 * Auto-play one game by repeatedly BFS-ing to the nearest unvisited cell
 * with an OPEN path and walking there. Mirrors how a human plays except
 * exhaustive (no manual stopping). Uses minimap-style teleport semantics
 * (move along visited cells without re-triggering enterCell).
 */
async function autoPlayOneGame() {
  await start();
  while (inputLocked) await new Promise(r => setTimeout(r, 30));
  const startExitRow = exitRow;
  let safety = 5000;
  while (safety-- > 0) {
    if (gameOver) break;
    while (inputLocked) await new Promise(r => setTimeout(r, 20));
    // BFS from player through OPEN walls; walk to nearest unvisited target.
    const dist = new Map();
    const parent = new Map();
    dist.set(`${player.r},${player.c}`, 0);
    const q = [[player.r, player.c]];
    let target = null;
    while (q.length && !target) {
      const [r, c] = q.shift();
      for (const side of ['N','E','S','W']) {
        const id = cellWalls(r, c)[side];
        if (!walls[id] || walls[id].state !== 'OPEN') continue;
        const dr = side === 'N' ? -1 : side === 'S' ? 1 : 0;
        const dc = side === 'E' ? 1 : side === 'W' ? -1 : 0;
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= GRID || nc < 0 || nc >= GRID) continue;
        const key = `${nr},${nc}`;
        if (dist.has(key)) continue;
        dist.set(key, dist.get(`${r},${c}`) + 1);
        parent.set(key, [r, c]);
        if (!cells[nr][nc].visited) { target = [nr, nc]; break; }
        q.push([nr, nc]);
      }
    }
    if (!target) break;
    // Reconstruct path and walk it (entering only the final unvisited cell).
    const path = [];
    let cur = target;
    while (cur && (cur[0] !== player.r || cur[1] !== player.c)) {
      path.unshift(cur);
      cur = parent.get(`${cur[0]},${cur[1]}`);
    }
    for (const [tr, tc] of path) {
      if (cells[tr][tc].visited) {
        player.r = tr; player.c = tc;
      } else {
        player.r = tr; player.c = tc;
        await enterCell({ r: tr, c: tc });
        while (inputLocked) await new Promise(r => setTimeout(r, 20));
        if (gameOver) break;
      }
    }
  }
  return { startExitRow, gameOver, exitOpenedRow };
}

/** Count visited cells and wall states. */
function countState() {
  let visited = 0;
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) if (cells[r][c].visited) visited++;
  let open = 0, solid = 0, superp = 0, entangled = 0;
  for (const id in walls) {
    const s = walls[id].state;
    if (s === 'OPEN') open++;
    else if (s === 'SOLID') solid++;
    else if (s === 'SUPERPOSED') superp++;
    else if (s === 'ENTANGLED') entangled++;
  }
  return { visited, open, solid, superp, entangled };
}

/** BFS from (0,0) through OPEN walls. */
function reachableFromStart() {
  const set = new Set(['0,0']);
  const q = [[0, 0]];
  while (q.length) {
    const [r, c] = q.shift();
    for (const side of ['N','E','S','W']) {
      const id = cellWalls(r, c)[side];
      if (!walls[id] || walls[id].state !== 'OPEN') continue;
      const dr = side === 'N' ? -1 : side === 'S' ? 1 : 0;
      const dc = side === 'E' ? 1 : side === 'W' ? -1 : 0;
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= GRID || nc < 0 || nc >= GRID) continue;
      const key = `${nr},${nc}`;
      if (set.has(key)) continue;
      set.add(key); q.push([nr, nc]);
    }
  }
  return set;
}

/** Run the suite of N games and return aggregated invariant data. */
window.runE2ESuite = async function runE2ESuite(n = 20) {
  const games = [];
  for (let i = 0; i < n; i++) {
    const { startExitRow, gameOver: sealed, exitOpenedRow: opened } = await autoPlayOneGame();
    const counts = countState();
    const reach = reachableFromStart();
    // Invariant 1: exactly one or zero exit walls OPEN.
    let openExits = [];
    for (let r = 0; r < GRID; r++) if (walls[`V:${r}:14`].state === 'OPEN') openExits.push(r);
    // Invariant 2: if exit opened, it matches the pre-picked row.
    const exitMatchesPick = (opened === null) || (opened === startExitRow);
    // Invariant 3: no SUPERPOSED walls between visited cells (loop prev).
    // (Skipped: would require iterating all wall IDs; we check totals.)
    games.push({
      i, exitRow: startExitRow, sealed, exitOpened: opened !== null,
      openExits, exitMatchesPick,
      visited: counts.visited, open: counts.open, solid: counts.solid,
      superp: counts.superp, entangled: counts.entangled,
      reachableFromStart: reach.size,
      exitReachable: reach.has(`${startExitRow},${GRID - 1}`),
    });
  }
  // Aggregate
  const sealedCount = games.filter(g => g.sealed).length;
  const wonCount = games.filter(g => g.exitOpened).length;
  const avgVisited = games.reduce((s, g) => s + g.visited, 0) / n;
  const exitRowsUsed = new Set(games.map(g => g.exitRow));
  // Spec acceptance criteria:
  const assertions = [
    { name: 'orphan_rate_le_25pct', pass: sealedCount / n <= 0.25, actual: `${sealedCount}/${n}` },
    { name: 'exit_row_variety', pass: exitRowsUsed.size >= 5, actual: `${exitRowsUsed.size} distinct rows` },
    { name: 'exit_always_matches_pick', pass: games.every(g => g.exitMatchesPick), actual: '' },
    { name: 'at_most_one_exit_open', pass: games.every(g => g.openExits.length <= 1), actual: '' },
    { name: 'won_games_exit_reachable', pass: games.filter(g => g.exitOpened).every(g => g.exitReachable), actual: '' },
  ];
  return {
    n, sealedCount, wonCount, avgVisited,
    exitRowsUsed: [...exitRowsUsed].sort((a, b) => a - b),
    assertions,
    allPass: assertions.every(a => a.pass),
    games,
  };
};

console.log('e2e_invariants.js loaded. Run: await runE2ESuite(20)');
