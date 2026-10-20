/** A holder tier. Balances are compared as a share of total supply, in parts per million. */
export type HolderTier = { id: string; name: string; minSupplyPpm: number; onsiteCoverageBps: number; offsiteCoverageBps: number };

export type Settings = {
  /** Stops new orders, claim payouts, burns and fee routing. In-flight orders still settle or refund. */
  paused: boolean;
  /** On-site protection fee on top of the pack price. 1000 = 10%. */
  feeBps: number;
  /** Fixed split of every on-site fee. The pool gets this share; the rest goes to buyback-and-burn. */
  poolShareBps: number;
  tiers: HolderTier[];
  /** Hard cap on any single rebate, on-site or off-site. */
  maxRebateUsd: number;
  /** Hours of continuous holding checked before a pull. 0 = balance at quote and at settlement only. */
  onsiteHoldHours: number;
  offsiteHoldHours: number;
  /** Hours after a wallet first connects before its off-site pulls are covered. 0 = covered right away. */
  offsiteActivationHours: number;
  offsite: {
    enabled: boolean;
    /** How far back a pull may be claimed, in hours. Packs opened on our site need no claim: they are paid automatically. */
    claimWindowHours: number;
    /** Claims a wallet may file per rolling 24h. 0 = no limit. */
    perWalletDailyClaims: number;
    /** USDC a wallet can be paid per rolling 24h; extra approved claims wait in the queue. 0 = no limit. */
    perWalletDailyUsd: number;
    perWalletWeeklyUsd: number;
    /** Share of the pool all off-site payouts together may use per 24h. 0 = no limit. */
    dailyPoolBps: number;
    targetReserveUsd: number;
  };
  /** Pauses a pack price when trailing rebates exceed this share of its pool fee income. */
  breaker: { lossRatioBps: number; minPacks: number; windowDays: number };
  /** Pack prices paused by an admin or by the loss-ratio breaker. */
  pausedPrices: number[];
  /** Daily creator-fee income the fee guardrail may count on (USD). */
  creatorFeeBudgetUsdPerDay: number;
  burnThresholdUsd: number;
  feeTransferThresholdUsd: number;
  gasReserveSol: number;
  /**
   * Keeps both wallets able to pay Solana network fees. When OPS drops below `opsMinSol`, POOL sends it
   * SOL up to `opsTargetSol`. When POOL itself drops below `poolMinSol`, it buys SOL with `buyUsd` of its
   * USDC, at most `maxUsdPerDay` a day (0 = never buy).
   */
  gas: { opsMinSol: number; opsTargetSol: number; poolMinSol: number; buyUsd: number; maxUsdPerDay: number };
  slippageBps: number;
};

export type Card = { mint: string; name: string; image: string | null; insuredValueUsd: number | null; rarity: string | null; transferSignature: string | null };

export type Quote = {
  priceMicros: number; feeMicros: number; totalMicros: number;
  coverageBps: number; maxRebateMicros: number; tier: HolderTier | null;
  protected: boolean; reason: string | null;
};

export type OrderStatus = 'awaiting_payment' | 'paying' | 'paid' | 'buying' | 'delivering' | 'settling' | 'refunding' | 'complete' | 'refunded' | 'expired' | 'review';

export type OrderView = {
  id: string; status: OrderStatus; wallet: string; priceUsd: number; feeUsd: number; totalUsd: number;
  coverageBps: number; maxRebateUsd: number; card: Card | null; valueUsd: number | null; rebateUsd: number | null;
  paymentSignature: string | null; rebateSignature: string | null; refundSignature: string | null; nftSignature: string | null;
  message: string | null; createdAt: number;
};

export type ClaimCandidate = {
  memo: string; signature: string; priceUsd: number; valueUsd: number | null; pulledAt: number;
  card: { mint: string; name: string | null; image: string | null } | null;
  eligible: boolean; reason: string | null; coverageBps: number; rebateUsd: number;
  claim: { status: string; rebateUsd: number; signature: string | null } | null;
};

export type PoolView = {
  live: boolean; poolAddress: string | null; opsAddress: string | null;
  balanceUsd: number; reservedUsd: number; freeUsd: number; queuedUsd: number; healthBps: number;
  pendingFeeTransferUsd: number; burnBucketUsd: number;
  totals: { creatorFeesUsd: number; feeShareUsd: number; onsiteRebatesUsd: number; offsiteRebatesUsd: number; networkFeesUsd: number; burnedUsd: number; packsOpened: number; claimsPaid: number };
  byPrice: { priceUsd: number; packs: number; feesToPoolUsd: number; rebatesUsd: number; lossRatioBps: number | null; paused: boolean }[];
  recentBurns: { id: string; usdcUsd: number; tokens: string; signature: string | null; createdAt: number }[];
};

export type HolderView = {
  configured: boolean; balance: string; supply: string; ppm: number; tier: HolderTier | null;
  activatedAt: number | null; offsiteCoverageFrom: number | null;
};
