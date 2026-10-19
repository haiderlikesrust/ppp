export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data as T;
}

export const money = (n: number | null | undefined) => n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);
export const pct = (bps: number) => `${+(bps / 100).toFixed(2)}%`;
export const short = (address?: string | null) => address ? `${address.slice(0, 4)}…${address.slice(-4)}` : '';
export const solscan = (kind: 'tx' | 'account' | 'token', id: string) => `https://solscan.io/${kind}/${id}`;
export const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`; if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};
