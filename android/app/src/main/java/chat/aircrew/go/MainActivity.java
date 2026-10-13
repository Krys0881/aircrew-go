package chat.aircrew.go;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TdJsonPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
