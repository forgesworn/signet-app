package app.mysignet;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {

    /**
     * A page that kept serving after its activity was swiped away (always-on
     * bunker). Its unlock key stays in its own JS memory; nothing is handed to
     * native. Released when a newer page unlocks (claimServing) or when it is
     * found dead at the next launch.
     */
    private static Bridge parkedBridge;

    /** The page that last heartbeated as an unlocked, serving page. */
    private static volatile Bridge servingBridge;

    static void noteServing(Bridge candidate) {
        servingBridge = candidate;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SignetNativePlugin.class);
        super.onCreate(savedInstanceState);
        // The WebView renderer is a separate process whose priority is waived
        // while the page is not visible; a parked page is never visible.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && bridge != null) {
            bridge.getWebView().setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        if (parkedBridge != null && !BunkerForegroundService.isServingPersistently(this)) {
            releaseParked();
        }
    }

    /**
     * Relies on Capacitor 8.5.2: BridgeActivity.onDestroy and
     * onDetachedFromWindow only touch the bridge when `bridge != null`, and
     * Bridge.onDestroy / Bridge.onDetachedFromWindow are what stop the plugin
     * thread and destroy the WebView. Nulling `bridge` first keeps the page
     * (and its NIP-46 server) running in the foreground-service process.
     */
    @Override
    public void onDestroy() {
        maybePark();
        super.onDestroy();
    }

    @Override
    public void onDetachedFromWindow() {
        maybePark();
        super.onDetachedFromWindow();
    }

    private void maybePark() {
        // Only the page that is actually serving parks. A locked page swiped
        // away (e.g. opened on the PIN screen while another page is parked)
        // is destroyed normally and must not displace the parked one.
        if (bridge == null || bridge != servingBridge || isChangingConfigurations()) return;
        if (!BunkerForegroundService.isServingPersistently(this)) return;
        releaseParked();
        parkedBridge = bridge;
        bridge = null;
        // Any NIP-55 request now launches a fresh page to decide on it; a
        // parked page has no screen to ask on.
        PluginHandle handle = parkedBridge.getPlugin("SignetNative");
        if (handle != null && handle.getInstance() instanceof SignetNativePlugin) {
            ((SignetNativePlugin) handle.getInstance()).detachNip55();
        }
    }

    /** True when `candidate` is the parked page (it must never release itself). */
    static boolean isParked(Bridge candidate) {
        return candidate != null && candidate == parkedBridge;
    }

    /** Stops a parked page. Main thread only. */
    static void releaseParked() {
        Bridge parked = parkedBridge;
        parkedBridge = null;
        if (parked == null) return;
        if (servingBridge == parked) servingBridge = null;
        try {
            parked.onDestroy();
            parked.onDetachedFromWindow();
        } catch (Throwable ignored) {
            // the page is going either way
        }
    }
}
