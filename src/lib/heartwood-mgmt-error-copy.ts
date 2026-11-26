/**
 * Plain words for what went wrong on the operator channel (kind 24134) to a
 * Heartwood: listing its identities, handing an app to it, revoking an app.
 * Those paths throw raw strings ("timeout waiting for device (revoke_client)",
 * a device's own error text), and the screens used to show one generic line
 * for all of them, so a device saying it was out of memory read the same as
 * one that was switched off.
 *
 * A message already written for people passes through unchanged; anything
 * else unrecognised gets the generic line, never the raw text.
 */
import { HeartwoodDeviceError } from './heartwood-mgmt';

export const MGMT_GENERIC_COPY = 'That did not work. Try again.';
export const MGMT_NO_ANSWER_COPY = "Your Heartwood didn't answer. Check it's on and online, then try again.";
export const MGMT_UNREACHABLE_COPY = "This phone couldn't reach your Heartwood's relays. Check this phone is online, then try again.";
export const MGMT_LOW_MEMORY_COPY = 'Your Heartwood is short of memory. Wait a minute, then try again. If it keeps happening, unplug it and plug it back in.';
export const MGMT_CHANGED_COPY = 'Your Heartwood changed while this was being sent. Try again.';
export const MGMT_LINK_CLOSED_COPY = "This phone's link to your Heartwood closed. Try again.";

/**
 * A message already put in words for people. The mapper below passes it
 * through untouched, so copy is never mapped twice (a device's quoted text
 * with brackets in it would otherwise fall to the generic line, or text that
 * mentions "failed to publish" would read as a relay problem).
 */
export class HeartwoodCopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeartwoodCopyError';
  }
}

/**
 * Longest piece of a device's own error text shown. Long enough for a whole
 * reply (a device's pairing refusal ran past the old 120 and read as
 * "pairing w…"); the banner wraps it rather than cutting it.
 */
export const DEVICE_TEXT_MAX = 300;

/** Control and bidi characters and double quotes out, whitespace collapsed, capped by code point. */
function cleanDeviceText(raw: string): string {
  const flat = raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Code points, so a cut never splits a surrogate pair.
  const chars = Array.from(flat);
  return chars.length > DEVICE_TEXT_MAX ? `${chars.slice(0, DEVICE_TEXT_MAX - 1).join('')}…` : flat;
}

/** A sentence our own code wrote for people: capital first, full stop last, no code-ish marks. */
function writtenForPeople(raw: string): boolean {
  return raw.length <= 240 && /^[A-Z][^_(){}<>]*[.!?]$/.test(raw.trim());
}

/** A known code's friendly copy, then the device's own words when they say more. */
function withDeviceText(copy: string, text: string): string {
  return text && text.toLowerCase() !== copy.toLowerCase() ? `${copy} Your Heartwood said: "${text}".` : copy;
}

export function heartwoodMgmtErrorCopy(e: unknown): string {
  if (e instanceof HeartwoodCopyError) return e.message;
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const m = raw.toLowerCase();
  const text = e instanceof HeartwoodDeviceError ? cleanDeviceText(raw) : '';
  if (/low on memory|out of memory/.test(m)) return withDeviceText(MGMT_LOW_MEMORY_COPY, text);
  // A bare code (one word, no sentence) says nothing the copy does not.
  if (/stale_management_challenge|stale_client_slot/.test(m)) return withDeviceText(MGMT_CHANGED_COPY, /\s/.test(text) ? text : '');
  if (e instanceof HeartwoodDeviceError) {
    return text ? `Your Heartwood replied: "${text}".` : MGMT_GENERIC_COPY;
  }
  if (/^timeout waiting for device/.test(m)) return MGMT_NO_ANSWER_COPY;
  if (/failed to publish/.test(m)) return MGMT_UNREACHABLE_COPY;
  if (/^transport closed( \([a-z0-9_]+\))?$/.test(m) || m === 'not started') return MGMT_LINK_CLOSED_COPY;
  if (writtenForPeople(raw)) return raw.trim();
  return MGMT_GENERIC_COPY;
}

/** True when the error says the device answered (with an error), or was never reached at all. */
export function isDeviceAnswerOrUnreachable(e: unknown): boolean {
  if (e instanceof HeartwoodDeviceError) return true;
  return e instanceof Error && /failed to publish/i.test(e.message);
}
