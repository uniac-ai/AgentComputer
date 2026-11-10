// Text in pieces small enough for one live message each.

/**
 * The most of a terminal's text that one message carries. A character, a UTF-16 unit, is six bytes
 * of JSON at most, so this many always fit in a message of 65,536 bytes with the rest of it.
 */
export const MAX_TEXT = 10_000;

/** A text as pieces of at most `most` characters, no pair of them that is one cut in two. */
export function* pieces(text: string, most = MAX_TEXT) {
  for (let from = 0; from < text.length; ) {
    let to = Math.min(from + most, text.length);
    const last = text.charCodeAt(to - 1);
    if (to < text.length && last >= 0xd800 && last <= 0xdbff) to -= 1;
    yield text.slice(from, to);
    from = to;
  }
}
