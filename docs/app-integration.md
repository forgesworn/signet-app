# Sign in and approve online play

This is a My Signet app extension to Sign in with Signet. It is implemented
in the current source. Installed or hosted releases may lag behind main, so
clients must retain the documented fallback. It adds an optional
`app_permission` parameter to the existing `?auth=1` URL. The underlying
sign-in protocol and its challenge/origin verification stay unchanged.

For an app that only needs an online-play statement, use this flow instead of
turning on a general remote signer. One approval can return both the sign-in
proof and the exact game statement. The person can choose **Sign in only**.
Bunker remains off by default; combined requests do not hand out a Bunker URI,
even if Bunker is enabled in My Signet settings.

## Request

Build the normal fresh sign-in URL, with a new unpredictable 32-byte hex
`challenge`, your HTTPS `origin`, app `name`, same-origin `callback` and Unix
seconds `t`. For relay delivery also supply `relay` (wss) and
`sessionPubkey` (a fresh session key, distinct from the installation key).
Subscribe to gift wraps for that session before opening My Signet. Supply your
relay explicitly; do not assume My Signet's primary. See the
[relay defaults and failover notes](../README.md#relay-defaults-and-failover).

Append exactly one `app_permission` value: **unpadded base64url of UTF-8 JSON**:

```json
{
  "v": 1,
  "permission": "online-play",
  "appId": "your-game",
  "installKey": "<64 lowercase hex characters: this installation's public key>",
  "validFrom": 1791979200,
  "validUntil": 1799755200,
  "reason": "Show other players that it is really you."
}
```

The timestamps above illustrate a 90-day window; generate fresh values.
`appId` is 1–64 lowercase ASCII letters, digits or hyphens. `installKey` must
be a valid secp256k1 x-only public key and differ from the selected persona.
Keep its private key on the installation; it proves control during play.
`validFrom` must be within 300 seconds of My Signet's current time, and
`validUntil` must be later and at most 90 days after it. Dates are JSON safe
integers in seconds. `reason` is 1–200 Unicode characters; My Signet sanitises
it and displays it as the app's explanation, alongside its own permission
wording. Version 1 accepts exactly these seven fields and only `online-play`.
The encoded parameter is capped at 4,096 characters. Duplicate, malformed,
stale or unsupported permission parameters reject the combined request.

```js
const request = {
  v: 1, permission: 'online-play', appId: 'your-game',
  installKey: installationPublicKey,
  validFrom: Math.floor(Date.now() / 1000),
  validUntil: Math.floor(Date.now() / 1000) + 90 * 86400,
  reason: 'Show other players that it is really you.',
};
const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(request))))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
signInUrl.searchParams.set('app_permission', encoded);
```

The approval binds the following exact kind-30420 statement to the persona
selected during sign-in. The consumer does not need to know that persona in
advance. Content is empty; tags are in this order:

```text
["d", appId]
["p", installKey]
["valid_from", String(validFrom)]
["valid_until", String(validUntil)]
["v", "1"]
["role", "player"]
["expiration", String(validUntil)]
```

## Answer and verification

Relay delivery uses the existing NIP-59 answer: a verified kind-1059 wrap,
kind-13 seal signed by the selected persona, and kind-29999 rumor. The normal
`signet-auth-response` JSON gains one optional property:

```json
{
  "appPermission": {
    "v": 1,
    "permission": "online-play",
    "status": "approved",
    "event": { "kind": 30420, "pubkey": "...", "id": "...", "sig": "..." }
  }
}
```

The event above is abbreviated; the real answer contains the complete signed
event, including `created_at`, empty `content` and the exact requested tags.
If the person chooses sign-in only, or their guardian declines that part:

```json
{ "appPermission": { "v": 1, "permission": "online-play", "status": "declined" } }
```

Same-device callback delivery uses the query parameter `app_permission`,
encoded with the same UTF-8/base64url rules, containing the **result object**
(the value of `appPermission` above). The usual sign-in callback parameters
are still present. Treat callback query values as untrusted.

Before accepting or caching an approved statement:

1. Verify the ordinary sign-in proof against your outstanding challenge and
   exact origin, including freshness, session tags and request ID. In relay
   mode verify every NIP-59 layer, recipient and seal/rumor authorship.
2. Verify the statement's event ID and Schnorr signature. Its author must
   equal the verified sign-in persona and, in relay mode, the seal author.
3. Require kind 30420, empty content and exactly the requested seven tags,
   including your app ID, this installation key and both requested dates.
   Require a fresh `created_at` (within 300 seconds), current validity and a
   maximum 90-day validity window. Never accept an extension of that window.
4. Consume only an answer to the current session. A sign-out, persona switch,
   cancelled sign-in or superseding request invalidates a pending answer.

`approved`, `declined` and an absent extension are distinct. An invalid
extension is an invalid answer; do not downgrade it into a legacy success.
An absent extension means the signer predates this feature: accept a valid
ordinary sign-in and use the existing online-permission fallback when needed.
A declined extension still permits sign-in, but does not permit online play.
Do not immediately reopen an approval after an explicit decline.

Cache the verified statement locally and reuse it while valid. A new game or
match must not trigger another approval. Do not publish it to a public relay
or include it in a public profile; share it only where the play protocol
needs it. On expiry or installation-key change, ask again with fresh values.

## Fallback for a persona already signed in

Keep the existing `?action=app-permission&permission=online-play` flow for
older My Signet versions, renewals and users who choose online play later.
Its normal request carries `origin`, `name`, `reason`, `t`, a fresh
`challenge`, `relay`, `sessionPubkey`, same-origin `callback`, and `template`
(base64url JSON of **only** `kind`, `pubkey`, `content`, `tags` as above).
Verify the `signet-app-permission-response` using its outstanding challenge,
permission name, NIP-59 author/recipient binding and exact template. A
permission response is not a sign-in response; do not mix their validators.

A new Android app URL must open its approval even if My Signet is already on
a completed acknowledgement page or needs unlocking. Consumers should keep
the session subscription alive while the request is pending, offer explicit
cancel/retry, and create a fresh challenge/session on a new attempt.

## Remote signing and `perms`

`nostrconnect://` may carry NIP-46 `perms`, for example
`perms=sign_event:30420,sign_event:5`. My Signet displays and persists an
explicit requested method/kind ceiling and enforces it before dispatch,
including encryption/decryption. A `connect` call cannot widen an existing
ceiling; new requested rights require an approved `nostrconnect` flow.
Malformed, duplicate or unknown permission lists fail closed. Omitted
`perms` preserves compatibility for existing integrations and stored clients.

A method/kind list does not describe a particular game's statement and is
not approval to sign arbitrary events of that kind. Online-play statements
still require approval. A scoped client's kind-5 deletion requests also
require individual approval; they cannot use whole-client “Allow always”.
This includes legacy cleanup: requesting `sign_event:5` does not grant silent
rights to retract unrelated persona events. Use the combined statement flow
when that is all the app needs; it grants no ongoing signing or deletion
rights. See [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md)
and [NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md).

## Family decisions stay in My Signet

Default behaviour still asks a guardian for a dependant's online permission.
For a dependant's own phone paired directly to a Heartwood, at full autonomy
a guardian can explicitly delegate the right to approve online play in the
dependant's Permissions screen. The dependant must still tap to approve a statement in My Signet; a raw remote-signing request cannot
claim that a person already approved it.

For the same directly paired setup, a guardian can instead remember the
particular online-play permission until its displayed expiry. This new grant is bound to persona, site origin,
app ID and installation key. It cannot authorise a later expiry or a new
installation. It can be revoked in Permissions and is inactive below full
autonomy. Existing wildcard or legacy “allow” rules do not acquire this right.
App blocks, denials, schedules, pause and rate limits continue to apply.

External answers carry only ordinary sign-in and approved/declined permission
results. Never infer or request age, dependant status, guardian identity or
autonomy stage. The app follows the same flow for everyone.
