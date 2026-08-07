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
	// Versioned because /showdex/ is served with a 30-day public cache;
	// bump this whenever main.js changes.
	var SRC = '/showdex/main.js?v=5';
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

	function isTextInputTarget(target) {
		for (var elem = target; elem && elem !== document; elem = elem.parentElement) {
			if (elem.isContentEditable || elem.tagName === 'TEXTAREA') return true;
			if (elem.tagName === 'INPUT') {
				return !/^(button|checkbox|file|hidden|image|radio|range|reset|submit)$/i.test(elem.type);
			}
		}
		return false;
	}

	// Showdex installs document-level hotkey handlers after this loader runs.
	// Keep those handlers from consuming keystrokes meant for Showdown inputs.
	function protectTextInputsFromHotkeys() {
		document.addEventListener('keydown', function (event) {
			if (isTextInputTarget(event.target)) event.stopImmediatePropagation();
		}, false);
		document.addEventListener('keyup', function (event) {
			if (isTextInputTarget(event.target)) event.stopImmediatePropagation();
		}, false);
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

	function readAutoAcceptSheetsSetting(callback) {
		if (!window.indexedDB) return callback(false);
		var req = window.indexedDB.open('showdex');
		req.onerror = function () { callback(false); };
		req.onsuccess = function () {
			var db = req.result;
			if (!db.objectStoreNames.contains('settings')) {
				db.close();
				return callback(false);
			}
			var getReq = db.transaction('settings', 'readonly').objectStore('settings').get('showdown');
			getReq.onerror = function () { db.close(); callback(false); };
			getReq.onsuccess = function () {
				var enabled = !!(getReq.result && getReq.result.autoAcceptSheets);
				db.close();
				callback(enabled);
			};
		};
	}

	function roomidFromElement(el) {
		for (var node = el; node && node !== document; node = node.parentNode) {
			var id = node.id || '';
			var match = /(?:room-)?(battle-[a-z0-9-]+)/i.exec(id);
			if (match) return match[1];
		}
		return '';
	}

	function sendAcceptOpenTeamSheets(roomid) {
		if (!roomid) return;
		if (window.PS && typeof window.PS.send === 'function') {
			window.PS.send('/acceptopenteamsheets', roomid);
		} else if (window.app && typeof window.app.send === 'function') {
			window.app.send('/acceptopenteamsheets', roomid);
		}
	}

	function battleHasOtsRequest(battle) {
		var queue = battle && battle.stepQueue;
		if (!queue || !queue.length) return false;
		var joined = queue.join('\n').toLowerCase();
		return joined.indexOf('otsrequest') >= 0 || joined.indexOf('acceptopenteamsheets') >= 0 || joined.indexOf('open team sheet') >= 0;
	}

	function scanBattleObjects(accepted) {
		if (window.PS && window.PS.rooms) {
			var rooms = window.PS.rooms;
			var list = rooms instanceof Map ? Array.from(rooms.values()) : Object.keys(rooms).map(function (k) { return rooms[k]; });
			for (var i = 0; i < list.length; i++) {
				var room = list[i];
				var battle = room && room.battle;
				var roomid = room && (room.id || room.roomid) || battle && battle.id;
				if (roomid && /^battle-/.test(roomid) && battleHasOtsRequest(battle) && !accepted[roomid]) {
					accepted[roomid] = true;
					sendAcceptOpenTeamSheets(roomid);
				}
			}
		}

		if (window.app && window.app.rooms) {
			Object.keys(window.app.rooms).forEach(function (roomid) {
				var room = window.app.rooms[roomid];
				var battle = room && room.battle;
				if (/^battle-/.test(roomid) && battleHasOtsRequest(battle) && !accepted[roomid]) {
					accepted[roomid] = true;
					sendAcceptOpenTeamSheets(roomid);
				}
			});
		}
	}

	function startNativeOtsAutoAccept() {
		var accepted = Object.create(null);
		var scan = function () {
			readAutoAcceptSheetsSetting(function (enabled) {
				if (!enabled) return;

				// Best path: inspect Showdown battle objects directly. This catches requests
				// even if the client renders a different button label/DOM on mobile.
				scanBattleObjects(accepted);

				// Fallback path: click/send from rendered request controls.
				var candidates = document.querySelectorAll('button, input[type="button"], input[type="submit"], .button');
				for (var i = 0; i < candidates.length; i++) {
					var el = candidates[i];
					var text = ((el.value || '') + ' ' + (el.name || '') + ' ' + (el.getAttribute('name') || '') + ' ' + (el.textContent || '')).toLowerCase();
					if (!/accept.*(?:open.*team.*sheet|ots)|acceptopenteamsheets/.test(text)) continue;
					var roomid = roomidFromElement(el);
					if (!roomid || accepted[roomid]) continue;
					accepted[roomid] = true;
					sendAcceptOpenTeamSheets(roomid);
					if (typeof el.click === 'function') el.click();
				}
			});
		};
		scan();
		setInterval(scan, 1000);
		new MutationObserver(scan).observe(document.body, {childList: true, subtree: true});
	}

	function readCalcdexOverlaySetting(callback) {
		if (!window.indexedDB) return callback(false);
		var req = window.indexedDB.open('showdex');
		req.onerror = function () { callback(false); };
		req.onsuccess = function () {
			var db = req.result;
			if (!db.objectStoreNames.contains('settings')) {
				db.close();
				return callback(false);
			}
			var getReq = db.transaction('settings', 'readonly').objectStore('settings').get('calcdex');
			getReq.onerror = function () { db.close(); callback(false); };
			getReq.onsuccess = function () {
				var settings = getReq.result;
				db.close();
				callback(!!settings && settings.openAs === 'overlay');
			};
		};
	}

	// The Preact client can replace its battle controls after Showdex has patched
	// them. Keep a DOM-level fallback for the overlay control in that case.
	function startCalcdexOverlayControlFallback() {
		readCalcdexOverlaySetting(function (enabled) {
			if (!enabled) return;
			var scan = function () {
				var rooms = document.querySelectorAll('[id^="room-battle-"]');
				for (var i = 0; i < rooms.length; i++) {
					var room = rooms[i];
					if (room.querySelector('button[name="toggleCalcdexOverlay"]')) continue;
					var battleOptions = room.querySelector('button[data-href="battleoptions"]');
					var controls = room.querySelector('.battle-controls, .controls');
					if (!battleOptions && !controls) continue;
					var button = document.createElement('button');
					button.type = 'button';
					button.className = 'button';
					button.name = 'toggleCalcdexOverlay';
					button.setAttribute('data-cmd', '/calcdex overlay toggle');
					button.textContent = 'Open Calcdex';
					if (battleOptions) {
						battleOptions.parentNode.insertBefore(button, battleOptions.nextSibling);
					} else {
						controls.appendChild(button);
					}
				}
			};
			scan();
			new MutationObserver(scan).observe(document.body, {childList: true, subtree: true});
		});
	}

	// Do not let Showdex's startup route replace the home panel. This only
	// applies during boot; normal user navigation remains untouched.
	function keepHomeFocusedDuringBoot() {
		var deadline = Date.now() + 10000;
		var iv = setInterval(function () {
			if (Date.now() > deadline) return clearInterval(iv);

			// Focusing a room also focuses its `.autofocus` element. Do not
			// steal focus from a textbox while the user is typing.
			var active = document.activeElement;
			if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;

			var roomid = window.PS && window.PS.room && window.PS.room.id;
			if (roomid !== 'hellodex' && roomid !== 'view-hellodex' && roomid !== 'rooms') return;
			if (window.PS && typeof window.PS.focusRoom === 'function') {
				window.PS.focusRoom('');
			}
		}, 100);
	}

	function waitForShowdown() {
		if (showdownReady()) {
			protectTextInputsFromHotkeys();
			inject();
			startNativeOtsAutoAccept();
			startCalcdexOverlayControlFallback();
			keepHomeFocusedDuringBoot();
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
