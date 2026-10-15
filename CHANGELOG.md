# Changelog

Short, user-facing notes for each My Signet release. Zapstore shows the
section for the version being published (`release_notes` in zapstore.yaml).

## Unreleased
- Relay-mode sign-in uses up to three relays named by the app (repeated `relay=`, primary first), so one relay the phone cannot reach no longer fails the sign-in
- The home-screen scanner opens My Signet web links carrying NostrConnect invitations instead of silently ignoring them

## 0.21.0
- Trotters removed from default and saved app relay settings; sync uses the full remaining pool, writes return on the first acknowledgement, and primary connections fail over after outages
- Apps can request an exact online-play statement alongside sign-in, with a sign-in-only choice and no need to enable Bunker
- At full autonomy, guardians can explicitly delegate online-play approval or remember an app permission until its displayed expiry; app blocks and schedules still apply
- Explicit NIP-46 method and event-kind permissions are displayed and enforced; scoped deletion requests require individual approval
- App-permission links open from completed sign-in screens, survive an existing unlock, and can be reopened after cancelling the PIN prompt
- Identity cards fit shorter screens without internal scrolling; swiping up and down changes personas again
- More consistent card sizes, spacing and form alignment throughout the app; smoother screen changes keep the incoming card ready instead of rebuilding it
- Portrait orientation on phones and tablets, with a turn-upright screen that preserves your place when the browser cannot lock orientation
- Persona contact cards have a clearer layout, trust-tier counts, contact previews and better empty and locked states
- PIN and biometric prompts now explain the action, including dependant pairing, recovery words, bot permissions and professional credentials
- Independence handover moves a dependant's contacts and persona names to new recovery words, verifies restore before removing the family copy, and lets the guardian keep a read-only encrypted contact archive or delete it
- Review contact trust and blocks during handover; old contact proofs need fresh checks, and apps and credentials must be set up again

## 0.20.0
- Pair a child's phone by tapping the two phones together (NFC) or over Bluetooth, with the QR code kept as a fallback
- A "Before you pair" checklist on the Phone & Pairing card shows what's ready and what isn't
- Pairing recovers if the Heartwood's reply is missed, and now says whether the Heartwood is unreachable or the wrong identity
- Creating a persona or dependant in Heartwood mode now tells you when the Heartwood can't be reached, instead of failing quietly

## 0.19.0
- Signet Handshake: meet someone in person and swap contacts by tap (NFC), Bluetooth with no internet, or the Jigsaw, where two phones side by side show matching lines. You confirm "Is this them?" before anything is saved, and you can ask the other screen to hide you until tapped
- Contact pictures: crop your own picture to a square, see theirs as a badge on yours, and keep an encrypted backup of your own contact pictures that restores with your words
- Your name and photo can go in contact requests and acceptances
- Old pictures, banners and photos are deleted from your picture server when you remove or replace them; uploads no longer carry your identity key
- Sign-in fixes: the app name you were asked for is bound into the response, relay health and delivery failures are shown, and redirect sign-ins verify again for the sites that use them
- Importing an existing Nostr account is easier to see and confirm on desktop
- Much lower battery use when the app is left running in the background

## 0.18.2
- Approve from my phone: in Advanced settings, under your Heartwood operator key, choose which of your own apps can have their button requests approved from this phone when you are away from your Heartwood. Off for every app until you turn it on, and only offered once this phone can see and answer those requests
- Scan or paste someone's npub on a persona card to add them to that persona's contacts; their contact opens so you can name or confirm them
- The paste box and scan errors on the camera card are now easy to read

## 0.18.1
- Requests your Heartwood holds for your phone from your own apps now say so: "An app wants to sign as <name>", listed under Waiting for approval, instead of being shown as a family sign-in

## 0.18.0
- Confirm it's them: mark a contact's key as confirmed from their page; the list shows who's confirmed, with a "Not confirmed" filter
- Contacts without a name show a short npub instead of a code
- Vault sync is quicker and more reliable, with fewer device prompts
- Your card shows your public profile picture when you haven't set one in the app
- Follow lists with more than 100 people now load in full
