package app.mysignet;

import android.app.PendingIntent;
import android.content.Intent;
import android.nfc.NfcAdapter;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * Chromium freezes a hidden page 60 s after it is hidden (page lifecycle
     * "freeze": timers, WebSocket events, everything), which stopped the
     * NIP-46 server about a minute after the screen went off or the app went
     * to the background. While always-on serving is set, keep telling the
     * WebView its window is visible so the page is never frozen. Checked on
     * device (GrapheneOS, Vanadium WebView): frozen at 60 s without this,
     * alive past 6 min with it.
     *
     * Always-on only: a temporary serving window must still see the page as
     * hidden when it ends, so a backgrounded app locks at once.
     *
     * A swiped-away app cannot be kept: the WebView is detached from any
     * window and no visibility signal reaches it. onDestroy says so instead.
     *
     * A pulse, not a hold: held visible, the stopped WebView asked for a frame
     * on every vsync that it could never draw (Chromium's begin-frame source
     * on the main thread, ~13% of a core in the background, measured
     * 2026-10-10). Marking it visible for a moment every 30 s still resets the
     * 60 s freeze, and the frame requests stop in between.
     */
    private static final long KEEP_VISIBLE_MS = 30_000;
    private static final long PULSE_MS = 1_000;
    private final Handler keepVisibleHandler = new Handler(Looper.getMainLooper());
    private boolean started = false;
    private final Runnable hideAgain = new Runnable() {
        @Override
        public void run() {
            if (!started && bridge != null) bridge.getWebView().dispatchWindowVisibilityChanged(View.INVISIBLE);
        }
    };
    private final Runnable keepVisible = new Runnable() {
        @Override
        public void run() {
            if (bridge != null && BunkerForegroundService.isAlwaysOn(MainActivity.this)) {
                bridge.getWebView().dispatchWindowVisibilityChanged(View.VISIBLE);
                keepVisibleHandler.postDelayed(hideAgain, PULSE_MS);
            }
            keepVisibleHandler.postDelayed(this, KEEP_VISIBLE_MS);
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SignetNativePlugin.class);
        super.onCreate(savedInstanceState);
        // The WebView renderer is a separate process whose priority is waived
        // while the page is not visible; a backgrounded bunker page is not.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && bridge != null) {
            bridge.getWebView().setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
    }

    /**
     * While this app is on screen it takes every NFC tag the system would
     * otherwise dispatch, and drops it. Two phones held back to back for a
     * Handshake read each other as tags whenever My Signet is not in reader
     * mode (before the screen opens, between its card slots); with nothing to
     * open them, the system toasts "no supported app" (seen on the OnePlus 8T,
     * 2026-10-11). Reader mode still wins while it is on, so Handshake reads
     * are unaffected. The cost: a tag touched while My Signet is in front does
     * nothing. Released in onPause, as Android requires.
     */
    @Override
    public void onResume() {
        super.onResume();
        NfcAdapter adapter = NfcAdapter.getDefaultAdapter(this);
        if (adapter == null) return;
        Intent self = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        // Mutable: the system adds the tag to it.
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
        try {
            adapter.enableForegroundDispatch(this, PendingIntent.getActivity(this, 0, self, flags), null, null);
        } catch (Exception ignored) {}
    }

    @Override
    public void onPause() {
        NfcAdapter adapter = NfcAdapter.getDefaultAdapter(this);
        if (adapter != null) try { adapter.disableForegroundDispatch(this); } catch (Exception ignored) {}
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // A claimed tag: dropped here, so no plugin sees it as an app link.
        String action = intent == null ? null : intent.getAction();
        if (NfcAdapter.ACTION_TAG_DISCOVERED.equals(action) || NfcAdapter.ACTION_TECH_DISCOVERED.equals(action)
                || NfcAdapter.ACTION_NDEF_DISCOVERED.equals(action)) return;
        super.onNewIntent(intent);
    }

    @Override
    public void onStart() {
        super.onStart();
        started = true;
        keepVisibleHandler.removeCallbacks(keepVisible);
        keepVisibleHandler.removeCallbacks(hideAgain);
        // A pulse may have left it marked invisible; on screen, it is visible.
        if (bridge != null) bridge.getWebView().dispatchWindowVisibilityChanged(View.VISIBLE);
    }

    @Override
    public void onStop() {
        super.onStop();
        started = false;
        keepVisibleHandler.removeCallbacks(keepVisible);
        keepVisibleHandler.removeCallbacks(hideAgain);
        keepVisibleHandler.postDelayed(keepVisible, 1_000);
    }

    @Override
    public void onDestroy() {
        keepVisibleHandler.removeCallbacks(keepVisible);
        keepVisibleHandler.removeCallbacks(hideAgain);
        // Swiped away (or otherwise finished) while serving: signing stops
        // with the page, so say so now rather than after the heartbeat lapses.
        if (!isChangingConfigurations() && BunkerForegroundService.isServingPersistently(this)) {
            BunkerForegroundService.pageClosed(getApplicationContext());
        }
        super.onDestroy();
    }
}
