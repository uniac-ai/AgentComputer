// The one place that uses Playwright's screencast, which is new: if its API changes, only this
// file does.
import type { Page } from "playwright-core";

export interface Frame {
  /** A JPEG. */
  data: Buffer;
  width: number;
  height: number;
}

/** How long a screencast may show nothing before it is started again, and how many times. */
const FIRST_FRAME_MS = 500;
const RESTARTS = 3;

/**
 * Send a page's frames while it changes. Returns how to stop.
 *
 * A frame comes only when the page changes, apart from one as the screencast starts. One started
 * as a tab opens can miss that one, and a page that then stays still would never be seen. So a
 * screencast that has shown nothing after a moment is started again, when the page has settled.
 */
export async function startScreencast(page: Page, onFrame: (frame: Frame) => void) {
  let seen = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const start = () =>
    page.screencast.start({
      quality: 70,
      onFrame: ({ data, viewportWidth, viewportHeight }) => {
        seen = true;
        onFrame({ data, width: viewportWidth, height: viewportHeight });
      },
    });
  await start();
  const again = (left: number) => {
    timer = setTimeout(async () => {
      if (seen || stopped || left === 0) return;
      await page.screencast.stop().catch(() => {});
      if (stopped) return;
      await start().catch(() => {});
      again(left - 1);
    }, FIRST_FRAME_MS);
  };
  again(RESTARTS);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await page.screencast.stop().catch(() => {});
  };
}
