// The one place that uses Playwright's screencast, which is new: if its API changes, only this
// file does.
import type { Page } from "playwright-core";

export interface Frame {
  /** A JPEG. */
  data: Buffer;
  width: number;
  height: number;
}

/** Send a page's frames while it changes. Returns how to stop. */
export async function startScreencast(page: Page, onFrame: (frame: Frame) => void) {
  await page.screencast.start({
    quality: 70,
    onFrame: ({ data, viewportWidth, viewportHeight }) =>
      onFrame({ data, width: viewportWidth, height: viewportHeight }),
  });
  return () => page.screencast.stop().catch(() => {});
}
