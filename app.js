/* GuitarSolo Web 1.0.0 */
(function () {
  'use strict';

  var SF2 = 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.9.0/dist/soundfont/sonivox.sf2';
  var SF3 = 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.9.0/dist/soundfont/sonivox.sf3';

  var $ = function (id) { return document.getElementById(id); };
  var api = null, curScore = null, curName = '', curFileId = null;
  var playing = false, lastTick = 0, scoreBpm0 = 0;
  var aTick = -1, bTick = -1, loopOn = false, loopBarLabel = [];
  var zoomPct = 100, layoutMode = 'page';
  var db = null, files = [];

  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('on'); }, ms || 2200);
  }
  function lsGet(k, d) { try { var v = localStorage.getItem('gsweb_' + k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem('gsweb_' + k, v); } catch (e) {} }
  function fmtTick(ms) {
    ms = Math.max(0, ms || 0);
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    return m + ':' + ('0' + (s % 60)).slice(-2);
  }

  var DBNAME = 'gs_web_v2';
  function openDB() {
    return new Promise(function (res, rej) {
      var settled = false;
      var timer = setTimeout(function () { if (!settled) { settled = true; rej(new Error('idb timeout')); } }, 4000);
      var r = indexedDB.open(DBNAME, 1);
      r.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
      };
      r.onsuccess = function (e) { if (!settled) { settled = true; clearTimeout(timer); res(e.target.result); } };
      r.onerror = function () { if (!settled) { settled = true; clearTimeout(timer); rej(r.error || new Error('idb error')); } };
      r.onblocked = function () { if (!settled) { settled = true; clearTimeout(timer); rej(new Error('idb blocked')); } };
    });
  }
  function dbAll() {
    return new Promise(function (res) {
      if (!db) return res([]);
      var tx = db.transaction('files', 'readonly'), st = tx.objectStore('files'), out = [];
      st.openCursor().onsuccess = function (e) {
        var c = e.target.result;
        if (c) { out.push(c.value); c.continue(); } else res(out);
      };
    });
  }
  function dbPut(rec) {
    return new Promise(function (res, rej) {
      if (!db) return rej(new Error('no db'));
      var tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(rec);
      tx.oncomplete = function () { res(rec); };
      tx.onerror = function () { rej(tx.error); };
    });
  }
  function dbDel(id) {
    return new Promise(function (res) {
      var tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').delete(id);
      tx.oncomplete = function () { res(); };
    });
  }
  function dbClear() {
    return new Promise(function (res) {
      var tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').clear();
      tx.oncomplete = function () { res(); };
    });
  }

  function renderLib() {
    var q = ($('libSearch').value || '').trim().toLowerCase();
    var list = $('libList'); list.innerHTML = '';
    var shown = files.filter(function (f) { return !q || f.name.toLowerCase().indexOf(q) >= 0; })
                     .sort(function (a, b) { return b.added - a.added; });
    if (!shown.length) {
      list.innerHTML = '<div class="empty">' + (files.length
        ? '没有匹配的谱'
        : '谱库是空的<br>点「导入」，从「文件」App 里多选 .gp3 / .gp4 / .gp5 / .gpx') + '</div>';
      return;
    }
    shown.forEach(function (f) {
      var spd = parseFloat(lsGet('spd:' + f.name, '0')) || 0;
      var it = document.createElement('div');
      it.className = 'item' + (f.id === curFileId ? ' on' : '');
      it.innerHTML = '<div class="t">' + esc(f.name) + '</div>' +
        '<div class="m"><span>' + kb(f.size) + '</span>' +
        (spd && spd !== 1 ? '<span style="color:var(--gold)">练习 ' + spd.toFixed(2) + '×</span>' : '') +
        (f.bars ? '<span>' + f.bars + ' 小节</span>' : '') +
        '<span>' + dateStr(f.added) + '</span></div>' +
        '<div class="acts"><button class="gold">打开</button><button>删</button></div>';
      it.querySelector('.gold').onclick = function () { openFile(f); };
      it.querySelector('.acts button:not(.gold)').onclick = function (e) {
        e.stopPropagation();
        if (!confirm('从谱库删除「' + f.name + '」？')) return;
        dbDel(f.id).then(function () {
          files = files.filter(function (x) { return x.id !== f.id; });
          if (curFileId === f.id) { curFileId = null; curScore = null; curName = ''; $('stFile').textContent = '未加载谱文件'; }
          renderLib(); toast('已删除');
        });
      };
      it.querySelector('.t').onclick = function () { openFile(f); };
      list.appendChild(it);
    });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function kb(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'; }
  function dateStr(t) { var d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate(); }

  function openFile(f) {
    curFileId = f.id; curName = f.name;
    $('stFile').textContent = f.name;
    renderLib();
    $('hint').style.display = 'none';
    $('loadMask').style.display = 'flex';
    setSide(false);
    var buf = f.data;
    if (buf instanceof Blob) { var fr = new FileReader(); fr.onload = function () { doLoad(fr.result); }; fr.readAsArrayBuffer(buf); }
    else doLoad(buf);
  }
  function doLoad(data) {
    if (api) { try { api.destroy(); } catch (e) {} api = null; }
    $('tabView').innerHTML = '';
    initApi();
    try {
      api.load(data);
    } catch (e) {
      $('loadMask').style.display = 'none';
      toast('解析失败：' + (e && e.message ? e.message : e), 3500);
    }
  }

  function staveProfileOf(v) { return v === '3' ? 3 : (v === '2' ? 2 : 1); }
  function layoutOf(v) { return v === 'h' ? 1 : 0; }

  function initApi() {
    var sfUrl = lsGet('sf:url', '') || (lsGet('sf', 'sf2') === 'sf3' ? SF3 : SF2);
    var pm = alphaTab.PlayerMode;
    var playerMode = (pm && pm.Html5 !== undefined) ? pm.Html5 : 1;
    var settings = {
      core: {
        engine: 'html5',
        fontDirectory: 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.9.0/dist/font/',
        logLevel: 'warning'
      },
      player: {
        playerMode: playerMode,
        enablePlayer: true,
        enableCursor: true,
        enableUserInteraction: true,
        enableAnimatedBeatCursor: true,
        enableElementHighlighting: true,
        enableSeekToClick: true,
        scrollElement: $('scoreScroll'),
        scrollMode: 'off',
        soundFont: sfUrl,
        nativeBrowserSmoothScroll: true
      },
      display: {
        staveProfile: staveProfileOf(lsGet('stave', '1')),
        layoutMode: layoutOf(layoutMode),
        scale: zoomPct / 100,
        rhythmMode: 2,
        resources: {
          mainGlyphColor: '#20242b',
          secondaryGlyphColor: '#5e6b7c',
          staffLineColor: '#9aa4b2',
          barSeparatorColor: '#7d8796'
        }
      }
    };
    api = new alphaTab.AlphaTabApi($('tabView'), settings);

    api.renderFinished.on(function () {
      $('loadMask').style.display = 'none';
      $('hint').style.display = 'none';
      updateZoomLabel();
      setTimeout(function () { autoFitOnce(); }, 180);
    });
    api.scoreLoaded.on(function (score) {
      curScore = score;
      var bars = (score.masterBars && score.masterBars.length) || 0;
      scoreBpm0 = (score.tempo) || 120;
      $('tempoBase').textContent = '原谱 ' + Math.round(scoreBpm0) + ' BPM';
      $('barFrom').value = 1;
      $('barTo').value = Math.min(bars || 4, 4);
      $('barTo').max = bars; $('barFrom').max = bars;
      if (curFileId) {
        var rec = files.filter(function (x) { return x.id === curFileId; })[0];
        if (rec && !rec.bars) { rec.bars = bars; dbPut(rec).catch(function () {}); }
      }
      var spd = parseFloat(lsGet('spd:' + curName, '0')) || parseFloat(lsGet('defspd', '0.7')) || 0.7;
      applySpeed(spd, true);
      clearLoopUI();
      afterLoadFreeze();
      setTimeout(kickRender, 260);
    });
    api.playerPositionChanged.on(function (e) {
      if (suppressPos > 0) { suppressPos--; if (e.currentTick > 0 && suppressPos === 0) { try { api.tickPosition = 0; } catch (x) {} } return; }
      lastTick = e.currentTick;
      var pct = e.endTime ? Math.min(100, (e.currentTime / e.endTime) * 100) : 0;
      $('progFill').style.width = pct + '%';
      $('progHead').style.display = 'block';
      $('progHead').style.left = 'calc(' + pct + '% - 1px)';
      $('timeBox').textContent = fmtTick(e.currentTime) + ' / ' + fmtTick(e.endTime);
      barIndicator(e.currentTick);
      if (loopOn && bTick >= 0 && e.currentTick >= bTick) seekTo(aTick >= 0 ? aTick : 0);
    });
    api.playerStateChanged.on(function (e) {
      playing = e.state === 1;
      $('btnPlay').textContent = playing ? '❚❚' : '▶';
      $('btnPlay').classList.toggle('play', !playing);
    });
    api.error.on(function (e) { toast('谱面错误：' + (e && e.message ? e.message : '未知'), 4000); });
    refreshSfLabel();
  }
  function afterLoadFreeze() { $('loadMask').style.display = 'none'; }

  function kickRender() {
    if (!api || !curScore) return;
    var want = lsGet('stave', '1');
    var sel = $('selStave');
    var alt = want === '2' ? '1' : '2';
    try { sel.value = alt; sel.dispatchEvent(new Event('change')); } catch (e) {}
    setTimeout(function () {
      try { sel.value = want; sel.dispatchEvent(new Event('change')); } catch (e) {}
      setTimeout(function () { autoFitOnce(); }, 260);
    }, 450);
  }

  function playPause() {
    if (!api || !curScore) { toast('先导入并打开一首谱'); return; }
    if (!api.player) { toast('播放器未就绪'); return; }
    try { api.playPause(); } catch (e) { toast('播放失败：' + e.message, 3000); }
  }
  var suppressPos = 0;
  function stopPlay() {
    if (!api) return;
    suppressPos = 2;
    try { api.stop(); } catch (e) {}
    try { api.tickPosition = 0; } catch (e) {}
    playing = false; $('btnPlay').textContent = '▶';
    $('progFill').style.width = '0%'; $('progHead').style.display = 'none';
    $('timeBox').textContent = '0:00 / ' + $('timeBox').textContent.split('/')[1];
    lastTick = 0;
  }
  function seekTo(tick) {
    if (!api || !curScore) return;
    try { api.tickPosition = Math.max(0, tick || 0); } catch (e) {}
  }

  function applySpeed(v, silent) {
    v = Math.min(2, Math.max(0.3, v));
    $('speedRange').value = Math.round(v * 100);
    $('spdLabel').textContent = v.toFixed(2) + '×';
    if (api) { try { api.playbackSpeed = v; } catch (e) {} }
    setTargetBpmText(v);
    if (curName) lsSet('spd:' + curName, v);
    if (!silent && curFileId) renderLib();
  }
  function setTargetBpmText(v) {
    if (!scoreBpm0) { $('targetBpm').value = ''; return; }
    $('targetBpm').value = Math.round(scoreBpm0 * v);
  }

  function tickOfBar(n) {
    if (!curScore || !curScore.masterBars) return 0;
    var bars = curScore.masterBars;
    n = Math.min(Math.max(1, n), bars.length);
    var st = bars[n - 1].start;
    return st || 0;
  }
  function barOfTick(tick) {
    if (!curScore || !curScore.masterBars) return 0;
    var bars = curScore.masterBars, r = 1;
    for (var i = 0; i < bars.length; i++) {
      var st = bars[i].start || 0;
      if (st <= tick) r = i + 1; else break;
    }
    return r;
  }
  function barIndicator(tick) {
    var n = barOfTick(tick);
    $('stPos').textContent = '小节 ' + n + ' · ' + zoomPct + '%';
    if (bTick >= 0) {
      var a = aTick >= 0 ? aTick : 0;
      var w = Math.max(0, ((bTick - a) / Math.max(1, lastEndTick())) * 100);
      var l = (a / Math.max(1, lastEndTick())) * 100;
      var z = $('progZone');
      z.style.display = 'block';
      z.style.left = l + '%'; z.style.width = w + '%';
    }
  }
  function lastEndTick() {
    if (!curScore || !curScore.masterBars) return 1;
    var bars = curScore.masterBars;
    return Math.max(1, (bars[bars.length - 1].start || 0) + 1);
  }
  function setA() {
    if (!curScore) return;
    aTick = lastTick || 0;
    loopBarLabel[0] = barOfTick(aTick);
    $('btnA').classList.add('set');
    $('btnA').textContent = 'A ' + loopBarLabel[0];
    $('barFrom').value = loopBarLabel[0];
    toast('A 点：小节 ' + loopBarLabel[0]);
    if (bTick > aTick) applyLoop();
  }
  function setB() {
    if (!curScore) return;
    bTick = lastTick || 0;
    loopBarLabel[1] = barOfTick(bTick);
    $('btnB').classList.add('set');
    $('btnB').textContent = 'B ' + loopBarLabel[1];
    $('barTo').value = loopBarLabel[1];
    toast('B 点：小节 ' + loopBarLabel[1]);
    if (aTick >= 0 && bTick > aTick) applyLoop();
  }
  function applyLoop() {
    if (!api) return;
    if (aTick < 0 || bTick <= aTick) { clearLoopUI(); return; }
    try { api.isLooping = true; } catch (e) {}
    try { api.playbackRange = { startTick: aTick, endTick: bTick }; } catch (e) {}
    loopOn = true;
    var bs = loopBarLabel[0] || barOfTick(aTick);
    var be = loopBarLabel[1] || Math.max(bs, barOfTick(bTick) - 1);
    $('loopState').textContent = '循环 小节 ' + bs + '–' + be;
    var l = lastEndTick();
    var z = $('progZone');
    z.style.display = 'block';
    z.style.left = (aTick / l) * 100 + '%';
    z.style.width = Math.max(0.4, ((bTick - aTick) / l) * 100) + '%';
  }
  function clearLoopUI() {
    loopOn = false; aTick = -1; bTick = -1; loopBarLabel = [];
    $('btnA').classList.remove('set'); $('btnB').classList.remove('set');
    $('btnA').textContent = 'A'; $('btnB').textContent = 'B';
    $('loopState').textContent = '';
    $('progZone').style.display = 'none';
    if (api) { try { api.isLooping = false; } catch (e) {} try { api.playbackRange = null; } catch (e) {} }
  }
  function loopBars() {
    if (!curScore) { toast('先打开一首谱'); return; }
    var f = parseInt($('barFrom').value, 10) || 1;
    var t = parseInt($('barTo').value, 10) || f;
    if (t < f) { var x = f; f = t; t = x; }
    aTick = tickOfBar(f);
    bTick = tickOfBar(t + 1);
    loopBarLabel = [f, t];
    $('btnA').classList.add('set'); $('btnB').classList.add('set');
    $('btnA').textContent = 'A ' + f; $('btnB').textContent = 'B ' + t;
    applyLoop();
    seekTo(aTick);
    toast('循环设定：小节 ' + f + '–' + t);
  }

  function updateZoomLabel() { $('zoomLabel').textContent = zoomPct + '%'; }
  function applyView() {
    if (!api) return;
    try {
      api.settings.display.scale = zoomPct / 100;
      api.settings.display.staveProfile = staveProfileOf(lsGet('stave', '1'));
      api.settings.display.layoutMode = layoutOf(layoutMode);
      api.settings.display.rhythmMode = 2;
      api.updateSettings();
      api.render();
    } catch (e) { toast('切换失败：' + e.message, 3000); }
  }
  function reZoom(d) {
    zoomPct = Math.min(220, Math.max(35, zoomPct + d));
    updateZoomLabel();
    if (!api) return;
    try { api.settings.display.scale = zoomPct / 100; api.updateSettings(); api.render(); } catch (e) {}
  }
  function autoFitOnce() {
    if (!curName || !api || !curScore) return;
    if (lsGet('fitted:' + curName, '') === '1') return;
    var vw = $('scoreScroll').clientWidth;
    var tw = $('tabView').scrollWidth;
    if (tw > vw + 6) { fitWidth(); }
    lsSet('fitted:' + curName, '1');
  }

  function fitWidth() {
    if (!api || !curScore) { toast('先打开一首谱'); return; }
    var vw = $('scoreScroll').clientWidth - 2;
    var tw = $('tabView').scrollWidth;
    if (!tw || tw < 50) { toast('谱面还没渲染好，稍后再点适宽'); return; }
    var base = (tw / (zoomPct / 100));
    var target = Math.floor((vw / base) * 100);
    target = Math.min(200, Math.max(20, target));
    zoomPct = target; updateZoomLabel();
    if (curName) lsSet('fitted:' + curName, '1');
    try { api.settings.display.scale = zoomPct / 100; api.updateSettings(); api.render(); } catch (e) {}
  }

  function sfUrlOf() {
    var v = lsGet('sf', 'sf2');
    if (v === 'sf3') return SF3;
    if (v === 'custom') return lsGet('sf:url', '') || SF2;
    return SF2;
  }
  function refreshSfLabel() {
    var u = sfUrlOf();
    $('sfNow').innerHTML = '当前音源：<br><span style="color:var(--gold2);word-break:break-all">' + esc(u) + '</span>' +
      '<br><br>音源文件就是 GM 音色库，越大音质越好。网页版受托管方式限制，只能从公开 CDN 取 Sonivox（1.35MB / 977KB），' +
      '达不到 PC 版那套 40MB MuseScore_General 的饱满度。想换更好的音源，填一个能跨域访问的 .sf2 地址即可。';
  }
  function switchSf() {
    var v = lsGet('sf', 'sf2');
    $('selSf').value = v;
    $('sfUrlRow').style.display = v === 'custom' ? 'flex' : 'none';
    $('sfUrl').value = lsGet('sf:url', '');
    refreshSfLabel();
  }
  function themeApply() {
    var mode = lsGet('theme', 'auto');
    var dark = mode === 'dark' || (mode === 'auto' && !window.matchMedia('(prefers-color-scheme: light)').matches);
    document.body.classList.toggle('light', !dark);
    themeLabel();
    if (api) {
      try {
        api.settings.display.resources.mainGlyphColor = dark ? '#20242b' : '#22262c';
        api.settings.display.resources.staffLineColor = dark ? '#9aa4b2' : '#8e98a6';
        api.updateSettings(); api.render();
      } catch (e) {}
    }
    window.removeEventListener('resize', themeLabel);
    window.addEventListener('resize', themeLabel);
  }

  function themeLabel() {
    var mode = lsGet('theme', 'auto');
    var narrow = window.innerWidth <= 600;
    $('btnTheme').textContent = narrow
      ? (mode === 'auto' ? '自动' : (mode === 'dark' ? '暗' : '亮'))
      : (mode === 'auto' ? '跟随系统' : (mode === 'dark' ? '暗色' : '亮色'));
  }

  function findUrl(src, q) {
    q = encodeURIComponent(q || '');
    if (src === 'gtpso') return 'https://www.gtpso.com/search?search=' + q;
    if (src === 'gprotab') return 'https://gprotab.net/';
    if (src === '911') return 'https://www.911tabs.com/';
    if (src === 'tan8') return 'https://www.tan8.com/';
    if (src === 'ug') return 'https://www.ultimate-guitar.com/';
    return 'https://www.gtpso.com/search?search=' + q;
  }

  function setSide(on) {
    var s = $('side'), m = $('sideMask');
    if (s) s.classList.toggle('open', !!on);
    if (m) m.classList.toggle('on', !!on);
  }
  function bind() {
    $('btnPlay').onclick = playPause;
    $('btnStop').onclick = stopPlay;
    $('btnImport').onclick = function () { $('fileInput').click(); };
    $('fileInput').onchange = function (e) {
      var picked = Array.from(e.target.files || []);
      e.target.value = '';
      if (!picked.length) return;
      var n = 0;
      picked.reduce(function (chain, f) {
        return chain.then(function () {
          var name = f.name.replace(/\.(gp[3-7]?x?|gtp)$/i, '');
          var ext = (f.name.match(/\.([a-z0-9]+)$/i) || [0, ''])[1].toLowerCase();
          var id = 'f' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
          var fr = new FileReader();
          return new Promise(function (res) {
            fr.onload = function () {
              var dup = files.filter(function (x) { return x.name.indexOf(name) === 0 && x.size === f.size; })[0];
              if (dup) { res(); return; }
              var rec = { id: id, name: name + '.' + (ext || 'gp'), size: f.size, added: Date.now(), type: ext, data: fr.result };
              dbPut(rec).then(function () { }, function () { window.__dbFail = 1; })
                .then(function () {
                  files.push(rec); n++;
                  if (!curFileId && n === 1) openFile(rec);
                  res();
                });
            };
            fr.onerror = function () { res(); };
            fr.readAsArrayBuffer(f);
          });
        });
      }, Promise.resolve()).then(function () {
        renderLib();
        toast('已导入 ' + n + ' 首，谱库共 ' + files.length + ' 首');
      });
    };
    $('libSearch').oninput = renderLib;
    $('btnFind').onclick = function () {
      var q = ($('findInput').value || '').trim();
      var src = $('findSrc').value;
      if (src === 'gtpso' && !q) { toast('输入曲名再搜'); return; }
      window.open(findUrl(src, q), '_blank');
      if (src !== 'gtpso') toast('已打开谱站首页，在里面搜「' + (q || '曲名') + '」再下载');
    };

    $('tabs').onclick = function (e) {
      var b = e.target.closest('button[data-tab]'); if (!b) return;
      Array.from(document.querySelectorAll('#tabs button')).forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      var t = b.getAttribute('data-tab');
      $('paneLib').classList.toggle('on', t === 'lib');
      $('paneFind').classList.toggle('on', t === 'find');
      setSide(true);
    };
    $('sideTog').onclick = function () { setSide(!$('side').classList.contains('open')); };
    $('sideMask').onclick = function () { setSide(false); };
    $('scoreScroll').addEventListener('pointerdown', function () { setSide(false); }, { passive: true });

    $('speedRange').oninput = function () { applySpeed(parseInt(this.value, 10) / 100); };
    $('targetBpm').onchange = function () {
      var v = parseFloat(this.value);
      if (!v || !scoreBpm0) return;
      applySpeed(v / scoreBpm0);
    };
    $('btnA').onclick = setA;
    $('btnB').onclick = setB;
    $('btnClear').onclick = function () { clearLoopUI(); toast('已清除循环'); };
    $('btnLoopBar').onclick = loopBars;
    $('selStave').onchange = function () { lsSet('stave', this.value); applyView(); };
    $('btnZoomIn').onclick = function () { reZoom(10); };
    $('btnZoomOut').onclick = function () { reZoom(-10); };
    $('btnFit').onclick = fitWidth;
    $('selLayout').onchange = function () { layoutMode = this.value; lsSet('layout', layoutMode); applyView(); };

    $('btnSet').onclick = function () { $('maskSheet').style.display = 'block'; switchSf(); };
    $('sheetClose').onclick = function () { $('maskSheet').style.display = 'none'; };
    $('maskSheet').onclick = function (e) { if (e.target === $('maskSheet')) $('maskSheet').style.display = 'none'; };
    $('selSf').onchange = function () { lsSet('sf', this.value); $('sfUrlRow').style.display = this.value === 'custom' ? 'flex' : 'none'; refreshSfLabel(); };
    $('sfUrl').onchange = function () {
      var u = this.value.trim(); lsSet('sf:url', u);
      if (u && api) { try { api.loadSoundFont(u, false); toast('已切换音源'); } catch (e) { toast('音源加载失败'); } }
      refreshSfLabel();
    };
    $('selDefSpd').onchange = function () { lsSet('defspd', this.value); };
    $('btnWipe').onclick = function () {
      if (!confirm('清空整个谱库？（谱库存在浏览器里，清掉要重新导入）')) return;
      dbClear().then(function () {
        files = []; curFileId = null; curScore = null; curName = '';
        $('stFile').textContent = '未加载谱文件'; renderLib(); toast('谱库已清空');
      });
    };

    var dragging = false;
    function seekByX(x) {
      var bar = $('progBar'), r = bar.getBoundingClientRect();
      var pct = Math.min(1, Math.max(0, (x - r.left) / r.width));
      if (loopOn && bTick > 0) { seekTo(aTick + Math.round((bTick - aTick) * pct)); return; }
      seekTo(Math.round(pct * lastEndTick()));
    }
    $('progWrap').addEventListener('pointerdown', function (e) {
      dragging = true; seekByX(e.clientX);
      try { $('progWrap').setPointerCapture(e.pointerId); } catch (_) {}
    });
    $('progWrap').addEventListener('pointermove', function (e) { if (dragging) seekByX(e.clientX); });
    $('progWrap').addEventListener('pointerup', function () { dragging = false; });
    $('progWrap').addEventListener('pointercancel', function () { dragging = false; });

    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () {
      if (lsGet('theme', 'auto') === 'auto') themeApply();
    });
    $('btnTheme').onclick = function () {
      var cur = lsGet('theme', 'auto');
      var next = cur === 'auto' ? 'dark' : (cur === 'dark' ? 'light' : 'auto');
      lsSet('theme', next); themeApply();
      toast('主题：' + (next === 'auto' ? '跟随系统' : next === 'dark' ? '暗色' : '亮色'));
    };
  }

  function boot() {
    $('selStave').value = lsGet('stave', '1');
    layoutMode = lsGet('layout', 'page');
    $('selLayout').value = layoutMode;
    $('selDefSpd').value = lsGet('defspd', '0.7');
    $('selSf').value = lsGet('sf', 'sf2');
    themeApply();
    updateZoomLabel();
    bind();
    openDB().then(function (d) {
      db = d;
      return dbAll();
    }).then(function (all) {
      files = all || [];
      renderLib();
      if (files.length) {
        var last = files.slice().sort(function (a, b) { return b.added - a.added; })[0];
        if (last) openFile(last);
      }
    }).catch(function (e) {
      toast('谱库打不开（浏览器可能禁用了本地存储）', 4000);
    });
    window.__gs = { get api() { return api; }, get score() { return curScore; }, files: function () { return files; } };
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
