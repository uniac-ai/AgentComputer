// The one place that uses Playwright's screencast, which is new: if its API changes, only this
// file does.
import type { Page } from "playwright-core";

export interface Frame {
  /** A JPEG. */
  data: Buffer;
  width: number;
  height: number;
}

/**
 * How long a screencast may show nothing before it is started again. A first frame that is coming
 * comes within a fraction of this; a new tab has settled by the end of it.
 */
const FIRST_FRAME_MS = 500;
/**
 * How many times it is started again. One has been enough wherever it was measured; after the
 * last, a page that still shows nothing is left until it changes.
 */
const RESTARTS = 3;

/**
 * Send a page's frames while it changes. Returns how to stop.
 *
 * A frame comes only when the page changes, apart from one as the screencast starts. One started
 * as a tab opens sometimes gets no frame at all from the browser, and a page that then stays still
 * would never be seen. So a screencast that has shown nothing after a moment is started again,
 * when the page has settled. This was seen with the playwright-core this is pinned to, and is
 * worth measuring again when that moves.
 */
export async function startScreencast(page: Page, onFrame: (frame: Frame) => void) {
  let seen = false;
  let stopped = false;
  const start = () =>
    page.screencast.start({
      quality: 70,
      onFrame: ({ data, viewportWidth, viewportHeight }) => {
        seen = true;
        onFrame({ data, width: viewportWidth, height: viewportHeight });
      },
    });
  await start();
  void (async () => {
    for (let left = RESTARTS; left > 0; left--) {
      await new Promise((done) => setTimeout(done, FIRST_FRAME_MS).unref());
      if (seen || stopped) return;
      await page.screencast.stop().catch(() => {});
      if (stopped) return;
      // If it can't be started again, as when the page has closed, there is nothing more to try.
      if (
        !(await start()
          .then(() => true)
          .catch(() => false))
      )
        return;
    }
  })();
  return async () => {
    stopped = true;
    await page.screencast.stop().catch(() => {});
  };
}
