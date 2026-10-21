type Clock = { now: () => number; sleep: (ms: number) => Promise<unknown> };
const realClock: Clock = { now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };

/** JSON-RPC calls in a request body: a batch counts one per item, as RPC providers bill it. */
function callsIn(body: unknown) {
  try { const parsed = JSON.parse(String(body)); return Array.isArray(parsed) ? Math.max(1, parsed.length) : 1; } catch { return 1; }
}

/**
 * Wraps `fetch` for the Solana RPC: keeps calls under `perSecond` (a token bucket shared by every caller, so
 * a claim scan, payments and the creator-fee check take turns), and waits out a 429 "too many requests"
 * reply, using its Retry-After when given, instead of failing. A 429 still standing after 4 retries is returned.
 */
export function pacedFetch(perSecond: number, base: typeof fetch = fetch, clock: Clock = realClock): typeof fetch {
  let tokens = perSecond, last = clock.now(), gate: Promise<unknown> = Promise.resolve();
  async function take(n: number) {
    for (;;) {
      const now = clock.now();
      tokens = Math.min(perSecond, tokens + (now - last) * perSecond / 1000); last = now;
      if (tokens >= n) { tokens -= n; return; }
      await clock.sleep(Math.ceil((n - tokens) * 1000 / perSecond));
    }
  }
  // One request takes its turn at a time, so a big batch can't be overtaken forever by small ones.
  const acquire = (n: number) => { const turn = gate.then(() => take(Math.min(n, perSecond))); gate = turn; return turn; };
  return async (url, init) => {
    const calls = callsIn(init?.body);
    for (let attempt = 0; ; attempt++) {
      await acquire(calls);
      const response = await base(url, init);
      if (response.status !== 429 || attempt >= 4) return response;
      const after = Number(response.headers.get('retry-after'));
      await clock.sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt);
    }
  };
}
