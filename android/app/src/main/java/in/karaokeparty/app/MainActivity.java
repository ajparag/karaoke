package in.karaokeparty.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

// =============================================================================
// MainActivity.java — KaraokeParty
// =============================================================================
// Destination: android/app/src/main/java/in/karaokeparty/app/MainActivity.java
// (Capacitor generates this file with an empty body when you run
// `npx cap add android` — replace its entire contents with this file.)
//
// WHY THIS EXISTS:
// Capacitor's default WebView never surfaces a microphone permission
// prompt. When the web app calls getUserMedia() (in useVocalsComparison.ts,
// via requestMicrophone() in audioPermissions.ts), the browser-side promise
// just rejects silently inside the WebView -- there's no equivalent of the
// "Allow karaokeparty.in to use your microphone?" prompt you'd see on
// desktop Chrome or mobile Chrome browser.
//
// Two permission layers have to both say yes before the mic works:
//   1. Android OS-level permission (RECORD_AUDIO) -- the same permission
//      dialog every native app shows ("Allow KaraokeParty to record
//      audio?"). Requested once, on app start, below.
//   2. WebView-level permission (PermissionRequest.RESOURCE_AUDIO_CAPTURE)
//      -- this is what getUserMedia() is actually waiting on. The WebView
//      fires onPermissionRequest() when JS calls getUserMedia(); we must
//      explicitly grant() it here, and we only do so if the OS-level
//      permission above was already accepted.
// =============================================================================

public class MainActivity extends BridgeActivity {

    private static final int MIC_PERMISSION_REQUEST_CODE = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Layer 1: request the OS-level microphone permission up front,
        // on app launch, rather than waiting for the user to tap Sing and
        // then confusingly nothing happening. If they deny it here, the
        // WebView-level grant below will correctly refuse mic access too,
        // and Sing.tsx's existing mic-error UI handles that gracefully.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                    this,
                    new String[]{Manifest.permission.RECORD_AUDIO},
                    MIC_PERMISSION_REQUEST_CODE
            );
        }

        // Layer 2: whenever the WebView's JS calls getUserMedia() for audio,
        // grant it -- but only if the OS-level permission is actually held.
        // Without this override, every getUserMedia() call in the app
        // (i.e. every time someone taps the mic toggle or presses Play)
        // fails immediately with no native prompt at all.
        this.bridge.getWebView().setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    for (String resource : request.getResources()) {
                        if (resource.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                            boolean granted = ContextCompat.checkSelfPermission(
                                    MainActivity.this, Manifest.permission.RECORD_AUDIO
                            ) == PackageManager.PERMISSION_GRANTED;

                            if (granted) {
                                request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                            } else {
                                request.deny();
                            }
                            return;
                        }
                    }
                    // Not an audio request (e.g. camera, which this app never
                    // uses) -- deny by default, principle of least privilege.
                    request.deny();
                });
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        // No extra action needed here -- if the user grants RECORD_AUDIO
        // after this callback, the next getUserMedia() call (e.g. tapping
        // the mic toggle again) will re-check the permission in
        // onPermissionRequest() above and succeed. If they deny it, the
        // web app's existing mic-error handling in useVocalsComparison.ts
        // takes over (shows the AudioDebugOverlay error state / mic-off icon).
    }
}
