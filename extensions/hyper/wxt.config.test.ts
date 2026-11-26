import { describe, expect, it } from 'vitest';
import config from './wxt.config';

async function viteConfig() {
  if (typeof config.vite !== 'function') {
    throw new Error('Expected a Vite configuration callback.');
  }
  return config.vite({
    browser: 'chrome',
    command: 'build',
    manifestVersion: 3,
    mode: 'production',
  });
}

async function manifestFor(browser: 'chrome' | 'firefox', manifestVersion: 2 | 3) {
  if (typeof config.manifest !== 'function') {
    throw new Error('Expected a browser-aware manifest configuration.');
  }
  return config.manifest({
    browser,
    command: 'build',
    manifestVersion,
    mode: 'production',
  });
}

describe('extension build', () => {
  it('does not preload chunks across browser new-tab worlds', async () => {
    const vite = await viteConfig();
    const modulePreload = vite.build?.modulePreload;
    if (!modulePreload || typeof modulePreload !== 'object') {
      throw new Error('Expected scoped module preload configuration.');
    }
    const resolveDependencies = modulePreload.resolveDependencies;
    if (!resolveDependencies) {
      throw new Error('Expected module preload dependency filtering.');
    }
    const dependencies = ['chunks/windowState.js'];

    expect(resolveDependencies('chunks/newtab.js', dependencies, {
      hostId: 'entrypoints/newtab/index.html',
      hostType: 'html',
    })).toEqual([]);
    expect(resolveDependencies('chunks/sidepanel.js', dependencies, {
      hostId: 'entrypoints/sidepanel/index.html',
      hostType: 'html',
    })).toBe(dependencies);
  });

  // WXT builds the worker and the pages as separate groups, so an id minted per group would make every page see a stale worker.
  it('stamps every entrypoint group with one build id', async () => {
    const first = (await viteConfig()).define?.['import.meta.env.HYPER_BUILD_ID'];
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = (await viteConfig()).define?.['import.meta.env.HYPER_BUILD_ID'];

    expect(JSON.parse(first)).toEqual(expect.any(String));
    expect(second).toBe(first);
  });
});

describe('extension manifest', () => {
  it('reserves browser commands for the fallback instead of Print', async () => {
    const manifests = await Promise.all([
      manifestFor('chrome', 3),
      manifestFor('firefox', 2),
    ]);

    for (const manifest of manifests) {
      for (const command of Object.values(manifest.commands ?? {})) {
        const suggestedKeys = typeof command.suggested_key === 'string'
          ? [command.suggested_key]
          : [command.suggested_key?.default, command.suggested_key?.mac];
        expect(suggestedKeys).not.toContain('Ctrl+P');
        expect(suggestedKeys).not.toContain('Command+P');
      }
    }
  });

  it('sets the Firefox extension id and data-collection declaration', async () => {
    const manifest = await manifestFor('firefox', 2);

    expect(manifest.browser_specific_settings?.gecko).toMatchObject({
      id: 'hyper',
      data_collection_permissions: { required: ['none'] },
    });
    expect(manifest.permissions).not.toContain('tabGroups');
    expect(manifest.permissions).toEqual(expect.arrayContaining([
      'clipboardRead',
      'clipboardWrite',
      'sessions',
      'webNavigation',
    ]));
    expect(manifest.commands?.['open-command-bar']?.suggested_key).toEqual({
      default: 'Alt+Shift+H',
      mac: 'Alt+Shift+H',
    });
    expect(manifest.chrome_url_overrides).toEqual({ newtab: 'newtab.html' });
  });

  it('keeps Firefox-only settings out of Chromium', async () => {
    const manifest = await manifestFor('chrome', 3);

    expect(manifest.browser_specific_settings).toBeUndefined();
    expect(manifest.permissions).toContain('tabGroups');
    expect(manifest.permissions).toEqual(expect.arrayContaining([
      'clipboardRead',
      'clipboardWrite',
      'sessions',
      'webNavigation',
    ]));
    expect(manifest.minimum_chrome_version).toBe('116');
    expect(manifest.commands?.['_execute_action']?.suggested_key).toEqual({
      default: 'Ctrl+Shift+P',
      mac: 'Command+Shift+P',
    });
    expect(manifest.commands?.['open-command-bar']).toBeUndefined();
    expect(manifest.chrome_url_overrides).toEqual({ newtab: 'newtab.html' });
  });
});