const assert = require('assert').strict;
const {describe, it} = require('node:test');
const fs = require('fs');
const vm = require('vm');

function storage(initial = {}) {
	const values = new Map(Object.entries(initial));
	return {
		getItem: key => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, String(value)),
		removeItem: key => values.delete(key),
	};
}
function response(status, json = {}) {
	return {status, ok: status >= 200 && status < 300, json: async () => json, text: async () => JSON.stringify(json)};
}
function loadAuth(fetch, initial = {}) {
	const context = vm.createContext({
		location: {hostname: 'localhost', origin: 'http://localhost:4000'},
		localStorage: storage(initial), sessionStorage: storage(),
		fetch, console, navigator: {}, window: {},
		setTimeout, clearTimeout, setInterval, clearInterval,
	});
	vm.runInContext(fs.readFileSync(require.resolve('../play.pokemonshowdown.com/js/pokebin-auth.js'), 'utf8'), context);
	return context;
}
function session(expired = true) {
	return {
		pokebin_access_token: 'old-access',
		pokebin_token_expiry: String(Date.now() + (expired ? -60000 : 600000)),
		pokebin_refresh_token: 'old-refresh',
		pokebin_refresh_expiry: String(Date.now() + 86400000),
	};
}
const renewed = {access_token: 'new-access', expires_in: 900, refresh_token: 'new-refresh', refresh_expires_in: 2592000};

describe('PokeBin refresh authentication', () => {
	it('keeps an expired access session connected when it can renew', () => {
		const auth = loadAuth(() => { throw new Error('Unexpected request'); }, session());
		assert.equal(auth.isPokebinLoggedIn(), true);
		assert.equal(auth.getPokebinAccessToken(), null);
		assert.equal(auth.localStorage.getItem('pokebin_refresh_token'), 'old-refresh');
	});
	it('renews expired credentials before uploading and stores rotated tokens', async () => {
		const calls = [];
		const auth = loadAuth(async (url, options) => {
			calls.push({url, options});
			return url.endsWith('/api/oauth/token') ? response(200, renewed) : response(200, {uuid: 'paste'});
		}, session());
		assert.equal(await auth.uploadPokebinAuthenticated('payload'), 'paste');
		assert.equal(calls.length, 2);
		assert.equal(JSON.parse(calls[0].options.body).grant_type, 'refresh_token');
		assert.equal(JSON.parse(calls[0].options.body).refresh_token, 'old-refresh');
		assert.equal(calls[1].options.headers.Authorization, 'Bearer new-access');
		assert.equal(auth.localStorage.getItem('pokebin_refresh_token'), 'new-refresh');
	});
	it('does not refresh an access token that is still valid', async () => {
		const auth = loadAuth(async (url, options) => {
			assert.ok(url.endsWith('/api/pastes'));
			assert.equal(options.headers.Authorization, 'Bearer old-access');
			return response(200, {uuid: 'paste'});
		}, session(false));
		assert.equal(await auth.uploadPokebinAuthenticated('payload'), 'paste');
	});
	it('coalesces concurrent refresh requests', async () => {
		let refreshes = 0;
		const auth = loadAuth(async url => {
			if (url.endsWith('/api/oauth/token')) {
				refreshes++;
				return response(200, renewed);
			}
			return response(200, {uuid: 'paste'});
		}, session());
		await Promise.all([auth.uploadPokebinAuthenticated('a'), auth.uploadPokebinAuthenticated('b')]);
		assert.equal(refreshes, 1);
	});
	for (const failure of ['network', 'server']) {
		it(`preserves refresh credentials after a ${failure} failure`, async () => {
			const auth = loadAuth(async () => {
				if (failure === 'network') throw new Error('offline');
				return response(503);
			}, session());
			await assert.rejects(auth.uploadPokebinAuthenticated('payload'));
			assert.equal(auth.localStorage.getItem('pokebin_refresh_token'), 'old-refresh');
			assert.equal(auth.isPokebinLoggedIn(), true);
		});
	}
	it('clears credentials when the refresh grant is invalid', async () => {
		const auth = loadAuth(async () => response(400, {error: 'invalid_grant'}), session());
		try { await auth.uploadPokebinAuthenticated('payload'); } catch {}
		assert.equal(auth.isPokebinLoggedIn(), false);
		assert.equal(auth.localStorage.getItem('pokebin_refresh_token'), null);
	});
	it('renews and retries once after an upload returns 401', async () => {
		let uploads = 0;
		let refreshes = 0;
		const auth = loadAuth(async url => {
			if (url.endsWith('/api/oauth/token')) {
				refreshes++;
				return response(200, renewed);
			}
			return ++uploads === 1 ? response(401) : response(200, {uuid: 'paste'});
		}, session(false));
		assert.equal(await auth.uploadPokebinAuthenticated('payload'), 'paste');
		assert.equal(refreshes, 1);
		assert.equal(uploads, 2);
	});
	it('still supports access-only sessions issued by the old backend', async () => {
		const initial = session(false);
		delete initial.pokebin_refresh_token;
		delete initial.pokebin_refresh_expiry;
		const auth = loadAuth(async () => response(200, {uuid: 'paste'}), initial);
		assert.equal(auth.isPokebinLoggedIn(), true);
		assert.equal(await auth.uploadPokebinAuthenticated('payload'), 'paste');
	});

	it('disconnect clears locally and revokes the refresh token', async () => {
		const calls = [];
		const auth = loadAuth(async (url, options) => {
			calls.push({url, options});
			return response(200);
		}, session(false));
		auth.clearPokebinAuth();
		assert.equal(auth.isPokebinLoggedIn(), false);
		await Promise.resolve();
		assert.equal(calls.length, 1);
		assert.ok(calls[0].url.endsWith('/api/oauth/revoke'));
		assert.equal(JSON.parse(calls[0].options.body).refresh_token, 'old-refresh');
	});
	it('does not restore credentials when an in-flight refresh finishes after disconnect', async () => {
		let finishRefresh;
		let started;
		const ready = new Promise(resolve => { started = resolve; });
		const auth = loadAuth(async url => {
			if (url.endsWith('/api/oauth/token')) {
				started();
				return new Promise(resolve => { finishRefresh = resolve; });
			}
			assert.ok(url.endsWith('/api/oauth/revoke'), 'must not upload after disconnect');
			return response(200);
		}, session());
		const upload = auth.uploadPokebinAuthenticated('payload');
		await ready;
		auth.clearPokebinAuth();
		finishRefresh(response(200, renewed));
		try { await upload; } catch {}
		assert.equal(auth.isPokebinLoggedIn(), false);
		assert.equal(auth.localStorage.getItem('pokebin_refresh_token'), null);
	});

	it('limits retries when the renewed access token also gets a 401', async () => {
		let uploads = 0;
		const auth = loadAuth(async url => {
			if (url.endsWith('/api/oauth/token')) return response(200, renewed);
			uploads++;
			return response(401);
		}, session(false));
		await assert.rejects(auth.uploadPokebinAuthenticated('payload'));
		assert.equal(uploads, 2);
	});
	it('uses credentials saved by another tab during refresh', async () => {
		const auth = loadAuth(async (url, options) => {
			if (url.endsWith('/api/oauth/token')) {
				auth.localStorage.setItem('pokebin_access_token', 'other-tab-access');
				auth.localStorage.setItem('pokebin_token_expiry', Date.now() + 900000);
				auth.localStorage.setItem('pokebin_refresh_token', 'other-tab-refresh');
				return response(200, renewed);
			}
			assert.equal(options.headers.Authorization, 'Bearer other-tab-access');
			return response(200, {uuid: 'paste'});
		}, session());
		assert.equal(await auth.uploadPokebinAuthenticated('payload'), 'paste');
		assert.equal(auth.localStorage.getItem('pokebin_refresh_token'), 'other-tab-refresh');
	});
	it('rereads credentials inside the cross-tab refresh lock', async () => {
		const auth = loadAuth(async (url, options) => {
			assert.ok(url.endsWith('/api/pastes'));
			assert.equal(options.headers.Authorization, 'Bearer other-tab-access');
			return response(200, {uuid: 'paste'});
		}, session());
		auth.navigator.locks = {request: async (name, callback) => {
			assert.equal(name, 'pokebin-refresh');
			auth.localStorage.setItem('pokebin_access_token', 'other-tab-access');
			auth.localStorage.setItem('pokebin_token_expiry', Date.now() + 900000);
			auth.localStorage.setItem('pokebin_refresh_token', 'other-tab-refresh');
			return callback();
		}};
		assert.equal(await auth.uploadPokebinAuthenticated('payload'), 'paste');
	});
});
