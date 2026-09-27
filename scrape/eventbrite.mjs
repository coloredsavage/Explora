/* Eventbrite-specific extraction helpers */

/* Map Eventbrite categories to our 15 categories, with fallback keyword matching.
 * Eventbrite uses categories like "Music", "Food & Drink", "Business", etc. */
export function classifyEventbriteEvent(raw) {
  const title = String(raw.title || '').toLowerCase();
  const desc = String(raw.description || '').toLowerCase();
  const text = `${title} ${desc}`;
  
  /* Check Eventbrite's category field if present (from event page or listing) */
  const ebCat = String(raw.eventbriteCategory || '').toLowerCase();
  
  /* Book launches and author talks */
  if (/\b(book launch|author|writer)\b/i.test(text)) {
    return { category: 'books', art: 'art-books' };
  }
  
  /* Talks, panels, discussions */
  if (/\b(talk|panel|discussion|conversation|speaker|lecture)\b/i.test(text)) {
    return { category: 'stage', art: 'art-stage' };
  }
  
  /* Music/Performing Arts */
  if (ebCat.includes('music') || /\b(concert|band|jazz|blues|folk|rock|dj|live music|orchestra|choir)\b/i.test(text)) {
    return { category: 'music', art: 'art-music' };
  }
  
  /* Comedy */
  if (ebCat.includes('comedy') || /\b(comedy|comedian|stand-up|improv)\b/i.test(text)) {
    return { category: 'comedy', art: 'art-comedy' };
  }
  
  /* Film */
  if (ebCat.includes('film') || /\b(film|movie|cinema|screening|documentary)\b/i.test(text)) {
    return { category: 'film', art: 'art-film' };
  }
  
  /* Stage/Theatre */
  if (ebCat.includes('performing') || /\b(theatre|theater|play|musical|performance|dance)\b/i.test(text)) {
    return { category: 'stage', art: 'art-stage' };
  }
  
  /* Food & Drink */
  if (ebCat.includes('food') || ebCat.includes('drink') || /\b(tasting|wine|beer|food|culinary|chef|restaurant|brunch)\b/i.test(text)) {
    return { category: 'food', art: 'art-food' };
  }
  
  /* Art & Exhibitions */
  if (ebCat.includes('art') || /\b(art|gallery|exhibition|exhibit|artist|painting|sculpture)\b/i.test(text)) {
    return { category: 'art', art: 'art-gallery' };
  }
  
  /* Books/Literature */
  if (ebCat.includes('book') || /\b(book|author|reading|literary|writer|publisher)\b/i.test(text)) {
    return { category: 'books', art: 'art-books' };
  }
  
  /* Festivals */
  if (ebCat.includes('festival') || /\b(festival|carnival|celebration|parade)\b/i.test(text)) {
    return { category: 'festival', art: 'art-festival' };
  }
  
  /* Markets */
  if (/\b(market|vendor|stall|farmer|artisan)\b/i.test(text)) {
    return { category: 'market', art: 'art-market' };
  }
  
  /* Flea markets */
  if (/\b(flea|vintage|antique|thrift|collectible)\b/i.test(text)) {
    return { category: 'flea', art: 'art-flea' };
  }
  
  /* Museums */
  if (/\b(museum)\b/i.test(text)) {
    return { category: 'museum', art: 'art-museum' };
  }
  
  /* Outdoors */
  if (/\b(hike|walk|trail|park|outdoor|nature|garden|bike|run)\b/i.test(text)) {
    return { category: 'outdoors', art: 'art-outdoors' };
  }
  
  /* Architecture/Tours */
  if (/\b(tour|architecture|building|historic|heritage)\b/i.test(text)) {
    return { category: 'architecture', art: 'art-architecture' };
  }
  
  /* Default: dropin */
  return { category: 'dropin', art: 'art-market' };
}

/* Extract price from Eventbrite's AggregateOffer or individual Offer.
 * Returns "Free" or "$N" or null if no price is readable. */
export function extractEventbritePrice(offers) {
  if (!offers) return null;
  
  const offerList = Array.isArray(offers) ? offers : [offers];
  let lowestPrice = null;
  let hasFree = false;
  
  for (const offer of offerList) {
    if (!offer) continue;
    
    /* Check price, lowPrice, or highPrice */
    const price = offer.price ?? offer.lowPrice ?? offer.highPrice;
    
    if (price === 0 || price === '0' || price === '0.00') {
      hasFree = true;
      continue;
    }
    
    const num = parseFloat(String(price).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(num) && num >= 0) {
      if (lowestPrice === null || num < lowestPrice) {
        lowestPrice = num;
      }
    }
  }
  
  /* If any ticket is free, the event is free */
  if (hasFree && lowestPrice === null) return 'Free';
  
  /* If there are both free and paid tickets, it's free (you can attend for free) */
  if (hasFree) return 'Free';
  
  /* Otherwise return the lowest price */
  if (lowestPrice !== null) {
    return `$${Math.round(lowestPrice * 100) / 100}`;
  }
  
  return null;
}
