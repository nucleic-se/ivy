import { createTestDatabase } from 'gears/testing';

/**
 * Returns a fresh better-sqlite3 in-memory database for use in ivy tests.
 *
 * Delegates to gears/testing so better-sqlite3 remains a single dependency
 * in gears rather than being duplicated across bundles.
 *
 * RoomLog's local Database interface is a structural subset of
 * better-sqlite3 Database, so the returned instance satisfies it directly.
 */
export function createInMemoryDb() {
    return createTestDatabase();
}
