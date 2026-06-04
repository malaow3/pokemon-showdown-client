// Pokémon Showdown client dev server.
// Run with: deno run --allow-net --allow-read --allow-env server.ts

import { serveDir } from "jsr:@std/http/file-server";
import { join, fromFileUrl } from "jsr:@std/path";

const clientPath = join(fromFileUrl(new URL(".", import.meta.url)), "play.pokemonshowdown.com");
const port = Number(Deno.env.get("PORT")) || 4000;
const preactDevtools = Deno.env.get("PREACT_DEVTOOLS") === "1";

const devtoolsScripts = `<script src="js/lib/preact-devtools.umd.js"></script>
	<script src="js/lib/preact-debug.umd.js"></script>`;

async function serveBetaClient(): Promise<Response> {
	const html = await Deno.readTextFile(join(clientPath, "testclient-beta.html"));
	return new Response(
		html.replace("<!-- __PREACT_DEVTOOLS__ -->", preactDevtools ? devtoolsScripts : ""),
		{ headers: { "Content-Type": "text/html; charset=utf-8" } },
	);
}

async function serveClassicClient(): Promise<Response> {
	const html = await Deno.readTextFile(join(clientPath, "testclient-old.html"));
	return new Response(
		html
			.replaceAll('href="style/', 'href="/style/')
			.replaceAll('href="favicon.ico"', 'href="/favicon.ico"')
			.replaceAll('src="pokemonshowdownbeta.png"', 'src="/pokemonshowdownbeta.png"')
			.replaceAll('src="js/', 'src="/js/')
			.replaceAll('src="data/', 'src="/data/'),
		{ headers: { "Content-Type": "text/html; charset=utf-8" } },
	);
}

async function proxyGet(upstream: string): Promise<Response> {
	const r = await fetch(upstream);
	if (!r.ok) return new Response("", { status: r.status });
	const contentType = r.headers.get("content-type") || "application/javascript";
	return new Response(r.body, { headers: { "Content-Type": contentType } });
}

async function serveOldClientSource(pathname: string): Promise<Response> {
	let js = await Deno.readTextFile(join(clientPath, "src", "oldclient", pathname.slice("/js/oldclient/".length)));
	if (pathname === "/js/oldclient/client.js") {
		js = js.replace(
			"\t\tgetActionPHP: function () {\n\t\t\tvar ret = '/~~' + Config.server.id + '/action.php';\n\t\t\tif (Config.testclient) {\n\t\t\t\tret = 'https://' + Config.routes.client + ret;\n\t\t\t}\n\t\t\treturn (this.getActionPHP = function () {\n\t\t\t\treturn ret;\n\t\t\t})();\n\t\t},\n",
			"\t\tgetActionPHP: function () {\n\t\t\tvar ret = '/~~' + Config.server.id + '/action.php';\n\t\t\tif (Config.loginServerProxy) {\n\t\t\t\tret = Config.loginServerProxy + '?serverid=' + encodeURIComponent(Config.server.id);\n\t\t\t} else if (Config.testclient) {\n\t\t\t\tret = 'https://' + Config.routes.client + ret;\n\t\t\t}\n\t\t\treturn (this.getActionPHP = function () {\n\t\t\t\treturn ret;\n\t\t\t})();\n\t\t},\n",
		);
	}
	return new Response(js, { headers: { "Content-Type": "application/javascript; charset=utf-8" } });
}

async function handleLoginProxy(req: Request, url: URL): Promise<Response> {
	const serverId = url.searchParams.get("serverid") || "showdown";
	const targetUrl = `https://play.pokemonshowdown.com/~~${serverId}/action.php`;
	try {
		const cookieHeader = req.headers.get("cookie") || "";
		const upstream = await fetch(targetUrl, {
			method: "POST",
			headers: {
				"Content-Type": req.headers.get("content-type") || "application/x-www-form-urlencoded",
				"Cookie": cookieHeader,
			},
			body: await req.arrayBuffer(),
		});

		const text = await upstream.text();
		const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });

		const setCookieHeaders = upstream.headers.getSetCookie?.() ?? [];
		for (const c of setCookieHeaders) {
			const rewritten = c
				.replace(/;\s*domain=[^;]*/gi, "")
				.replace(/;\s*secure/gi, "; Secure") + "; SameSite=Lax";
			headers.append("Set-Cookie", rewritten);
		}
		return new Response(text, { headers });
	} catch (err) {
		console.error("Login server proxy error:", err);
		return new Response("", { status: 500 });
	}
}

Deno.serve({ port }, async (req) => {
	const url = new URL(req.url);
	const { pathname } = url;

	try {
		if (req.method === "POST" && pathname === "/api/loginserver") {
			return await handleLoginProxy(req, url);
		}

		if (req.method !== "GET" && req.method !== "HEAD") {
			return new Response(null, { status: 405 });
		}

		if (pathname === "/" || pathname === "/hellodex") {
			return await serveBetaClient();
		}
		if (pathname === "/classic" || pathname === "/classic/") {
			return await serveClassicClient();
		}

		if (pathname.startsWith("/js/oldclient/")) {
			return await serveOldClientSource(pathname);
		}
		if (pathname.startsWith("/data/") || pathname.startsWith("/js/server/") || pathname === "/js/battledata.js") {
			return await proxyGet(`https://play.pokemonshowdown.com${pathname}`);
		}
		if (pathname.startsWith("/config/")) {
			if (pathname === "/config/testclient-key.js") {
				return new Response("// No testclient key configured", {
					headers: { "Content-Type": "application/javascript" },
				});
			}
			return await proxyGet(`https://play.pokemonshowdown.com${pathname}`);
		}

		// Static file under clientPath
		const fileResp = await serveDir(req, {
			fsRoot: clientPath,
			quiet: true,
		});
		if (fileResp.status !== 404) return fileResp;

		// SPA fallback
		return await serveBetaClient();
	} catch (err) {
		console.error("Request error:", err);
		return new Response("", { status: 500 });
	}
});

console.log(`Pokemon Showdown client running at http://localhost:${port}`);
console.log(`  - Beta client: http://localhost:${port}/`);
console.log(`  - Classic client: http://localhost:${port}/classic`);
