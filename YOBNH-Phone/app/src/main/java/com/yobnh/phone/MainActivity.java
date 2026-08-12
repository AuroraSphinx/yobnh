package com.yobnh.phone;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class MainActivity extends AppCompatActivity {

    private static final int REQUEST_FILE = 1001;
    private static final int REQUEST_MIC = 1002;

    private EditText serverUrlInput;
    private EditText tokenInput;
    private EditText messageInput;
    private TextView statusText;
    private TextView alertsBody;
    private Button recordVoiceBtn;

    private MediaRecorder recorder;
    private String voiceFile;
    private boolean recording = false;
    private final Handler pollHandler = new Handler(Looper.getMainLooper());
    private long lastAlertId = 0;

    private final Runnable poller = new Runnable() {
        @Override
        public void run() {
            pollAlerts();
            pollHandler.postDelayed(this, 5000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        serverUrlInput = findViewById(R.id.serverUrl);
        tokenInput = findViewById(R.id.token);
        messageInput = findViewById(R.id.messageInput);
        statusText = findViewById(R.id.status);
        alertsBody = findViewById(R.id.alertsBody);
        recordVoiceBtn = findViewById(R.id.recordVoice);

        ApiClient.Settings s = ApiClient.loadSettings(this);
        serverUrlInput.setText(s.serverUrl);
        tokenInput.setText(s.token);

        findViewById(R.id.saveSettings).setOnClickListener(v -> saveSettings());
        findViewById(R.id.sendMessage).setOnClickListener(v -> sendMessage());
        findViewById(R.id.sendFile).setOnClickListener(v -> pickFile());
        recordVoiceBtn.setOnClickListener(v -> toggleRecording());

        lastAlertId = System.currentTimeMillis() / 1000;
        pollHandler.post(poller);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        pollHandler.removeCallbacks(poller);
        stopRecorder();
    }

    private void saveSettings() {
        ApiClient.saveSettings(this, serverUrlInput.getText().toString(), tokenInput.getText().toString());
        ApiClient.Settings s = ApiClient.loadSettings(this);
        if (s.serverUrl.isEmpty()) {
            statusText.setText("Set a server URL first.");
            return;
        }
        statusText.setText("Connecting...");
        ApiClient.ping(s.serverUrl, s.token, (ok, msg, code) -> runOnUiThread(() -> {
            if (ok) statusText.setText("Connected. Listening for alerts...");
            else statusText.setText("Connection failed: " + msg);
        }));
    }

    private void sendMessage() {
        String text = messageInput.getText().toString().trim();
        if (text.isEmpty()) {
            Toast.makeText(this, "Type a message first.", Toast.LENGTH_SHORT).show();
            return;
        }
        ApiClient.Settings s = ApiClient.loadSettings(this);
        if (s.serverUrl.isEmpty()) {
            statusText.setText("Set a server URL first.");
            return;
        }
        statusText.setText("Sending message...");
        ApiClient.sendMessage(s.serverUrl, s.token, text, (ok, msg, code) -> runOnUiThread(() -> {
            if (ok) {
                statusText.setText("Message sent.");
                messageInput.setText("");
            } else {
                statusText.setText("Send failed: " + msg);
            }
        }));
    }

    private void pickFile() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        startActivityForResult(intent, REQUEST_FILE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_FILE && resultCode == Activity.RESULT_OK && data != null) {
            Uri uri = data.getData();
            if (uri != null) {
                statusText.setText("Uploading file...");
                String fileName = queryFileName(uri);
                new Thread(() -> {
                    try {
                        byte[] bytes = readUriBytes(uri);
                        ApiClient.Settings s = ApiClient.loadSettings(this);
                        ApiClient.sendFile(s.serverUrl, s.token, fileName, bytes, (ok, msg, code) -> runOnUiThread(() -> {
                            if (ok) statusText.setText("File sent: " + fileName);
                            else statusText.setText("File send failed: " + msg);
                        }));
                    } catch (Exception e) {
                        runOnUiThread(() -> statusText.setText("File error: " + e.getMessage()));
                    }
                }).start();
            }
        }
    }

    private String queryFileName(Uri uri) {
        try (android.database.Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) return cursor.getString(idx);
            }
        } catch (Exception ignored) {
        }
        return "file_" + System.currentTimeMillis();
    }

    private byte[] readUriBytes(Uri uri) throws Exception {
        try (InputStream is = getContentResolver().openInputStream(uri);
             ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
            return bos.toByteArray();
        }
    }

    private void toggleRecording() {
        if (recording) {
            stopAndSendVoice();
        } else {
            requestMicAndStart();
        }
    }

    private void requestMicAndStart() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_MIC);
            return;
        }
        startRecording();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_MIC && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startRecording();
        } else {
            Toast.makeText(this, "Microphone permission needed for voice mails.", Toast.LENGTH_LONG).show();
        }
    }

    private void startRecording() {
        try {
            File dir = new File(getCacheDir(), "voice");
            if (!dir.exists()) dir.mkdirs();
            voiceFile = new File(dir, "voicemail_" + System.currentTimeMillis() + ".m4a").getAbsolutePath();
            recorder = new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioSamplingRate(44100);
            recorder.setAudioEncodingBitRate(128000);
            recorder.setOutputFile(voiceFile);
            recorder.prepare();
            recorder.start();
            recording = true;
            recordVoiceBtn.setText(R.string.stop_voice);
            statusText.setText("Recording voice mail... tap Stop & send when done.");
        } catch (Exception e) {
            statusText.setText("Could not start recording: " + e.getMessage());
        }
    }

    private void stopAndSendVoice() {
        stopRecorder();
        if (voiceFile == null) return;
        final String path = voiceFile;
        statusText.setText("Uploading voice mail...");
        new Thread(() -> {
            try {
                byte[] bytes = readFileBytes(path);
                ApiClient.Settings s = ApiClient.loadSettings(this);
                ApiClient.sendVoice(s.serverUrl, s.token, new File(path).getName(), bytes, (ok, msg, code) -> runOnUiThread(() -> {
                    if (ok) statusText.setText("Voice mail sent.");
                    else statusText.setText("Voice mail failed: " + msg);
                }));
            } catch (Exception e) {
                runOnUiThread(() -> statusText.setText("Voice error: " + e.getMessage()));
            }
        }).start();
    }

    private void stopRecorder() {
        if (recorder != null) {
            try {
                recorder.stop();
            } catch (Exception ignored) {
            }
            recorder.release();
            recorder = null;
        }
        recording = false;
        recordVoiceBtn.setText(R.string.record_voice);
    }

    private byte[] readFileBytes(String path) throws Exception {
        try (FileInputStream fis = new FileInputStream(path);
             ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = fis.read(buf)) != -1) bos.write(buf, 0, n);
            return bos.toByteArray();
        }
    }

    private void pollAlerts() {
        ApiClient.Settings s = ApiClient.loadSettings(this);
        if (s.serverUrl.isEmpty()) return;
        String url = ApiClient.normalizeUrl(s.serverUrl) + "/api/phone/alerts?after=" + lastAlertId;
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                URL u = new URL(url);
                conn = (HttpURLConnection) u.openConnection();
                conn.setRequestMethod("GET");
                conn.setRequestProperty("X-Phone-Token", s.token);
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);
                int code = conn.getResponseCode();
                if (code != 200) return;
                try (InputStream is = conn.getInputStream();
                     java.util.Scanner sc = new java.util.Scanner(is, "UTF-8")) {
                    String resp = sc.useDelimiter("\\A").hasNext() ? sc.next() : "";
                    JSONObject obj = new JSONObject(resp);
                    JSONArray alerts = obj.getJSONArray("alerts");
                    if (alerts.length() > 0) {
                        runOnUiThread(() -> showAlertDialog(alerts.optJSONObject(0)));
                        StringBuilder sb = new StringBuilder();
                        for (int i = 0; i < alerts.length(); i++) {
                            JSONObject a = alerts.optJSONObject(i);
                            sb.append("🚨 ").append(a.optString("author")).append(" in ").append(a.optString("server")).append("/").append(a.optString("channel")).append(" said: ").append(a.optString("content")).append("\n\n");
                        }
                        runOnUiThread(() -> alertsBody.setText(sb.toString()));
                    }
                }
            } catch (Exception ignored) {
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    private void showAlertDialog(JSONObject alert) {
        if (alert == null) return;
        String author = alert.optString("author", "unknown");
        String server = alert.optString("server", "unknown");
        String content = alert.optString("content", "");
        String word = alert.optString("word", "");

        String title = "🚨 Bad word detected!";
        String msg = "**" + author + "** said in **" + server + "**:\n\n\"" + content + "\"\n\nMatched: " + word;

        new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(msg)
                .setPositiveButton("OK", null)
                .show();
    }
}
