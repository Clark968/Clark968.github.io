/* GuitarSolo Web 渲染兜底（与主程序解耦，可单独更新） */
(function () {
  'use strict';
  var badRe = /textBaseline|container was invisible|not visible/i;

  function hasCanvas() { return document.querySelectorAll('#tabView canvas').length > 0; }

  var tries = 0;
  function heal() {
    var gs = window.__gs;
    if (!gs || !gs.api || !gs.score) return;
    if (hasCanvas()) { tries = 0; return; }
    if (tries >= 8) return;
    tries++;
    try { gs.api.render(); } catch (e) {}
  }
  setInterval(heal, 600);

  if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
    document.fonts.ready.then(function () { setTimeout(heal, 120); });
  }

  // alphaTab 在字体未就绪时抛的异常不算真故障，别让用户看到红字提示
  var t = document.getElementById('toast');
  if (t && window.MutationObserver) {
    new MutationObserver(function () {
      if (badRe.test(t.textContent || '')) { t.textContent = ''; t.classList.remove('on'); }
    }).observe(t, { childList: true, characterData: true, subtree: true });
  }
})();
