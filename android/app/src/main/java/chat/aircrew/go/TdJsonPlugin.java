package chat.aircrew.go;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
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
    public void load() { current = this; registerNetworkWatch(); }

    // ---- 0.5.4: tell TDLib about network changes the moment Android reports them -------------------------------
    // Chris: "Connecting…" for a while after every app switch. Samsung blocks a backgrounded app's network while
    // the process lives; TDLib keeps failing, its retry backoff grows, and after returning the next retry is far
    // away. TDLib docs: setNetworkType "forces all network connections to reopen … must be called whenever the
    // network is changed". The WebView's online/offline events don't fire reliably, so do it natively:
    // default-network callback → on UNBLOCKED (app back in front) / new network / type change → setNetworkType.
    private static ConnectivityManager.NetworkCallback netWatch;
    private static String lastType = null;          // last type sent (or seen at registration)

    private void registerNetworkWatch() {
        synchronized (TdJsonPlugin.class) { if (netWatch != null) return; }
        ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        ConnectivityManager.NetworkCallback cb = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network n) { nudge(typeOf(cm, n), "network available", lastType == null); }
            @Override public void onLost(Network n) { nudge("networkTypeNone", "network lost", false); }
            @Override public void onCapabilitiesChanged(Network n, NetworkCapabilities c) {
                String t = typeOf(c);
                if (lastType != null && !t.equals(lastType) && !"networkTypeNone".equals(lastType)) nudge(t, "network type changed", false);
            }
            @Override public void onBlockedStatusChanged(Network n, boolean blocked) {
                if (blocked) emit("net: Android BLOCKED the app's network (background)");
                // log only: measured on the emulator, TDLib starts reconnecting by itself on resume (~1.7–2.1 s);
                // a setNetworkType at/after the unblock RESTARTS that attempt (median 4.3 s). JS rescues if stuck.
                else emit("net: Android UNBLOCKED the app's network");
            }
        };
        try {
            cm.registerDefaultNetworkCallback(cb);
            synchronized (TdJsonPlugin.class) { netWatch = cb; }
        } catch (RuntimeException e) { emit("net: watch not available: " + e.getMessage()); }
    }

    private static String typeOf(ConnectivityManager cm, Network n) {
        return typeOf(cm.getNetworkCapabilities(n));
    }
    private static String typeOf(NetworkCapabilities c) {
        if (c == null) return "networkTypeOther";
        if (c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return "networkTypeWiFi";
        if (c.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return c.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_ROAMING) ? "networkTypeMobile" : "networkTypeMobileRoaming";
        return "networkTypeOther";
    }

    /** setNetworkType straight into the shared TDLib client. initial=true only records the type (no reconnect at start). */
    private static void nudge(String type, String reason, boolean initial) {
        lastType = type;
        if (initial) { emit("net: watching (" + type.replace("networkType", "") + ")"); return; }
        int id;
        synchronized (TdJsonPlugin.class) { id = clientId; }
        if (id < 0) return;
        JsonClient.send(id, "{\"@type\":\"setNetworkType\",\"type\":{\"@type\":\"" + type + "\"}}");
        emit("net: setNetworkType " + type.replace("networkType", "") + " (" + reason + ")");
    }

    /** Diagnostics line for the JS ring log (event "net"). */
    private static void emit(String line) {
        TdJsonPlugin p = current;
        if (p == null) return;
        JSObject ev = new JSObject();
        ev.put("line", line);
        p.notifyListeners("net", ev, true);
    }

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
