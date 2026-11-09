const assert = require('assert').strict;
const {describe, it} = require('node:test');
const fs = require('fs');
const vm = require('vm');

const parserSource = fs.readFileSync(require.resolve('../play.pokemonshowdown.com/js/battle-text-parser.js'), 'utf8');

function loadParser() {
	// The client now consumes language/table catalogs with brace placeholders.
	// Legacy server templates are converted when the catalogs are built.
	const context = vm.createContext({
		Dex: {
			gen: 9,
			text: {getLanguage: () => 'en', get: effect => effect},
			loadTextData: () => Promise.resolve(),
			species: {get: name => ({name})},
		},
		toID: text => text.toLowerCase().replace(/[^a-z0-9]/g, ''),
		BattleText: {en: {
			Default: {default: {
				pokemon: '{NICKNAME}',
				opposingPokemon: 'the opposing {NICKNAME}',
				team: 'your team',
				opposingTeam: 'the opposing team',
				party: 'your party',
				opposingParty: 'the opposing party',
				switchIn: '{TRAINER} sent out {FULLNAME}!',
				switchInOwn: 'Go! {FULLNAME}!',
				turn: 'Turn {NUMBER}',
				gen8: {turn: 'Old turn {NUMBER}'},
				move: '{POKEMON} used **{MOVE}**!',
				abilityActivation: "[{POKEMON}'s {ABILITY}]",
			}},
			Moves: {sleeptalk: {
				move: '{POKEMON} called **{MOVE}**!',
				gen8: {move: '{POKEMON} previously called **{MOVE}**!'},
			}},
		}},
	});
	vm.runInContext(parserSource, context);
	return new context.BattleTextParser();
}

describe('Battle text catalog placeholders', () => {
	it('renders own and opposing switch messages', () => {
		const parser = loadParser();
		parser.extractMessage('|player|p2|Alice');
		assert.equal(parser.extractMessage('|switch|p1a: Sparky|Pikachu, L50|100/100'), 'Go! Sparky (**Pikachu**)!\n');
		assert.equal(parser.extractMessage('|switch|p2a: Eevee|Eevee, L50|100/100'), '\nAlice sent out **Eevee**!\n');
	});

	it('renders turn numbers', () => {
		const parser = loadParser();
		assert.equal(parser.extractMessage('|turn|12'), 'Turn 12\n\n');
		assert.equal(parser.turn, 12);
	});

	it('renders moves and capitalizes opposing Pokemon at the start of a line', () => {
		const parser = loadParser();
		assert.equal(parser.extractMessage('|move|p1a: Pikachu|Thunderbolt|p2a: Eevee'), 'Pikachu used **Thunderbolt**!\n');
		assert.equal(parser.extractMessage('|move|p2a: Eevee|Tackle|p1a: Pikachu'), '\nThe opposing Eevee used **Tackle**!\n');
	});

	it('preserves literal outer brackets around ability activations', () => {
		const parser = loadParser();
		assert.equal(parser.extractMessage('|-ability|p1a: Pikachu|Static'), "[Pikachu's Static]\n");
		assert.equal(parser.extractMessage('|-ability|p2a: Eevee|Run Away'), "[The opposing Eevee's Run Away]\n");
	});

	for (const token of ['{MOVE}', '[MOVE]']) {
		it(`does not reprocess ${token} inside nicknames`, () => {
			const parser = loadParser();
			assert.equal(parser.extractMessage(`|move|p1a: ${token}|Tackle|p2a: Eevee`), `${token} used **Tackle**!\n`);
			assert.equal(parser.extractMessage(`|-ability|p2a: ${token}|Static`), `[The opposing ${token}'s Static]\n`);
		});
	}

	it('renders namespaced move templates', () => {
		const parser = loadParser();
		assert.equal(parser.extractMessage('|move|p1a: Snorlax|Tackle|p2a: Eevee|[from] move: Sleep Talk'), 'Snorlax called **Tackle**!\n');
	});

	it('renders generation-specific default templates', () => {
		const parser = loadParser();
		parser.extractMessage('|gen|8');
		assert.equal(parser.extractMessage('|turn|3'), 'Old turn 3\n\n');
	});

	it('renders generation-specific namespaced templates', () => {
		const parser = loadParser();
		parser.extractMessage('|gen|8');
		assert.equal(parser.extractMessage('|move|p2a: Snorlax|Tackle|p1a: Eevee|[from] move: Sleep Talk'), 'The opposing Snorlax previously called **Tackle**!\n');
	});
});
