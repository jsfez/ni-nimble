import { argosScreenshot } from '@argos-ci/playwright';
import { test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface StoryIndex {
    entries: Record<
    string,
    { id: string, title: string, name: string, type: string }
    >;
}

interface ChromaticParameters {
    disableSnapshot?: boolean;
    delay?: number;
    viewports?: number[];
}

const indexPath = fileURLToPath(
    new URL('../packages/storybook/dist/storybook/index.json', import.meta.url)
);
const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as StoryIndex;

// `ARGOS_ONLY=nimble-components-banner--outline-banner,...` narrows a local run
// to the stories being investigated instead of the whole index.
const only = process.env.ARGOS_ONLY?.split(',').map(s => s.trim());

const stories = Object.values(index.entries).filter(
    entry => entry.type === 'story' && (!only || only.includes(entry.id))
);

const DEFAULT_VIEWPORT = { width: 1200, height: 800 };

for (const story of stories) {
    test(`${story.title} › ${story.name}`, async ({ page }) => {
        // `chromatic=true` is what `src/utilities/isChromatic.ts` looks for, so
        // the stories that branch on it here behave exactly as they do in a
        // Chromatic run: the spinner animation stays paused, the table renders
        // its rows eagerly, the select opens without its animation.
        const storyUrl = `/iframe.html?id=${story.id}&viewMode=story&chromatic=true`;

        const readChromaticParameters = async () => await page.evaluate(
            id => (
                window as unknown as {
                    __STORYBOOK_PREVIEW__?: {
                        storyRenders?: {
                            id?: string,
                            story?: {
                                parameters?: { chromatic?: ChromaticParameters }
                            }
                        }[]
                    };
                }
            ).__STORYBOOK_PREVIEW__?.storyRenders?.find(
                render => render.id === id
            )?.story?.parameters?.chromatic ?? null,
            story.id
        );

        const waitForRender = async () => {
            // Some stories render into a portal (dialog, drawer, menu, tooltip)
            // and leave the Storybook root empty, so wait on the render phase
            // rather than on the root element. Storybook 10 tracks renders in
            // `storyRenders` rather than exposing a single `currentRender`.
            await page.waitForFunction(
                id => (
                    window as unknown as {
                        __STORYBOOK_PREVIEW__?: {
                            storyRenders?: { id?: string, phase?: string }[]
                        };
                    }
                ).__STORYBOOK_PREVIEW__?.storyRenders?.some(
                    render => render.id === id
                        && (render.phase === 'completed'
                            || render.phase === 'finished')
                ) === true,
                story.id
            );
        };

        await page.setViewportSize(DEFAULT_VIEWPORT);
        await page.goto(storyUrl);
        await waitForRender();

        const parameters = await readChromaticParameters();

        // Stories that opt out of snapshots today keep opting out.
        test.skip(
            parameters?.disableSnapshot === true,
            'story opts out of snapshots (chromatic parameter)'
        );

        // A story that pins its own `chromatic: { viewports: [...] }` is
        // captured at those widths and nowhere else, same as today.
        const viewports = parameters?.viewports?.length
            ? parameters.viewports
            : [DEFAULT_VIEWPORT.width];

        for (const width of viewports) {
            if (width !== DEFAULT_VIEWPORT.width || viewports.length > 1) {
                await page.setViewportSize({
                    width,
                    height: DEFAULT_VIEWPORT.height
                });
                await page.goto(storyUrl);
                await waitForRender();
            }

            if (parameters?.delay) {
                await page.waitForTimeout(parameters.delay);
            }

            // Nimble sizes controls from text metrics, so a capture taken
            // before Nunito Sans lands measures the fallback font. Wait for the
            // faces, then nudge the viewport so any observer re-measures.
            await page.evaluate(async () => await document.fonts.ready);
            await page.setViewportSize({
                width: width + 1,
                height: DEFAULT_VIEWPORT.height
            });
            await page.setViewportSize({
                width,
                height: DEFAULT_VIEWPORT.height
            });

            // Hold until the markup stops changing, capped so a story with a
            // running animation still gets captured.
            let previousMarkup = '';
            let stableSamples = 0;

            for (let i = 0; i < 40 && stableSamples < 3; i++) {
                // Every Nimble component renders into a shadow root and
                // `innerHTML` stops at the shadow boundary, so a table still
                // materialising its rows or an icon still resolving looks
                // settled from the light DOM. Walk the shadow roots too.
                const markup = await page.evaluate(() => {
                    const serialize = (
                        root: DocumentFragment | Element
                    ): string => {
                        let out = root.innerHTML;

                        for (const el of Array.from(
                            root.querySelectorAll('*')
                        )) {
                            if (el.shadowRoot) {
                                out += `<${el.tagName}>${serialize(
                                    el.shadowRoot
                                )}`;
                            }
                        }

                        return out;
                    };

                    return serialize(document.body);
                });

                stableSamples = markup === previousMarkup ? stableSamples + 1 : 0;
                previousMarkup = markup;
                if (stableSamples < 3) {
                    await page.waitForTimeout(250);
                }
            }

            // Settled markup is not a settled picture: a banner sliding in or a
            // drawer opening animates an inline `transform` without touching
            // the markup. Let every animation that has an end reach it, and
            // leave the endless ones (spinner) alone.
            await page.evaluate(async () => {
                const finite = document.getAnimations().filter(animation => {
                    const { endTime } = animation.effect?.getComputedTiming() ?? {};

                    return (
                        animation.playState === 'running'
                        && typeof endTime === 'number'
                        && Number.isFinite(endTime)
                    );
                });

                await Promise.race([
                    Promise.all(
                        finite.map(
                            async animation => await animation.finished.catch(
                                () => undefined
                            )
                        )
                    ),
                    new Promise(resolve => setTimeout(resolve, 2000))
                ]);
            });

            // Virtualised tables, dropdown lists and toolbars can settle on an
            // arbitrary offset: pin every scroll position, inside shadow roots
            // too, before capturing.
            await page.evaluate(() => {
                const pin = (root: DocumentFragment | Document): void => {
                    for (const el of Array.from(root.querySelectorAll('*'))) {
                        if (el.scrollLeft !== 0) {
                            el.scrollLeft = 0;
                        }
                        if (el.scrollTop !== 0) {
                            el.scrollTop = 0;
                        }
                        if (el.shadowRoot) {
                            pin(el.shadowRoot);
                        }
                    }
                };

                pin(document);
            });

            // The spinner stories are `aria-busy` for as long as they are
            // mounted, which is the state they exist to show. Read that off the
            // DOM instead of guessing from the story name; the markup has
            // already held still above, so anything still busy is intended.
            const staysBusy = await page.evaluate(
                () => document.querySelector('[aria-busy="true"]') !== null
            );

            const name = viewports.length > 1 ? `${story.id}-${width}` : story.id;

            // Capture the body rather than the viewport: its box is exactly the
            // rendered story, which matches the crop the current runs produce
            // and keeps a small change from being diluted in empty canvas.
            // Portals mount into the body, so overlays stay in frame.
            await argosScreenshot(page, name, {
                element: 'body',
                stabilize: { waitForAriaBusy: !staysBusy }
            });
        }
    });
}
