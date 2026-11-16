# Prepare and rehearse account recovery

This is the owner rehearsal for the imported-account collection preview in
Signet 0.29.0. Preparation can be completed before choosing storage nodes.
The automated tests used disposable accounts; they do not record an owner
rehearsal. Keep independent key backups during the preview and retain the
current working Signet installation throughout this exercise.

## Prepare the recovery material

1. Obtain [Signet 0.29.0](https://github.com/forgesworn/signet-app/releases/tag/v0.29.0)
   or a later compatible release. Check the installed version. On Android,
   save the matching APK somewhere you can reach without the original phone.
2. Confirm that you have your matching Signet recovery words in a separate
   private place. Enter them only in Signet during recovery. Do not send the
   words, nsecs, collection or storage receipt to support or a reviewer.
3. In **Settings → My identities → Back up several accounts**, choose the
   locally held imported accounts to protect, then **Download account
   collection** and approve the request. There may be 1–100 accounts.
   Hardware-held and dependant keys need their own recovery arrangements.
4. Without leaving this screen, select the file you just saved under
   **Account collection file**, choose **Open collection** and approve.
   Wait for **Saved collection checked: N accounts**. Check the expected
   account count, names, creation time and exact npubs. A download alone does
   not complete this step.
5. Retain an offline copy of the checked `signet-accounts.nstc`. The file is
   exactly **65,608 bytes**. Keep the previous checked snapshot until the new
   snapshot and its recovery route have both been checked. Adding an account
   later does not update an existing collection.

The words and encrypted collection are both necessary for this recovery
route. Words alone cannot reconstruct these unrelated nsecs. The encrypted
file alone cannot decrypt them. Anyone with both has access to the accounts.

On macOS, these optional local checks let you compare the saved and recovered
files without entering a key or installing a tool. Replace the quoted paths
with your actual files; keep the output private.

```sh
wc -c < "/path/to/signet-accounts.nstc"
shasum -a 256 "/path/to/signet-accounts.nstc"
```

Expect 65,608 bytes. Record the SHA-256 privately for the later comparison.
Size and hash checks establish which file you have; only Signet can
authenticate its contents with the matching root.

## Choose the Wildbloom storage destinations

Before uploading, obtain four storage destinations that admit your selected
storage signer. Confirm their quota, retention and availability with their
operators. There are no default destinations supplied by this feature.

Choose destinations in four independent failure groups for a 2-of-4 layout.
Four URLs on one server, disk, provider account or shared power supply do not
establish four independent copies. Confirm the actual arrangements rather
than assigning different group names to shared infrastructure.

The four parts total **131,216 bytes**: four parts of **32,804 bytes** each,
plus a separate private signed pool receipt. Any two distinct verified parts
rebuild the encrypted file. This coding does not grant the servers authority
to decrypt it.

If the destinations are not ready, retain the checked offline file and stop
here. This completes local preparation, not remote storage acceptance.

## Upload and retain the private receipt

1. Open [Wildbloom](https://wildbloom.forgesworn.dev). Choose a split pool with
   two required parts, four total parts and the four chosen destinations and
   failure groups.
2. Choose **Store an already encrypted file**, select the checked `.nstc`
   file and inspect it locally. This flow must not ask for Signet recovery
   words or create another `wbk1_` key. Wildbloom checks the envelope structure;
   the originating Signet performs authentication.
3. Connect the storage-authorised signer, approve the upload and wait for
   **Requested layout verified**. A signed receipt or upload acknowledgement
   by itself does not establish storage.
4. Download the private signed pool receipt. Keep at least two independent
   copies, including an offline copy, separately from the parts it locates.
   It names the retrieval destinations; losing it can prevent recovery even
   if the servers retain the parts. Do not publish it.

## Recover without the original browser state

1. Create a separate fresh browser profile for Wildbloom. Leave your original
   Signet installation and browser data intact. Load the saved receipt via
   **Use a saved file event or pool receipt**, then verify it locally. Check
   its author and listed destinations against your private records.
2. Select **Download the encrypted file**, then fetch it. Expect **Pool parts
   and reconstructed ciphertext hash verified** before saving the verified
   encrypted file. This read should work without the original storage signer.
3. Compare the recovered file's size and SHA-256 against your checked offline
   file. The download may use a different filename or `.fswnenc` extension;
   its bytes must match.
4. In another separate fresh Signet browser profile, use Signet's recovery
   flow with your matching recovery words. Keep the words out of Wildbloom,
   command lines, test scripts, recordings and reports. Configure local
   authentication on this recovered installation.
5. Open **Settings → My identities**, select the recovered file under
   **Account collection file** and choose **Open collection**. Approve and
   check the expected timestamp, account count and every original npub.
6. Select the accounts to restore, approve the separate restore request and
   confirm the resulting account count and original npubs. Existing accounts
   cannot be overwritten. Restored accounts do not inherit app permissions.

If any step fails, retain the original installation, independent backups,
checked offline file and receipt. Do not replace them with unverified output.
Failure is not a reason to reset or flash the hardware signer.

## Record the outcome privately

Record only what you actually completed:

- Date, Signet version, browser/OS and number of imported accounts.
- Saved file checked in Signet: pending / passed / failed.
- Offline file and independently retained receipt copies: pending / saved.
- Requested 2-of-4 layout verified: pending / passed / failed.
- Fresh Wildbloom profile retrieved identical bytes: pending / passed / failed.
- Fresh Signet recovered the selected original npubs: pending / passed / failed.

Keep hashes, npubs, labels, receipt IDs and destinations in private records,
outside this repository. A public status update needs only the versions,
counts, steps completed and any redacted error. Do not attach the recovery
material or capture screens showing it.

A successful rehearsal proves this recovery route at that time. It does not
certify future server retention, independent physical failure groups,
hardware recovery or the pending [external security review](ACCOUNT-COLLECTION-SECURITY-REVIEW.md).
The automated local-node suite covers all six possible two-part combinations;
this owner rehearsal does not ask you to stop production nodes to repeat it.
