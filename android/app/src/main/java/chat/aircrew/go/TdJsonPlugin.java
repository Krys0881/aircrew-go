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
