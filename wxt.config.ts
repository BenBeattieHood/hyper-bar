import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';
import { manifestKey, shortcutBinding } from './entrypoints/lib/shortcuts';

// One id for everything a build emits, so a page can tell when the browser is still running an older background worker.
const buildId = new Date().toISOString();

export default defineConfig({
  outDir: 'output',
  // End-to-end runs build beside the folder a browser has loaded unpacked, never over it.
  ...(process.env.HYPER_E2E_BUILD ? { outDirTemplate: '{{browser}}-mv{{manifestVersion}}-e2e' } : {}),
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    build: {
      modulePreload: {
        resolveDependencies: (_filename, dependencies, { hostId, hostType }) =>
          hostType === 'html' && /(?:^|\/)newtab(?:\/index)?\.html$/.test(hostId)
            ? []
            : dependencies,
      },
    },
    define: {
      'import.meta.env.HYPER_BUILD_ID': JSON.stringify(buildId),
    },
    optimizeDeps: {
      entries: ['entrypoints/**/*.html'],
    },
    resolve: {
      alias: {
        flexsearch: fileURLToPath(new URL(
          'node_modules/flexsearch/dist/flexsearch.light.module.min.js',
          import.meta.url,
        )),
      },
    },
  }),
  manifest: ({ browser, command }) => {
    const isFirefox = browser === 'firefox';
    return {
      name: command === 'serve' ? 'Hyper (Dev)' : 'Hyper',
      description: 'A spatial sidebar for bookmarks and tabs.',
      version: '0.1.0',
      ...(!isFirefox && { minimum_chrome_version: '116' }),
      permissions: isFirefox
        ? [
            'bookmarks',
            'clipboardRead',
            'clipboardWrite',
            'history',
            'search',
            'sessions',
            'storage',
            'tabs',
            'webNavigation',
          ]
        : [
            'bookmarks',
            'clipboardRead',
            'clipboardWrite',
            'favicon',
            'history',
            'search',
            'sessions',
            'sidePanel',
            'storage',
            'tabGroups',
            'tabs',
            'webNavigation',
          ],
      ...(!isFirefox && {
        optional_permissions: ['scripting'],
        optional_host_permissions: ['http://*/*', 'https://*/*'],
      }),
      ...(isFirefox && {
        browser_specific_settings: {
          gecko: {
            id: 'hyper',
            data_collection_permissions: { required: ['none'] },
          },
        },
      }),
      action: {
        default_title: 'Open Hyper',
      },
      commands: {
        [isFirefox ? 'open-command-bar' : '_execute_action']: {
          suggested_key: {
            default: manifestKey(shortcutBinding('openHyper', isFirefox), 'default'),
            mac: manifestKey(shortcutBinding('openHyper', isFirefox), 'mac'),
          },
          ...(isFirefox && { description: 'Open the Hyper command bar' }),
        },
      },
      chrome_url_overrides: {
        newtab: 'newtab.html',
      },
      web_accessible_resources: isFirefox
        ? ['newtab.html', 'inpage.html', 'assets/*', 'chunks/*']
        : [{
            resources: ['newtab.html', 'inpage.html', 'assets/*', 'chunks/*'],
            matches: ['http://*/*', 'https://*/*'],
          }],
    };
  },
});
