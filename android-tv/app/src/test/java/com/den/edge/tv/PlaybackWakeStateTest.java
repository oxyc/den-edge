package com.den.edge.tv;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class PlaybackWakeStateTest {
    @Test
    public void transitionsOnlyWhenPlaybackStateChanges() {
        PlaybackWakeState state = new PlaybackWakeState();

        assertFalse(state.isActive());
        assertTrue(state.setActive(true));
        assertTrue(state.isActive());
        assertFalse(state.setActive(true));
        assertTrue(state.setActive(false));
        assertFalse(state.isActive());
        assertFalse(state.setActive(false));
    }
}
