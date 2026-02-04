import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { join } from "path";

const clientPath = join(import.meta.dir, "play.pokemonshowdown.com");
const port = process.env.PORT || 4000;

const app = new Elysia()
	// Serve beta client at root
	.get("/hellodex", () => Bun.file(join(clientPath, "testclient-beta.html")))
	.get("/", () => Bun.file(join(clientPath, "testclient-beta.html")))

	// Serve classic client at /classic
	.get("/classic", () => Bun.file(join(clientPath, "testclient.html")))

	// Proxy missing data/config files to play.pokemonshowdown.com
	.get("/data/*", async ({ params, set }) => {
		const file = params["*"];
		const response = await fetch(`https://play.pokemonshowdown.com/data/${file}`);
		if (!response.ok) {
			set.status = response.status;
			return "";
		}
		set.headers["content-type"] = response.headers.get("content-type") || "application/javascript";
		return response.text();
	})
	.get("/js/server/*", async ({ params, set }) => {
		const file = params["*"];
		const response = await fetch(`https://play.pokemonshowdown.com/js/server/${file}`);
		if (!response.ok) {
			set.status = response.status;
			return "";
		}
		set.headers["content-type"] = response.headers.get("content-type") || "application/javascript";
		return response.text();
	})
	.get("/config/*", async ({ params, set }) => {
		const file = params["*"];
		// Don't proxy testclient-key.js - return empty to avoid errors
		if (file === "testclient-key.js") {
			set.headers["content-type"] = "application/javascript";
			return "// No testclient key configured";
		}
		const response = await fetch(`https://play.pokemonshowdown.com/config/${file}`);
		if (!response.ok) {
			set.status = response.status;
			return "";
		}
		set.headers["content-type"] = response.headers.get("content-type") || "application/javascript";
		return response.text();
	})

	// Login server proxy to avoid CORS issues
	.post("/api/loginserver", async ({ query, request, cookie, set }) => {
		const serverId = query.serverid || "showdown";
		const targetUrl = `https://play.pokemonshowdown.com/~~${serverId}/action.php`;

		try {
			const formData = await request.formData();
			const body = new URLSearchParams();
			for (const [key, value] of formData.entries()) {
				body.append(key, value.toString());
			}

			// Forward cookies from client to login server
			const cookieHeader = request.headers.get("cookie") || "";
			
			const response = await fetch(targetUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"Cookie": cookieHeader,
				},
				body: body.toString(),
			});

			const text = await response.text();
			
			// Forward Set-Cookie headers from login server to client
			// Use getSetCookie() if available (modern), otherwise fall back to getAll
			const setCookieHeaders: string[] = typeof response.headers.getSetCookie === 'function' 
				? response.headers.getSetCookie()
				: (response.headers as any).getAll?.("set-cookie") || [];
			
			if (setCookieHeaders.length > 0) {
				// Rewrite cookies to work on current domain
				const rewrittenCookies = setCookieHeaders.map((cookieStr: string) => {
					// Remove domain restriction so cookie works on proxy domain
					return cookieStr
						.replace(/;\s*domain=[^;]*/gi, "")
						.replace(/;\s*secure/gi, "; Secure")
						+ "; SameSite=Lax";
				});
				set.headers["set-cookie"] = rewrittenCookies;
			}
			
			return new Response(text, {
				headers: { "Content-Type": "text/plain" },
			});
		} catch (error) {
			console.error("Login server proxy error:", error);
			return new Response("", { status: 500 });
		}
	})

	// Serve static assets from play.pokemonshowdown.com directory
	.use(
		staticPlugin({
			assets: clientPath,
			prefix: "/",
		})
	)

	// Serve the index for any unmatched routes (SPA fallback)
	.onError(({ code }) => {
		if (code === "NOT_FOUND") {
			return Bun.file(join(clientPath, "testclient-beta.html"));
		}
	})

	.listen(port);

console.log(
	`Pokemon Showdown client running at http://localhost:${app.server?.port}`
);
console.log(`  - Beta client: http://localhost:${app.server?.port}/`);
console.log(`  - Classic client: http://localhost:${app.server?.port}/classic`);
