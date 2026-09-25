package app.mysignet;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SignetNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
