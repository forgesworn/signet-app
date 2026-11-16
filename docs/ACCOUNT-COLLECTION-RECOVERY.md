# Imported-account collection recovery (preview)

Settings → My identities offers **Back up several accounts** for an owner with
verified local Signet recovery words. Select 1–100 locally held imported
accounts, download `signet-accounts.nstc`, then select the saved file and open
it to authenticate every account and compare the exact downloaded snapshot.
Keep the previous checked snapshot until its replacement has also been checked.
Adding or removing an account does not update older files.

The encrypted file and matching Signet recovery words are both essential.
Words alone cannot reconstruct unrelated nsecs. The file alone cannot decrypt
them. Equivalent access to the same root also opens the file. Keep independent
key backups during the preview; external security review remains pending.

Restore your Signet from its recovery words on a fresh installation, open the
collection under My identities, check its timestamp, names and exact npubs,
then select the accounts to restore. A separate fresh owner approval precedes
one atomic encrypted identity-row write. Existing accounts cannot be overwritten;
a concurrent identity change or lock during encryption refuses the write.
The accounts retain their original keys and `imported: true`, without inherited
app permissions or derivation provenance. Hardware and dependant keys are
excluded. Existing single-account `.nstw` files still work separately.

## Collection v1

The disk file is a standard binary **FSWNENC2** envelope, using Stash's existing
codec at commit `0d9f5e1917a4d4d9dd3bfa661f4bf9f97823e102` (MIT). No new
encryption algorithm or signer protocol is introduced. The input key is the
raw private-key bytes of `derive(fromMnemonic(mnemonic),
'signet/wrapped-account-collection/v1', 0)`. The fixed purpose, index, root
construction and collection schema are part of the recovery contract. The
FSWNENC2 writer supplies fresh random salt, nonce prefix and padding; its
existing HKDF derives a different AES key for each envelope.

Private envelope metadata is `name: 'signet-accounts.json'`,
`type: 'application/json'`. The UTF-8 JSON body is exactly:

```ts
{
  type: 'signet.wrapped-accounts', version: 1,
  createdAt: number, // Unix milliseconds
  accounts: [{name: string, npub: string, record: string}] // 1–100
}
```

Each `record` is the unchanged 181-character `nstw1:` record. Labels are
non-empty, at most 100 UTF-8 bytes and contain no C0/DEL controls. Npubs are
unique and must match each authenticated raw key. Unknown fields/versions,
duplicates and incomplete inventories are refused. The outer envelope
authenticates the entire inventory and records together: deletion, substitution
or truncation cannot silently produce a complete verified backup. All records
are checked before inventory or selected keys are returned.

The accepted collection size is exactly **65,608 bytes** (64 KiB padded
plaintext, 56-byte header and one 16-byte tag), including ten or up to 100
accounts within these bounds. A 2-of-4 layout stores four 32,804-byte parts,
**131,216 bytes** total, plus a separate private receipt. Generic filenames
avoid disclosing account names. A file hash identifies a snapshot but does not
prove it is the latest; recovery displays the authenticated creation date.

The native bridge transports `nstc1:` plus canonical unpadded base64url, then
decodes back to the same binary FSWNENC2 bytes before writing. This bridge text
is not a disk format. Native writes read back and compare the saved bytes;
browser downloads still require explicit saved-file verification.

Root, child and recovered private-key byte buffers are zeroised after use.
JavaScript strings and runtime/dependency copies cannot be reliably erased;
the existing derivation API also creates an immutable nsec string. This is
best-effort software memory hygiene, not hardware isolation.

## Wildbloom storage and fresh recovery

1. First save and check the collection in Signet. Keep an offline copy.
2. In Wildbloom choose a replicated or split pool. For 2-of-4 choose two
   required parts and four total on independent failure groups.
3. Select **Store an already encrypted file**, then choose the `.nstc` file.
   Inspect locally. No additional `wbk1_` key is created.
4. Connect the storage-authorised signer, approve upload/read-back, and save
   the private signed pool receipt. Do not publish that receipt. Retain it
   independently of the data it locates, including an offline copy. A receipt
   alone is not proof that uploads succeeded; wait for verified layout results.
5. In a fresh Wildbloom browser, load and verify the receipt, check its author
   and listed nodes, select **Download the encrypted file**, then fetch and
   save the verified ciphertext. No original device or publishing signer is
   required for this read. Never enter Signet recovery words into Wildbloom.
6. Open the downloaded file in the recovered Signet and restore the selected
   accounts. Signet authenticates the envelope and all account records.

Any two distinct verified parts rebuild the encrypted file. This is erasure
coding, not sharing the root: two servers do not receive decryption authority.
Servers may collude or fetch other parts if they learn their addresses;
confidentiality depends on encryption. Node admission, quota and retention
remain the owner's responsibility. No default servers or automatic upload
are added.

## Bothy Keep integration handover

The collection is already in Bothy's normal FSWNENC2 envelope family. This
establishes byte-format compatibility, **not a delivered Keep upload path**.
Bothy Node exposes its Blossom file store over Link. Signet's existing Keep
pairing provides Nostr control-relay addresses, not a Link file-upload client
or a recoverable file locator. Neither account import nor a Keep claim is a
storage write or proof of a replica.

For Quill/decented's integration, the client must:

- Write these exact ciphertext bytes through the normal admitted keeper
  file-store interface and independently fetch/hash-check each claimed copy.
- Save a private, portable locator containing the Keep/Link endpoint identity,
  blob hash, byte count and verified destinations outside the blob it opens.
- Make read access recoverable from Signet words or a separately retained
  owner credential, never an imported account locked inside the collection.
- Retain the previous verified locator/snapshot until the new one is checked,
  and rehearse a fresh-client read with the original phone unavailable.

No Bothy server, ownership, policy, retention or replication code is changed by
this release. A direct Keep backup button and verified Keep recovery remain
pending that client integration. The downloaded-file and Wildbloom paths can
be used independently.

## Verification scope

The 16 November 2026 integration rehearsal used ten disposable accounts from
public test inputs. Signet produced a 65,608-byte collection; Wildbloom split
the exact bytes into four 32,804-byte parts. Each of the six possible pairs
reconstructed the identical file, and a freshly reconstructed Signet root
recovered every original key and verified 60 offline signatures in total.
One remaining part was insufficient. No event was published and no owner
key, live storage node or connected hardware signer was used.

The Signet browser regression also restores ten accounts, exports and checks
the saved snapshot, then restores one selected account in a separate browser
storage partition. These checks establish software behaviour, not an
independent security audit or physical-device recovery acceptance.
