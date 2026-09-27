#!/usr/bin/env node
/* Comprehensive dry-run of Eventbrite source with detailed statistics */

import { chromium } from 'playwright';
import { fromJsonLd } from './scrape/extract.mjs';
import { normalize, validate } from './scrape/normalize.mjs';
import { classifyEventbriteEvent } from './scrape/eventbrite.mjs';

const source = {
  id: 'eventbrite',
  name: 'Eventbrite',
  url: 'https://www.eventbrite.ca/d/canada--toronto/all-events/',
  category: 'dropin',
  art: 'art-market',
  defaultVenue: null,
  defaultAddress: null,
  exclude: /\b(networking|mixer|career fair|job fair|hiring|recruit|pitch (night|competition)|demo day|trade show|expo|conference|summit|convention)\b/i,
  followLinks: /^https:\/\/www\.eventbrite\.c[ao]\/e\/[a-z0-9-]+-tickets-\d+/i,
  maxFollow: 40,
};

const today = new Date().toISOString().slice(0, 10);

async function dryRun() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });
  const page = await context.newPage();
  
  console.log('=== EVENTBRITE DRY-RUN ===\n');
  console.log('Fetching listing page:', source.url);
  
  await page.goto(source.url, { waitUntil: 'networkidle', timeout: 45000 });
  const listingHtml = await page.content();
  
  console.log('Extracting events from listing page JSON-LD...');
  const listingEvents = fromJsonLd(listingHtml, 'eventbrite');
  console.log(`Found ${listingEvents.length} events on listing page\n`);
  
  const eventUrls = listingEvents
    .map(e => e.url)
    .filter(url => url && source.followLinks.test(url))
    .slice(0, source.maxFollow);
  
  console.log(`Following ${eventUrls.length} event pages for prices...\n`);
  
  const allEvents = [];
  for (let i = 0; i < eventUrls.length; i++) {
    const url = eventUrls[i];
    try {
      await new Promise(r => setTimeout(r, 1500)); // Polite delay
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      const eventHtml = await page.content();
      const eventData = fromJsonLd(eventHtml, 'eventbrite');
      
      if (eventData.length > 0) {
        allEvents.push({ ...eventData[0], followedFrom: url });
      }
    } catch (err) {
      console.log(`  Error fetching ${url}: ${err.message}`);
    }
  }
  
  await browser.close();
  
  console.log(`\nExtracted ${allEvents.length} events with full details\n`);
  console.log('=== PROCESSING & FILTERING ===\n');
  
  const kept = [];
  const dropped = {
    filter: [],
    price: [],
    gate: [],
    noPrice: [],
  };
  
  const priceStats = { free: 0, under20: 0, over20: 0, unknown: 0, overCeiling: 0 };
  const categoryStats = {};
  
  for (const raw of allEvents) {
    // Check source filter
    if (source.exclude && source.exclude.test(raw.title || '')) {
      dropped.filter.push({ title: raw.title, reason: 'excluded by source filter' });
      continue;
    }
    
    // Classify category
    const classified = classifyEventbriteEvent(raw);
    const sourceWithCategory = { ...source, category: classified.category, art: classified.art };
    
    // Normalize
    const result = normalize(raw, sourceWithCategory, { today, checked: today });
    
    if (!result.ok) {
      if (result.why.includes('$') && result.why.includes('past what this calendar is for')) {
        dropped.price.push({ title: result.title, reason: result.why });
        priceStats.overCeiling++;
      } else {
        dropped.gate.push({ title: result.title, reason: result.why });
      }
      continue;
    }
    
    // Validate
    const problems = validate(result.event);
    if (problems.length) {
      dropped.gate.push({ title: result.event.title, reason: problems.join(', ') });
      continue;
    }
    
    // Check if price is unknown (we drop these for Eventbrite)
    if (!result.event.entry || result.event.entry === 'Price not listed') {
      dropped.noPrice.push({ title: result.event.title, reason: 'no readable price' });
      priceStats.unknown++;
      continue;
    }
    
    // Track price stats
    const entry = result.event.entry.toLowerCase();
    if (entry.startsWith('free')) {
      priceStats.free++;
    } else {
      const match = entry.match(/\$(\d+(?:\.\d+)?)/);
      if (match) {
        const price = parseFloat(match[1]);
        if (price < 20) priceStats.under20++;
        else priceStats.over20++;
      } else {
        priceStats.unknown++;
      }
    }
    
    // Track category stats
    categoryStats[result.event.category] = (categoryStats[result.event.category] || 0) + 1;
    
    kept.push(result.event);
  }
  
  console.log('=== RESULTS ===\n');
  console.log(`Fetched from listing: ${listingEvents.length}`);
  console.log(`Followed event pages: ${eventUrls.length}`);
  console.log(`Extracted with full data: ${allEvents.length}`);
  console.log(`Kept: ${kept.length}`);
  console.log(`Dropped: ${Object.values(dropped).reduce((sum, arr) => sum + arr.length, 0)}`);
  console.log(`  - By source filter: ${dropped.filter.length}`);
  console.log(`  - Over $35 ceiling: ${dropped.price.length}`);
  console.log(`  - Other gates: ${dropped.gate.length}`);
  console.log(`  - No readable price: ${dropped.noPrice.length}`);
  
  console.log(`\n=== PRICE DISTRIBUTION (kept events) ===`);
  console.log(`Free: ${priceStats.free}`);
  console.log(`Under $20: ${priceStats.under20}`);
  console.log(`$20 and up: ${priceStats.over20}`);
  console.log(`Unknown: ${priceStats.unknown}`);
  console.log(`Over $35 (dropped): ${priceStats.overCeiling}`);
  
  console.log(`\n=== CATEGORY DISTRIBUTION (kept events) ===`);
  Object.entries(categoryStats)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, count]) => {
      console.log(`${cat}: ${count}`);
    });
  
  if (dropped.filter.length > 0) {
    console.log(`\n=== DROPPED BY FILTER (first 5) ===`);
    dropped.filter.slice(0, 5).forEach(d => {
      console.log(`- ${d.title}`);
    });
    if (dropped.filter.length > 5) console.log(`  ... and ${dropped.filter.length - 5} more`);
  }
  
  if (dropped.price.length > 0) {
    console.log(`\n=== DROPPED BY PRICE (over $35) ===`);
    dropped.price.forEach(d => {
      console.log(`- ${d.title}: ${d.reason}`);
    });
  }
  
  if (dropped.gate.length > 0) {
    console.log(`\n=== DROPPED BY OTHER GATES (first 5) ===`);
    dropped.gate.slice(0, 5).forEach(d => {
      console.log(`- ${d.title}: ${d.reason}`);
    });
    if (dropped.gate.length > 5) console.log(`  ... and ${dropped.gate.length - 5} more`);
  }
  
  console.log(`\n=== KEPT EVENTS (full list) ===\n`);
  kept.forEach((e, i) => {
    console.log(`${i + 1}. ${e.title}`);
    console.log(`   Date: ${e.schedule.date || e.schedule.start}${e.schedule.end ? ' - ' + e.schedule.end : ''}`);
    console.log(`   Category: ${e.category}`);
    console.log(`   Price: ${e.entry || '(none)'}`);
    console.log(`   Venue: ${e.venue}`);
    console.log();
  });
}

dryRun().catch(console.error);
