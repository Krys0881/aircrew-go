package chat.aircrew.go;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.drinkless.tdlib.JsonClient;

/**
 * Thin bridge to TDLib's JSON interface (libtdjsonjava.so, built with TDLIB_INTERFACE=JSONJava).
 * One global receive loop delivers every TDLib response/update to JS as a raw JSON string
 * (event "td"); the JS shim (src/td.ts) routes by @client_id and @extra.
 */
@CapacitorPlugin(name = "TdJson")
public class TdJsonPlugin extends Plugin {
    private static volatile Thread receiver;

    private synchronized void ensureReceiver() {
        if (receiver != null && receiver.isAlive()) return;
        receiver = new Thread(() -> {
            while (!Thread.currentThread().isInterrupted()) {
                String s = JsonClient.receive(1.0);
                if (s != null) {
                    JSObject ev = new JSObject();
                    ev.put("json", s);
                    notifyListeners("td", ev);
                }
            }
        }, "tdlib-receive");
        receiver.setDaemon(true);
        receiver.start();
    }

    @PluginMethod
    public void create(PluginCall call) {
        int id = JsonClient.createClientId();
        ensureReceiver();
        JSObject r = new JSObject();
        r.put("clientId", id);
        r.put("filesDir", getContext().getFilesDir().getAbsolutePath());
        r.put("cacheDir", getContext().getCacheDir().getAbsolutePath());
        call.resolve(r);
    }

    @PluginMethod
    public void send(PluginCall call) {
        Integer id = call.getInt("clientId");
        String json = call.getString("json");
        if (id == null || json == null) { call.reject("clientId and json are required"); return; }
        JsonClient.send(id, json);
        call.resolve();
    }

    @PluginMethod
    public void execute(PluginCall call) {
        String json = call.getString("json");
        if (json == null) { call.reject("json is required"); return; }
        JSObject r = new JSObject();
        r.put("json", JsonClient.execute(json));
        call.resolve(r);
    }
}
