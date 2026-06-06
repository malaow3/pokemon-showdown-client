/*
 * Native Showdex loader for Pokemon Showdown.
 *
 * This intentionally loads the Showdex page bundle directly instead of using
 * the Chrome/Firefox extension content script, so it works on mobile browsers
 * and any desktop browser that can run the client.
 */
(function () {
	'use strict';

	var params = new URLSearchParams(window.location.search || '');
	if (params.has('noshowdex') || window.Config && window.Config.disableShowdex) return;

	var SCRIPT_ID = 'showdex-script-main';
	var SRC = '/showdex/main.js';
	var started = false;

	function showdownReady() {
		return !!(
			window.Dex && typeof window.Dex.gen === 'number' && typeof window.Dex.forGen === 'function' &&
			(
				window.app && typeof window.app.receive === 'function' ||
				window.PS && typeof window.PS.startTime === 'number'
			)
		);
	}

	function inject() {
		if (started || window.__SHOWDEX_INIT || document.getElementById(SCRIPT_ID)) return;
		started = true;

		var script = document.createElement('script');
		script.id = SCRIPT_ID;
		script.src = SRC;
		script.async = true;
		// Showdex reads this in extension builds. It is harmless in standalone builds
		// and helps if this bundle is rebuilt with a different target later.
		script.setAttribute('data-ext-id', 'native');
		script.onerror = function () {
			started = false;
			// eslint-disable-next-line no-console
			console.error('[showdex] Failed to load ' + SRC);
		};
		document.body.appendChild(script);
	}

	function waitForShowdown() {
		if (showdownReady()) {
			inject();
			return;
		}
		setTimeout(waitForShowdown, 250);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', waitForShowdown);
	} else {
		waitForShowdown();
	}
})();
