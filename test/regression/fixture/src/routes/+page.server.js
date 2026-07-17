// No prerender flag — this route stays dynamic (SSR at request time).
export function load() {
	return { renderedAt: Date.now() };
}
