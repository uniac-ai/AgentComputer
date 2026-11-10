// A screencast that shows nothing is started again: the browser sometimes sends no first frame to
// one started as a tab opens, and a page that then stays still would never be seen.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { type Frame, startScreencast } from "../src/screencast.ts";

type OnFrame = (frame: { data: Buffer; viewportWidth: number; viewportHeight: number }) => void;

/** A page whose screencast sends a frame only when the test says so. */
function stillPage() {
  const calls: string[] = [];
  let onFrame: OnFrame | undefined;
  const page = {
    screencast: {
      start: async (options: { onFrame: OnFrame }) => {
        calls.push("start");
        onFrame = options.onFrame;
      },
      stop: async () => {
        calls.push("stop");
        onFrame = undefined;
      },
    },
  } as unknown as Page;
  const frame = () =>
    onFrame?.({ data: Buffer.from("jpeg"), viewportWidth: 800, viewportHeight: 600 });
  return { page, calls, frame };
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("a screencast that has shown nothing is started again, until a frame comes", async () => {
  const { page, calls, frame } = stillPage();
  const frames: Frame[] = [];
  const stop = await startScreencast(page, (one) => frames.push(one));
  assert.deepEqual(calls, ["start"]);

  await wait(700);
  assert.deepEqual(calls, ["start", "stop", "start"]);
  frame();
  assert.deepEqual(frames, [{ data: Buffer.from("jpeg"), width: 800, height: 600 }]);

  // Once a frame has come it is left alone, however still the page then is.
  await wait(1200);
  assert.deepEqual(calls, ["start", "stop", "start"]);
  await stop();
  assert.deepEqual(calls, ["start", "stop", "start", "stop"]);
});

test("a screencast that shows a frame at once is never started again", async () => {
  const { page, calls, frame } = stillPage();
  const stop = await startScreencast(page, () => {});
  frame();
  await wait(700);
  assert.deepEqual(calls, ["start"]);
  await stop();
});

test("a page that never shows anything is tried three times more, and stopping ends the trying", async () => {
  const { page, calls } = stillPage();
  const stop = await startScreencast(page, () => {});
  await wait(2500);
  assert.equal(calls.filter((call) => call === "start").length, 4);
  await stop();
  const stopped = calls.length;
  await wait(700);
  assert.equal(calls.length, stopped);

  const early = stillPage();
  await (await startScreencast(early.page, () => {}))();
  await wait(700);
  assert.deepEqual(early.calls, ["start", "stop"]);
});
