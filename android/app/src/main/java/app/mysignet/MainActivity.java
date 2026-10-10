package app.mysignet;

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
