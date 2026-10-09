package com.lizarcrush.game;

import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * In-app updater for builds installed outside Google Play.
 *
 * Builds are published as GitHub releases tagged build-<versionCode> with one .apk asset.
 * The game page talks to this through window.LizarNative and receives answers on
 * window.LizarUpdate.onResult / onProgress / onError.
 *
 * The page also runs player mods, so nothing here trusts page input: only APKs attached to
 * releases of the configured repository are ever downloaded, and Android's own installer still
 * asks the player before anything is installed.
 */
public class UpdateBridge {
    private static final Pattern TAG = Pattern.compile("^build-(\\d+)$");
    private static final String API = "https://api.github.com/repos/" + BuildConfig.UPDATE_REPO + "/releases?per_page=15";
    private static final String ALLOWED_DOWNLOAD = "https://github.com/" + BuildConfig.UPDATE_REPO + "/releases/download/";

    private final MainActivity activity;
    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean busy = false;
    private File pendingApk = null;
    private boolean waitingForInstallPermission = false;

    UpdateBridge(MainActivity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    @JavascriptInterface
    public int getVersionCode() { return BuildConfig.VERSION_CODE; }

    @JavascriptInterface
    public String getVersionName() { return BuildConfig.VERSION_NAME; }

    /** The display's current refresh rate, its supported rates and the rate the app asked for (JSON). */
    @JavascriptInterface
    public String getDisplayInfo() {
        JSONObject out = new JSONObject();
        try {
            android.view.Display d = activity.getWindowManager().getDefaultDisplay();
            out.put("refresh", d.getRefreshRate());
            JSONArray modes = new JSONArray();
            for (android.view.Display.Mode m : d.getSupportedModes()) modes.put(m.getRefreshRate());
            out.put("modes", modes);
            out.put("requested", activity.getWindow().getAttributes().preferredRefreshRate);
        } catch (Exception ignored) { }
        return out.toString();
    }

    /** Looks for the newest build-N release with an APK. manual=true when the player tapped the button. */
    @JavascriptInterface
    public void checkForUpdate(final boolean manual) {
        new Thread(() -> {
            JSONObject out = new JSONObject();
            try {
                out.put("manual", manual);
                out.put("currentCode", BuildConfig.VERSION_CODE);
                out.put("currentName", BuildConfig.VERSION_NAME);
                JSONArray releases = new JSONArray(httpGet(API));
                int bestCode = -1;
                JSONObject best = null;
                String bestApk = null;
                for (int i = 0; i < releases.length(); i++) {
                    JSONObject rel = releases.getJSONObject(i);
                    if (rel.optBoolean("draft")) continue;
                    Matcher m = TAG.matcher(rel.optString("tag_name"));
                    if (!m.matches()) continue;
                    int code = Integer.parseInt(m.group(1));
                    if (code <= bestCode) continue;
                    String apk = null;
                    JSONArray assets = rel.optJSONArray("assets");
                    for (int a = 0; assets != null && a < assets.length(); a++) {
                        String url = assets.getJSONObject(a).optString("browser_download_url");
                        if (url.endsWith(".apk") && url.startsWith(ALLOWED_DOWNLOAD)) { apk = url; break; }
                    }
                    if (apk == null) continue;
                    bestCode = code; best = rel; bestApk = apk;
                }
                out.put("ok", true);
                out.put("available", best != null && bestCode > BuildConfig.VERSION_CODE);
                if (best != null) {
                    out.put("latestCode", bestCode);
                    out.put("latestName", best.optString("name", "Build " + bestCode));
                    String notes = best.optString("body", "");
                    out.put("notes", notes.length() > 600 ? notes.substring(0, 600) + "…" : notes);
                    out.put("url", bestApk);
                }
            } catch (Exception e) {
                try { out.put("ok", false); out.put("error", "Could not reach the update server."); } catch (Exception ignored) { }
            }
            callJs("onResult", out.toString());
        }).start();
    }

    /** Downloads the APK and hands it to Android's installer. */
    @JavascriptInterface
    public void downloadAndInstall(final String url) {
        if (url == null || !url.startsWith(ALLOWED_DOWNLOAD) || !url.endsWith(".apk")) {
            callJs("onError", JSONObject.quote("This update link is not from the official releases."));
            return;
        }
        if (busy) return;
        busy = true;
        new Thread(() -> {
            try {
                File dir = new File(activity.getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("no cache dir");
                File apk = new File(dir, "lizar-crush-update.apk");
                download(url, apk);
                pendingApk = apk;
                main.post(this::installPending);
            } catch (Exception e) {
                callJs("onError", JSONObject.quote("Download failed. Check your connection and try again."));
            } finally {
                busy = false;
            }
        }).start();
    }

    void onResume() {
        // Back from the "allow installs from this app" screen: continue where we stopped.
        if (waitingForInstallPermission && pendingApk != null) {
            waitingForInstallPermission = false;
            if (activity.getPackageManager().canRequestPackageInstalls()) installPending();
            else callJs("onError", JSONObject.quote("Installing updates needs permission to install apps from LIZAR CRUSH."));
        }
    }

    private void installPending() {
        if (pendingApk == null || !pendingApk.exists()) return;
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            waitingForInstallPermission = true;
            callJs("onPermission", "true");
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(i);
            return;
        }
        Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".updates", pendingApk);
        Intent install = new Intent(Intent.ACTION_VIEW);
        install.setDataAndType(uri, "application/vnd.android.package-archive");
        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.startActivity(install);
    }

    private void download(String url, File target) throws Exception {
        HttpURLConnection c = open(url);
        int total = c.getContentLength();
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(target)) {
            byte[] buf = new byte[64 * 1024];
            long done = 0;
            int lastPct = -1, n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
                done += n;
                if (total > 0) {
                    int pct = (int) (done * 100 / total);
                    if (pct != lastPct) { lastPct = pct; callJs("onProgress", String.valueOf(pct)); }
                }
            }
        } finally {
            c.disconnect();
        }
    }

    private String httpGet(String url) throws Exception {
        HttpURLConnection c = open(url);
        c.setRequestProperty("Accept", "application/vnd.github+json");
        try (InputStream in = c.getInputStream()) {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
            return bos.toString("UTF-8");
        } finally {
            c.disconnect();
        }
    }

    private HttpURLConnection open(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true); // GitHub release assets redirect to their CDN (https only)
        c.setRequestProperty("User-Agent", "LizarCrush/" + BuildConfig.VERSION_NAME);
        if (c.getResponseCode() >= 400) throw new Exception("HTTP " + c.getResponseCode());
        return c;
    }

    private void callJs(final String fn, final String arg) {
        main.post(() -> webView.evaluateJavascript(
                "window.LizarUpdate && window.LizarUpdate." + fn + " && window.LizarUpdate." + fn + "(" + arg + ");",
                null));
    }
}
