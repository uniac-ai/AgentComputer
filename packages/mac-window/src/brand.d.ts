// The names the window shows, from the app's brand file (`packages/mac/brand.json`), put in at build
// time by scripts/build.js.
declare const BRAND: {
  /** The app's name. */
  name: string;
  /** Its bundle identifier. */
  identifier: string;
  /** The client the app lends this Mac to. */
  client: string;
  controls: { heading: string; entry: string };
};
