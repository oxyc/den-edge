package com.den.edge.tv;

import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;

public final class MainActivity extends ComponentActivity {
    private static final Uri TV_URI = Uri.parse(BuildConfig.DEN_TV_URL);
    private static final String ANDROID_EXIT_SCHEME = "den";
    private static final String ANDROID_EXIT_HOST = "exit";
    private static final String ANDROID_RETRY_HOST = "retry";

    private FrameLayout root;
    private WebView webView;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private boolean pageReady;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(11, 11, 15));
        setContentView(root);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleBack();
            }
        });
        createWebView();
        webView.loadUrl(BuildConfig.DEN_TV_URL);
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void createWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(11, 11, 15));
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        // Ignore target=_blank/popups instead of allowing them to replace the trusted top-level page.
        settings.setSupportMultipleWindows(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(
                settings.getUserAgentString() + " DenAndroidTV/" + BuildConfig.VERSION_NAME);

        webView.setWebViewClient(new DenWebViewClient());
        webView.setWebChromeClient(new DenWebChromeClient());
        root.addView(webView, fillParent());
        webView.requestFocus();
    }

    private void handleBack() {
        if (customView != null) {
            hideCustomView();
            return;
        }
        if (!pageReady) {
            finish();
            return;
        }
        webView.evaluateJavascript(
                "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}))",
                null);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        immersive();
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            // TV apps must not leave video or unaccompanied audio running after another activity covers them.
            webView.evaluateJavascript(
                    "document.querySelectorAll('video,audio').forEach((media)=>media.pause())", null);
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            root.removeView(webView);
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    private void showLoadError() {
        pageReady = false;
        if (webView != null) webView.stopLoading();
        root.removeAllViews();
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(android.view.Gravity.CENTER);
        panel.setPadding(72, 72, 72, 72);

        TextView title = new TextView(this);
        title.setText(R.string.load_error_title);
        title.setTextColor(Color.rgb(242, 239, 233));
        title.setTextSize(32);
        panel.addView(title);

        TextView body = new TextView(this);
        body.setText(R.string.load_error_body);
        body.setTextColor(Color.rgb(190, 187, 181));
        body.setTextSize(20);
        body.setPadding(0, 24, 0, 36);
        panel.addView(body);

        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setOnClickListener(view -> {
            root.removeAllViews();
            if (webView == null) createWebView();
            else root.addView(webView, fillParent());
            webView.loadUrl(BuildConfig.DEN_TV_URL);
            webView.requestFocus();
        });
        panel.addView(retry);

        Button exit = new Button(this);
        exit.setText(R.string.exit);
        exit.setOnClickListener(view -> finish());
        panel.addView(exit);

        root.addView(panel, fillParent());
        retry.requestFocus();
    }

    private static FrameLayout.LayoutParams fillParent() {
        return new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private boolean isDenPage(Uri uri) {
        return "https".equalsIgnoreCase(uri.getScheme())
                && TV_URI.getHost().equalsIgnoreCase(uri.getHost())
                && effectivePort(TV_URI) == effectivePort(uri);
    }

    private static int effectivePort(Uri uri) {
        if (uri.getPort() != -1) return uri.getPort();
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private boolean handlePrivateNavigation(Uri uri, boolean mainFrame) {
        if (!ANDROID_EXIT_SCHEME.equals(uri.getScheme())) return false;
        if (!mainFrame) return true;
        if (ANDROID_EXIT_HOST.equals(uri.getHost())) finish();
        else if (ANDROID_RETRY_HOST.equals(uri.getHost())) webView.loadUrl(BuildConfig.DEN_TV_URL);
        return true;
    }

    private final class DenWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (handlePrivateNavigation(uri, request.isForMainFrame())) return true;
            if (!request.isForMainFrame()) return false;
            return !isDenPage(uri);
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            Uri uri = Uri.parse(url);
            if (handlePrivateNavigation(uri, true)) return true;
            return !isDenPage(uri);
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            if (isDenPage(Uri.parse(url))) pageReady = false;
            super.onPageStarted(view, url, favicon);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (isDenPage(Uri.parse(url))) pageReady = true;
            super.onPageFinished(view, url);
        }

        @Override
        public void onReceivedError(
                WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showLoadError();
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // A renderer killed on a low-memory TV cannot be reused. Keep the activity alive and let the user
            // explicitly create a fresh renderer rather than immediately reloading a page that may have crashed it.
            if (customView != null) {
                root.removeView(customView);
                customView = null;
                if (customViewCallback != null) customViewCallback.onCustomViewHidden();
                customViewCallback = null;
            }
            root.removeView(view);
            view.destroy();
            if (view == webView) webView = null;
            showLoadError();
            return true;
        }
    }

    private final class DenWebChromeClient extends WebChromeClient {
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) {
                callback.onCustomViewHidden();
                return;
            }
            customView = view;
            customViewCallback = callback;
            customView.setKeepScreenOn(true);
            webView.setVisibility(View.GONE);
            root.addView(view, fillParent());
            immersive();
        }

        @Override
        public void onHideCustomView() {
            hideCustomView();
        }
    }

    private void hideCustomView() {
        if (customView == null) return;
        customView.setKeepScreenOn(false);
        root.removeView(customView);
        customView = null;
        webView.setVisibility(View.VISIBLE);
        if (customViewCallback != null) customViewCallback.onCustomViewHidden();
        customViewCallback = null;
        webView.requestFocus();
        immersive();
    }
}
