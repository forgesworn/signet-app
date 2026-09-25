# Signet Test Harness

Dev-only test consumer for Sign-in-with-Signet flows. Not shipped as part of
the production app — Vite's build ignores this folder.

## Why this exists

Writing a new flow, changing the URL-auth parser, tweaking the ApproveAuth
screen — all of these benefit from a known-good consumer site to sign in
against, without depending on MatchPass, Axenstax, or other whitelisted
production consumers.

It is also the answer to "is it my Signet, or the site I'm signing into?".
The callback page verifies the signature for real, so a sign-in that fails
here is Signet's fault, and one that passes here points at the other site.

## Run it

```bash
cd test-consumer
./serve.sh
```

**Fixed port: 5175** (one above `signet-app`'s 5174, so they never clash).
The script binds to `0.0.0.0` so other devices on your LAN can reach it.
It needs `python3` — the server is `server.py`, not a plain static server,
because it also records results (below).

**Bookmarks:**
- `http://localhost:5175/` — on the same machine
- `http://<your-machine-ip>:5175/` — from a phone/tablet on the same Wi-Fi
  (`serve.sh` prints the LAN URL when it starts)

## What the callback page proves

`callback.html` does not just display the params. It runs four checks
(`src/verify.js`, bundled to `vendor/signet-verify.js`):

1. the required params came back at all;
2. the `npub` and the hex `pubkey` are the same key;
3. the kind-21236 event rebuilt from **the challenge and origin this harness
   sent** hashes to exactly the `eventId` Signet returned — so the signature
   is bound to this attempt and not replayed from another;
4. the BIP-340 Schnorr signature verifies against that id under that key.

Verdicts: **signed** (all four pass), **failed** (one broke — the page names
which), **denied** (the user tapped Deny), **unverifiable** (the signature is
valid but this browser has no record of what was asked for, e.g. the callback
page was opened directly or in a different browser than the dashboard).

### Results land on disk

Every outcome is POSTed to `/report` and appended to
`results/log.jsonl` (gitignored). One JSON object per attempt: verdict,
per-check detail, the scenario, the outbound URL, and every callback param.
Read the last few with:

```bash
tail -3 test-consumer/results/log.jsonl | python3 -m json.tool --json-lines
```

That file is the point of the harness for debugging by proxy — someone else
can read what actually happened without you having to describe it.

### Self-test

The verifier has its own test, so a green "Signed ✓" means something:

```bash
node test-consumer/verify.test.mjs     # from the repo root
```

It mints real kind-21236 signatures and checks the verifier accepts a genuine
one and rejects a tampered signature, a substituted challenge, a wrong origin,
a mismatched npub and a missing param.

There is also a Playwright spec that drives the whole loop — harness → Signet
→ approve → callback → log:

```bash
npx playwright test e2e/test-consumer-signin.spec.ts --project=mobile-chromium
# https dev server (mkcert certs in cert/):
E2E_BASE_URL=https://localhost:5174 npx playwright test e2e/test-consumer-signin.spec.ts --project=mobile-chromium
```

## Pointing at a different Signet

The **Target Signet** input at the top of the dashboard defaults to
`https://mysignet.app`. Override for local dev (`http://localhost:5174`, or
`https://localhost:5174` when `cert/` holds mkcert certs) or staging.

## Testing on a phone

The sign-in contract only accepts a consumer whose origin is `https://` or
`http://localhost`. A LAN IP such as `http://192.168.1.20:5175` is rejected
by the parser before Signet ever asks you to approve, which looks like a
broken app but is not.

**Over Wi-Fi (any phone).** Give the harness a certificate for this
machine's LAN address and it serves https, which the parser accepts:

```bash
cd test-consumer
mkcert -cert-file cert/harness.pem -key-file cert/harness-key.pem <lan-ip> localhost 127.0.0.1
./serve.sh          # now prints an https:// LAN URL
```

`server.py` picks the certificate up automatically when `cert/harness.pem`
and `cert/harness-key.pem` exist (override the paths with
`SIGNET_HARNESS_CERT` / `SIGNET_HARNESS_KEY`). The phone does not trust the
mkcert CA, so the browser shows a "connection is not private" interstitial
once — tap Advanced, then proceed. The certificate is pinned to the IP it
was minted for, so re-mint after the machine's address changes.

**Over USB (a phone with adb).** No certificate needed:

```bash
adb reverse tcp:5175 tcp:5175
```

Then open `http://localhost:5175` on the phone. It reaches this machine, the
origin is `localhost`, and the callback comes back to the same server.

Either way, results from the phone land in `results/log.jsonl` on this
machine.

## Scenarios

Each button builds a different sign-in URL, redirects to Signet, then catches
the callback at `/callback.html`. See `scenarios.js` for the full list; add
one by dropping another entry into the `SCENARIOS` array.

## What's covered vs not

**Covered:**
- Redirect-mode sign-in (`?auth=1&...&callback=...`) — happy paths, keypair
  constraints, consumer-hint warnings, error cases, with real signature
  verification.
- NIP-46 pairing (`?nostrconnect=...`) — the matchpass-app desktop flow
  (launch only; no verification, there is no callback).

- Relay-mode sign-in (`?auth=1&...&relay=...&sessionPubkey=...`), the
  cross-device path the Android consumer apps use — see below.

**Not covered:**
- NIP-55 signing for other apps on the phone, and NIP-46 request signing
  after the sign-in. Both are separate surfaces from the sign-in itself.

## Cross-device (relay) mode

`relay.html` is the second half of the harness, and the one that matches what
the Android consumers do. Signet does not redirect in this mode: it
gift-wraps its answer to a session key the consumer minted and publishes it
to the relay the consumer named. So the consumer has to still be listening.

The page mints a session key, subscribes to the relay for kind-1059 wraps
addressed to it, and shows the sign-in URL. Approve in Signet, come back, and
it unwraps three layers and verifies:

- the wrap is a valid kind-1059 addressed to this session;
- the kind-13 seal inside it is signed by its author;
- the kind-29999 response has the same author as the seal and names this
  attempt in its `session` tag;
- the kind-21236 auth event inside verifies, and carries exactly the
  challenge and origin we sent.

Silence is a result too: after two minutes with an open subscription and
nothing delivered, it reports that Signet either did not publish, published
somewhere else, or the relay dropped it. A relay that refuses the
subscription is reported as a refusal rather than as an empty wait — worth
knowing, because some relays now require NIP-42 authentication to read
kind-1059 at all (`relay.damus.io` does), which makes a cross-device sign-in
fail with no visible cause on either side.

Its self-test builds gift wraps the way `relay-publish.ts` does:

```bash
node test-consumer/relay.test.mjs
```

And the end-to-end version, opt-in because it uses a live relay:

```bash
E2E_RELAY=wss://relay.trotters.cc E2E_BASE_URL=https://localhost:5174 \
  npx playwright test e2e/test-consumer-relay.spec.ts --project=mobile-chromium
```

## Adding a scenario

```js
{
  id: 'my-new-case',
  title: 'My new case',
  description: 'What it proves',
  build: (ctx) => ctx.signinUrl({ /* extra params */ }),
}
```

The `ctx` helper fills in `auth=1`, origin, callback, a fresh challenge,
and a current timestamp. Override what you need.

## Rebuilding the verifier bundle

`vendor/signet-verify.js` is committed so the harness works from a clone with
no install step. After editing `src/verify.js`:

```bash
./build-vendor.sh
```
