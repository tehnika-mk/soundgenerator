// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://soundgenerator.app',
  trailingSlash: 'ignore',
  build: {
    // All audio is generated client-side; there is no server runtime.
    format: 'directory',
  },
  integrations: [
    sitemap({
      // /dev is the internal DSP harness; /og-card is the social preview source.
      filter: (page) => !page.includes('/dev/') && !page.includes('/og-card'),
      // Build date: honest "last modified" for a fully static site.
      lastmod: new Date(),
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
  compressHTML: true,
});
