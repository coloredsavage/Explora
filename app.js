/* What should we do today? — Toronto */
(function () {
  'use strict';

  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var MONTHS_LONG = ['January','February','March','April','May','June','July',
                     'August','September','October','November','December'];
  var WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  /* ---------------------------------------------------------- date helpers */

  function fromISO(s) {
    var p = s.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2], 12);      /* noon: DST-proof */
  }
  function addDays(d, n) { var c = new Date(d); c.setDate(c.getDate() + n); return c; }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12); }
  function cmp(a, b) { return a.getTime() - b.getTime(); }
  function min(a, b) { return cmp(a, b) <= 0 ? a : b; }
  function max(a, b) { return cmp(a, b) >= 0 ? a : b; }
  function sameDay(a, b) { return cmp(a, b) === 0; }

  function fmtDay(d) { return MONTHS[d.getMonth()] + ' ' + d.getDate(); }

  /* "Sep 11 – 16" within a month, "Sep 18 – Nov 6" across months */
  function fmtSpan(a, b) {
    if (sameDay(a, b)) return fmtDay(a);
    if (a.getMonth() === b.getMonth()) return fmtDay(a) + ' – ' + b.getDate();
    return fmtDay(a) + ' – ' + fmtDay(b);
  }
  /* the modal spells both ends out: "Sep 11 – Sep 16", with the year when a
     range runs into the next one ("Sep 2 – Jan 30, 2027") */
  function fmtSpanLong(a, b) {
    if (sameDay(a, b)) return fmtDay(a);
    var end = fmtDay(b);
    if (a.getFullYear() !== b.getFullYear()) end += ', ' + b.getFullYear();
    return fmtDay(a) + ' – ' + end;
  }
  function fmtLongDate(d) {
    return MONTHS_LONG[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  /* "Friday, September 11" — the modal has room to say it properly */
  function fmtWeekday(d) {
    return WEEKDAYS[d.getDay()] + ', ' + MONTHS_LONG[d.getMonth()] + ' ' + d.getDate();
  }

  /* The modal lets a time range breathe — but only when both ends name their
     own half of the day. "5:30pm – 8:30pm" reads well; "4 – 9pm" does not. */
  function spaced(time) {
    var parts = time.split('–');
    if (parts.length !== 2) return time;
    var marked = /am|pm/i;
    return marked.test(parts[0]) && marked.test(parts[1])
      ? parts[0] + ' – ' + parts[1]
      : time;
  }

  /* --------------------------------------------------------- occurrences */

  /* the nth (1-5, or -1 for last) given weekday of a month */
  function nthWeekday(year, month, weekday, nth) {
    if (nth > 0) {
      var first = new Date(year, month, 1, 12);
      var offset = (weekday - first.getDay() + 7) % 7;
      var day = 1 + offset + (nth - 1) * 7;
      var d = new Date(year, month, day, 12);
      return d.getMonth() === month ? d : null;
    }
    var last = new Date(year, month + 1, 0, 12);
    var back = (last.getDay() - weekday + 7) % 7;
    return new Date(year, month, last.getDate() - back, 12);
  }

  /* An event may hold several schedules — a bike co-op open on weekday
     evenings and weekend afternoons is one event, not two. */
  function expand(event, from, to) {
    var out = [];
    [].concat(event.schedule).forEach(function (s) {
      out = out.concat(expandOne(event, s, from, to));
    });
    return out;
  }

  function expandOne(event, s, from, to) {
    var out = [], d, y, m, cursor, limitFrom, limitTo;

    function push(start, end) {
      if (cmp(end, from) < 0 || cmp(start, to) > 0) return;
      out.push({
        event: event, start: start, end: end,
        time: s.time || null, hour: s.hour == null ? 0 : s.hour
      });
    }

    if (s.kind === 'range') { push(fromISO(s.start), fromISO(s.end)); return out; }
    if (s.kind === 'day')   { d = fromISO(s.date); push(d, d); return out; }

    limitFrom = max(from, fromISO(s.from));
    limitTo   = min(to, fromISO(s.to));
    if (cmp(limitFrom, limitTo) > 0) return out;

    if (s.kind === 'weekly') {
      var days = [].concat(s.weekday);
      days.forEach(function (wd) {
        var c = addDays(limitFrom, (wd - limitFrom.getDay() + 7) % 7);
        while (cmp(c, limitTo) <= 0) { push(c, c); c = addDays(c, 7); }
      });
      return out;
    }

    if (s.kind === 'nth') {
      y = limitFrom.getFullYear(); m = limitFrom.getMonth();
      while (y < limitTo.getFullYear() || (y === limitTo.getFullYear() && m <= limitTo.getMonth())) {
        d = nthWeekday(y, m, s.weekday, s.nth);
        if (d && cmp(d, limitFrom) >= 0 && cmp(d, limitTo) <= 0) push(d, d);
        m += 1; if (m > 11) { m = 0; y += 1; }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------- windows */

  var TODAY = startOfDay(new Date());
  var YEAR_END = new Date(TODAY.getFullYear(), 11, 31, 12);

  function endOfWeek(d) {                       /* the coming Sunday */
    var back = (7 - d.getDay()) % 7;
    return addDays(d, back === 0 ? 7 : back);
  }
  function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0, 12); }

  /* `tab` is the short form used by the mobile tab strip, where five full
     titles do not fit across a phone. It is never seen on a wide screen, and
     the dates sit directly under it, so "Week" cannot be misread. */
  var WINDOWS = [
    { id: 'today', title: 'Today',      tab: 'Today', from: TODAY,             to: TODAY,
      range: fmtLongDate(TODAY), hideWhen: true },
    { id: 'week',  title: 'This week',  tab: 'Week',  from: addDays(TODAY, 1), to: endOfWeek(TODAY) },
    { id: 'month', title: 'This month', tab: 'Month', from: TODAY,             to: endOfMonth(TODAY) },
    { id: 'year',  title: 'This year',  tab: 'Year',  from: TODAY,             to: YEAR_END }
  ];
  WINDOWS.forEach(function (w) {
    if (!w.range) w.range = fmtSpan(w.from, w.to);
  });

  /* Hand-written listings, plus whatever the poller last committed. A missing
     or malformed scraped.js must never take the calendar down with it. */
  var LISTINGS = EVENTS.concat(
    typeof SCRAPED !== 'undefined' && Array.isArray(SCRAPED) ? SCRAPED : []
  ).filter(function (ev) {
    return ev && ev.id && ev.title && ev.schedule && CATEGORIES[ev.category];
  });

  /* every occurrence we could ever show, computed once */
  var ALL = [];
  LISTINGS.forEach(function (ev) {
    ALL = ALL.concat(expand(ev, TODAY, YEAR_END));
  });

  function inWindow(o, w) { return cmp(o.end, w.from) >= 0 && cmp(o.start, w.to) <= 0; }

  /* ------------------------------------------------------------- filters */

  /* Two independent groups — category and price. They are stored under separate
     keys so an older saved category filter still loads; someone who had one
     before price existed keeps it, and gets every price. */
  var GROUPS = [
    { key: 'cats',   store: 'wswdt.categories', title: 'Category', of: CATEGORIES,
      pick: function (ev) { return ev.category; } },
    { key: 'prices', store: 'wswdt.prices',     title: 'Price',    of: PRICES,
      pick: priceOf },
  ];

  /* The listings that actually reach the board — the ones with at least one
     occurrence between today and year end — rather than everything in the
     file. A finished event nobody can scroll to should not shape the filter. */
  var ON_BOARD = [];
  (function () {
    var seen = {};
    ALL.forEach(function (o) {
      if (seen[o.event.id]) return;
      seen[o.event.id] = true;
      ON_BOARD.push(o.event);
    });
  }());

  /* Each group covers only the values those listings contain. A chip nobody
     can match is a trap — tick it alone and the board goes blank with no way
     to tell a filter from an empty calendar — so today there is no "Under $20"
     chip, because nothing costs between a penny and twenty dollars, and none
     for "Meetups", because nothing is one. Both appear on their own the day
     something lands in them.

     They are dropped from the state, not just from the sheet. A value that is
     hidden but still held at true reads as a tick nobody can see or clear,
     and it defeats the empty-group guard below: every visible category off
     plus an invisible one on is not "no categories chosen", so the guard
     would not fire and the board would go empty. */
  GROUPS.forEach(function (g) {
    g.keys = Object.keys(g.of).filter(function (key) {
      return ON_BOARD.some(function (ev) { return g.pick(ev) === key; });
    });
  });

  var active = {};
  GROUPS.forEach(function (g) {
    active[g.key] = {};
    g.keys.forEach(function (k) { active[g.key][k] = true; });
    try {
      var saved = JSON.parse(localStorage.getItem(g.store) || 'null');
      if (saved) g.keys.forEach(function (k) {
        if (typeof saved[k] === 'boolean') active[g.key][k] = saved[k];
      });
    } catch (e) { /* private mode, or nothing stored */ }
  });

  function persist() {
    GROUPS.forEach(function (g) {
      try { localStorage.setItem(g.store, JSON.stringify(active[g.key])); } catch (e) {}
    });
  }

  /* Strictly, every listing's value is offered, since that is where the keys
     came from. The !== false is for the case that cannot happen: an unknown
     value shows rather than vanishing, because a listing on the calendar and
     impossible to filter beats one silently dropped. */
  function shown(event) {
    return GROUPS.every(function (g) { return active[g.key][g.pick(event)] !== false; });
  }

  /* ------------------------------------------------------------ rendering */

  var board = document.getElementById('board');
  var statusEl = document.getElementById('status');
  var seenArt;                                  /* one illustration per event */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* a generated image if the event has one, else the drawn SVG object */
  function artFor(event) {
    if (event.image) {
      var img = document.createElement('img');
      img.src = event.image;
      img.alt = event.title;
      img.loading = 'lazy';
      img.decoding = 'async';
      /* if the file is missing, fall back to the symbol rather than a broken icon */
      img.addEventListener('error', function () {
        var svg = symbolFor(event);
        svg.setAttribute('class', img.getAttribute('class') || '');
        if (img.parentNode) img.parentNode.replaceChild(svg, img);
      });
      return img;
    }
    return symbolFor(event);
  }

  function symbolFor(event) {
    var id = event.art || CATEGORIES[event.category].art;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 260 200');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', event.title);
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }

  /* A run you can drop in on across many days, rather than something with a
     start. Sorts after the timed events in every window. */
  function ongoing(occ) {
    return sameDay(occ.start, occ.end) ? 0 : 1;
  }

  function cardFor(occ, win) {
    var ev = occ.event;
    var btn = el('button', 'card card--' + ev.category);
    btn.type = 'button';
    btn.dataset.event = ev.id;
    btn.dataset.start = occ.start.toISOString();
    btn.dataset.price = priceOf(ev);

    btn.appendChild(el('h3', 'card__title', ev.title));

    /* the visible dates are clipped to this column's window */
    var from = max(occ.start, win.from);
    var to = min(occ.end, win.to);

    /* Date and time go in separate spans so the phone can drop the time from
       this line and show it in the card's footer instead, without either
       layout having to render a different card. */
    var dateText = win.hideWhen ? '' : (sameDay(from, to) ? fmtDay(from) : fmtSpan(from, to));
    var when = el('p', 'card__when');
    if (dateText) when.appendChild(el('span', 'card__when-date', dateText));
    if (occ.time) {
      when.appendChild(el('span', 'card__when-time', (dateText ? ' · ' : '') + occ.time));
    }
    if (when.childNodes.length) {
      /* Today's cards carry only a time, and on the phone that has moved to
         the footer — so the line has nothing left to say and is dropped. */
      if (!dateText) when.className += ' card__when--time-only';
      btn.appendChild(when);
    }

    if (!seenArt[ev.id]) {
      seenArt[ev.id] = true;
      var node = artFor(ev);
      node.setAttribute('class', 'card__art');
      btn.appendChild(node);
    }

    /* Phone only: what it costs, and when. */
    var foot = el('div', 'card__foot');
    foot.appendChild(el('span', 'card__price', priceTag(ev)));
    foot.appendChild(el('span', 'card__time', timeTag(occ, from)));
    btn.appendChild(foot);

    return btn;
  }

  /* The short form of a price, for the corner of a card. The whole `entry`
     line stays in the modal; this is the number you want at a glance, and it
     agrees with the filter because it asks priceOf which bucket applies
     rather than re-reading the line its own way. */
  function priceTag(ev) {
    var t = String(ev.entry || '').trim();
    if (!t) return '';
    if (priceOf(ev) === 'free') {
      return /pay[- ]what|pwyc/i.test(t) ? 'Pay what you can' : 'Free';
    }
    var m = t.match(/\$\s*(\d+(?:\.\d+)?)/);
    return m ? '$' + m[1] : '';
  }

  /* When it starts, or — for a run with no daily time, like an exhibition —
     when it shuts on the day you are looking at.

     `closes` is either one time, for a place that keeps the same hours all
     week, or seven indexed by weekday (0 = Sunday) with null for the days it
     is shut. Per-day matters more than it looks: MOCA closes at 5 most days
     and 9 on Fridays, and the Gardiner at 6 on weekdays and 5 at weekends, so
     a single figure was wrong four days out of seven. A day it is closed, or
     a listing with no hours at all, shows nothing rather than a guess. */
  function timeTag(occ, day) {
    if (occ.time) return occ.time;
    var c = occ.event.closes;
    if (!c) return '';
    var at = typeof c === 'string' ? c : c[day.getDay()];
    return at ? 'Closes ' + at : '';
  }

  function render() {
    seenArt = {};
    Array.prototype.slice.call(board.querySelectorAll('.col:not(.col--about)'))
      .forEach(function (n) { n.remove(); });

    var todayCount = 0;

    WINDOWS.forEach(function (win) {
      var col = el('section', 'col');
      col.id = 'panel-' + win.id;
      col.dataset.tab = win.tab;
      col.setAttribute('aria-labelledby', 'head-' + win.id);

      var head = el('header', 'col__head');
      var title = el('h2', 'col__title', win.title);
      title.id = 'head-' + win.id;
      head.appendChild(title);
      head.appendChild(el('span', 'col__range', win.range));
      col.appendChild(head);

      var body = el('div', 'col__body');
      var list = ALL.filter(function (o) {
        return shown(o.event) && inWindow(o, win);
      }).sort(function (a, b) {
        /* Things that happen at a time come before things that are simply
           open. An exhibition running until October is worth knowing about,
           but it is not an answer to "what should we do today" in the way a
           7pm gig is — and because a run starts before the window does, it
           used to sort to the very top and push the day's actual events off
           the screen. */
        return (ongoing(a) - ongoing(b)) ||
               cmp(max(a.start, win.from), max(b.start, win.from)) ||
               a.hour - b.hour ||
               a.event.title.localeCompare(b.event.title);
      });

      if (win.id === 'today') todayCount = list.length;

      if (!list.length) {
        body.appendChild(el('p', 'col__empty', 'Nothing here.'));
      } else {
        list.forEach(function (o) { body.appendChild(cardFor(o, win)); });
      }

      col.appendChild(body);
      board.appendChild(col);
    });

    statusEl.textContent = 'Today. ' + fmtLongDate(TODAY) + '. ' +
      todayCount + (todayCount === 1 ? ' event.' : ' events.');
    updateNav();
    buildTabs();
  }

  /* --------------------------------------------------------------- modal */

  var scrim = document.getElementById('scrim');
  var modal = document.getElementById('modal');
  var mClose = document.getElementById('modal-close');
  var lastFocus = null;

  function openModal(eventId, startISO) {
    var ev = null, i;
    for (i = 0; i < LISTINGS.length; i++) if (LISTINGS[i].id === eventId) { ev = LISTINGS[i]; break; }
    if (!ev) return;

    var occ = null;
    for (i = 0; i < ALL.length; i++) {
      if (ALL[i].event.id !== eventId) continue;
      if (!startISO || ALL[i].start.toISOString() === startISO) { occ = ALL[i]; break; }
      if (!occ) occ = ALL[i];
    }
    if (!occ) return;

    document.getElementById('modal-title').textContent = ev.title;

    var art = document.getElementById('modal-art');
    art.textContent = '';
    var artEl = artFor(ev);
    artEl.setAttribute('class', 'modal__art-item');
    art.appendChild(artEl);

    document.getElementById('modal-desc').textContent = ev.description;

    var link = document.getElementById('modal-link');
    link.href = ev.url;
    link.target = '_blank';
    link.rel = 'noopener';

    var when = sameDay(occ.start, occ.end)
      ? fmtWeekday(occ.start)
      : fmtSpanLong(occ.start, occ.end);
    if (occ.time) when += ' · ' + spaced(occ.time);
    document.getElementById('modal-when').textContent = when;
    document.getElementById('modal-where').textContent = ev.venue + ', ' + ev.address;
    document.getElementById('modal-map').href =
      'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(ev.venue + ', ' + ev.address);

    var entry = document.getElementById('modal-entry');
    var entryLabel = document.getElementById('modal-entry-label');
    entry.textContent = ev.entry || '';
    entry.hidden = entryLabel.hidden = !ev.entry;

    var caveat = document.getElementById('modal-caveat');
    caveat.textContent = ev.unconfirmed || '';
    caveat.hidden = !ev.unconfirmed;

    lastFocus = document.activeElement;
    scrim.hidden = false;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    mClose.focus();
    if (history.replaceState) history.replaceState(null, '', '#' + ev.id);
  }

  function closeModal() {
    if (modal.hidden) return;
    modal.hidden = true;
    if (fPanel.hidden) scrim.hidden = true;
    document.body.style.overflow = '';
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  mClose.addEventListener('click', closeModal);
  scrim.addEventListener('click', function () { closeModal(); closeFilter(); });

  board.addEventListener('click', function (e) {
    var card = e.target.closest ? e.target.closest('.card') : null;
    if (card) openModal(card.dataset.event, card.dataset.start);
  });

  /* keep Tab inside whichever dialog is open */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeModal(); closeFilter(); return; }
    if (e.key !== 'Tab') return;

    var dialog = !modal.hidden ? modal : (!fPanel.hidden ? fPanel : null);
    if (!dialog) return;

    var focusable = dialog.querySelectorAll('a[href], button, input:not([type="checkbox"]), label.filter-row');
    if (!focusable.length) return;
    var first = focusable[0], last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* --------------------------------------------------------- filter sheet */

  var fToggle = document.getElementById('filter-toggle');
  var fPanel = document.getElementById('filter-panel');
  var fRows = document.getElementById('filter-rows');
  var pending = null;                     /* staged until Apply is pressed */

  function buildFilter() {
    fRows.textContent = '';
    GROUPS.forEach(function (g) { buildGroup(g); });
  }

  function buildGroup(g) {
    if (!g.keys.length) return;
    fRows.appendChild(el('h3', 'sheet__group', g.title));

    g.keys.forEach(function (key) {
      var row = el('label', 'filter-row');
      /* categories carry their own colour; price has none of its own */
      if (g.key === 'cats') row.style.setProperty('--soft', 'var(--s-' + key + ')');

      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = pending[g.key][key];
      box.addEventListener('change', function () { pending[g.key][key] = box.checked; });

      var tick = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      tick.setAttribute('class', 'filter-row__tick');
      tick.setAttribute('viewBox', '0 0 24 24');
      tick.setAttribute('aria-hidden', 'true');
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      tick.appendChild(path);

      row.appendChild(box);
      row.appendChild(el('span', 'filter-row__label', g.of[key].label));
      row.appendChild(tick);
      fRows.appendChild(row);
    });
  }

  function openFilter() {
    pending = {};
    GROUPS.forEach(function (g) {
      pending[g.key] = {};
      Object.keys(active[g.key]).forEach(function (k) { pending[g.key][k] = active[g.key][k]; });
    });
    buildFilter();
    fRows.scrollTop = 0;
    scrim.hidden = false;
    fPanel.hidden = false;
    fToggle.setAttribute('aria-expanded', 'true');
    document.getElementById('filter-close').focus();
  }

  function closeFilter() {
    if (fPanel.hidden) return;
    fPanel.hidden = true;
    if (modal.hidden) scrim.hidden = true;
    fToggle.setAttribute('aria-expanded', 'false');
    fToggle.focus();
  }

  fToggle.addEventListener('click', function () {
    if (fPanel.hidden) openFilter(); else closeFilter();
  });

  document.getElementById('filter-close').addEventListener('click', closeFilter);

  document.getElementById('filter-reset').addEventListener('click', function () {
    GROUPS.forEach(function (g) {
      Object.keys(pending[g.key]).forEach(function (k) { pending[g.key][k] = true; });
    });
    buildFilter();
    fRows.scrollTop = 0;
  });

  document.getElementById('filter-apply').addEventListener('click', function () {
    /* A group with nothing ticked would empty the board on its own, so it is
       read as "everything". Each group is guarded on its own: clearing all the
       prices must not quietly undo a category choice made in the same visit. */
    GROUPS.forEach(function (g) {
      var any = Object.keys(pending[g.key]).some(function (k) { return pending[g.key][k]; });
      Object.keys(active[g.key]).forEach(function (k) {
        active[g.key][k] = any ? pending[g.key][k] : true;
      });
    });
    persist();
    render();
    closeFilter();
  });

  /* ----------------------------------------------------------- dock nav */

  var prev = document.getElementById('nav-prev');
  var next = document.getElementById('nav-next');
  var nextLabel = document.getElementById('nav-next-label');

  /* Where a column starts along the board, in the board's own scroll
     coordinates. Read from layout rather than assumed, because the columns
     are not all the same width — About is 640px against a window's 320 — and
     stepping by a fixed amount lands mid-column every time you pass it. */
  function colStart(col) {
    return Math.round(
      col.getBoundingClientRect().left - board.getBoundingClientRect().left + board.scrollLeft
    );
  }
  function columns() {
    return Array.prototype.slice.call(board.querySelectorAll('.col'));
  }
  function colTitle(col) {
    var t = col.querySelector('.col__title');
    if (t) return t.textContent;
    return col.classList.contains('col--about') ? 'About' : '';
  }
  function neighbour(dir) {
    var list = columns();
    if (dir > 0) {
      for (var i = 0; i < list.length; i++) {
        if (colStart(list[i]) > board.scrollLeft + 4) return list[i];
      }
      return null;
    }
    for (var j = list.length - 1; j >= 0; j--) {
      if (colStart(list[j]) < board.scrollLeft - 4) return list[j];
    }
    return null;
  }

  function updateNav() {
    var maxLeft = board.scrollWidth - board.clientWidth;
    prev.hidden = board.scrollLeft <= 4;
    next.hidden = board.scrollLeft >= maxLeft - 4;

    /* Name the destination on the forward button. A chevron on its own reads
       as decoration; the words are what tell someone the board keeps going. */
    var ahead = neighbour(1);
    var name = ahead ? colTitle(ahead) : '';
    nextLabel.textContent = name;
    next.classList.toggle('dock__nav--wide', !!name);
    next.setAttribute('aria-label', name ? 'Scroll to ' + name : 'Scroll to the next column');

    var back = neighbour(-1);
    prev.setAttribute('aria-label', back ? 'Scroll to ' + colTitle(back) : 'Scroll to the previous column');
  }

  function go(dir) {
    var col = neighbour(dir);
    if (col) board.scrollTo({ left: colStart(col), behavior: 'smooth' });
  }
  prev.addEventListener('click', function () { go(-1); });
  next.addEventListener('click', function () { go(1); });
  board.addEventListener('scroll', updateNav, { passive: true });
  window.addEventListener('resize', updateNav);

  /* ---------------------------------------------------------- mobile tabs */

  /* A phone shows one column at a time and nothing else, so the sideways run
     that works on a wide screen leaves a first-time visitor on the About
     essay with no sign a calendar exists. On narrow screens the same columns
     become tab panels: tap a window, scroll straight down. Nothing about the
     cards, the filter or the modal changes — only how you get between the
     four windows.

     The tabs are ordered windows-first with About last, which is not DOM
     order; About stays first in the markup because that is where it belongs
     on a wide screen and for anyone reading the page without CSS. */

  var tabsEl = document.getElementById('tabs');
  var aboutBtn = document.getElementById('about-btn');
  var activePanel = 'panel-today';

  /* Every panel that can be shown. About is one of them, but it is reached
     from the bar rather than the tab strip — it is not a time window, and
     sitting it beside Today read as though it were one. */
  function panels() {
    var wins = Array.prototype.slice.call(board.querySelectorAll('.col:not(.col--about)'));
    var about = board.querySelector('.col--about');
    return about ? wins.concat([about]) : wins;
  }
  function windowPanels() {
    return Array.prototype.slice.call(board.querySelectorAll('.col:not(.col--about)'));
  }
  function panelName(p) {
    if (p.classList.contains('col--about')) return 'About';
    if (p.dataset.tab) return p.dataset.tab;
    var t = p.querySelector('.col__title');
    return t ? t.textContent : '';
  }

  function selectPanel(id, moveFocus) {
    var list = panels();
    if (!list.some(function (p) { return p.id === id; })) {
      id = list.length ? list[0].id : null;
    }
    if (!id) return;
    activePanel = id;

    list.forEach(function (p) {
      p.classList.toggle('col--active', p.id === id);
    });
    Array.prototype.slice.call(tabsEl.children).forEach(function (b) {
      var on = b.getAttribute('aria-controls') === id;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      /* One stop for the whole strip, as a tablist should be. When About is
         showing nothing in the strip is selected, so the first tab takes the
         stop rather than leaving the strip unreachable by keyboard. */
      b.tabIndex = on ? 0 : -1;
      if (on && moveFocus) b.focus();
    });
    var onAbout = id === 'panel-about';
    aboutBtn.setAttribute('aria-pressed', onAbout ? 'true' : 'false');
    if (onAbout && tabsEl.firstChild) tabsEl.firstChild.tabIndex = 0;

    /* A panel switched into view keeps whatever scroll position it had from
       last time, which reads as broken. Start each one at the top. */
    var panel = document.getElementById(id);
    if (panel) panel.scrollTop = 0;
  }

  function buildTabs() {
    tabsEl.innerHTML = '';
    windowPanels().forEach(function (p) {
      var b = el('button', 'tab', panelName(p));
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', p.id);
      b.setAttribute('aria-selected', 'false');
      b.tabIndex = -1;
      b.addEventListener('click', function () { selectPanel(p.id); });
      tabsEl.appendChild(b);
    });
    selectPanel(activePanel);
  }

  aboutBtn.addEventListener('click', function () { selectPanel('panel-about'); });

  /* Left and right walk the strip, as a tablist is expected to. */
  tabsEl.addEventListener('keydown', function (e) {
    var dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    var tabs = Array.prototype.slice.call(tabsEl.children);
    var at = tabs.findIndex(function (b) { return b.getAttribute('aria-selected') === 'true'; });
    var to = tabs[(at + dir + tabs.length) % tabs.length];
    if (to) { e.preventDefault(); selectPanel(to.getAttribute('aria-controls'), true); }
  });

  /* The sidebar hero is a photograph if one has been added, and the drawn
     streetcar until then — so the page never shows a broken image. */
  (function heroFallback() {
    var hero = document.getElementById('hero');
    var fallback = document.getElementById('hero-fallback');
    if (!hero || !fallback) return;

    function showDrawnOne() {
      hero.hidden = true;
      /* `hidden` is an HTMLElement property — on an SVG element assigning it
         creates a useless expando and the attribute stays put. Toggle the
         attribute instead. */
      fallback.removeAttribute('hidden');
    }

    /* A missing file fails before this script runs, so the listener alone
       never fires. Check the outcome as well as listening for it. */
    if (hero.complete && hero.naturalWidth === 0) showDrawnOne();
    hero.addEventListener('error', showDrawnOne);
  }());

  /* ---------------------------------------------------------------- boot */

  render();

  if (location.hash.length > 1) openModal(decodeURIComponent(location.hash.slice(1)), null);
})();
