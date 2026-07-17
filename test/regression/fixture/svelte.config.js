import adapter from 'svelte-bun-compile';

/** @type {import('@sveltejs/kit').Config} */
export default {
	kit: {
		adapter: adapter()
	}
};
