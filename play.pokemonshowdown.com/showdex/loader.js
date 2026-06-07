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
	var SRC = '/showdex/main.js?v=2';
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

	// 'hellodex' on the preact client, 'view-hellodex' on the classic client.
	var HELLODEX_ROOM_IDS = ['hellodex', 'view-hellodex'];

	function currentRoomId() {
		if (window.PS && window.PS.room) return window.PS.room.id || '';
		if (window.app && window.app.curRoom) return window.app.curRoom.id || '';
		return '';
	}

	function joinedHellodexRoomId() {
		for (var i = 0; i < HELLODEX_ROOM_IDS.length; i++) {
			var id = HELLODEX_ROOM_IDS[i];
			if (window.PS && window.PS.rooms && window.PS.rooms[id]) return id;
			if (window.app && window.app.rooms && window.app.rooms[id]) return id;
		}
		return '';
	}

	function focusRoom(roomid) {
		if (window.PS && typeof window.PS.focusRoom === 'function') {
			window.PS.focusRoom(roomid);
			if (typeof window.PS.update === 'function') window.PS.update();
		} else if (window.app) {
			if (roomid && typeof window.app.focusRoomRight === 'function') {
				window.app.focusRoomRight(roomid);
			} else if (typeof window.app.focusRoom === 'function') {
				window.app.focusRoom(roomid);
			}
		}
	}

	// Reads Showdex's "Show Chatrooms Panel" setting (hellodex.focusRoomsRoom).
	// Defaults to true (keep home focused) when nothing is stored, matching the
	// patched default in main.js.
	function readFocusRoomsRoomSetting(callback) {
		if (!window.indexedDB) return callback(true);
		var req = window.indexedDB.open('showdex');
		req.onerror = function () { callback(true); };
		req.onsuccess = function () {
			var db = req.result;
			if (!db.objectStoreNames.contains('settings')) {
				db.close();
				return callback(true);
			}
			var getReq = db.transaction('settings', 'readonly').objectStore('settings').get('hellodex');
			getReq.onerror = function () { db.close(); callback(true); };
			getReq.onsuccess = function () {
				var settings = getReq.result;
				var enabled = settings && typeof settings.focusRoomsRoom === 'boolean' ?
					settings.focusRoomsRoom : true;
				db.close();
				callback(enabled);
			};
		};
	}

	// Showdex decides whether to auto-focus its Hellodex tab from Redux state
	// that may not have the stored settings hydrated yet at boot, so the
	// "Show Chatrooms Panel" setting is unreliable on startup (and Showdex
	// documents it as a no-op in single-panel/mobile layouts). Enforce it here
	// instead, in both directions, exactly once during initial boot:
	// - setting on (default): if the Hellodex steals focus, bounce back home
	// - setting off: focus the Hellodex once it has been joined
	function applyFocusSettingDuringBoot() {
		readFocusRoomsRoomSetting(function (showChatroomsPanel) {
			var deadline = Date.now() + 10000;
			var joinedByUs = false;
			var iv = setInterval(function () {
				if (Date.now() > deadline) return clearInterval(iv);

				// We always want the Hellodex joined, even when Showdex's
				// "Open When Showdown Starts" setting is off. 'hellodex' is a
				// registered route (same one the /hellodex URL uses), so
				// joining it directly is safe once Showdex has registered it.
				var roomid = joinedHellodexRoomId();
				if (!roomid && !joinedByUs &&
					window.PS && window.PS.routes && window.PS.routes['hellodex'] &&
					typeof window.PS.join === 'function') {
					window.PS.join('hellodex', {noURL: true, autofocus: false});
					joinedByUs = true;
					roomid = joinedHellodexRoomId();
				}

				if (showChatroomsPanel) {
					if (HELLODEX_ROOM_IDS.indexOf(currentRoomId()) >= 0) {
						focusRoom('');
						clearInterval(iv);
					}
				} else {
					if (!roomid) return;
					if (currentRoomId() !== roomid) focusRoom(roomid);
					clearInterval(iv);
				}
			}, 100);
		});
	}

	function waitForShowdown() {
		if (showdownReady()) {
			inject();
			startNativeOtsAutoAccept();
			applyFocusSettingDuringBoot();
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
