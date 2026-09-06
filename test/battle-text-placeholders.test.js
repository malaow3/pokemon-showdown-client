const assert = require('assert').strict;
const {describe, it} = require('node:test');
const fs = require('fs');
const vm = require('vm');

const parserSource = fs.readFileSync(require.resolve('../play.pokemonshowdown.com/js/battle-text-parser.js'), 'utf8');

function loadParser(modern) {
	const token = name => modern ? `{${name}}` : `[${name}]`;
	const context = vm.createContext({
		Dex: {gen: 9},
		toID: text => text.toLowerCase().replace(/[^a-z0-9]/g, ''),
		BattleText: {
			default: {
				pokemon: token('NICKNAME'),
				opposingPokemon: `the opposing ${token('NICKNAME')}`,
				team: 'your team',
				opposingTeam: 'the opposing team',
				party: 'your party',
				opposingParty: 'the opposing party',
				switchIn: `${token('TRAINER')} sent out ${token('FULLNAME')}!`,
				switchInOwn: `Go! ${token('FULLNAME')}!`,
				turn: `Turn ${token('NUMBER')}`,
				turnGen8: `Old turn ${token('NUMBER')}`,
				move: `${token('POKEMON')} used **${token('MOVE')}**!`,
				abilityActivation: `[${token('POKEMON')}'s ${token('ABILITY')}]`,
			},
			sleeptalk: {
				move: `${token('POKEMON')} called **${token('MOVE')}**!`,
				moveGen8: `${token('POKEMON')} previously called **${token('MOVE')}**!`,
			},
		},
	});
	vm.runInContext(parserSource, context);
	return new context.BattleTextParser();
}

for (const modern of [false, true]) {
	describe(`Battle text ${modern ? 'brace' : 'legacy bracket'} placeholders`, () => {
		it('renders own and opposing switch messages', () => {
			const parser = loadParser(modern);
			parser.extractMessage('|player|p2|Alice');
			assert.equal(parser.extractMessage('|switch|p1a: Sparky|Pikachu, L50|100/100'), 'Go! Sparky (**Pikachu**)!\n');
			assert.equal(parser.extractMessage('|switch|p2a: Eevee|Eevee, L50|100/100'), '\nAlice sent out **Eevee**!\n');
		});

		it('renders turn numbers', () => {
			const parser = loadParser(modern);
			assert.equal(parser.extractMessage('|turn|12'), 'Turn 12\n\n');
			assert.equal(parser.turn, 12);
		});

		it('renders moves and capitalizes opposing Pokemon at the start of a line', () => {
			const parser = loadParser(modern);
			assert.equal(parser.extractMessage('|move|p1a: Pikachu|Thunderbolt|p2a: Eevee'), 'Pikachu used **Thunderbolt**!\n');
			assert.equal(parser.extractMessage('|move|p2a: Eevee|Tackle|p1a: Pikachu'), '\nThe opposing Eevee used **Tackle**!\n');
		});

		it('preserves literal outer brackets around ability activations', () => {
			const parser = loadParser(modern);
			assert.equal(parser.extractMessage('|-ability|p1a: Pikachu|Static'), "[Pikachu's Static]\n");
			assert.equal(parser.extractMessage('|-ability|p2a: Eevee|Run Away'), "[The opposing Eevee's Run Away]\n");
		});

		it('does not reprocess brace tokens inside nicknames', () => {
			const parser = loadParser(modern);
			assert.equal(parser.extractMessage('|move|p1a: {MOVE}|Tackle|p2a: Eevee'), '{MOVE} used **Tackle**!\n');
			assert.equal(parser.extractMessage('|-ability|p2a: {ABILITY}|Static'), "[The opposing {ABILITY}'s Static]\n");
		});

		it('renders namespaced move templates', () => {
			const parser = loadParser(modern);
			assert.equal(parser.extractMessage('|move|p1a: Snorlax|Tackle|p2a: Eevee|[from] move: Sleep Talk'), 'Snorlax called **Tackle**!\n');
		});

		it('renders generation-specific default templates', () => {
			const parser = loadParser(modern);
			parser.extractMessage('|gen|8');
			assert.equal(parser.extractMessage('|turn|3'), 'Old turn 3\n\n');
		});

		it('renders generation-specific namespaced templates', () => {
			const parser = loadParser(modern);
			parser.extractMessage('|gen|8');
			assert.equal(parser.extractMessage('|move|p2a: Snorlax|Tackle|p1a: Eevee|[from] move: Sleep Talk'), 'The opposing Snorlax previously called **Tackle**!\n');
		});
	});
}
