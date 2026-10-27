/**
 * The most events one relay read (or one live subscription kept by the Keep screens) collects. A relay, or a
 * hostile one, can answer a filter with far more than its `limit`; nothing past this is kept, so nothing past it
 * is ever decrypted or parsed by the caller. Its own module so a test can mock the relay client without it.
 */
export const FETCH_EVENT_CAP = 500;
