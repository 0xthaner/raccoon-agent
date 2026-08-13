import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
	build: {
		rollupOptions: {
			input: {
				main: resolve('web/index.html'),
				demoRenew: resolve('web/demo-renew.html'),
				guide: resolve('web/guide.html')
			}
		}
	}
});
