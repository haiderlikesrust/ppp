/** A holder tier. Balances are compared as a share of total supply, in parts per million. */
export type HolderTier = { id: string; name: string; minSupplyPpm: number; onsiteCoverageBps: number; offsiteCoverageBps: number };

export type Settings = {
  /** Stops new orders, claim payouts, burns and fee routing. In-flight orders still settle or refund. */
  paused: boolean;
  /** Flat on-site fee on top of the pack price, used until a pack has enough pull data to be priced. 1000 = 10%. */
  feeBps: number;
  /**
   * Prices each pack from its real pulls: the fee pays the pool the expected rebate at that coverage, plus `marginBps`.
   * Fees stay between `minFeeBps` and `maxFeeBps`; when the top fee can't pay for a tier's coverage, coverage on that
   * pack comes down to what it can pay for. A pack with fewer than `minSamples` pulls keeps the flat fee.
   */
  pricing: { enabled: boolean; marginBps: number; minFeeBps: number; maxFeeBps: number; minSamples: number };
  /** Fixed split of every on-site fee. The pool gets this share; the rest goes to buyback-and-burn. */
  poolShareBps: number;
  tiers: HolderTier[];
  /**
   * Wallets the owner guarantees a tier on packs opened here, whatever they hold. A wallet that holds
   * enough for a better tier gets that one. Off-site claims still go by holdings.
   */
  walletTiers: { wallet: string; tierId: string }[];
  /**
   * Minutes a wallet waits after opening a pack before it can open the next. `minutes` applies to every
   * wallet except those with a tier exception; a wallet listed in `wallets` always uses its own time. 0 = no wait.
   */
  cooldown: { minutes: number; wallets: { wallet: string; minutes: number }[] };
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
  /** Pack machine codes paused by an admin or by the loss-ratio breaker. */
  pausedPacks: string[];
  /** Daily creator-fee income the fee guardrail may count on (USD). */
  creatorFeeBudgetUsdPerDay: number;
  /** Creator fees are checked every 10 seconds and claimed once at least this much (USD) has built up. 0 = any amount. */
  creatorFeeMinUsd: number;
  /** Largest price impact a creator-fee sale may have; bigger claims are sold in parts. 300 = 3%. */
  maxPriceImpactBps: number;
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
  /** The fee as a share of the pack price. */
  feeBps: number;
  /** True when this pack's fee and coverage were set from its pull data, not the flat fee. */
  riskPriced: boolean;
};

/** What a pack's pull history says it costs to protect. `expectedLossRatio` = E[max(0, price - value)] / price. */
export type PackRisk = { n: number; expectedLossRatio: number };

export type OrderStatus = 'awaiting_payment' | 'paying' | 'paid' | 'buying' | 'delivering' | 'settling' | 'refunding' | 'complete' | 'refunded' | 'expired' | 'review';

export type OrderView = {
  id: string; status: OrderStatus; wallet: string; packCode: string; priceUsd: number; feeUsd: number; totalUsd: number;
  coverageBps: number; maxRebateUsd: number; card: Card | null; valueUsd: number | null; rebateUsd: number | null;
  paymentSignature: string | null; rebateSignature: string | null; refundSignature: string | null; nftSignature: string | null;
  message: string | null; createdAt: number;
  /** Set once the card was quick-sold back to Collector Crypt. */
  sale: { amountUsd: number; signature: string } | null;
};

export type ClaimCandidate = {
  memo: string; signature: string; packCode: string; priceUsd: number; valueUsd: number | null; pulledAt: number;
  card: { mint: string; name: string | null; image: string | null } | null;
  eligible: boolean; reason: string | null; coverageBps: number; rebateUsd: number;
  claim: { status: string; rebateUsd: number; signature: string | null } | null;
};

export type PoolView = {
  live: boolean; poolAddress: string | null; opsAddress: string | null;
  balanceUsd: number; reservedUsd: number; freeUsd: number; queuedUsd: number; healthBps: number;
  pendingFeeTransferUsd: number; burnBucketUsd: number;
  totals: { creatorFeesUsd: number; feeShareUsd: number; onsiteRebatesUsd: number; offsiteRebatesUsd: number; networkFeesUsd: number; burnedUsd: number; packsOpened: number; claimsPaid: number };
  byPack: { code: string; priceUsd: number; packs: number; feesToPoolUsd: number; rebatesUsd: number; lossRatioBps: number | null; paused: boolean }[];
  recentBurns: { id: string; usdcUsd: number; tokens: string; signature: string | null; createdAt: number }[];
};

export type HolderView = {
  /** `tier` is for packs opened here and counts tier exceptions; `heldTier` is from holdings alone, as off-site claims are judged. */
  configured: boolean; balance: string; supply: string; ppm: number; tier: HolderTier | null; heldTier: HolderTier | null;
  activatedAt: number | null; offsiteCoverageFrom: number | null;
};

/** A pull from Collector Crypt's public feed. `mint` is the card's NFT, so anyone can look it up on-chain. */
export type FeedPull = { id: string; mint: string; code: string; priceUsd: number; valueUsd: number; at: number; card: { name: string; image: string } | null; onSite: boolean };
/**
 * A pack opened on Regrade: the card that came out, the rebate actually sent back, and the transactions
 * behind it (the buyer's payment, our purchase on Collector Crypt, the card sent to the buyer, the rebate,
 * and a quick sale if there was one). The wallet is shortened.
 */
export type SitePull = {
  id: string; code: string; priceUsd: number; valueUsd: number; rebateUsd: number; at: number; wallet: string; mint: string | null;
  card: { name: string; image: string | null } | null; soldUsd: number | null;
  txs: { payment: string | null; pack: string | null; card: string | null; rebate: string | null; sale: string | null };
};

/** What a pack's recent pulls were worth, over its latest `n` pulls on Collector Crypt. */
export type PackStats = {
  code: string; priceUsd: number; n: number; since: number | null;
  medianUsd: number; meanUsd: number; p10Usd: number; p90Usd: number;
  /** Share of pulls worth at least the pack price. */
  hitRate: number;
  /** Share of the pack price the average pull falls short by. What the pack costs to protect at 100% coverage. */
  expectedLossRatio: number;
  /** What each tier pays and gets on this pack today, by tier id. */
  terms: Record<string, { feeBps: number; coverageBps: number; riskPriced: boolean }>;
  /** Average rebate per pack opened on Regrade, by tier id, at today's fee and coverage. */
  avgRebateUsd: Record<string, number>;
  /** Best pull of the last 7 days, if one beat 2× the pack price. */
  best: FeedPull | null;
};
export type StatsView = { packs: PackStats[]; updatedAt: number | null };

/** One finished pull in a wallet's portfolio: a pack opened here, or an off-site pack paid through a claim. */
export type PortfolioItem = {
  id: string; source: 'onsite' | 'offsite'; code: string; priceUsd: number; feeUsd: number; valueUsd: number; rebateUsd: number; soldUsd: number | null;
  /** Sale or held value, plus the rebate, minus what the pull cost. */
  netUsd: number; at: number; card: { name: string; image: string | null; mint: string | null } | null;
};
/** Everything a wallet pulled, and how it came out overall. Cards not sold count at their insured value. */
export type Portfolio = {
  totals: { pulls: number; spentUsd: number; feesUsd: number; rebatesUsd: number; soldUsd: number; heldUsd: number; heldCards: number; hits: number; netUsd: number };
  items: PortfolioItem[];
};

export type LeaderWallet = { wallet: string; you: boolean };
export type Leaderboard = {
  week: 'current' | 'last'; start: number; end: number;
  hits: (LeaderWallet & { code: string; priceUsd: number; valueUsd: number; card: { name: string; image: string | null } | null; at: number })[];
  packs: (LeaderWallet & { packs: number; spentUsd: number })[];
  rebates: (LeaderWallet & { code: string; priceUsd: number; valueUsd: number; rebateUsd: number; source: 'onsite' | 'offsite'; cardName: string | null; at: number })[];
};
