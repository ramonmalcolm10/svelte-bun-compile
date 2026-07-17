import { join, relative, parse, normalize } from 'node:path';
import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Adapter, Builder } from '@sveltejs/kit';

const ADAPTER_NAME = 'svelte-bun-compile';
const SVELTEKIT_DIR = `.svelte-kit/${ADAPTER_NAME}`;

export type AdapterOptions = {
	/** Output directory for the binary. Default: "dist". */
	out?: string;
	/** Binary filename (no extension on POSIX, `.exe` is appended on Windows). Default: "app". */
	binaryName?: string;
	/** Cross-compile target. Omit to build for the current platform. */
	target?: Bun.CompileBuildOptions['target'];
	/**
	 * Bun.build option overrides. Sensible production defaults are applied
	 * (minify, bytecode, linked sourcemap, NODE_ENV=production) — set to
	 * override on a per-key basis. `compile` overrides are merged so the
	 * outfile is preserved.
	 */
	bun?: Partial<Parameters<typeof Bun.build>[0]>;
};

type Asset = {
	filePath: string;
	routePath: string;
	varName: string;
	isPrerendered: boolean;
};

// --- Asset utilities ---

function generateVarName(filePath: string): string {
	const { name, ext } = parse(filePath);
	let cleanName = name
		.replace(/[^a-zA-Z0-9]/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_|_$/g, '');
	if (/^[0-9]/.test(cleanName)) cleanName = `asset_${cleanName}`;
	if (!cleanName) cleanName = 'asset';
	const normalizedPath = normalize(filePath).replace(/\\/g, '/');
	const pathHash = createHash('md5').update(normalizedPath).digest('hex').slice(0, 8);
	const extSuffix = ext.replace('.', '').toUpperCase();
	return `${cleanName}_${extSuffix}_${pathHash}`;
}

async function discoverAssets(clientDir: string, prerenderedDir: string): Promise<Asset[]> {
	const assets: Asset[] = [];

	async function walk(dir: string, isPrerendered: boolean): Promise<void> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return; // dir does not exist (e.g. no prerendered pages)
		}
		const dirPromises: Promise<void>[] = [];
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				dirPromises.push(walk(fullPath, isPrerendered));
			} else {
				const routePath =
					'/' + relative(isPrerendered ? prerenderedDir : clientDir, fullPath).replace(/\\/g, '/');
				assets.push({
					filePath: fullPath,
					routePath,
					varName: generateVarName(routePath),
					isPrerendered
				});
			}
		}
		await Promise.all(dirPromises);
	}

	await Promise.all([walk(clientDir, false), walk(prerenderedDir, true)]);
	// Concurrent walks push in scheduling order — sort so the generated
	// module (and therefore the binary) is reproducible.
	assets.sort((a, b) => a.routePath.localeCompare(b.routePath));
	return assets;
}

function generateAssetModule(
	assets: Asset[],
	prerendered: Builder['prerendered'],
	serverAssets: string[]
): string {
	const byRoutePath = new Map(assets.map((a) => [a.routePath, a]));

	const imports = assets.map((a) => {
		const rel = (a.isPrerendered ? '../prerendered' : '../client') + a.routePath;
		return `import ${a.varName} from ${JSON.stringify(rel)} with { type: "file" };`;
	});

	const mapEntries = assets.map((a) => `  [${JSON.stringify(a.routePath)}, ${a.varName}]`);

	// Pretty URL aliases for prerendered pages (/about → about.html), exactly
	// as recorded by the prerenderer — respects the app's trailingSlash config.
	for (const [path, { file }] of prerendered.pages) {
		const asset = byRoutePath.get('/' + file);
		if (asset && path !== asset.routePath) {
			mapEntries.push(`  [${JSON.stringify(path)}, ${asset.varName}]`);
		}
	}

	// Content types recorded by the prerenderer — covers extensionless files
	// (e.g. a prerendered /api/health) that MIME inference would get wrong.
	const overrideEntries = [...prerendered.assets].map(
		([path, { type }]) => `  [${JSON.stringify(path)}, ${JSON.stringify(type)}]`
	);

	const redirectEntries = [...prerendered.redirects].map(
		([path, { status, location }]) =>
			`  [${JSON.stringify(path)}, { status: ${status}, location: ${JSON.stringify(location)} }]`
	);

	const serverImports: string[] = [];
	const serverEntries: string[] = [];
	[...serverAssets].sort().forEach((file, i) => {
		const varName = `server_asset_${i}`;
		serverImports.push(
			`import ${varName} from ${JSON.stringify('../server/' + file)} with { type: "file" };`
		);
		serverEntries.push(`  [${JSON.stringify(file)}, ${varName}]`);
	});

	return `// Auto-generated asset imports
// @ts-nocheck
${imports.join('\n')}
${serverImports.join('\n')}

export const assetMap = new Map([
${mapEntries.join(',\n')}
]);

export const contentTypeOverrides = new Map([
${overrideEntries.join(',\n')}
]);

export const redirects = new Map([
${redirectEntries.join(',\n')}
]);

// Assets read via read() from $app/server, keyed by manifest filename.
export const serverAssetMap = new Map([
${serverEntries.join(',\n')}
]);
`;
}

// --- Compilation ---

async function compileApplication(
	builder: Builder,
	opts: Required<Pick<AdapterOptions, 'out' | 'binaryName'>> &
		Pick<AdapterOptions, 'target' | 'bun'>
): Promise<string> {
	if (typeof Bun === 'undefined') {
		throw new Error(
			`${ADAPTER_NAME} needs the Bun runtime to compile the binary — run the build with \`bun --bun vite build\``
		);
	}

	const entrypoint = join(SVELTEKIT_DIR, 'temp-server/index.ts');
	const isWindows = process.platform === 'win32';
	const outfile = join(opts.out, opts.binaryName + (isWindows ? '.exe' : ''));

	// Sensible production defaults — user can override any key via opts.bun.
	// NOTE: when `compile` is set, `outfile` MUST live inside the compile
	// object; a top-level `outfile` is silently ignored for standalone builds.
	// User-supplied `compile` overrides are merged key-by-key so they cannot
	// accidentally drop the outfile.
	const { compile: compileOverrides, ...bunOverrides } = opts.bun ?? {};
	const buildConfig: Parameters<typeof Bun.build>[0] = {
		entrypoints: [entrypoint],
		minify: true,
		sourcemap: 'linked',
		bytecode: true,
		define: {
			'process.env.NODE_ENV': JSON.stringify('production')
		},
		...bunOverrides,
		compile: {
			outfile,
			...(opts.target && { target: opts.target }),
			...(typeof compileOverrides === 'object' ? compileOverrides : {})
		}
	};

	const result = await Bun.build(buildConfig);

	if (!result.success) {
		for (const log of result.logs) {
			builder.log.error(String(log));
		}
		throw new Error('Bun.build failed');
	}

	return outfile;
}

// --- Adapter ---

export default function adapter(options: AdapterOptions = {}): Adapter {
	return {
		name: ADAPTER_NAME,

		async adapt(builder) {
			const opts = {
				out: options.out ?? 'dist',
				binaryName: options.binaryName ?? 'app',
				target: options.target,
				bun: options.bun
			};

			// Clean and prepare directories
			builder.rimraf(SVELTEKIT_DIR);
			builder.mkdirp(SVELTEKIT_DIR);
			builder.rimraf(opts.out);
			builder.mkdirp(opts.out);

			// Write SvelteKit outputs
			builder.writeClient(join(SVELTEKIT_DIR, 'client'));
			builder.writePrerendered(join(SVELTEKIT_DIR, 'prerendered'));
			builder.writeServer(join(SVELTEKIT_DIR, 'server'));
			builder.rimraf(join(SVELTEKIT_DIR, 'server', '_app'));
			builder.log.success('SvelteKit build output written');

			// Copy server template
			const serverTemplatePath = join(import.meta.dirname, 'server.ts');
			builder.copy(serverTemplatePath, join(SVELTEKIT_DIR, 'temp-server/index.ts'));
			builder.log.success('Server template copied');

			// Generate manifest
			const manifest = builder.generateManifest({ relativePath: './server' });
			await writeFile(
				join(SVELTEKIT_DIR, 'manifest.js'),
				`const manifest = ${manifest};\nexport default manifest;`,
				'utf-8'
			);
			builder.log.success('Manifest generated');

			// Server assets consumed via read() from $app/server — embedded so
			// the compiled binary can serve them without a filesystem.
			const serverAssets = builder
				.findServerAssets(builder.routes)
				.filter((file) => existsSync(join(SVELTEKIT_DIR, 'server', file)));

			// Generate embedded asset imports — assets always baked into binary
			const assets = await discoverAssets(
				join(SVELTEKIT_DIR, 'client'),
				join(SVELTEKIT_DIR, 'prerendered')
			);
			await writeFile(
				join(SVELTEKIT_DIR, 'temp-server/assets.generated.ts'),
				generateAssetModule(assets, builder.prerendered, serverAssets)
			);
			builder.log.success('Assets embedded');

			// Compile
			const binaryPath = await compileApplication(builder, opts);
			builder.log.success(`Compiled: ./${binaryPath}`);
		},

		supports: {
			read: () => true
		}
	};
}
