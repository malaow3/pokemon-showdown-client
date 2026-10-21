#!/usr/bin/env node
/**
 * Stand-in for `php build-tools/news-embed.php` inside the Docker builder
 * (which has no PHP). build-tools/update expects `[newsid, html]` as JSON on
 * stdout; if we exit non-zero it falls back to fetching
 * https://pokemonshowdown.com/news.json itself.
 *
 * We scrape the news embedded in the production client page instead, because
 * play.pokemonshowdown.com is a different host from pokemonshowdown.com and
 * is usually up when the latter isn't.
 */
'use strict';

const SOURCE = 'https://play.pokemonshowdown.com/';

if (!(process.argv[2] || '').endsWith('news-embed.php')) {
	console.error('php shim: only build-tools/news-embed.php is supported');
	process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchNews() {
	const res = await fetch(SOURCE, { signal: AbortSignal.timeout(15000) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const page = await res.text();
	// Each entry ends with `</p></div>` and never nests other divs.
	const entries = page.match(/<div class="newsentry"[^>]*>[\s\S]*?<\/p><\/div>/g);
	if (!entries?.length) throw new Error('no news entries found in page');
	const newsid = Number(/data-newsid="(\d+)"/.exec(entries[0])?.[1]);
	if (!newsid) throw new Error('could not read newsid');
	return [newsid, entries.join('')];
}

(async () => {
	let lastError;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			process.stdout.write(JSON.stringify(await fetchNews()));
			return;
		} catch (err) {
			lastError = err;
			if (attempt < 3) await sleep(attempt * 2000);
		}
	}
	console.error(`php shim: could not fetch news from ${SOURCE}: ${lastError?.message || lastError}`);
	process.exit(1);
})();
