/**
 * Tests for ViewFilter — operator view filter for TelegramParticipant.
 *
 * ViewFilter has no external dependencies; tests run against the class directly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ViewFilter } from '../src/ViewFilter.js';
import type { Message } from '../src/types.js';

function msg(from: string, to: string, text = 'hello'): Message {
    return { id: '1', from, to, text, timestamp: Date.now() };
}

const SELF = '@architect';

describe('ViewFilter — default (no filters active)', () => {
    let filter: ViewFilter;

    beforeEach(() => { filter = new ViewFilter(); });

    it('allows a broadcast message', () => {
        expect(filter.allows(msg('@ivy', '*'), SELF)).toBe(true);
    });

    it('allows a DM addressed to self', () => {
        expect(filter.allows(msg('@ivy', SELF), SELF)).toBe(true);
    });

    it('allows a DM between two other agents', () => {
        expect(filter.allows(msg('@ivy', '@nova'), SELF)).toBe(true);
    });
});

describe('ViewFilter — mute', () => {
    let filter: ViewFilter;

    beforeEach(() => { filter = new ViewFilter(); });

    it('blocks messages from a muted handle', () => {
        filter.mute('@nova');
        expect(filter.allows(msg('@nova', '*'), SELF)).toBe(false);
    });

    it('only blocks the muted handle, not others', () => {
        filter.mute('@nova');
        expect(filter.allows(msg('@ivy', '*'), SELF)).toBe(true);
    });

    it('multiple mutes stack independently', () => {
        filter.mute('@nova');
        filter.mute('@sentinel');
        expect(filter.allows(msg('@nova', '*'), SELF)).toBe(false);
        expect(filter.allows(msg('@sentinel', '*'), SELF)).toBe(false);
        expect(filter.allows(msg('@ivy', '*'), SELF)).toBe(true);
    });

    it('unmute with handle restores that handle', () => {
        filter.mute('@nova');
        filter.unmute('@nova');
        expect(filter.allows(msg('@nova', '*'), SELF)).toBe(true);
    });

    it('unmute with handle does not affect other mutes', () => {
        filter.mute('@nova');
        filter.mute('@sentinel');
        filter.unmute('@nova');
        expect(filter.allows(msg('@nova', '*'), SELF)).toBe(true);
        expect(filter.allows(msg('@sentinel', '*'), SELF)).toBe(false);
    });

    it('unmute with no arg clears all mutes', () => {
        filter.mute('@nova');
        filter.mute('@sentinel');
        filter.unmute();
        expect(filter.allows(msg('@nova', '*'), SELF)).toBe(true);
        expect(filter.allows(msg('@sentinel', '*'), SELF)).toBe(true);
    });

    it('unmute of a handle that was never muted is a no-op', () => {
        filter.unmute('@nova');
        expect(filter.allows(msg('@nova', '*'), SELF)).toBe(true);
    });
});

describe('ViewFilter — focus mode', () => {
    let filter: ViewFilter;

    beforeEach(() => {
        filter = new ViewFilter();
        filter.setFocus(true);
    });

    it('allows a broadcast that mentions selfHandle', () => {
        expect(filter.allows(msg('@ivy', '*', `hey ${SELF} check this`), SELF)).toBe(true);
    });

    it('allows a DM addressed directly to self', () => {
        expect(filter.allows(msg('@ivy', SELF, 'private'), SELF)).toBe(true);
    });

    it('blocks a broadcast with no mention of self', () => {
        expect(filter.allows(msg('@ivy', '*', '@nova look at this'), SELF)).toBe(false);
    });

    it('blocks a DM between other agents', () => {
        expect(filter.allows(msg('@ivy', '@nova', 'hey'), SELF)).toBe(false);
    });

    it('unfocus restores all traffic', () => {
        filter.setFocus(false);
        expect(filter.allows(msg('@ivy', '*', 'unrelated'), SELF)).toBe(true);
    });
});

describe('ViewFilter — mute + focus interaction', () => {
    it('muted handle is blocked even when their message mentions self', () => {
        const filter = new ViewFilter();
        filter.mute('@nova');
        filter.setFocus(true);
        // message mentions self — would pass focus check, but mute wins
        expect(filter.allows(msg('@nova', '*', `${SELF} look at this`), SELF)).toBe(false);
    });

    it('muted handle is blocked regardless of focus mode being off', () => {
        const filter = new ViewFilter();
        filter.mute('@nova');
        expect(filter.allows(msg('@nova', '*'), SELF)).toBe(false);
    });
});

describe('ViewFilter — describe()', () => {
    it('shows default state: focus OFF, no mutes', () => {
        const filter = new ViewFilter();
        expect(filter.describe()).toBe('Focus mode: OFF\nMuted: none');
    });

    it('shows focus ON', () => {
        const filter = new ViewFilter();
        filter.setFocus(true);
        expect(filter.describe()).toContain('Focus mode: ON');
    });

    it('lists muted handles sorted alphabetically', () => {
        const filter = new ViewFilter();
        filter.mute('@sentinel');
        filter.mute('@ivy');
        filter.mute('@nova');
        expect(filter.describe()).toContain('Muted: @ivy, @nova, @sentinel');
    });

    it('shows no mutes after unmute all', () => {
        const filter = new ViewFilter();
        filter.mute('@nova');
        filter.unmute();
        expect(filter.describe()).toContain('Muted: none');
    });
});
