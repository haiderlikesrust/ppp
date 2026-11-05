import { BRAND } from '../shared/brand';
import type { SitePull } from '../shared/types';

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** What a shared pull says about itself. */
export function shareText(p: SitePull) {
  const name = p.card?.name.split(' · ')[0] ?? 'A graded card';
  const body = p.rebateUsd > 0 ? `Pulled from a ${money(p.priceUsd)} pack, worth ${money(p.valueUsd)}. ${money(p.rebateUsd)} came back in USDC.`
    : `Pulled from a ${money(p.priceUsd)} pack, worth ${money(p.valueUsd)}.`;
  return { title: `${name} · ${BRAND.name}`, description: body };
}

/**
 * The link people post. Crawlers don't run the site's script, so this small page carries the link preview,
 * and visitors are sent straight on to the pull's own page. Card names come from a provider, so all of it is escaped.
 */
export function sharePage(p: SitePull, origin: string) {
  const { title, description } = shareText(p), page = `/pull/${p.id}`;
  const image = p.card?.image ?? `${origin}/og.png`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${escape(BRAND.name)}" />
<meta property="og:title" content="${escape(title)}" />
<meta property="og:description" content="${escape(description)}" />
<meta property="og:url" content="${escape(origin + page)}" />
<meta property="og:image" content="${escape(image)}" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${escape(title)}" />
<meta name="twitter:description" content="${escape(description)}" />
<meta name="twitter:image" content="${escape(image)}" />
<meta http-equiv="refresh" content="0;url=${escape(page)}" />
</head><body><a href="${escape(page)}">${escape(title)}</a></body></html>`;
}
