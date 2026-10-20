import { PublicKey, type Connection, type Keypair } from '@solana/web3.js';
import { CollectorCrypt } from './client';
import { buyPack } from './purchase';
import type { PurchaseStore } from './store';
import type { PackMachine, PackProvider, PurchaseResult } from '../ports';

export const PACK_PRICES = [25, 50, 100, 500];

/** Collector Crypt's gacha, buying with the OPS wallet. */
export class CollectorCryptPacks implements PackProvider {
  constructor(readonly client: CollectorCrypt, readonly opts: { connection: Connection | null; signer: Keypair | null; paymentWallet: string; store: PurchaseStore; enabled: boolean; dasRpcUrl: string; maxPackUsd?: number }) {}

  private cache: { at: number; value: Promise<PackMachine[]> } | null = null;

  /**
   * Single-card Pokémon machines that are public, open, and in stock (grailshot's filter).
   * Cached for 30s and shared by concurrent callers, so page views do not fan out to Collector
   * Crypt. A pack that sells out inside that window is caught at purchase time and refunded.
   */
  machines(): Promise<PackMachine[]> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.value;
    const value = this.fetchMachines();
    this.cache = { at: Date.now(), value };
    value.catch(() => { if (this.cache?.value === value) this.cache = null; });
    return value;
  }

  private async fetchMachines(): Promise<PackMachine[]> {
    const [catalog, status] = await Promise.all([this.client.machines(), this.client.gachaStatus()]);
    if (status.machineStatus !== 'running') return [];
    return catalog
      .filter((m: any) => PACK_PRICES.includes(m.price) && m.code === `pokemon_${m.price}` && m.contains === 1
        && Object.values(m.stock ?? {}).length > 0 && Object.values(m.stock ?? {}).every((n: any) => Number.isFinite(n) && n > 0)
        && status.gachas?.some((s: any) => s.code === m.code && s.isOpen))
      .map((m: any) => ({ priceUsd: m.price, code: m.code }))
      .sort((a, b) => a.priceUsd - b.priceUsd);
  }

  buy(purchaseId: string, priceUsd: number): Promise<PurchaseResult> {
    const { connection, signer, paymentWallet, store, enabled } = this.opts;
    if (!connection || !signer) throw new Error('The OPS wallet and RPC must be configured to buy packs.');
    return buyPack({ id: purchaseId, priceUsdc: priceUsd, maxPriceUsdc: this.opts.maxPackUsd ?? 500, enabled, client: this.client, connection, signer, paymentWallet: new PublicKey(paymentWallet), store });
  }

  status(memo: string) { return this.client.packStatus(memo); }

  async asset(mint: string) {
    if (!this.opts.dasRpcUrl) return null;
    try {
      const asset = await this.client.asset(mint, this.opts.dasRpcUrl);
      const metadata = asset.content?.metadata ?? {};
      const image = asset.content?.links?.image ?? asset.content?.files?.[0]?.uri ?? null;
      return { name: metadata.name ?? null, image: typeof image === 'string' && image.startsWith('https://') ? image : null };
    } catch { return null; }
  }
}
