package chat.aircrew.go;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import java.io.File;
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
 *
 * 0.5.3 (Chris: "sometimes I'm not able to send messages"): Android may recreate the WebView/bridge
 * while the process (and TDLib) lives on. Before, every JS start created a NEW TDLib client on the same
 * database (→ "Can't lock file") and the static receive loop kept notifying the FIRST, dead plugin
 * instance (→ the page went deaf: no answers, Send stuck). Now: ONE TDLib client per process, reused
 * across JS restarts, and events always go to the live plugin instance.
 */
@CapacitorPlugin(name = "TdJson")
public class TdJsonPlugin extends Plugin {
    private static volatile Thread receiver;
    private static volatile TdJsonPlugin current;   // the LIVE plugin instance (the bridge can be recreated)
    private static int clientId = -1;               // ONE TDLib client per process, reused across JS restarts

    @Override
    public void load() { current = this; }

    private static synchronized void ensureReceiver() {
        if (receiver != null && receiver.isAlive()) return;
        receiver = new Thread(() -> {
            while (!Thread.currentThread().isInterrupted()) {
                String s = JsonClient.receive(1.0);
                TdJsonPlugin p = current;
                if (s != null && p != null) {
                    JSObject ev = new JSObject();
                    ev.put("json", s);
                    p.notifyListeners("td", ev);
                }
            }
        }, "tdlib-receive");
        receiver.setDaemon(true);
        receiver.start();
    }

    @PluginMethod
    public void create(PluginCall call) {
        boolean fresh = Boolean.TRUE.equals(call.getBoolean("fresh", false));   // e.g. after authorizationStateClosed
        boolean reused;
        int id;
        synchronized (TdJsonPlugin.class) {
            reused = clientId >= 0 && !fresh;
            if (!reused) clientId = JsonClient.createClientId();
            id = clientId;
        }
        current = this;
        ensureReceiver();
        JSObject r = new JSObject();
        r.put("clientId", id);
        r.put("reused", reused);
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

    /** Open a downloaded TDLib file with the matching Android app (APK -> system installer). */
    @PluginMethod
    public void openFile(PluginCall call) {
        String path = call.getString("path");
        String mime = call.getString("mime", "*/*");
        if (path == null) { call.reject("path is required"); return; }
        File f = new File(path);
        if (!f.exists()) { call.reject("file not found"); return; }
        Context ctx = getContext();
        boolean apk = "application/vnd.android.package-archive".equals(mime) || path.endsWith(".apk");
        if (apk && Build.VERSION.SDK_INT >= 26 && !ctx.getPackageManager().canRequestPackageInstalls()) {
            Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
            s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(s);
            JSObject r = new JSObject();
            r.put("needsPermission", true);
            call.resolve(r);
            return;
        }
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, apk ? "application/vnd.android.package-archive" : mime);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app on this phone can open this file type");
        }
    }
}
