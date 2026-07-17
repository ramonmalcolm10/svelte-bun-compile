// Async IIFE for --bytecode compatibility (no top-level await)
(async () => {
	const { file, serve, env } = Bun;

	function intEnv(name: string, fallback: number): number {
		const parsed = Number.parseInt(env[name] ?? '', 10);
		return Number.isNaN(parsed) ? fallback : parsed;
	}

	// Parallel boot imports — keeps the entry TLA-free so --bytecode stays valid.
	const [assetsModule, manifestModule, serverModule] = await Promise.all([
		// @ts-expect-error generated at build time
		import('./assets.generated.ts'),
		// @ts-expect-error generated at build time
		import('../manifest.js'),
		// @ts-expect-error generated at build time (SvelteKit server bundle)
		import('../server/index.js')
	]);

	const { assetMap, contentTypeOverrides, redirects, serverAssetMap } = assetsModule as {
		assetMap: Map<string, string>;
		contentTypeOverrides: Map<string, string>;
		redirects: Map<string, { status: number; location: string }>;
		serverAssetMap: Map<string, string>;
	};

	type ServerType = import('@sveltejs/kit').Server;
	type SSRManifest = import('@sveltejs/kit').SSRManifest;

	const manifest = manifestModule.default as SSRManifest;
	const { Server } = serverModule as {
		Server: new (manifest: SSRManifest) => ServerType;
	};
	const svelteKitServer = new Server(manifest);
	await svelteKitServer.init({
		env: env as Record<string, string>,
		// Backs read() from $app/server — server assets are embedded in the
		// binary, so resolve manifest filenames against the embedded refs.
		read: (asset) => {
			const ref = serverAssetMap.get(asset);
			return ref ? file(ref).stream() : null;
		}
	});

	const immutablePrefix = `/${manifest.appDir}/immutable/`;

	// Build static routes from the embedded asset map. Bun's static-route
	// dispatch gives us, for free:
	//   - Automatic ETag generation (content hash) + If-None-Match → 304
	//   - SIMD-accelerated route matching with structure caching
	//   - Zero-allocation dispatch (~15%+ faster than a fetch handler)
	//
	// Aliases that point at the same embedded ref (e.g. /about and /about.html
	// both resolving to the prerendered file) share a single Response instance
	// so we don't double-buffer the bytes. All refs load concurrently.
	const responseByRef = new Map<string, Promise<Response>>();
	function loadResponse(urlPath: string, ref: string): Promise<Response> {
		let pending = responseByRef.get(ref);
		if (!pending) {
			const bunFile = file(ref);
			pending = bunFile.bytes().then(
				(bytes) =>
					new Response(bytes, {
						headers: {
							'Content-Type':
								contentTypeOverrides.get(urlPath) || bunFile.type || 'application/octet-stream',
							'Cache-Control': urlPath.startsWith(immutablePrefix)
								? 'public, max-age=31536000, immutable'
								: 'max-age=0, must-revalidate'
						}
					})
			);
			responseByRef.set(ref, pending);
		}
		return pending;
	}

	const routes: Record<string, Response> = {};
	await Promise.all(
		[...assetMap].map(async ([urlPath, ref]) => {
			routes[urlPath] = await loadResponse(urlPath, ref);
		})
	);

	// Redirects recorded during prerendering (redirect() in a prerendered load).
	for (const [urlPath, { status, location }] of redirects) {
		routes[urlPath] = new Response(null, { status, headers: { location } });
	}

	// Reverse-proxy support, mirroring adapter-node's env contract. Needed
	// when TLS terminates at an ingress/load balancer: the socket-level URL
	// says http://<pod>, which breaks form-action origin checks and url.origin.
	const origin = env.ORIGIN;
	const protocolHeader = env.PROTOCOL_HEADER?.toLowerCase();
	const hostHeader = env.HOST_HEADER?.toLowerCase();
	const portHeader = env.PORT_HEADER?.toLowerCase();
	const addressHeader = env.ADDRESS_HEADER?.toLowerCase();
	const xffDepth = intEnv('XFF_DEPTH', 1);
	if (addressHeader === 'x-forwarded-for' && xffDepth < 1) {
		throw new Error('XFF_DEPTH must be a positive integer');
	}
	const rewritesUrl = Boolean(origin || protocolHeader || hostHeader || portHeader);

	function forwardedUrl(req: Request): string {
		const url = new URL(req.url);
		if (origin) return origin + url.pathname + url.search;
		const proto =
			(protocolHeader && req.headers.get(protocolHeader)?.split(',')[0].trim()) ||
			url.protocol.slice(0, -1);
		let host = (hostHeader && req.headers.get(hostHeader)) || url.host;
		const port = portHeader && req.headers.get(portHeader);
		if (port) host = `${host.split(':')[0]}:${port}`;
		return `${proto}://${host}${url.pathname}${url.search}`;
	}

	let shuttingDown = false;

	const server = serve({
		port: intEnv('PORT', 3000),
		hostname: env.HOST || '0.0.0.0',
		idleTimeout: intEnv('BUN_IDLE_TIMEOUT', 255),
		routes,
		async fetch(req: Request, bunServer: Bun.Server<unknown>) {
			// Only reached on a static-route miss — SSR path.
			let request = req;
			if (rewritesUrl) {
				const url = forwardedUrl(req);
				if (url !== req.url) request = new Request(url, req);
			}
			return await svelteKitServer.respond(request, {
				getClientAddress() {
					if (addressHeader) {
						const value = req.headers.get(addressHeader) ?? '';
						if (addressHeader === 'x-forwarded-for') {
							const addresses = value.split(',');
							if (xffDepth > addresses.length) {
								throw new Error(
									`XFF_DEPTH is ${xffDepth}, but only found ${addresses.length} addresses`
								);
							}
							return addresses[addresses.length - xffDepth].trim();
						}
						return value;
					}
					return bunServer.requestIP(req)?.address || '127.0.0.1';
				}
			});
		},
		error(error) {
			console.error(error);
			return Response.json({ code: 500, message: 'Something went wrong' }, { status: 500 });
		}
	});

	async function gracefulShutdown(signal: NodeJS.Signals) {
		if (shuttingDown) return;
		shuttingDown = true;

		console.info(`Received ${signal}, stopping server...`);
		// Stop accepting new connections; in-flight requests (including open
		// SSE streams) get SHUTDOWN_TIMEOUT seconds to finish before being
		// force-closed.
		const force = setTimeout(() => server.stop(true), intEnv('SHUTDOWN_TIMEOUT', 30) * 1000);
		await server.stop();
		clearTimeout(force);
		// process is an EventEmitter — cast to access the generic emit signature
		// (@types/node's process.emit only enumerates known events).
		(process as import('node:events').EventEmitter).emit('sveltekit:shutdown', signal);
		console.info('Stopped server');
	}

	process.on('SIGTERM', gracefulShutdown);
	process.on('SIGINT', gracefulShutdown);

	console.log(`Listening on http://localhost:${server.port}`);
})();
