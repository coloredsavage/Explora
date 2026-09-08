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

  var WINDOWS = [
    { id: 'today', title: 'Today',      from: TODAY,             to: TODAY,
      range: fmtLongDate(TODAY), hideWhen: true },
    { id: 'week',  title: 'This week',  from: addDays(TODAY, 1), to: endOfWeek(TODAY) },
    { id: 'month', title: 'This month', from: TODAY,             to: endOfMonth(TODAY) },
    { id: 'year',  title: 'This year',  from: TODAY,             to: YEAR_END }
  ];
  WINDOWS.forEach(function (w) {
    if (!w.range) w.range = fmtSpan(w.from, w.to);
  });

  /* every occurrence we could ever show, computed once */
  var ALL = [];
  EVENTS.forEach(function (ev) {
    ALL = ALL.concat(expand(ev, TODAY, YEAR_END));
  });

  function inWindow(o, w) { return cmp(o.end, w.from) >= 0 && cmp(o.start, w.to) <= 0; }

  /* ------------------------------------------------------------- filters */

  var STORE_KEY = 'wswdt.categories';
  var active = {};
  Object.keys(CATEGORIES).forEach(function (k) { active[k] = true; });

  try {
    var saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved) Object.keys(active).forEach(function (k) {
      if (typeof saved[k] === 'boolean') active[k] = saved[k];
    });
  } catch (e) { /* private mode, or nothing stored */ }

  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(active)); } catch (e) {}
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

  function cardFor(occ, win) {
    var ev = occ.event;
    var btn = el('button', 'card card--' + ev.category);
    btn.type = 'button';
    btn.dataset.event = ev.id;
    btn.dataset.start = occ.start.toISOString();

    btn.appendChild(el('h3', 'card__title', ev.title));

    /* the visible dates are clipped to this column's window */
    var from = max(occ.start, win.from);
    var to = min(occ.end, win.to);
    var when;

    if (win.hideWhen) {
      when = occ.time || null;                  /* today's column: time only */
    } else if (sameDay(from, to)) {
      when = fmtDay(from) + (occ.time ? ' · ' + occ.time : '');
    } else {
      when = fmtSpan(from, to);
    }
    if (when) btn.appendChild(el('p', 'card__when', when));

    if (!seenArt[ev.id]) {
      seenArt[ev.id] = true;
      var node = artFor(ev);
      node.setAttribute('class', 'card__art');
      btn.appendChild(node);
    }
    return btn;
  }

  function render() {
    seenArt = {};
    Array.prototype.slice.call(board.querySelectorAll('.col:not(.col--about)'))
      .forEach(function (n) { n.remove(); });

    var todayCount = 0;

    WINDOWS.forEach(function (win) {
      var col = el('section', 'col');
      col.setAttribute('aria-labelledby', 'head-' + win.id);

      var head = el('header', 'col__head');
      var title = el('h2', 'col__title', win.title);
      title.id = 'head-' + win.id;
      head.appendChild(title);
      head.appendChild(el('span', 'col__range', win.range));
      col.appendChild(head);

      var body = el('div', 'col__body');
      var list = ALL.filter(function (o) {
        return active[o.event.category] && inWindow(o, win);
      }).sort(function (a, b) {
        return cmp(max(a.start, win.from), max(b.start, win.from)) ||
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
  }

  /* --------------------------------------------------------------- modal */

  var scrim = document.getElementById('scrim');
  var modal = document.getElementById('modal');
  var mClose = document.getElementById('modal-close');
  var lastFocus = null;

  function openModal(eventId, startISO) {
    var ev = null, i;
    for (i = 0; i < EVENTS.length; i++) if (EVENTS[i].id === eventId) { ev = EVENTS[i]; break; }
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
    Object.keys(CATEGORIES).forEach(function (key) {
      var row = el('label', 'filter-row');
      row.style.setProperty('--soft', 'var(--s-' + key + ')');

      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = pending[key];
      box.addEventListener('change', function () { pending[key] = box.checked; });

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
      row.appendChild(el('span', 'filter-row__label', CATEGORIES[key].label));
      row.appendChild(tick);
      fRows.appendChild(row);
    });
  }

  function openFilter() {
    pending = {};
    Object.keys(active).forEach(function (k) { pending[k] = active[k]; });
    buildFilter();
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
    Object.keys(pending).forEach(function (k) { pending[k] = true; });
    buildFilter();
  });

  document.getElementById('filter-apply').addEventListener('click', function () {
    /* an empty filter shows nothing at all, so treat it as "everything" */
    var any = Object.keys(pending).some(function (k) { return pending[k]; });
    Object.keys(active).forEach(function (k) { active[k] = any ? pending[k] : true; });
    persist();
    render();
    closeFilter();
  });

  /* ----------------------------------------------------------- dock nav */

  var prev = document.getElementById('nav-prev');
  var next = document.getElementById('nav-next');

  function step() {
    var col = board.querySelector('.col:not(.col--about)');
    return col ? col.getBoundingClientRect().width : 360;
  }
  function updateNav() {
    var maxLeft = board.scrollWidth - board.clientWidth;
    prev.hidden = board.scrollLeft <= 4;
    next.hidden = board.scrollLeft >= maxLeft - 4;
  }

  prev.addEventListener('click', function () { board.scrollBy({ left: -step(), behavior: 'smooth' }); });
  next.addEventListener('click', function () { board.scrollBy({ left: step(), behavior: 'smooth' }); });
  board.addEventListener('scroll', updateNav, { passive: true });
  window.addEventListener('resize', updateNav);

  /* ---------------------------------------------------------------- boot */

  render();

  if (location.hash.length > 1) openModal(decodeURIComponent(location.hash.slice(1)), null);
})();
