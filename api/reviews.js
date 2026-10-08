// Google reviews via the Places API (New).
// Requires env GOOGLE_PLACES_API_KEY and GOOGLE_PLACE_ID; otherwise responds { configured: false }
// and the site falls back to a plain "see reviews on Google" call to action.
const CACHE_MS = 6 * 60 * 60 * 1000;
let cache = null; // { at, data }

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const apiKey  = process.env.GOOGLE_PLACES_API_KEY;
  const placeId = process.env.GOOGLE_PLACE_ID;
  if (!apiKey || !placeId) return res.status(200).json({ configured: false });

  if (cache && Date.now() - cache.at < CACHE_MS) {
    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    return res.status(200).json(cache.data);
  }

  try {
    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=pt-PT`;
    const r = await fetch(url, {
      headers: {
        'X-Goog-Api-Key':   apiKey,
        'X-Goog-FieldMask': 'id,rating,userRatingCount,googleMapsUri,reviews',
      },
    });
    if (!r.ok) throw new Error(`Places API ${r.status}: ${await r.text()}`);
    const place = await r.json();

    const data = {
      configured:  true,
      placeId:     place.id || placeId,
      rating:      place.rating ?? null,
      total:       place.userRatingCount ?? 0,
      mapsUrl:     place.googleMapsUri || null,
      writeReviewUrl: `https://search.google.com/local/writereview?placeid=${encodeURIComponent(place.id || placeId)}`,
      reviews: (place.reviews || [])
        .filter(rv => (rv.text?.text || rv.originalText?.text))
        .map(rv => ({
          rating: rv.rating,
          text:   rv.text?.text || rv.originalText?.text,
          when:   rv.relativePublishTimeDescription || '',
          author: rv.authorAttribution?.displayName || 'Cliente Google',
          authorUrl: rv.authorAttribution?.uri || null,
        })),
    };

    cache = { at: Date.now(), data };
    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    return res.status(200).json(data);
  } catch (err) {
    console.error('[reviews]', err.message);
    if (cache) return res.status(200).json(cache.data);
    return res.status(200).json({ configured: false });
  }
};
