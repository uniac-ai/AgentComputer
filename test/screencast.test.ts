// A screencast that shows nothing is started again: the browser sometimes sends no first frame to
// one started as a tab opens, and a page that then stays still would never be seen.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { type Frame, startScreencast } from "../src/screencast.ts";

type OnFrame = (frame: { data: Buffer; viewportWidth: number; viewportHeight: number }) => void;

/**
 * A page whose screencast sends its one frame only from the start numbered `showsAt`, counting
 * from 1, or never. A start can be held open, to stop it part way.
 */
function stillPage(showsAt?: number) {
  const calls: string[] = [];
  let starts = 0;
  let hold: Promise<void> | undefined;
  const page = {
    screencast: {
      start: async (options: { onFrame: OnFrame }) => {
        calls.push("start");
        await hold;
        if (++starts === showsAt)
          options.onFrame({ data: Buffer.from("jpeg"), viewportWidth: 800, viewportHeight: 600 });
      },
      stop: async () => {
        calls.push("stop");
      },
    },
  } as unknown as Page;
  return {
    page,
    calls,
    starts: () => calls.filter((call) => call === "start").length,
    /** Make the next starts wait until the returned function is called. */
    holdStarts() {
      let release = () => {};
      hold = new Promise((done) => {
        release = done;
      });
      return release;
    },
  };
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Waited too long for ${what}.`);
    await wait(20);
  }
}
/** Longer than two more tries would take, to see that none is made. */
const QUIET_MS = 1300;

test("a screencast that has shown nothing is started again, and left alone once a frame comes", async () => {
  const { page, calls } = stillPage(2);
  const frames: Frame[] = [];
  const stop = await startScreencast(page, (one) => frames.push(one));
  assert.deepEqual(calls, ["start"]);
  await until(() => frames.length === 1, "the frame of its second start");
  assert.deepEqual(frames, [{ data: Buffer.from("jpeg"), width: 800, height: 600 }]);
  await wait(QUIET_MS);
  assert.deepEqual(calls, ["start", "stop", "start"]);
  await stop();
  assert.deepEqual(calls, ["start", "stop", "start", "stop"]);
});

test("a screencast that shows a frame at once is never started again", async () => {
  const { page, calls } = stillPage(1);
  const stop = await startScreencast(page, () => {});
  await wait(QUIET_MS);
  assert.deepEqual(calls, ["start"]);
  await stop();
});

test("a page that never shows anything is tried three times more and then left", async () => {
  const { page, calls, starts } = stillPage();
  const stop = await startScreencast(page, () => {});
  await until(() => starts() === 4, "its three more tries");
  await wait(QUIET_MS);
  assert.equal(starts(), 4);
  await stop();
  assert.equal(calls.at(-1), "stop");
});

test("stopping ends the trying, before a try and part way through one", async () => {
  const early = stillPage();
  await (await startScreencast(early.page, () => {}))();
  await wait(QUIET_MS);
  assert.deepEqual(early.calls, ["start", "stop"]);

  // Stopped while its second start is still on its way: no third is made.
  const late = stillPage();
  const stop = await startScreencast(late.page, () => {});
  const release = late.holdStarts();
  await until(() => late.starts() === 2, "its second start");
  await stop();
  release();
  await wait(QUIET_MS);
  assert.equal(late.starts(), 2);
  assert.equal(late.calls.at(-1), "stop");
});
