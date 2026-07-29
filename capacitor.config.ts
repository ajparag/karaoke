import { CapacitorConfig } from '@capacitor/cli';

// =============================================================================
// capacitor.config.ts — KaraokeParty Android app
// =============================================================================
// androidScheme: 'https' -- makes the WebView serve content from
// https://localhost instead of the default file:// scheme. This matters
// because getUserMedia() (microphone access) and several Web APIs used by
// this app (Screen Wake Lock, MediaSession) require a secure context --
// file:// does not count as secure in all WebView versions, https:// does.
//
// IMPORTANT: after adding the android platform, you must allow the origin
// "https://localhost" in any CORS-restricted backend this app calls directly
// from the browser (not via Supabase edge functions, which already return
// Access-Control-Allow-Origin: * and are unaffected). Specifically:
//   - Modal's CORSMiddleware (modal_app.py) — add "https://localhost" to its
//     allowed origins list, or confirm it already allows "*".
// If this isn't done, vocal separation will fail with a CORS error when
// running inside the Android app (it will still work fine in the mobile
// browser at karaokeparty.in, since that's a different origin).
// =============================================================================

const config: CapacitorConfig = {
  appId: 'in.karaokeparty.app',
  appName: 'KaraokeParty',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    // Allow mixed content only if you have any http:// (non-https) audio
    // sources — you shouldn't, since JioSaavn/Gaana/YouTube/Modal are all
    // https. Left false (default/secure) intentionally.
    allowMixedContent: false,
  },
};

export default config;
