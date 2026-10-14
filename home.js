/* ══════════════════════════════════════════════════
   IT Study Hub — home.js  (homepage only)

   1. Hero: a binary search tree drifting in 3D, with values being inserted along its edges.
   2. Run: bubble sort, one step per bit of scrolling. Buttons and arrow keys work too.
   3. Roadmap: pick a language, see all 12 modules (titles are embedded in the page at build time).
   4. Mini quiz: three questions, answered and scored in the browser.

   No libraries. Everything degrades: without JavaScript the sections still read as text;
   with prefers-reduced-motion the canvas is drawn once and nothing animates by itself.
══════════════════════════════════════════════════ */
(function () {
  'use strict';

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };

  /* ───────────────────────── 1. HERO CANVAS ───────────────────────── */
  function initHero() {
    var cv = $('#heroCanvas');
    if (!cv || !cv.getContext) return;
    var ctx = cv.getContext('2d');
    if (!ctx) return;

    var W = 0, H = 0, dpr = 1, narrow = false;
    var mouse = { x: 0.5, y: 0.5, sx: 0.5, sy: 0.5 };

    // A perfect binary search tree with 31 nodes (values 1..31, in-order), each with a fixed depth offset.
    var nodes = [];
    (function build() {
      var depth = 5, counter = 0;
      function rec(lo, hi, d, lane, id, parent) {
        if (lo > hi) return;
        var mid = (lo + hi) >> 1;
        var node = { v: mid, d: d, id: id, parent: parent, x: 0, y: 0, z: 0, lit: 0, kids: [] };
        // lane in [-1, 1]: left-to-right position of the node among all nodes of its level
        node.x = lane; node.y = d / (depth - 1) * 2 - 1;
        node.z = (Math.sin(mid * 12.9898) * 43758.5453 % 1) * 0.9;   // stable pseudo-random depth
        nodes.push(node);
        var idx = nodes.length - 1;
        if (parent >= 0) nodes[parent].kids.push(idx);
        var span = 1 / Math.pow(2, d + 1);
        rec(lo, mid - 1, d + 1, lane - span, id * 2, idx);
        rec(mid + 1, hi, d + 1, lane + span, id * 2 + 1, idx);
        counter++;
      }
      rec(1, 31, 0, 0, 1, -1);
    })();

    var dust = [];
    for (var i = 0; i < 70; i++) dust.push({ x: Math.random(), y: Math.random(), z: Math.random(), s: 0.4 + Math.random() * 1.4 });

    var pulses = [];
    function spawnPulse() {
      // a value is "inserted": the pulse runs from the root down to a random leaf
      var path = [0], cur = 0;
      while (nodes[cur].kids.length) { cur = nodes[cur].kids[(Math.random() * nodes[cur].kids.length) | 0]; path.push(cur); }
      pulses.push({ path: path, t: 0 });
    }
    spawnPulse();

    function resize() {
      var r = cv.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.max(1, r.width); H = Math.max(1, r.height);
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      narrow = W < 820;
      if (reduce) draw(0);
    }

    function project(n, ang, tilt, cx, cy, R) {
      var x = n.x * 1.15, y = n.y, z = n.z;
      var xr = x * Math.cos(ang) + z * Math.sin(ang);
      var zr = -x * Math.sin(ang) + z * Math.cos(ang);
      var yr = y * Math.cos(tilt) - zr * Math.sin(tilt);
      var zz = y * Math.sin(tilt) + zr * Math.cos(tilt);
      var s = 1 / (1.6 - zz * 0.5);
      return { x: cx + xr * R * s * 1.25, y: cy + yr * R * 0.8 * s, s: s, z: zz };
    }

    var last = 0, time = 0;
    function draw(dt) {
      time += dt;
      mouse.sx += (mouse.x - mouse.sx) * 0.05; mouse.sy += (mouse.y - mouse.sy) * 0.05;
      ctx.clearRect(0, 0, W, H);

      var cx = narrow ? W * 0.5 : W * 0.7, cy = narrow ? H * 0.36 : H * 0.48;
      var R = Math.min(W, H) * (narrow ? 0.5 : 0.52);
      var ang = time * 0.00012 + (mouse.sx - 0.5) * 0.9;
      var tilt = (mouse.sy - 0.5) * 0.35 + 0.12;
      var alphaK = narrow ? 0.55 : 1;

      // drifting dust (parallax with the mouse)
      for (var d = 0; d < dust.length; d++) {
        var p = dust[d];
        var px = ((p.x + time * 0.000004 * (0.4 + p.z) - (mouse.sx - 0.5) * 0.03 * p.z) % 1 + 1) % 1 * W;
        var py = ((p.y - time * 0.000006 * (0.4 + p.z)) % 1 + 1) % 1 * H;
        ctx.fillStyle = 'rgba(200,241,53,' + (0.08 + p.z * 0.25) * alphaK + ')';
        ctx.fillRect(px, py, p.s, p.s);
      }

      var pr = nodes.map(function (n) { return project(n, ang, tilt, cx, cy, R); });

      // edges
      ctx.lineWidth = 1;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        for (var k = 0; k < n.kids.length; k++) {
          var c = n.kids[k], a = pr[i], b = pr[c];
          var al = (0.1 + (a.s + b.s) * 0.12 + Math.max(n.lit, nodes[c].lit) * 0.5) * alphaK;
          ctx.strokeStyle = 'rgba(200,241,53,' + al.toFixed(3) + ')';
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }

      // pulses (values travelling down the tree)
      for (var q = pulses.length - 1; q >= 0; q--) {
        var pu = pulses[q];
        pu.t += dt * 0.0011;
        var seg = Math.floor(pu.t), f = pu.t - seg;
        if (seg >= pu.path.length - 1) { nodes[pu.path[pu.path.length - 1]].lit = 1; pulses.splice(q, 1); continue; }
        var A = pr[pu.path[seg]], B = pr[pu.path[seg + 1]];
        nodes[pu.path[seg]].lit = Math.max(nodes[pu.path[seg]].lit, 1);
        var gx = A.x + (B.x - A.x) * f, gy = A.y + (B.y - A.y) * f;
        ctx.save(); ctx.shadowColor = '#c8f135'; ctx.shadowBlur = 18; ctx.fillStyle = '#e9ff9a';
        ctx.beginPath(); ctx.arc(gx, gy, 3, 0, 6.2832); ctx.fill(); ctx.restore();
      }
      if (!reduce && pulses.length < 2 && Math.random() < 0.012) spawnPulse();

      // nodes, back to front
      var order = nodes.map(function (_, i) { return i; }).sort(function (a, b) { return pr[a].z - pr[b].z; });
      for (var o = 0; o < order.length; o++) {
        var ni = order[o], nd = nodes[ni], P = pr[ni];
        nd.lit = Math.max(0, nd.lit - dt * 0.0006);
        var size = (7 + P.s * 7) * (narrow ? 0.8 : 1);
        var base = (0.16 + P.s * 0.3) * alphaK;
        ctx.save();
        if (nd.lit > 0.05) { ctx.shadowColor = '#c8f135'; ctx.shadowBlur = 22 * nd.lit; }
        ctx.fillStyle = nd.lit > 0.05 ? 'rgba(200,241,53,' + Math.min(1, 0.35 + nd.lit * 0.65) + ')' : 'rgba(10,14,6,0.85)';
        ctx.strokeStyle = 'rgba(200,241,53,' + Math.min(1, base + nd.lit) + ')';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(P.x - size / 2, P.y - size / 2, size, size, 2); else ctx.rect(P.x - size / 2, P.y - size / 2, size, size);
        ctx.fill(); ctx.stroke(); ctx.restore();
        if (P.s > 0.78 && !narrow) {
          ctx.fillStyle = 'rgba(240,240,248,' + (0.25 + P.s * 0.25).toFixed(2) + ')';
          ctx.font = '10px "JetBrains Mono", monospace'; ctx.textAlign = 'center';
          ctx.fillText(String(nd.v), P.x, P.y + size / 2 + 13);
        }
      }
    }

    var visible = true, running = false;
    function loop(ts) {
      if (!running) return;
      var dt = Math.min(48, ts - (last || ts)); last = ts;
      draw(dt);
      requestAnimationFrame(loop);
    }
    function start() { if (reduce || running || !visible || document.hidden) return; running = true; last = 0; requestAnimationFrame(loop); }
    function stop() { running = false; }

    window.addEventListener('resize', resize);
    resize();
    if (reduce) { draw(0); return; }
    window.addEventListener('pointermove', function (e) { mouse.x = e.clientX / window.innerWidth; mouse.y = e.clientY / window.innerHeight; }, { passive: true });
    if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { visible = es[0].isIntersecting; visible ? start() : stop(); }).observe(cv);
    document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });
    start();
  }

  /* ───────────────────────── 2. RUN: bubble sort driven by scroll ───────────────────────── */
  var RUN_VALUES = [6, 3, 8, 2, 9, 4, 7, 1];

  function makeSteps(values) {
    var a = values.slice(), n = a.length, steps = [], comps = 0, swaps = 0, sorted = [];
    function push(o) {
      o.arr = a.slice(); o.comps = comps; o.swaps = swaps; o.sorted = sorted.slice();
      steps.push(o);
    }
    push({ line: 1, i: null, j: null, cmp: null, text: 'Start with ' + n + ' numbers. Bubble sort will order them smallest to largest.' });
    for (var i = 0; i < n - 1; i++) {
      push({ line: 2, i: i, j: null, cmp: null, text: 'Pass ' + (i + 1) + ': carry the largest number that is still unsorted to the right.' });
      for (var j = 0; j < n - 1 - i; j++) {
        comps++;
        var bigger = a[j] > a[j + 1];
        push({ line: 4, i: i, j: j, cmp: [j, j + 1], test: bigger,
          text: 'Compare ' + a[j] + ' and ' + a[j + 1] + (bigger ? ': ' + a[j] + ' is bigger, so they are in the wrong order.' : ': already in order, leave them.') });
        if (bigger) {
          var t = a[j]; a[j] = a[j + 1]; a[j + 1] = t; swaps++;
          push({ line: 5, i: i, j: j, cmp: [j, j + 1], swapped: true, test: true, text: 'Swap them. ' + a[j + 1] + ' moves one place to the right.' });
        }
      }
      sorted.push(n - 1 - i);
    }
    sorted.push(0);
    push({ line: 6, i: null, j: null, cmp: null, done: true, text: 'Sorted: ' + comps + ' comparisons and ' + swaps + ' swaps. Every pass fixed one more number in place.' });
    return steps;
  }
  window.ishRunSteps = makeSteps;   // used by the tests

  function initRun() {
    var section = $('#run');
    if (!section) return;
    var steps = makeSteps(RUN_VALUES), N = steps.length;
    var stage = $('.run-stage', section), bars = $('.bars', section), lines = $$('.code-line', section);
    var caption = $('.run-caption', section), count = $('.run-count', section), fill = $('.run-progress-fill', section), end = $('.run-end', section);
    var out = { i: $('[data-v="i"]', section), j: $('[data-v="j"]', section), c: $('[data-v="comps"]', section), s: $('[data-v="swaps"]', section), t: $('[data-v="test"]', section) };
    var STEP_PX = 56;

    // bars
    var max = Math.max.apply(null, RUN_VALUES), els = {};
    RUN_VALUES.forEach(function (v) {
      var b = document.createElement('div'); b.className = 'bar';
      b.style.setProperty('--h', (v / max).toFixed(3));
      b.innerHTML = '<span class="bar-fill"></span><span class="bar-num">' + v + '</span>';
      bars.appendChild(b); els[v] = b;
    });
    var ptrJ = document.createElement('span'); ptrJ.className = 'ptr'; ptrJ.textContent = 'j';
    var ptrK = document.createElement('span'); ptrK.className = 'ptr'; ptrK.textContent = 'j+1';
    bars.appendChild(ptrJ); bars.appendChild(ptrK);

    var current = -1;
    function render(k) {
      k = clamp(k, 0, N - 1);
      if (k === current) return;
      current = k;
      var s = steps[k], n = RUN_VALUES.length;
      s.arr.forEach(function (v, pos) {
        var e = els[v];
        e.style.setProperty('--pos', pos);
        e.classList.toggle('is-cmp', !!(s.cmp && (pos === s.cmp[0] || pos === s.cmp[1])));
        e.classList.toggle('is-swap', !!(s.swapped && s.cmp && (pos === s.cmp[0] || pos === s.cmp[1])));
        e.classList.toggle('is-sorted', s.sorted.indexOf(pos) !== -1);
      });
      if (s.cmp) { ptrJ.style.setProperty('--pos', s.cmp[0]); ptrK.style.setProperty('--pos', s.cmp[1]); }
      ptrJ.classList.toggle('on', !!s.cmp); ptrK.classList.toggle('on', !!s.cmp);
      lines.forEach(function (l, i) { l.classList.toggle('on', i === s.line); });
      caption.textContent = s.text;
      count.textContent = 'Step ' + (k + 1) + ' of ' + N;
      fill.style.transform = 'scaleX(' + (k / (N - 1)).toFixed(4) + ')';
      out.i.textContent = s.i === null ? '-' : s.i; out.j.textContent = s.j === null ? '-' : s.j;
      out.c.textContent = s.comps; out.s.textContent = s.swaps;
      out.t.textContent = s.cmp ? (s.test ? 'True' : 'False') : '-';
      section.classList.toggle('is-done', !!s.done);
      end.hidden = !s.done;
    }

    // scroll -> step
    var ticking = false;
    function fromScroll() {
      ticking = false;
      var top = section.getBoundingClientRect().top + window.scrollY;
      var range = section.offsetHeight - window.innerHeight;
      var p = clamp((window.scrollY - top) / Math.max(1, range), 0, 1);
      render(Math.round(p * (N - 1)));
    }
    function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(fromScroll); } }
    function sectionTop() { return section.getBoundingClientRect().top + window.scrollY; }
    function go(k) {
      k = clamp(k, 0, N - 1);
      var range = section.offsetHeight - window.innerHeight;
      window.scrollTo({ top: sectionTop() + (k / (N - 1)) * range, behavior: 'auto' });
      render(k);
    }

    section.style.setProperty('--steps', N);
    section.style.height = 'calc(100vh + ' + (N * STEP_PX) + 'px)';
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    $('[data-run="prev"]', section).addEventListener('click', function () { go(current - 1); });
    $('[data-run="next"]', section).addEventListener('click', function () { go(current + 1); });
    $('[data-run="reset"]', section).addEventListener('click', function () { go(0); });
    $('[data-run="skip"]', section).addEventListener('click', function () {
      var after = section.nextElementSibling;
      if (after) window.scrollTo({ top: after.getBoundingClientRect().top + window.scrollY, behavior: reduce ? 'auto' : 'smooth' });
    });
    var play = $('[data-run="play"]', section), timer = 0;
    function stopPlay() { clearInterval(timer); timer = 0; play.textContent = 'Play'; play.setAttribute('aria-pressed', 'false'); }
    play.addEventListener('click', function () {
      if (timer) { stopPlay(); return; }
      if (current >= N - 1) go(0);
      play.textContent = 'Pause'; play.setAttribute('aria-pressed', 'true');
      timer = setInterval(function () { if (current >= N - 1) { stopPlay(); return; } go(current + 1); }, 650);
    });
    stage.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); go(current + 1); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); go(current - 1); }
    });
    window.addEventListener('wheel', function () { if (timer) stopPlay(); }, { passive: true });
    render(0); fromScroll();
  }

  /* ───────────────────────── 3. ROADMAP ───────────────────────── */
  function initRoadmap() {
    var dataEl = $('#roadmap-data'), root = $('#roadmap');
    if (!dataEl || !root) return;
    var data = JSON.parse(dataEl.textContent);
    var tabs = $$('[role="tab"]', root), list = $('.road', root), title = $('.road-title', root), open = $('.road-open', root);

    function show(key, focus) {
      var c = data[key]; if (!c) return;
      tabs.forEach(function (t) { var on = t.getAttribute('data-course') === key; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); });
      title.textContent = c.name;
      open.textContent = 'Open the ' + c.name + ' course';
      open.setAttribute('href', c.href);
      list.innerHTML = '';
      c.modules.forEach(function (m, i) {
        var li = document.createElement('li');
        li.className = 'road-item' + (m.free ? '' : ' is-paid');
        li.style.setProperty('--d', (reduce ? 0 : i * 45) + 'ms');
        li.innerHTML = '<span class="road-node" aria-hidden="true"></span>' +
          '<span class="road-num">' + (i + 1) + '</span>' +
          '<span class="road-name"></span>' +
          '<span class="road-meta"><span class="road-level">' + m.level + '</span>' + (m.free ? '' : '<span class="road-lock">Paid plan</span>') + '</span>';
        $('.road-name', li).textContent = m.title;
        list.appendChild(li);
      });
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { show(t.getAttribute('data-course')); });
      t.addEventListener('keydown', function (e) {
        var d = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : (e.key === 'ArrowUp' || e.key === 'ArrowLeft') ? -1 : 0;
        if (!d) return; e.preventDefault();
        var n = tabs[(i + d + tabs.length) % tabs.length]; show(n.getAttribute('data-course'), true);
      });
      // hovering also previews, so the roadmap feels alive
      t.addEventListener('mouseenter', function () { if (window.matchMedia('(hover: hover)').matches) show(t.getAttribute('data-course')); });
    });
    show(tabs[0].getAttribute('data-course'));
  }

  /* ───────────────────────── 4. MINI QUIZ ───────────────────────── */
  var QUIZ = [
    { q: 'What does this print?', code: 'print(5 + 3 * 2)', opts: ['16', '11', '13', '10'], a: 1, why: 'Multiplication happens before addition: 3 * 2 = 6, then 5 + 6 = 11.' },
    { q: 'Which data structure removes items in first-in, first-out order?', code: '', opts: ['Stack', 'Tree', 'Queue', 'Hash table'], a: 2, why: 'A queue serves items in the order they arrived, like a line at a counter.' },
    { q: 'Searching a sorted array with binary search takes how long?', code: '', opts: ['O(n)', 'O(log n)', 'O(n log n)', 'O(1)'], a: 1, why: 'Each step halves the part of the array you still need to look at.' }
  ];
  window.ishQuiz = QUIZ;

  function initQuiz() {
    var root = $('#miniquiz');
    if (!root) return;
    var body = $('.mq-body', root), dots = $$('.mq-dot', root), n = 0, score = 0;

    function question() {
      var q = QUIZ[n];
      dots.forEach(function (d, i) { d.classList.toggle('on', i === n); d.classList.toggle('done', i < n); });
      body.innerHTML = '<p class="mq-q"></p>' + (q.code ? '<pre class="mq-code"><code></code></pre>' : '') + '<div class="mq-opts" role="group" aria-label="Answers"></div><p class="mq-why" role="status"></p>';
      $('.mq-q', body).textContent = q.q;
      if (q.code) $('code', body).textContent = q.code;
      var wrap = $('.mq-opts', body);
      q.opts.forEach(function (o, i) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'mq-opt';
        b.innerHTML = '<span class="mq-letter">' + 'ABCD'[i] + '</span><span class="mq-text"></span>';
        $('.mq-text', b).textContent = o;
        b.addEventListener('click', function () { answer(i); });
        wrap.appendChild(b);
      });
    }
    function answer(i) {
      var q = QUIZ[n], btns = $$('.mq-opt', body);
      if (btns[0].disabled) return;
      btns.forEach(function (b, k) { b.disabled = true; if (k === q.a) b.classList.add('right'); else if (k === i) b.classList.add('wrong'); });
      if (i === q.a) score++;
      $('.mq-why', body).textContent = (i === q.a ? 'Correct. ' : 'Not quite. ') + q.why;
      var next = document.createElement('button'); next.type = 'button'; next.className = 'btn btn-lime mq-next';
      next.textContent = n === QUIZ.length - 1 ? 'See my result' : 'Next question';
      next.addEventListener('click', function () { n++; n < QUIZ.length ? question() : result(); });
      body.appendChild(next); next.focus();
    }
    function result() {
      dots.forEach(function (d) { d.classList.remove('on'); d.classList.add('done'); });
      body.innerHTML = '<p class="mq-score"><span>' + score + '</span> of ' + QUIZ.length + '</p>' +
        '<p class="mq-result">' + (score === QUIZ.length ? 'Clean sweep.' : score >= 2 ? 'Good start.' : 'Plenty to learn, which is why you are here.') +
        ' The full skill quiz has 25 questions per subject and suggests where to begin.</p>' +
        '<div class="mq-actions"><a class="btn btn-lime" href="quiz.html">Take the full skill quiz</a><button type="button" class="btn btn-ghost mq-again">Try again</button></div>';
      $('.mq-again', body).addEventListener('click', function () { n = 0; score = 0; question(); });
    }
    question();
  }

  function boot() { initHero(); initRun(); initRoadmap(); initQuiz(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
