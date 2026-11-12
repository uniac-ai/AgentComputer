// A screenshot too large to pass on is refused in its answer, however the answer was sent.
import assert from "node:assert/strict";
import test from "node:test";
import { changed, withoutLarge } from "../src/browser.ts";

const MOST = 3 * 1024 * 1024;
const answerOf = (bytes: number) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        { type: "text", text: "### Result" },
        { type: "image", mimeType: "image/png", data: Buffer.alloc(bytes).toString("base64") },
      ],
    },
  });
const refusal = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    isError: true,
    content: [
      {
        type: "text",
        text: "The screenshot is 3.1 MiB, and the most a screenshot may be is 3 MiB. Take it again without fullPage for what is on screen, or with element and target for one part of the page.",
      },
    ],
  },
});

test("a screenshot of the most is passed on, and one a byte larger is refused", () => {
  const ways = [
    (json: string) => json,
    (json: string) => `event: message\nid: 7\ndata: ${json}\n\n`,
  ];
  for (const sent of ways) {
    assert.equal(changed(sent(answerOf(MOST)), withoutLarge), sent(answerOf(MOST)));
    assert.equal(changed(sent(answerOf(MOST + 1)), withoutLarge), sent(refusal));
  }
  // An answer with no picture in it, or none at all, is left as it is.
  const failed = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "No." } });
  assert.equal(changed(failed, withoutLarge), failed);
});
