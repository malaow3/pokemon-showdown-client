const assert = require('assert').strict;
const {describe, it} = require('node:test');
const fs = require('fs');
const vm = require('vm');
const {createHash} = require('crypto');

function loadLog(client = true) {
	const context = vm.createContext({
		window: client ? {PS: {}} : {},
		Config: {customcolors: {}},
		MD5: name => createHash('md5').update(name).digest('hex'),
		toID: name => name.toLowerCase().replace(/[^a-z0-9]/g, ''),
	});
	vm.runInContext(fs.readFileSync(require.resolve('../play.pokemonshowdown.com/js/battle-log.js'), 'utf8'), context);
	return context;
}

describe('Local username colors', () => {
	it('uses separate CSS variables with the normal color as fallback', () => {
		const {BattleLog} = loadLog();
		for (const name of ['alice', 'bob']) {
			const normal = BattleLog.defaultUsernameColor(name);
			assert.match(normal, /^#[0-9a-f]{6}$/);
			assert.equal(BattleLog.usernameColor(name), `var(--username-color-${name}, ${normal})`);
			assert.equal(BattleLog.hashColor(name), `color:var(--username-color-${name}, ${normal});`);
			assert.equal(BattleLog.colorCache[name], normal);
		}
	});

	it('keeps replay and legacy colors unchanged, even after caching', () => {
		const context = loadLog();
		const normal = context.BattleLog.defaultUsernameColor('alice');
		context.BattleLog.usernameColor('alice');
		delete context.window.PS;
		assert.equal(context.BattleLog.usernameColor('alice'), normal);
		assert.equal(context.BattleLog.hashColor('alice'), `color:${normal};`);
	});

	it('preserves server custom colors', () => {
		const {BattleLog, Config} = loadLog(false);
		Config.customcolors.alice = 'bob';
		assert.equal(BattleLog.usernameColor('alice'), BattleLog.usernameColor('bob'));
	});

	it('normalizes variable names before inserting them into CSS', () => {
		const {BattleLog} = loadLog();
		assert.match(BattleLog.usernameColor('Alice; color: red'), /^var\(--username-color-alicecolorred, #[0-9a-f]{6}\)$/);
	});
});
