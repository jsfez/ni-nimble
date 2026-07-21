import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: '.',
    testMatch: 'stories.spec.ts',
    timeout: 60_000,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 4 : 6,
    fullyParallel: true,
    reporter:
        process.env.ARGOS_TOKEN || process.env.CI
            ? [['list'], ['@argos-ci/playwright/reporter']]
            : 'list',
    use: {
        baseURL: 'http://127.0.0.1:6016',
        contextOptions: { reducedMotion: 'reduce' }
    },
    webServer: {
        command:
            'npx http-server ../packages/storybook/dist/storybook --port 6016 --silent',
        url: 'http://127.0.0.1:6016/iframe.html',
        reuseExistingServer: true,
        timeout: 60_000
    }
});
