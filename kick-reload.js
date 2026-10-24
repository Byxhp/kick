// ==UserScript==
// @name         Kick - Stop the livestream from reloading on window resize
// @name:pt-BR   Kick - Live sem recarregar ao redimensionar
// @namespace    kick-resize-fix
// @version      1.1.0
// @description  Keeps a Kick livestream playing when you resize the browser window, instead of restarting the player.
// @description:pt-BR  Impede que o player da Kick recarregue a live quando a janela é redimensionada.
// @match        https://kick.com/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// ==/UserScript==

/*
 * The problem
 * -----------
 * On kick.com the live player restarts every time the window width crosses
 * 1024px. On desktop that happens more than you'd think: snapping a window to
 * half of a 1920px screen, docking DevTools, zooming in, leaving fullscreen.
 * The console shows the IVS player starting a brand new load:
 *
 *   Seek discontinuity to 0 us
 *   (playback-monitor) Config changed {}
 *   (playback-monitor) Play - moving to buffered region 0.015333 0
 *
 * Why it happens (traced on build 2dc966f2, IVS Web Player 1.56.2)
 * -----------------------------------------------------------------
 * The bundles are minified, so the component names below are descriptive.
 *
 *   1. ViewportResizer renders an invisible <div data-viewport-state> and
 *      measures it with a ResizeObserver. Under 1024px the state becomes
 *      "tablet" or "mobile", and useIsMobile() returns true.
 *   2. ChannelLayout renders the mobile channel header when isMobile is true
 *      and the desktop one otherwise. Both contain the component that hooks
 *      the stream up to the shared IVS player, so crossing 1024px unmounts one
 *      and mounts the other.
 *   3. Each header asks initStreamPlayback for its own session: playerName
 *      "web" on desktop, "web_mobile" on mobile. That comes back with a
 *      different signed playback URL.
 *   4. setVideoInformations() only skips load() when the playbackUrl is the
 *      same string, so the new URL goes straight into ivsPlayer.load() and the
 *      stream starts over.
 *   5. Going from mobile to desktop, the old component also calls reset() on
 *      unmount (it only does that while isMobile is true), which pauses the
 *      player and clears the current video before the new one loads.
 *
 * What this script does
 * ---------------------
 * It never touches the player. It adds one stylesheet that keeps the measuring
 * <div> on a single side of 1024px (min-width or max-width), so Kick never
 * sees the breakpoint change and never swaps the layout. The window and the
 * video still resize like normal. Only Kick's idea of "mobile or desktop"
 * stays put.
 *
 * The desktop layout leans on Tailwind `lg:` classes, which stop applying
 * under 1024px. Without help, a desktop layout in a narrow window splits the
 * width between player and chat, and a hidden chat still takes up space. So
 * when the desktop layout is locked and the window is narrow, the script
 * re-applies the handful of `lg:` rules Kick uses for that layout.
 *
 * Modes (Tampermonkey menu)
 * -------------------------
 *   auto     Lock to whichever layout the page opened in. This is the default.
 *   desktop  Always use the desktop layout.
 *   mobile   Always use the mobile layout.
 *   off      Do nothing. Kick behaves as usual.
 *
 * In auto mode there's also "Re-fit to current window size", which picks the
 * layout again from the current width. If that changes the layout, the stream
 * reloads once, same as it would without the script.
 *
 * Limitations
 * -----------
 * - With the desktop layout locked in a window under 1024px you get a compact
 *   desktop page (chat beside the video), not Kick's mobile page (chat below).
 * - It relies on the `data-viewport-state` attribute. If that gets renamed,
 *   the script simply stops having an effect. It can't break playback.
 *
 * How Kick could fix this properly
 * --------------------------------
 * Either of the first two would fix it on its own.
 *
 * - Keep a single player connector mounted across the breakpoint: lift the
 *   component that calls setVideoInformations (and renders the OutPortal)
 *   above the isMobile branch, or render one header and handle the
 *   differences in CSS.
 * - In setVideoInformations, decide whether to call load() based on the
 *   livestream (type + id) rather than the exact playbackUrl. A freshly
 *   signed URL for a stream that's already playing doesn't need a reload.
 * - Don't tie playerName to the current layout. If "web" vs "web_mobile" is
 *   for analytics, choose it once per page load or send it as metadata.
 * - Defer the reset() that runs on unmount, and skip it when a connector for
 *   the same video mounts right after.
 *
 * Changelog
 * ---------
 * 1.1.0  English docs, menu follows the browser language (pt / en).
 * 1.0.0  First version.
 */

(function () {
  'use strict';

  // Kick's useIsMobile() is true below this width ("mobile" and "tablet").
  const BREAKPOINT = 1024;
  const LOG = '[Kick Resize Fix]';

  const PT = /^pt\b/i.test(navigator.language || '');
  const t = (en, pt) => (PT ? pt : en);

  const MODES = {
    auto: t('Auto (lock to the layout the page opened in)', 'Automático (trava no layout em que a página abriu)'),
    desktop: t('Always desktop layout', 'Sempre layout desktop'),
    mobile: t('Always mobile layout', 'Sempre layout mobile'),
    off: t("Off (Kick's original behavior)", 'Desativado (comportamento original da Kick)'),
  };

  const hasGM = typeof GM_getValue === 'function';
  let mode = hasGM ? GM_getValue('mode', 'auto') : 'auto';
  if (!(mode in MODES)) mode = 'auto';

  // Which side of the breakpoint the window is on right now. Null when the
  // window has no size yet (a prerendered or background tab, for example).
  const windowSide = () => {
    const w = window.innerWidth;
    if (!w) return null;
    return w >= BREAKPOINT ? 'desktop' : 'mobile';
  };

  let autoSide = windowSide();

  const lockedSide = () => {
    if (mode === 'off') return null;
    return mode === 'auto' ? autoSide : mode;
  };

  // Pins the width Kick measures. position:fixed takes the div out of the
  // flow, so forcing it wider than the window can't cause a horizontal scrollbar.
  const measurerCss = (side) => {
    const clamp = side === 'desktop' ? `min-width:${BREAKPOINT}px` : `max-width:${BREAKPOINT - 1}px`;
    return `[data-viewport-state]{position:fixed!important;top:0!important;left:0!important;${clamp}!important}`;
  };

  // Kick's own `lg:` rules for the desktop layout, re-applied for windows
  // narrower than 1024px while the desktop layout is locked.
  const narrowDesktopCss = `
    @media (max-width: ${BREAKPOINT - 0.02}px) {
      body { height: 100dvh !important; overflow: hidden !important; }
      div:has(> div > main[data-theatre-mode-container]) { overflow: hidden !important; }
      div:has(> main[data-theatre-mode-container]) { flex: 1 1 0% !important; min-width: 0 !important; overflow: hidden !important; }
      main[data-theatre-mode-container] { width: 100% !important; overflow-x: hidden !important; overflow-y: auto !important; }
      #channel-chatroom { flex-grow: 0 !important; flex-shrink: 0 !important; }
      [data-chat="true"] #channel-chatroom { width: var(--chat-width, 340px) !important; }
      [data-chat="false"] #channel-chatroom { width: 0 !important; }
      #channel-content { height: auto !important; }
    }`;

  const style = document.createElement('style');
  style.id = 'kick-resize-fix';

  let renderedSide;
  const render = () => {
    const side = lockedSide();
    style.textContent = side ? measurerCss(side) + (side === 'desktop' ? narrowDesktopCss : '') : '';
    if (side !== renderedSide) {
      renderedSide = side;
      console.info(LOG, side ? t(`layout locked to: ${side}`, `layout travado em: ${side}`) : t('lock disabled', 'trava desativada'));
    }
  };

  // Keeps the stylesheet in the document. If the window had no size at
  // startup, auto mode picks its side as soon as it does.
  const ensureStyle = () => {
    if (mode === 'auto' && !autoSide && (autoSide = windowSide())) render();
    if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
  };

  render();
  ensureStyle(); // as early as possible, before Kick takes its first measurement
  document.addEventListener('DOMContentLoaded', ensureStyle);
  setInterval(ensureStyle, 500);

  // ---- Tampermonkey menu ---------------------------------------------------

  if (!hasGM || typeof GM_registerMenuCommand !== 'function') return;

  let menuIds = [];
  const setMode = (m) => {
    mode = m;
    GM_setValue('mode', m);
    if (m === 'auto') autoSide = windowSide();
    render();
    buildMenu();
  };

  const buildMenu = () => {
    if (typeof GM_unregisterMenuCommand === 'function') menuIds.forEach((id) => GM_unregisterMenuCommand(id));
    menuIds = Object.entries(MODES).map(([key, label]) =>
      GM_registerMenuCommand(`${key === mode ? '✔' : ' '} ${label}`, () => setMode(key)),
    );
    if (mode === 'auto') {
      menuIds.push(
        GM_registerMenuCommand(
          t('↻ Re-fit to current window size (reloads the stream once)', '↻ Reajustar ao tamanho atual da janela (recarrega a live 1x)'),
          () => {
            autoSide = windowSide();
            render();
          },
        ),
      );
    }
  };

  buildMenu();
})();
