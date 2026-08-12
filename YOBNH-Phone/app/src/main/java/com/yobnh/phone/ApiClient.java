package com.yobnh.phone;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.AsyncTask;
import android.util.Base64;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class ApiClient {

    public interface Callback {
        void onResult(boolean ok, String message, String data);
    }

    public static class Settings {
        public final String serverUrl;
        public final String token;

        Settings(String serverUrl, String token) {
            this.serverUrl = serverUrl;
            this.token = token;
        }
    }

    public static Settings loadSettings(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences("yobnh_phone", Context.MODE_PRIVATE);
        String url = prefs.getString("server_url", "");
        String token = prefs.getString("token", "");
        return new Settings(url, token);
    }

    public static void saveSettings(Context ctx, String serverUrl, String token) {
        SharedPreferences prefs = ctx.getSharedPreferences("yobnh_phone", Context.MODE_PRIVATE);
        prefs.edit().putString("server_url", serverUrl.trim()).putString("token", token.trim()).apply();
    }

    public static String normalizeUrl(String serverUrl) {
        String url = serverUrl.trim();
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://" + url;
        return url;
    }

    public static void ping(String serverUrl, String token, Callback cb) {
        new Task("GET", normalizeUrl(serverUrl) + "/api/phone/ping", null, token, cb).execute();
    }

    public static void sendMessage(String serverUrl, String token, String text, Callback cb) {
        JSONObject body = new JSONObject();
        try {
            body.put("text", text);
        } catch (Exception ignored) {
        }
        new Task("POST", normalizeUrl(serverUrl) + "/api/phone/message", body, token, cb).execute();
    }

    public static void sendFile(String serverUrl, String token, String fileName, byte[] data, Callback cb) {
        String b64 = Base64.encodeToString(data, Base64.NO_WRAP);
        JSONObject body = new JSONObject();
        try {
            body.put("name", fileName);
            body.put("data", b64);
        } catch (Exception ignored) {
        }
        new Task("POST", normalizeUrl(serverUrl) + "/api/phone/file", body, token, cb).execute();
    }

    public static void sendVoice(String serverUrl, String token, String fileName, byte[] data, Callback cb) {
        String b64 = Base64.encodeToString(data, Base64.NO_WRAP);
        JSONObject body = new JSONObject();
        try {
            body.put("name", fileName);
            body.put("data", b64);
        } catch (Exception ignored) {
        }
        new Task("POST", normalizeUrl(serverUrl) + "/api/phone/voice", body, token, cb).execute();
    }

    private static class Task extends AsyncTask<Void, Void, String[]> {
        final String method;
        final String url;
        final JSONObject body;
        final String token;
        final Callback cb;
        boolean ok = false;

        Task(String method, String url, JSONObject body, String token, Callback cb) {
            this.method = method;
            this.url = url;
            this.body = body;
            this.token = token;
            this.cb = cb;
        }

        @Override
        protected String[] doInBackground(Void... voids) {
            HttpURLConnection conn = null;
            try {
                URL u = new URL(url);
                conn = (HttpURLConnection) u.openConnection();
                conn.setRequestMethod(method);
                conn.setRequestProperty("X-Phone-Token", token);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(60000);

                if (body != null) {
                    conn.setDoOutput(true);
                    byte[] out = body.toString().getBytes(StandardCharsets.UTF_8);
                    conn.setFixedLengthStreamingMode(out.length);
                    try (OutputStream os = conn.getOutputStream()) {
                        os.write(out);
                    }
                }

                int code = conn.getResponseCode();
                ok = code >= 200 && code < 300;
                InputStream is = ok ? conn.getInputStream() : conn.getErrorStream();
                String resp = "";
                if (is != null) {
                    StringBuilder sb = new StringBuilder();
                    BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
                    String line;
                    while ((line = br.readLine()) != null) sb.append(line);
                    resp = sb.toString();
                }
                return new String[]{String.valueOf(code), resp};
            } catch (Exception e) {
                return new String[]{"-1", e.getMessage() == null ? "Network error" : e.getMessage()};
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        @Override
        protected void onPostExecute(String[] result) {
            if (cb != null) cb.onResult(ok, result[1], result[0]);
        }
    }
}
