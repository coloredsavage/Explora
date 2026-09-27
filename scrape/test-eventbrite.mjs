#!/usr/bin/env node
/* Tests for Eventbrite source integration */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromJsonLd } from './extract.mjs';
import { normalize, validate, collapseSubsumed } from './normalize.mjs';
import { classifyEventbriteEvent } from './eventbrite.mjs';

const source = {
  id: 'eventbrite',
  name: 'Eventbrite',
  category: 'dropin',
  art: 'art-market',
  defaultVenue: null,
  defaultAddress: null,
};

const today = '2026-09-27';

test('excludes online-only events via eventAttendanceMode', () => {
  const html = `
    <script type="application/ld+json">
    {
      "@type": "Event",
      "name": "Online Webinar",
      "startDate": "2026-10-01",
      "location": {
        "@type": "Place",
        "name": "Online",
        "address": "Toronto, ON"
      },
      "eventAttendanceMode": "https://schema.org/OnlineEventAttendanceMode"
    }
    </script>
  `;
  
  const events = fromJsonLd(html, 'eventbrite');
  assert.equal(events.length, 1);
  assert.equal(events[0].venue, 'Online');
  
  const result = normalize(events[0], source, { today, checked: today });
  assert.equal(result.ok, false);
  assert.match(result.why, /not somewhere you can go/i);
});

test('keeps offline events', () => {
  const html = `
    <script type="application/ld+json">
    {
      "@type": "Event",
      "name": "In-Person Event",
      "startDate": "2026-10-01",
      "location": {
        "@type": "Place",
        "name": "Test Venue",
        "address": {
          "@type": "PostalAddress",
          "streetAddress": "123 Main St",
          "addressLocality": "Toronto",
          "addressRegion": "ON"
        }
      },
      "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode"
    }
    </script>
  `;
  
  const events = fromJsonLd(html, 'eventbrite');
  assert.equal(events.length, 1);
  assert.notEqual(events[0].venue, 'Online');
  
  const result = normalize(events[0], source, { today, checked: today });
  assert.equal(result.ok, true);
});

test('extracts free events correctly', () => {
  const html = `
    <script type="application/ld+json">
    {
      "@type": "Event",
      "name": "Free Event",
      "startDate": "2026-10-01",
      "location": {
        "@type": "Place",
        "name": "Test Venue",
        "address": {
          "@type": "PostalAddress",
          "streetAddress": "123 Main St",
          "addressLocality": "Toronto",
          "addressRegion": "ON"
        }
      },
      "offers": {
        "@type": "AggregateOffer",
        "lowPrice": 0,
        "highPrice": 0,
        "priceCurrency": "CAD"
      }
    }
    </script>
  `;
  
  const events = fromJsonLd(html, 'eventbrite');
  assert.equal(events.length, 1);
  assert.equal(events[0].entry, 'Free');
});

test('extracts paid event prices correctly', () => {
  const html = `
    <script type="application/ld+json">
    {
      "@type": "Event",
      "name": "Paid Event",
      "startDate": "2026-10-01",
      "location": {
        "@type": "Place",
        "name": "Test Venue",
        "address": {
          "@type": "PostalAddress",
          "streetAddress": "123 Main St",
          "addressLocality": "Toronto",
          "addressRegion": "ON"
        }
      },
      "offers": {
        "@type": "AggregateOffer",
        "lowPrice": 20,
        "highPrice": 30,
        "priceCurrency": "CAD"
      }
    }
    </script>
  `;
  
  const events = fromJsonLd(html, 'eventbrite');
  assert.equal(events.length, 1);
  assert.equal(events[0].entry, '$20');
});

test('drops events over $35 ceiling', () => {
  const html = `
    <script type="application/ld+json">
    {
      "@type": "Event",
      "name": "Expensive Event",
      "startDate": "2026-10-01",
      "location": {
        "@type": "Place",
        "name": "Test Venue",
        "address": {
          "@type": "PostalAddress",
          "streetAddress": "123 Main St",
          "addressLocality": "Toronto",
          "addressRegion": "ON"
        }
      },
      "offers": {
        "@type": "AggregateOffer",
        "lowPrice": 50,
        "priceCurrency": "CAD"
      }
    }
    </script>
  `;
  
  const events = fromJsonLd(html, 'eventbrite');
  assert.equal(events.length, 1);
  assert.equal(events[0].entry, '$50');
  
  const result = normalize(events[0], source, { today, checked: today });
  assert.equal(result.ok, false);
  assert.match(result.why, /\$50 is past what this calendar is for/);
});

test('classifies music events correctly', () => {
  const classified = classifyEventbriteEvent({
    title: 'Live Jazz Concert at The Rex',
    description: 'An evening of smooth jazz'
  });
  
  assert.equal(classified.category, 'music');
  assert.equal(classified.art, 'art-music');
});

test('classifies comedy events correctly', () => {
  const classified = classifyEventbriteEvent({
    title: 'Stand-Up Comedy Night',
    description: 'Featuring local comedians'
  });
  
  assert.equal(classified.category, 'comedy');
  assert.equal(classified.art, 'art-comedy');
});

test('classifies food events correctly', () => {
  const classified = classifyEventbriteEvent({
    title: 'Wine Tasting Experience',
    description: 'Sample fine wines from local vineyards'
  });
  
  assert.equal(classified.category, 'food');
  assert.equal(classified.art, 'art-food');
});

test('classifies art events correctly', () => {
  const classified = classifyEventbriteEvent({
    title: 'Gallery Opening',
    description: 'New exhibition of contemporary art'
  });
  
  assert.equal(classified.category, 'art');
  assert.equal(classified.art, 'art-gallery');
});

test('falls back to dropin for unclassified events', () => {
  const classified = classifyEventbriteEvent({
    title: 'Random Workshop',
    description: 'A workshop about things'
  });
  
  assert.equal(classified.category, 'dropin');
});

test('rejects events not in Toronto', () => {
  const html = `
    <script type="application/ld+json">
    {
      "@type": "Event",
      "name": "Ottawa Event",
      "startDate": "2026-10-01",
      "location": {
        "@type": "Place",
        "name": "Test Venue",
        "address": {
          "@type": "PostalAddress",
          "streetAddress": "123 Main St",
          "addressLocality": "Ottawa",
          "addressRegion": "ON"
        }
      }
    }
    </script>
  `;
  
  const events = fromJsonLd(html, 'eventbrite');
  const result = normalize(events[0], source, { today, checked: today });
  assert.equal(result.ok, false);
  assert.match(result.why, /not in Toronto/);
});

test('deduplicates events with same title, date, and venue', () => {
  const event1 = {
    id: 'eventbrite-test-event-2026-10-01',
    title: 'Test Event',
    venue: 'Test Venue',
    address: '123 Main St, Toronto, ON',
    url: 'https://eventbrite.com/e/test-event-tickets-123',
    schedule: { kind: 'day', date: '2026-10-01' },
    description: 'Short description',
  };
  
  const event2 = {
    id: 'luma-test-event-2026-10-01',
    title: 'Test Event',
    venue: 'Test Venue',
    address: '123 Main St, Toronto, ON',
    url: 'https://lu.ma/test-event',
    schedule: { kind: 'day', date: '2026-10-01' },
    description: 'Much longer description with more details',
  };
  
  const events = [event1, event2];
  const better = (a, b) => (a.description || '').length >= (b.description || '').length ? a : b;
  const isIndexUrl = () => false;
  
  collapseSubsumed(events, better, isIndexUrl);
  
  /* Should have been deduplicated to 1 event */
  assert.equal(events.length, 1);
  /* Should keep the one with longer description */
  assert.match(events[0].description, /longer description/);
});

test('treats free+paid tickets as free', () => {
  const html = `
    <script type="application/ld+json">
    {
      "@type": "Event",
      "name": "Mixed Pricing Event",
      "startDate": "2026-10-01",
      "location": {
        "@type": "Place",
        "name": "Test Venue",
        "address": {
          "@type": "PostalAddress",
          "streetAddress": "123 Main St",
            "addressLocality": "Toronto",
            "addressRegion": "ON"
          }
      },
      "offers": [
        {
          "@type": "Offer",
          "price": 0,
          "priceCurrency": "CAD"
        },
        {
          "@type": "Offer",
          "price": 20,
          "priceCurrency": "CAD"
        }
      ]
    }
    </script>
  `;
  
  const events = fromJsonLd(html, 'eventbrite');
  assert.equal(events.length, 1);
  assert.equal(events[0].entry, 'Free');
});

console.log('All Eventbrite tests passed!');
