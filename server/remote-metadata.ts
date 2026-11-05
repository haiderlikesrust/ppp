const HOSTS = ['arweave.net', 'ipfs.io', 'nftstorage.link', 'collectorcrypt.com', 'cloudfront.net'];

export function metadataUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error('Metadata host is not allowed.');
  return url;
}

/** Reads a whole response, refusing anything over `max` bytes. */
async function readLimited(response: Response, max: number, what: string) {
  if (!response.body) throw new Error(`${what} is unavailable.`);
  if (Number(response.headers.get('content-length')) > max) { await response.body.cancel(); throw new Error(`${what} is too large.`); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { await reader.cancel(); throw new Error(`${what} is too large.`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export async function fetchMetadata(value: string) {
  const url = metadataUrl(value);
  // No redirects: an allowed host must not forward server requests to private services.
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Metadata is unavailable.');
  return JSON.parse((await readLimited(response, 256 * 1024, 'Metadata')).toString('utf8'));
}

/** Image types served back from our own origin. SVG is left out: it can carry script. */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const MAX_IMAGE_REDIRECTS = 3;

/**
 * A card's photo, fetched for the share card: a canvas can only export images from its own origin. Same host
 * allow-list as metadata, since the URL comes from a provider's record. Collector Crypt redirects a card's photo to a
 * resized copy on its own host, so redirects are followed by hand and every hop has to pass the allow-list again:
 * an allowed host still can't forward a server request to a private service.
 */
export async function fetchCardImage(value: string, fetcher: typeof fetch = fetch) {
  let url = metadataUrl(value);
  for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop++) {
    const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const next = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && next) { await response.body?.cancel(); url = metadataUrl(new URL(next, url).href); continue; }
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    if (!response.ok || !IMAGE_TYPES.includes(type)) { await response.body?.cancel(); throw new Error('The card image is unavailable.'); }
    return { type, bytes: await readLimited(response, 8 * 1024 * 1024, 'The card image') };
  }
  throw new Error('The card image is unavailable.');
}
