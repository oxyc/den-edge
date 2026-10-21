package com.den.edge.tv;

/** Keeps the window flag transition idempotent and makes lifecycle behavior testable without a WebView. */
final class PlaybackWakeState {
    private boolean active;

    boolean setActive(boolean next) {
        if (active == next) return false;
        active = next;
        return true;
    }

    boolean isActive() {
        return active;
    }
}
