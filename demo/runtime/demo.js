/* TouchBoard demo — page bootstrap. Runs synchronously in <head> before the
 * app's modules, so fetch and EventSource are already in-browser. */
(function (g) {
  'use strict';
  var K = g.DemoKit;
  var page = g.__TB_DEMO_PAGE; // 'editor' | 'display' | 'login'

  var server = g.TouchBoardDemoServer.start(page);
  g.TouchBoardDemo = server;

  var direct = K.params.get('demo');
  if (direct === 'enter' || direct === 'admin') server.signIn();

  if (page === 'login' && server.signedIn()) { location.replace('/'); return; }
  if (page === 'editor' && !server.signedIn()) { location.replace('/login'); return; }

  var ribbon = K.ribbon({ slug: 'touchboard', position: page === 'display' ? 'bottom-left' : 'bottom-right', compactWhenEmbedded: true });
  // The display is meant to be glanced at — tuck the ribbon away after a moment.
  if (page === 'display') setTimeout(function () { ribbon.setAttribute('collapsed', ''); }, 6000);
})(window);
