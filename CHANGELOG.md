# Changelog

Short, user-facing notes for each My Signet release. Zapstore shows the
section for the version being published (`release_notes` in zapstore.yaml).

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
