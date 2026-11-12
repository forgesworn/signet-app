# Changelog

Short, user-facing notes for each My Signet release. Zapstore shows the
section for the version being published (`release_notes` in zapstore.yaml).

## Unreleased
- Always on: closing My Signet only warns you when something needs it (an app that signs through it, or your children), and names them. Otherwise it closes quietly
- Where you're known: "Approved on" is replaced by "Signed by" and "Needs My Signet", so you can see which apps keep working with My Signet closed

## 0.26.0
- Personas: "Add a key from my Heartwood" adds a key that lives on your Heartwood, such as an old nsec imported there, as a persona. My Signet signs as it through the Heartwood and never holds the key
- Nostr Connect: when you approve an app you can choose "Straight to my Heartwood". The Heartwood that holds the persona takes the app over and signs for it directly, so My Signet can be closed
- That is the default for apps that ask only for everyday signing. For an app that could change your profile, delete posts or pair other devices, the phone stays the default, and choosing the Heartwood shows what it would sign without a press
- Where you're known: an app handed to your Heartwood shows "By your Heartwood, without asking this phone". Disconnect removes it from the Heartwood, and if this phone can't reach that Heartwood, "Forget on this phone" clears it here
- Advanced settings takes operator keys for other Heartwoods, so an app can be handed to a persona on any of them

## 0.25.4
- Getting started: "Connect a remote signer" now opens the camera so you can scan the bunker QR from your phone or Heartwood. Pasting the connection still works
- Android: the back gesture now steps back through the first-run screens (restoring, connecting a signer, pairing with a guardian's phone, choosing a PIN) instead of doing nothing

## 0.25.3
- Sign-in: approving a QR sign-in with another persona now reconnects apps that remember an earlier persona, instead of leaving them without a signing connection

## 0.25.2
- Android: completed signing requests clear from other open approval screens and when returning to the app

## 0.25.1
- Settings: "Delete MySignet" is now "Remove MySignet from this phone". It clears this phone only and publishes nothing to Nostr unless you tick "Also take it down on Nostr" (shown only when you have a public profile or a connected app to take down)
- Before removing, the card lists anything that exists only on this phone and asks you to confirm you've saved it, and lists what you can bring back afterwards, such as your Heartwood pairing

## 0.25.0
- Family: an edit to a dependant made on this phone is no longer undone by an older copy arriving from another device
- Identity cards: the site tiles are now a record of where each identity is known, not shortcuts. Chips fill the space available (two per row, "+N" for the rest), each with one small badge: signs automatically, approved on your Heartwood, another device, shared handle or picture, pinned, not used in 3 months
- New "Where you're known" column on each card (swipe past Contacts): every site and app that identity has signed in to or paired with, grouped Pinned / Recent / Not used in 3 months, with the full story when you tap a row — which identity, how it arrived (an app on this phone, this phone's browser, another device, Nostr Connect), whether your Heartwood approved it, what was shared, first and last use
- Row actions say what they do: Pin, Open (only for an app on this phone or a browser sign-in), Forget (removes it from this phone; the site still has your account), Disconnect, Stop signing automatically
- Nostr Connect: when an app connects you can now choose "Ask me each time it signs"; encrypting and decrypting stay automatic either way
- Apps on this phone show their own icon and name
- A site you sign in to as two different personas now appears on both cards instead of the second overwriting the first
- Settings: "Connected Sites" is replaced by "Where you're known" (opens the column) and "Connected apps" (Nostr Connect clients and apps on this phone)
- Delete all data now also clears the permissions given to apps on this phone
- Apps that ask My Signet to encrypt or decrypt (NIP-44 or NIP-04) now get an approval prompt instead of a refusal. "Allow always" remembers the app
- Android: other apps on the phone can decrypt older NIP-04 direct messages through My Signet
- An imported nsec now has its own 31 recovery words in Security, Backup Words, and an imported persona shows its words on its Advanced page
- An app you paired as one persona can no longer ask another of your personas to sign
- Publishing a persona's profile for the first time from this phone asks first if the profile was changed in another app, so you can keep that version
- A dependant's autonomy stage no longer reverts a second after you change it
- A change to a dependant on one device is no longer undone by an older copy from another device
- After you change a backup key, its row shows the new key version straight away
- Edits made on two devices close together are no longer left out of the backup


## 0.24.2
- Identity cards: while the app is locked, the card shows "Unlock to see where this identity is known" instead of an empty space where your sites go
- Connected Sites: "Revoke" is now "Forget", and says that it only removes the site from this phone. The site still has your account
- Locking while changes are still saving no longer locks the app again if you unlock it before the save finishes

## 0.24.1
- Identity cards: “MY IDENTITY – MY SOVEREIGNTY – MY COMMUNITY” now runs across the top of the card
- Android: the Bunker lets the phone sleep when signing has stopped. Waiting-request alerts use periodic network checks instead of keeping the CPU awake
- Contact picture crop: scrolling to zoom works from the moment the photo appears, instead of moving the page

## 0.24.0
- Identity cards: a larger photo, three action tiles (Scan, Handshake, My QR) and quick links to your sites and contacts replace the tier, Signet IQ and vouch counts
- Card backdrops: give each persona its own wallpaper from the image button on its card or the Card backdrop row in its settings column. Photos are resized before they are stored, and the card keeps one readable plate behind the name. A backdrop stays on this device, is not encrypted, and shows while the app is locked
- Tap the role label on a card (PERSONA 1/3) to switch between your identities from a list
- New installs start in the dark theme, so Home and the other pages no longer flip colour. Existing installs keep their current theme, and System, Light and Dark are all in Settings, Appearance
- Settings: Security & Backup now opens on your lock and backup, and the Bunker and camera settings have their own Bunker & Scanning page. The Bunker tab's sheet turns the Bunker on directly
- Pictures are named by who sees them: "Picture shown to you", "Picture shown on Nostr" and "Verification photo"
- Contacts: one New contact button, with the import, picture refresh and recognise-a-key actions behind More, and a line explaining Kin, Kith and Ken
- The QR card fits short phones without cutting off its footer
- Android 11 and older: the app no longer closes when the home screen loads or when Bluetooth or NFC is switched
- Android 7: turning on the always-on Bunker no longer closes the app
- Private backup problems also show at the top of Settings, so a backup that has stopped working is not missed
- Paired children keep their camera settings, on a Scanning row in Settings
- Handshake calibration has moved to Advanced settings
- The public QR card no longer shows the tier line
- The blur names setting also covers the identity switcher, the site links and the card backdrop
- Sign-in sites and the contact count show on a card only while the app is unlocked
- Removing a persona or dependant also removes its card backdrop
- On the web, the welcome screen and Settings now point to the Android app

## 0.23.0
- Faster, more reliable QR scanning: codes are decoded off the main thread, only inside the framing box, and the code nearest the centre wins when several are in view
- The scan card on the home screen fills with the camera and starts on its own once the card settles, with Pause, a scanning line and "Paste a link" on top
- The camera switches off after a quiet spell with nothing found; tap anywhere on it to wake it. Turn auto-start off or choose the idle time in Settings, Security, Camera
- Handshake and "Choose from photos" use the same decoder, so photos of small codes read more reliably
- My Keep: claim a Keep, invite guests with passes, choose which personas own it and let returning players back in. Switch it on in Advanced settings

## 0.22.1
- Professional setup uses your enabled publishing relays in signet.json, and asks you to enable one if none is available
- Badge embeds work without a hosted image service: copy an inline SVG snapshot linked to your Nostr identity, with a reminder to request a fresh proof for verification
- App descriptions distinguish local and connected signers, public metadata and optional encrypted backups

## 0.22.0
- Set up a Heartwood with one five-second hold after comparing all five check words. Choose Everyday or Extra careful signing, review the current choice in Settings, and narrow or withdraw access there. Requires firmware v0.18.0-beta.29 or newer; older firmware keeps the separate pairing steps
- Private backups read from the relays they are written to, so a dead read-only relay no longer stalls them. If a write relay is unreachable, the backup banner offers to turn it off when another checked copy remains safe
- Default relays are now primal, damus and ditto

## 0.21.5
- Remote signing works again: the signer moves from nos.lol, which stopped answering around 19 October, to relay.primal.net. Installs on the old default move automatically, and synced settings carry the new relay to your other devices
- Apps and devices paired only over nos.lol need pairing again

## 0.21.4
- Signing in to a site by scanning its QR code with My Signet's own scanner now works for sites that ask for their app name, instead of the site refusing it with an app mismatch

## 0.21.3
- Signing up from a sign-in link or a pairing request now starts with a persona, keeping your real identity dormant, the same as Create my Signet
- Connecting a Heartwood during sign-up asks the device for your identity keys and saves nothing if the button press is missed, denied or the device is unreachable; Try again reuses the same connection
- Pairing a Heartwood waits for the on-device confirmation card instead of reporting the device as unreachable after 10 seconds
- Apps that send their name and address in the newer NIP-46 position are recognised when they pair, instead of showing as "App"

## 0.21.2
- Apps you sign in to over a temporary pairing relay are told to keep the relay My Signet stays on, so they can still reach you after a restart instead of asking you to sign in again

## 0.21.1
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
