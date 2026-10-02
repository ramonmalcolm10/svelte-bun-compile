# svelte-bun-compile

> [!WARNING]
> **Deprecated.** SvelteKit now ships its own Bun adapter,
> [`@sveltejs/adapter-bun`](https://svelte.dev/docs/kit/adapter-bun), which
> compiles your app into a single executable too. Switch to it:
>
> ```sh
> bun remove svelte-bun-compile && bun add -D @sveltejs/adapter-bun
> ```
>
> ```js
> import adapter from '@sveltejs/adapter-bun';
> // the executable is written to build/server
> adapter({ buildOptions: { compile: 'bun-linux-x64' } }); // or bun-linux-arm64, or true for this machine
> ```
>
> Then build with `bun --bun run build`. This package gets no further releases.

**Compile your SvelteKit app into a Bun single-file executable.**

Sibling of [next-bun-compile](https://www.npmjs.com/package/next-bun-compile).
Your whole app — server, client assets, prerendered pages — becomes one
self-contained binary. No `node_modules` on the server, no runtime to
install, static assets served from memory with automatic ETags. Ship it
with `scp`, run it with systemd, or deploy it with
[Homeport](https://github.com/homeport-sh/homeport).

## Usage

```bash
bun add -d svelte-bun-compile
```

```js
// svelte.config.js
import adapter from 'svelte-bun-compile';

/** @type {import('@sveltejs/kit').Config} */
export default {
	kit: {
		adapter: adapter()
	}
};
```

Build **with the Bun runtime** (the adapter uses `Bun.build` to compile):

```bash
bun --bun vite build
./dist/app        # → Listening on http://localhost:3000
```

## Options

```js
adapter({
	out: 'dist',          // output directory
	binaryName: 'app',    // binary filename (.exe appended on Windows)
	target: 'bun-linux-x64',  // cross-compile target; omit for current platform
	bun: {                // Bun.build overrides, merged over production defaults
		// defaults: minify, bytecode, linked sourcemap, NODE_ENV=production
	}
});
```

Cross-compile targets: `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`,
`bun-windows-x64`, and friends — build on macOS, deploy to Linux.

## What the binary does

- **Static & prerendered routes from memory** via Bun's static route dispatch:
  automatic ETag + `If-None-Match` → 304, immutable cache headers for
  `/_app/immutable/*`, zero-allocation matching.
- **Pretty URLs** for prerendered pages (`/about` and `/about.html` share one
  in-memory response) and prerendered redirects served without touching SSR.
- **SSR** for everything else through SvelteKit's server, including
  `read()` from `$app/server` — server assets are embedded too.
- **Reverse-proxy aware** — same env contract as `adapter-node`:
  `ORIGIN`, `PROTOCOL_HEADER`, `HOST_HEADER`, `PORT_HEADER`,
  `ADDRESS_HEADER`, `XFF_DEPTH`.
- **Graceful shutdown** on SIGINT/SIGTERM: stops accepting connections,
  gives in-flight requests `SHUTDOWN_TIMEOUT` seconds (default 30), emits
  `sveltekit:shutdown`.

## Runtime environment

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | listen port |
| `HOST` | `0.0.0.0` | bind address |
| `ORIGIN` | — | canonical origin behind a proxy |
| `PROTOCOL_HEADER` / `HOST_HEADER` / `PORT_HEADER` | — | forwarded-URL reconstruction |
| `ADDRESS_HEADER`, `XFF_DEPTH` | —, `1` | client IP behind proxies |
| `SHUTDOWN_TIMEOUT` | `30` | seconds before in-flight requests are force-closed |
| `BUN_IDLE_TIMEOUT` | `255` | socket idle timeout (seconds) |

## Requirements

- [Bun](https://bun.sh) ≥ 1.2 to build (`bun --bun vite build`) — the compiled
  binary itself needs nothing.
- SvelteKit 2.

## License

MIT
