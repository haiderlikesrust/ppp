import { PublicKey } from '@solana/web3.js';

export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export type Card = { mint: string; name: string; image: string | null; insuredValueUsd: number | null; rarity: string | null; transferSignature: string | null };
export type Buyback = { available: boolean; amountUsdc: number | null; secondsRemaining: number | null };
export class ApiError extends Error {
  constructor(readonly status: number) { super(`Collector Crypt returned HTTP ${status}.`); }
}
export class CollectorCrypt {
  constructor(private readonly apiKey = '', private readonly fetcher: typeof fetch = fetch) {}
  private async request(path: string, body?: unknown): Promise<any> {
    const response = await this.fetcher(`https://gacha.collectorcrypt.com/api${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new ApiError(response.status);
    return response.json();
  }
  async machines(): Promise<any[]> {
    const result = await this.request('/machines');
    if (!Array.isArray(result.machines)) throw new Error('Unexpected machine catalog.');
    return result.machines.filter((m: any) => m.public && /^pokemon_\d+$/.test(m.code));
  }
  async generatePack(playerAddress: string, priceUsdc: number) {
    new PublicKey(playerAddress);
    if (!Number.isSafeInteger(priceUsdc) || priceUsdc <= 0) throw new Error('Use a positive whole-USDC pack price.');
    const machine = (await this.machines()).find(m => m.code === `pokemon_${priceUsdc}` && m.price === priceUsdc && m.contains === 1);
    if (!machine) throw new Error('That single-card Pokémon pack is not in the public catalog.');
    const order = await this.request('/generatePack', { playerAddress, packType: machine.code, turbo: false });
    if (typeof order.memo !== 'string' || typeof order.transaction !== 'string') throw new Error('Invalid pack order.');
    return { memo: order.memo as string, transaction: order.transaction as string };
  }
  packStatus(memo: string): Promise<any> { return this.request(`/pack/status?${new URLSearchParams({ memo })}`); }
  /** Live machine availability. */
  gachaStatus(): Promise<any> { return this.request('/status'); }
  /** Opens an already-paid pack, or returns its existing award. Never buys a pack. */
  openPack(memo: string): Promise<any> { return this.request('/openPack', { memo }); }
  async buybackQuote(mint: string): Promise<Buyback> {
    new PublicKey(mint);
    const quote = await this.request(`/buyback/available?${new URLSearchParams({ nft: mint })}`);
    if (quote.available === false) return { available: false, amountUsdc: null, secondsRemaining: null };
    const amount = Number(quote.amount);
    if (quote.available !== true || !Number.isSafeInteger(amount) || amount < 10_000 || amount > 280_000_000_000) throw new Error('Invalid buyback quote.');
    return { available: true, amountUsdc: amount / 1e6, secondsRemaining: Number.isFinite(quote.timeRemaining) ? quote.timeRemaining : null };
  }
  /** Reads metadata for an existing purchase by memo (no payment or opening). */
  async cardDetails(memo: string, dasRpcUrl?: string): Promise<Card | null> {
    const status = await this.packStatus(memo);
    if (!status.send?.nft_address) return null;
    const asset = dasRpcUrl ? await this.asset(status.send.nft_address, dasRpcUrl) : undefined;
    return normalizeCard({ nft_address: status.send.nft_address, nftWon: asset, transactionSignature: status.send.transaction_signature }, status);
  }
  /** Requires an RPC provider supporting Solana DAS getAsset (including Core/compressed cards). */
  async asset(mint: string, dasRpcUrl: string): Promise<any> {
    new PublicKey(mint);
    const response = await this.fetcher(dasRpcUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }) });
    if (!response.ok) throw new Error('Asset RPC request failed.');
    const body: any = await response.json();
    if (body.error || !body.result || body.result.id !== mint) throw new Error('Asset unavailable. Check that this RPC supports DAS getAsset.');
    return body.result;
  }
}

export function normalizeCard(opened: any, status: any): Card {
  const nft = opened.nftWon ?? {}, metadata = nft.content?.metadata ?? nft.metadata ?? {};
  const attributes = Array.isArray(metadata.attributes) ? metadata.attributes : [];
  const rawValue = status.send?.insured_value ?? attributes.find((a: any) => /insured.?value/i.test(a.trait_type))?.value;
  const value = rawValue == null || rawValue === '' ? NaN : Number(rawValue);
  const rawImage = nft.content?.links?.image ?? nft.content?.files?.[0]?.uri ?? metadata.image ?? nft.image;
  let image: string | null = null;
  try { const url = new URL(rawImage); if (url.protocol === 'https:' && !url.username && !url.password) image = url.href; } catch {}
  return { mint: new PublicKey(opened.nft_address).toBase58(), name: metadata.name ?? nft.name ?? 'Pokémon collectible', image,
    insuredValueUsd: Number.isFinite(value) && value >= 0 ? value : null, rarity: opened.rarity ?? null,
    transferSignature: opened.transactionSignature ?? status.send?.transaction_signature ?? null };
}
