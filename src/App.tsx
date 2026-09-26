import { useChildContactDirectory, useChildContactDirectoryPublisher } from './hooks/useChildContactDirectory';
import { useChildContactReplyInbox } from './hooks/useChildContactReplyInbox';
import { useGuardianChildContactRequests } from './hooks/useGuardianChildContactRequests';
import type { GuardianChildRequest, GuardianChildRequestSource, GuardianChildStuckRequest } from './hooks/useGuardianChildContactRequests';
import { PairedChildRequestReview } from './components/PairedChildRequestReview';
import { cancelChildContactExecution, executeChildContactPlan } from './lib/child-contact-execution';
import { deliverPendingChildContactReplies } from './lib/child-contact-reply-delivery';
import { loadChildContactReview, type ChildContactExchangePlan } from './lib/child-contact-review';
import { childContactRequestInScope, transitionChildContactReceipt, type ChildContactRequest, type ChildRequestScope } from './lib/child-contact-requests';
import type { ChildExchangeCancelReason } from './lib/contact-invite-service';
import { cancelChildContactRequest, childContactRequestHistory, childExchangeAuthority, reconcileChildContactReplies, sendChildContactReply,
  submitChildContactRequest, CHILD_ASK_HISTORY_LABEL } from './lib/child-contact-lifecycle';
import { resolveChildAskPersona, childDirectoryPersonas, publishChildContactDirectory } from './lib/child-contact-directory-publisher';
import { ChildContactDirectory } from './components/ChildContactDirectory';
import { ChildContactAsk } from './components/ChildContactAsk';
import { useChildContactOutbox } from './hooks/useChildContactOutbox';
import { extractEndpointPubkey } from './lib/dependant-status-sync';
import { sanitizeDisplayName } from './lib/text-sanitize';
import { vaultPurpose } from 'signet-protocol/experimental';
import { rotatePrivateVaultDataset } from './lib/private-vault-sync';
import { supportsPrivateVaultRotationLock } from './lib/private-vault-lock';
import { useChildContactPolicy, useChildContactPolicyPublisher } from './hooks/useChildContactPolicy';
import { projectChildContactPolicy, sealChildContactPolicy } from './lib/child-contact-policy-wire';
import { contactPolicySigningBackend } from './lib/contact-policy-signing-backend';
import { storedContactInviteDecision } from './lib/contact-invite-policy';
import { approveChildContact, updateChildContactSettings } from './lib/db';
import { contactExchangeKey } from './lib/contact-exchange-key';
import { contactConnectionNotifier } from './lib/contact-connection-notifications';
import { uncheckedAppConnection } from './lib/contact-app-notice';
import { useContactAppInvites } from './hooks/useContactAppInvites';
import { ContactInviteQRCard } from './components/ContactInviteQRCard';
import { getOrCreateContactsDeviceId } from './lib/db';
import { BotCarouselCard } from './components/BotCarouselCard';
import { useBotInventory } from './hooks/useBotInventory';
import { publishToRelays } from './lib/sync-relays';
import { BotOwnershipService } from './lib/bot-ownership-service';
import { approveBotAuth } from './lib/bot-auth';
import { createBotSigningBackend } from './lib/bot-signing';
import { approveBotAppGrant, loadBotAppGrants, revokeBotAppGrant } from './lib/bot-app-grants';
import { useBotAppServer } from './hooks/useBotAppServer';
import { useBotOwnership } from './hooks/useBotOwnership';
import { Bots } from './pages/Bots';
import { createBot, loadBotRegistry, updateBotRegistry } from './lib/bot-registry';
import { deriveExtraPersonaPubkey, decodeNsec, bytesToHex } from './lib/signet';
import { nip19 } from 'nostr-tools';
import { ContactsCard } from './components/ContactsCard';
import { parseContactInviteLink } from './lib/contact-invite-link';
import { contactPeerAllowed, recordCompletedContactExchange } from './lib/contact-exchange-record';
import { ContactInvites } from './pages/ContactInvites';
import { ContactIdentityDecryptBudget, type ContactInvite } from '@forgesworn/signet-contacts';
import { ContactInviteService } from './lib/contact-invite-service';
import { contactInviteSigner } from './lib/contact-invite-signer';
import { useContactInviteMailboxes } from './hooks/useContactInviteMailboxes';
import { PrivateVaultStatus } from './components/PrivateVaultStatus';
import { toWire as profilesChangeWire } from './lib/personas-sync';
import { toSyncWire as dependantChangeWire } from './lib/dependants-sync';
import { usePrivateVaults, legacyVaultWriteAllowed, type PrivateVaultHealth } from './hooks/usePrivateVaults';
import { hasLocalVaultTree, privateVaultJobs } from './lib/private-vault-jobs';
import { portableSettingsValues } from './lib/portable-settings';
import { contactsMutationQueue } from './lib/contacts-v2-queue';
import { contactsForGrant } from './lib/contacts-v2-grant-scope';
import { contactIdentityLists } from './lib/contacts-v2-identity-lists';
import { contactBelongsToList } from './lib/contacts-v2-membership';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Page, CarouselRow, SignetIdentity } from './types';
import { resolveAuthSelectionIdentity, findRowForGuardianKeypair, findRowForDependant, resolveDependantCardSlot } from './lib/carousel-utils';
import { resolveSelectedPubkey } from './lib/auth-selection';
import { downscaleAvatar, uploadAvatar, fetchAvatar, uploadContactAvatar, PUBLIC_PICTURE_MAX_EDGE_PX, PUBLIC_BANNER_MAX_EDGE_PX } from './lib/avatar';
import { generateContactAvatarKey } from './lib/photo-crypto';
import { publishContactAvatarPointer, retractContactAvatarPointer } from './lib/contact-avatar';
import { verifiedAuthoredEvent } from './lib/event-verify';
import { resolveSettingsViewer } from './lib/carousel-routing';
import type { StoredCredential, RememberedGrant, ChildSettings as ChildSettingsType, GrantScope, CompanionGrant } from './types';
import { COMPANION_GRANT_CAP } from './types';
import { useSwUpdate } from './hooks/useSwUpdate';
import { useIdentity } from './hooks/useIdentity';
import { useContacts } from './hooks/useContacts';
import { useContactsSync } from './hooks/useContactsSync';
import { useContactsV2Import } from './hooks/useContactsV2Import';
import { shouldMintContactsDeviceId, directoryIdForDependant } from './lib/contacts-v2-ids';
import { ownerSlotPubkeys, dependantImportRefs, pairedChildImportRefs, stableActorPubkey, guardianPubkeysFor } from './lib/contacts-v2-directories';
import {
  resolveContactsScope, scopeEffectiveContext, familyLogEnabled,
  dependantIdsMissingChildSettings,
} from './lib/contacts-v2-scope';
import { resolveActorRights, ownBlocks } from './lib/contacts-v2-rights';
import { detailSections } from './lib/contacts-v2-detail';
import { buildManagerRows } from './lib/contacts-v2-manager-rows';
import {
  OWNER_DIRECTORY_LABEL, FAMILY_CONTACTS_PAGE_TITLE, CONTACTS_LOG_UNAVAILABLE_COPY,
  CONTACTS_BACKUP_TOO_LARGE_COPY, CONTACTS_BACKUP_STALLED_COPY,
} from './lib/contacts-v2-copy';
import { planDependantContactRemoval } from './lib/contacts-v2-removal';
import { resolveIndependenceGate } from './lib/contacts-v2-independence-gate';
import { useContactsV2 } from './hooks/useContactsV2';
import { useContactsV2Reimport } from './hooks/useContactsV2Reimport';
import { useContactsV2Sync, type ContactsV2BackupState } from './hooks/useContactsV2Sync';
import { missingBackupRailsFor } from './lib/sync-banner';
import { useFamilyContactsV2, type FamilyDirectoryRef } from './hooks/useFamilyContactsV2';
import { DEFAULT_CHILD_CEILING, OWNER_DIRECTORY_ID } from './types';
import { useKens } from './hooks/useKens';
import { useKensSync } from './hooks/useKensSync';
import { useCompanionRail } from './hooks/useCompanionRail';
import { useDependantsSync } from './hooks/useDependantsSync';
import { usePersonasSync } from './hooks/usePersonasSync';
import { useCredentialsSync } from './hooks/useCredentialsSync';
import { useGrantsSync } from './hooks/useGrantsSync';
import { useDependantStatusPublisher } from './hooks/useDependantStatusPublisher';
import { useDependantStatus } from './hooks/useDependantStatus';
import { usePersonaInventoryPublisher } from './hooks/usePersonaInventoryPublisher';
import { usePersonaInventory } from './hooks/usePersonaInventory';
import { useBunkerServer, type BunkerRoute, type BunkerServeStatus } from './hooks/useBunkerServer';
import { useEscalations } from './hooks/useEscalations';
import { useHeartwoodOperator } from './hooks/useHeartwoodOperator';
import { usePolicyPush } from './hooks/usePolicyPush';
import { resolveApproval as mgmtResolveApproval } from './lib/heartwood-mgmt';
import { submitVerdict, resolveVerdictAvailability, type PanelVerdictAction } from './lib/policy-push';
import type { EscalationNotice } from './lib/escalation-fetch';
import { LocalNotifications } from '@capacitor/local-notifications';
import { App as CapacitorApp } from '@capacitor/app';
import { isNativeApp, SignetNative } from './lib/native';
import { BunkerApprovalModal } from './components/BunkerApprovalModal';
import { Nip55ApprovalModal } from './components/Nip55ApprovalModal';
import { useNip55Server } from './hooks/useNip55Server';
import { usePreferences } from './hooks/usePreferences';
import { useDocuments } from './hooks/useDocuments';
import { useCredentials } from './hooks/useCredentials';
import { useDependants } from './hooks/useDependants';
import type { DependantDeviceDerive, ExtraPersonaDeviceDerive } from './hooks/useDependants';
import { Layout } from './components/Layout';
import { Carousel } from './components/Carousel';
import { ApprovalOverlay } from './components/ApprovalOverlay';
import { GuardianBanner } from './components/GuardianBanner';
import { RepairBanner } from './components/RepairBanner';
import { RateLimitBanner } from './components/RateLimitBanner';
import { AndroidAppPromo } from './components/AndroidAppPromo';
import { ANDROID_APP_URL, shouldPromoteAndroidApp, snoozeApkPromo } from './lib/android-promo';
import { BackupCard } from './components/BackupCard';
import { shouldShowBackupNudge, BACKUP_NUDGE_SNOOZE_MS } from './lib/backup-nudge';
import { LegacyGuestNotice } from './components/LegacyGuestNotice';
import { DependantSwitchPicker } from './components/DependantSwitchPicker';
import { useCarousel } from './hooks/useCarousel';
import { routeQR } from './lib/qr-router';
import { safeOrigin } from './lib/origin-display';
import { AddDependant } from './pages/AddDependant';
import { ApproveAddDependant } from './pages/ApproveAddDependant';
import { ImportDependant } from './pages/ImportDependant';
import { OnboardingApp } from './pages/OnboardingApp';
import { Onboarding } from './pages/Onboarding';
import { PairChildOnboarding } from './pages/PairChildOnboarding';
import { getPublicKey } from 'nostr-tools/pure';
import { FamilyList } from './pages/FamilyList';
import { FamilyContacts } from './pages/FamilyContacts';
import { ContactsRolodex } from './pages/ContactsRolodex';
import { ContactDetail } from './pages/ContactDetail';
import { ContactNew } from './pages/ContactNew';
import { AddMember } from './pages/AddMember';
import { SettingsMenu } from './pages/SettingsMenu';
import { GuardianSettings } from './pages/GuardianSettings';
import { GuardianActivityRoute, ChildActivityRoute } from './pages/Activity';
import { SecuritySettings } from './pages/SecuritySettings';
import { Profile } from './pages/Profile';
import { Personas } from './pages/Personas';
import { AdvancedSettings } from './pages/AdvancedSettings';
import { ManageCarousel } from './pages/ManageCarousel';
import { EditPublicProfile } from './pages/EditPublicProfile';
import { PersonaAdvanced } from './pages/PersonaAdvanced';
import { ActivateRealIdentity } from './pages/ActivateRealIdentity';
import { RequireRealIdentity } from './components/RequireRealIdentity';
import { resolveActivationBackupStep } from './lib/activation-backup-step';
import { isNaturalPersonActive, isDependantNaturalPersonActive } from './lib/identity-display';
import { dependantGateReason } from './lib/real-identity-gate-reasons';
import { toRecoveryWords } from './lib/recovery-words';
import type { SlotKind as PersonaAdvancedSlotKind } from './pages/PersonaAdvanced';
import { KenAdd } from './pages/KenAdd';
import { KenDetail } from './pages/KenDetail';
import { publishPublicProfile, retractPublicProfile, contentHashFor } from './lib/public-profile-publish';
import { uploadToBlossom, DEFAULT_BLOSSOM_URL } from './lib/blossom';
import { GetVerified } from './pages/GetVerified';
import { MyDocuments } from './pages/MyDocuments';
import { VerifySomeone } from './pages/VerifySomeone';
import { ShamirBackup } from './pages/ShamirBackup';
import { IdentityBridge } from './pages/IdentityBridge';
import { CredentialDetail } from './pages/CredentialDetail';
import { ApproveVerification } from './pages/ApproveVerification';
import { ApproveConnect } from './pages/ApproveConnect';
import { ApproveCompanionGrant } from './pages/ApproveCompanionGrant';
import { CompanionApps } from './pages/CompanionApps';
import { Connections, type PhoneApp } from './pages/Connections';
import { ApproveAuth, approveAuthTitle } from './pages/ApproveAuth';
import type { AuthSelection } from './pages/ApproveAuth';
import { RelayAuthAck } from './pages/RelayAuthAck';
import { AuthScreen } from './pages/AuthScreen';
import { AppShell } from './components/AppShell';
import { SetupAuth } from './pages/SetupAuth';
import { WebVerify } from './pages/WebVerify';
import { VenueEntry } from './pages/VenueEntry';
import { PhotoCapture } from './pages/PhotoCapture';
import { BadgeEmbed } from './pages/BadgeEmbed';
import { VouchSomeone } from './pages/VouchSomeone';
import { TransitionCeremony } from './pages/TransitionCeremony';
import { PairDependantDevice } from './pages/PairDependantDevice';
import { PairDependantApp } from './pages/PairDependantApp';
import { MigrateToHeartwood } from './pages/MigrateToHeartwood';
import { parseHeartwoodIdentities, pickOwnerIdentities } from './lib/heartwood-identities';
import { derivePersonaToken } from './lib/heartwood-enrolment';
import { PairedChildSwitcher } from './pages/PairedChildSwitcher';
import { Roster } from './pages/Roster';
import { getActivePubkey, getActiveDisplayName, signAuthChallenge, encodeNpub, hexToBytes, validateMnemonic, isValidHexKey } from './lib/signet';
import { LocalSigningBackend, BunkerSigningBackend, Nip07SigningBackend, createLocalBackends, createLocalBackendsFromKeyMaterial, generateBunkerClientSecret } from './lib/signing-backend';
import { deriveRailKeypair, publishSnapshot, revokeCompanionGrant, SNAPSHOT_D_TAG } from './lib/companion-rail';
import { ACK_KIND, buildPairingAckContent, parsePairingRequest } from './lib/companion-pair';
import { routeNativeUrl } from './lib/native-url';
import type { PairingRequest } from './lib/companion-pair';
// Contacts v2 app grants (Phase E, Task 22). The approval screen, the pairing
// adapter, the projection builders, the three grant hooks and the pure
// directory composition the wiring below feeds them.
import { ContactsGrantApprove } from './pages/ContactsGrantApprove';
import { ContactsGrantCode } from './pages/ContactsGrantCode';
import { ContactsGrantList } from './components/ContactsGrantList';
import type { GrantChoice } from './pages/ContactsGrantApprove';
import type { ContactsGrantCodeCheck } from './pages/ContactsGrantCode';
import {
  buildPairingAckV2Content, newGrantId, newRailKeypair, parseContactsPairingRequestV2,
} from './lib/companion-pair-v2';
import type { PairingRequestV2 } from './lib/companion-pair-v2';
import { ackEventTemplate, projectionTag, proposalTag } from '@forgesworn/signet-contacts/wire';
import { buildContactProjection, buildRevocationProjection, scopedIdIndex } from './lib/contact-projection';
import {
  buildProjectionDirectories, grantIdentityOptions, projectableDirectoryRefs,
} from './lib/contacts-grant-directories';
import { applyContactProposal } from './lib/contacts-v2-proposals';
import {
  useContactProjections, publishProjectionForGrant, nextProjectionStamp,
  liveProjectionStampFloor, tombstoneDeviceId,
} from './hooks/useContactProjections';
import { useContactProposals, type AddKenOutcome } from './hooks/useContactProposals';
import { useContactGrantsRail, type ContactGrantsRailBackupState } from './hooks/useContactGrantsRail';
import { applyOperations } from './lib/contacts-v2-reducer';
import { resolveEffectiveDirectory } from './lib/contacts-v2-effective';
import { isValidRelayUrl } from './lib/relay-url';
import { CONTACT_GRANT_V2_CAP } from './types';
import type { AppGrantV2 } from './types';
import {
  CONTACTS_GRANT_AT_CAP_COPY, CONTACTS_GRANT_DIRECTORY_UNAVAILABLE_COPY,
  CONTACTS_GRANT_NOT_READY_COPY, CONTACTS_GRANT_CONNECT_FAILED_COPY,
  CONTACTS_GRANT_DISCONNECT_FAILED_COPY, CONTACTS_GRANT_FORGET_FAILED_COPY,
  GRANTS_BACKUP_TOO_LARGE_COPY, GRANTS_SKIPPED_REMOTE_COPY, CONTACTS_GRANT_APPROVE_TITLE,
  CONTACTS_GRANT_CAPABILITIES_INVALID_COPY, CONTACTS_GRANT_FIRST_UPDATE_FAILED_COPY,
  CONTACTS_GRANT_PAIRED_CHILD_COPY, CONTACTS_GRANT_DISMISS_LABEL, CONTACTS_GRANT_CODE_TITLE,
} from './lib/contacts-v2-copy';
import {
  saveContactGrantV2, getContactGrantV2, listContactGrantsV2, updateContactGrantV2,
  deleteContactGrantV2, listContactOperationsV2, saveContactOperationsV2, isGrantCapError,
} from './lib/db';
import { identityKeypairs } from './lib/contacts-sync';
import { forgetSyncCacheKeys } from './lib/sync-decrypt-cache';
import { resolveSyncRelays } from './lib/sync-relays';
import { deleteHeartwoodOperator } from './lib/db';
import { contactToKindredEntry } from './lib/kindred-adapter';
import { RelayClient } from 'signet-protocol';
import { buildOwnerPersonaRoutes } from './lib/persona-bunker-routes';
import { resolveDependantRouteSlots } from './lib/dependant-route-slots';
import { resolveGuardianBackend, assertSigningIdentity, approvalGuardianPubkeys, isImportedGuardianPersona } from './lib/guardian-signing';
import { BunkerBackendRouter, createRouterWithRetry, routedSignerUnavailableMessage, resolveNpBunkerBackend, resolveSlotBunkerBackend, resolveServerTransportBackend } from './lib/bunker-router';
import type { RouterProbeState } from './lib/bunker-router';
import { awaitRoutedBackend, acquireRoutedBackend, ROUTED_APPROVAL_WAIT_MS } from './lib/await-routed-backend';
import { handOffAuthCallback, shouldRedirectDenial } from './lib/auth-redirect-handoff';
import { AuthRequestSettlement, authRequestKey, requestObjectKey } from './lib/auth-request-settlement';
import { deliverConnectApproval, ConnectWithdrawnError } from './lib/connect-delivery';
import { ConnectRouteTracker } from './lib/connect-route-cancel';
import type { SigningBackend, DecryptingSigningBackend } from './lib/signing-backend';
import { parseSignInRequest, getUrlAuthSiteName, buildAuthCallbackUrl, buildAuthDeniedUrl, parseAddDependantRequest, buildAddDependantProofTemplate, buildAddDependantCallbackUrl, buildAddDependantErrorUrl } from './lib/url-auth';
import type { AddDependantRequest } from './lib/url-auth';
import { parseVerifyRequestFromUrl, buildVerifyCallbackUrl, buildVerifyDeniedUrl } from './lib/url-verify';
import type { ConsumerHint } from './types';
import { logAuthRequest, updateAuthRequestOutcome } from './lib/auth-request-log';
import type { AuthRequestLogEntry } from './lib/auth-request-log';
import { DeveloperDiagnostics } from './pages/DeveloperDiagnostics';
import { Professional } from './pages/Professional';
import { ProOnboarding } from './pages/ProOnboarding';
import { ProDashboard } from './pages/ProDashboard';
import { SubRoleProDashboard } from './pages/SubRoleProDashboard';
import { SelfCertIssue } from './pages/SelfCertIssue';
import { ProAttest } from './pages/ProAttest';
import { LeadAddStaff } from './pages/LeadAddStaff';
import { LeadManageDelegates } from './pages/LeadManageDelegates';
import { useProRoleAnchor } from './hooks/useProRoleAnchor';
import { deriveAndStoreProPersona } from './hooks/useIdentity';
import { proModeBlockedReason, publishProKind0 } from './lib/professional/pro-persona';
import { PRO_ROSTER } from './lib/professional/kinds';
import type { RosterMember } from './lib/professional/role-anchor';
import { useNavigation } from './hooks/useNavigation';
import { useScreenWakeLock, isWakeLockSupported } from './hooks/useScreenWakeLock';
import { BunkerPanel } from './components/BunkerPanel';
import { isBarHiddenPage, isOrphanedApprovalPage } from './lib/app-nav';
import { stayAwakeUntil as computeStayAwakeUntil } from './lib/stay-awake';

/**
 * How long the key stays after the app is hidden once a phone app has been
 * served over NIP-55. The calling app is in front for the whole exchange, so
 * a hide-lock here would mean a PIN for every signature it sends, even one
 * the person allowed always; the phone's own lock screen is the boundary for
 * these few minutes, as it is for a stay-awake window.
 */
const PHONE_APPS_WINDOW_MS = 5 * 60 * 1000;
import { useAuthorizedSites } from './hooks/useAuthorizedSites';
import { useConnectedClients } from './hooks/useConnectedClients';
import { useOriginPolicies } from './hooks/useOriginPolicies';
import { useOwnBadge } from './hooks/useOwnBadge';
import { useRosterWatch } from './hooks/useRosterWatch';
import { isAuthSetUp, generateEncryptionKey, clearAuthData, getAuthMethod, authenticateGrace } from './lib/auth';
import { resolveLegacyGuestKey, nextLegacyMigrationState, isLegacyUnprotectedInstall } from './lib/legacy-guest';
import type { PurposeContext } from './lib/auth-purposes';
import { loadIdentityDecrypted, cleanupUnencryptedIdentities, purgeAllUserData, saveBunkerSecret, deleteBunkerSecret, loadBunkerSecret, getPreferences, savePreferences, migrateCleartextBunkerUri, saveIdentityEncrypted, saveChildModeSession, loadChildModeSession, clearChildModeSession, savePairedChild, loadPairedChild, markPairedChildConnected, listPairedChildMetas, listAllGrantsIncludingTombstones, getChildSettings, saveConnectedClient, deleteConnectedClient, getConnectedClient, addAppBunkerPairingAndClearSecret as dbAddAppBunkerPairingAndClearSecret, ensureAppBunkerEndpoint as dbEnsureAppBunkerEndpoint, setAppBunkerPairingSecret as dbSetAppBunkerPairingSecret, listAppBunkerPairings as dbListAppBunkerPairings, removeAppBunkerPairing as dbRemoveAppBunkerPairing, repairPairedChild, clearPairedChildPersonaRevision, saveContactAvatar, clearGraceState, clearGraceKey, listCompanionGrants, saveCompanionGrant, getContacts, getKens, saveDependant, loadProPersonaDecrypted, saveProPersonaEncrypted } from './lib/db';
import { stripIdentityKeys, stripDependantKeys, clearMigratedKeyReferences } from './lib/heartwood-strip';
import type { EnrolmentSlot } from './lib/heartwood-enrolment';
import { deriveDependantOnDevice, deriveExtraPersonaOnDevice } from './lib/heartwood-dependant-create';
import type { HeartwoodRequestFn } from './lib/heartwood-dependant-create';
import type { PairedChildMeta } from './lib/db';
import type { VerifyRequest, VerifyResponse } from './lib/presentation';
import { buildVerifyResponse, sendResponseViaBroadcast, parseVerifyRequest } from './lib/presentation';
import { parseStoredCredentialEvent, pickCredential, pickCredentialForSubject } from './lib/pick-credential';
import { publishVerifyResponseToRelay, publishVerifyRejectionToRelay, publishAuthResponseToRelay, getLastAuthPublishError } from './lib/relay-publish';
import type { AuthResponse } from './lib/relay-publish';
import { publishAuditEvent } from './lib/audit';
import { resolveAuditVisibility } from './lib/audit-visibility';
import { markRecentRestore, hasRecentRestore, clearRecentRestore } from './lib/recent-restore';
import { buildConnectedClientFromNostrConnect, parseNostrConnectURI, sendConnectResponse } from './lib/nip46';
import { parseCallback, buildCallbackRedirect } from './lib/nostrconnect-callback';
import { checkAutonomy } from './lib/autonomy-gate';
import { setRelays as setRelayServiceRelays, getRelayUrl as getRelayServiceUrl, connectRelay, DEFAULT_RELAY_URL, defaultRelays, fetchEvents } from './lib/relay-service';
import { buildPhoneBunkerUrl, buildAuthFlowBunkerUrl } from './lib/bunker-url';
import { runtimeBunkerUriForBackend, storedBunkerUriForGuardianNaturalPerson } from './lib/bunker-handoff';
import { buildPairingURI, generatePairingSecret } from './lib/pairing-uri';
import type { NostrConnectRequest } from './lib/nip46';
import type { AuthRequest, LoginRequest } from './lib/qr-router';
import { Z } from './lib/z-index';

const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const NOSTRCONNECT_SERVE_MINUTES = 2;
const NOSTRCONNECT_SINGLE_RELAY_OPEN_TIMEOUT_MS = 10_000;
const NOSTRCONNECT_MULTI_RELAY_OPEN_TIMEOUT_MS = 5_000;
const AUTH_FLOW_BUNKER_FALLBACK_RELAYS = [
  'wss://relay.trotters.cc',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.ditto.pub',
] as const;

// "Family asks" native-notification ids: hashed off the escalation notice's
// `id` (opaque string) into a range well clear of the small sequential ints
// `useBunkerServer`'s handleCounterRef hands out for pending-approval
// notifications, so the two id spaces can never collide.
const ESCALATION_NOTIFICATION_ID_BASE = 1_000_000;
const ESCALATION_NOTIFICATION_ID_RANGE = 900_000;

/** Deterministic small-int hash (FNV-1a, 32-bit) — id → notification id only, not security-sensitive. */
function hashToUint32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Where one contacts v2 grant's projection is published: every valid
 * configured write relay AND the grant's own relay (the one the app actually
 * reads, fixed at pairing). Mirrors `useContactProjections`' own I2 target
 * rule, so a write-relay-set edit after pairing can never orphan a grant on a
 * relay nobody in `relays.write` covers — including for the revocation
 * tombstone, which is the one publish that must reach the app.
 */
function contactsGrantPublishTargets(grant: AppGrantV2, writeRelays: string[]): string[] {
  const valid = writeRelays.filter(isValidRelayUrl);
  return Array.from(new Set(isValidRelayUrl(grant.relay) ? [...valid, grant.relay] : valid));
}

function requireNostrConnectRouteBackend(backend: SigningBackend): DecryptingSigningBackend {
  if (typeof (backend as Partial<DecryptingSigningBackend>).nip44Decrypt !== 'function') {
    throw new Error('Selected signer cannot serve NostrConnect requests because it does not support NIP-44 decrypt.');
  }
  return backend as DecryptingSigningBackend;
}

function formatNostrConnectServeStatus(
  status: BunkerServeStatus,
  expectedRelayUrl: string,
  expectedRoutePubkey: string,
): string {
  const actualRelay = status.relayUrl ?? 'none';
  const hasRoute = status.routePubkeys.some(pk => pk.toLowerCase() === expectedRoutePubkey.toLowerCase());
  const routeState = hasRoute ? 'route present' : `route missing (${status.routePubkeys.length} active)`;
  const notice = status.lastNotice ? `; relay notice: ${status.lastNotice.slice(0, 120)}` : '';
  return `phase ${status.phase}; relay ${actualRelay}; expected ${expectedRelayUrl}; ${routeState}${notice}`;
}

export function App() {
  // Auth state (must be declared before hooks that depend on encryptionKey)
  const [encryptionKey, setEncryptionKey] = useState<string | null>(null);
  const [pendingEncryptionKey, setPendingEncryptionKey] = useState<string | null>(null);
  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inactivityTimeoutRef = useRef(INACTIVITY_TIMEOUT_MS);

  // Stay-awake window — foreground-only; holds off the inactivity auto-lock.
  const [stayAwakeUntil, setStayAwakeUntil] = useState<number | null>(null);
  const stayAwakeUntilRef = useRef<number | null>(null);
  stayAwakeUntilRef.current = stayAwakeUntil;
  /** End of the window during which a hidden app keeps its key for the phone apps it serves (NIP-55). */
  const phoneAppsUntilRef = useRef<number | null>(null);

  // Native always-on serving (#APK): while true, the bunker serves with the
  // screen off — the foreground service + partial wake lock keep the WebView
  // alive, and the hide/idle auto-locks are suspended exactly like an active
  // stay-awake window. Native-only; never true on web.
  const [backgroundServing, setBackgroundServing] = useState(false);
  const backgroundServingRef = useRef(backgroundServing);
  backgroundServingRef.current = backgroundServing;
  const [bunkerReconnectNonce, setBunkerReconnectNonce] = useState(0);

  // Bunker panel pending arm — set when user clicks +X while locked and requests unlock.
  // After successful unlock, the panel reopens and arms with this value.
  const [pendingBunkerArm, setPendingBunkerArm] = useState<number | null>(null);

  // On-demand auth prompt — shown as an overlay when a signing operation needs the encryption key
  const [showAuthPrompt, setShowAuthPrompt] = useState(false);
  const [authPromptContext, setAuthPromptContext] = useState<PurposeContext | undefined>(undefined);
  const authResolverRef = useRef<((key: string | null) => void) | null>(null);

  /**
   * Request auth from the user. Returns the encryption key, or null if
   * cancelled/failed. Single-slot: if a prior auth prompt is still pending,
   * reject immediately so the caller can handle "auth busy" rather than
   * silently overwriting the earlier resolver and leaking its promise
   * (which would orphan any try/finally cleanup — e.g. temp signing backend
   * destruction).
   *
   * Optional `ctx` describes WHY the prompt is firing — see auth-purposes.ts.
   * When omitted, defaults to the generic "unlock-app" purpose, matching
   * pre-purpose-system behaviour.
   */
  const requestAuth = useCallback((ctx?: PurposeContext): Promise<string | null> => {
    if (encryptionKey) return Promise.resolve(encryptionKey);
    if (!isAuthSetUp()) return Promise.resolve(null);
    if (authResolverRef.current) return Promise.resolve(null);
    return new Promise((resolve) => {
      authResolverRef.current = resolve;
      setAuthPromptContext(ctx);
      setShowAuthPrompt(true);
    });
  }, [encryptionKey]);

  /** Always prompt for PIN/biometric, even if already unlocked. For sensitive reveals. */
  const requestFreshAuth = useCallback((ctx?: PurposeContext): Promise<string | null> => {
    if (!isAuthSetUp()) return Promise.resolve(null);
    if (authResolverRef.current) return Promise.resolve(null);
    return new Promise((resolve) => {
      authResolverRef.current = resolve;
      setAuthPromptContext(ctx);
      setShowAuthPrompt(true);
    });
  }, []);

  const handleAuthPromptUnlock = useCallback((key: string) => {
    setEncryptionKey(key);
    setShowAuthPrompt(false);
    setAuthPromptContext(undefined);
    // If there's a pending bunker arm (user clicked +X while locked), reopen panel and arm.
    if (pendingBunkerArm !== null) {
      setBunkerPanelOpen(true);
      setStayAwakeUntil(computeStayAwakeUntil(Date.now(), pendingBunkerArm));
      setPendingBunkerArm(null);
    }
    authResolverRef.current?.(key);
    authResolverRef.current = null;
  }, [pendingBunkerArm]);

  const handleAuthPromptCancel = useCallback(() => {
    setShowAuthPrompt(false);
    setAuthPromptContext(undefined);
    authResolverRef.current?.(null);
    authResolverRef.current = null;
  }, []);
  const openAndroidApp = useCallback(() => {
    window.open(ANDROID_APP_URL, '_blank', 'noopener');
  }, []);
  const getVerifiedSavedInjectorRef = useRef<((eventJsons: string[]) => void) | null>(null);

  // PWA service worker registration. Poll for a freshly-deployed SW every 60s.
  // `useRegisterSW` otherwise only checks for a new worker at registration
  // (page load), and the manifest uses launch_handler 'navigate-existing'
  // (vite.config.ts), so relaunching the installed PWA can reuse the warm
  // running instance instead of cold-starting. Without this poll a warm client
  // never re-fetches sw.js, so `needRefresh` never flips and neither the
  // lock-transition auto-update (below) nor the update banner ever fires — the
  // build badge stays stuck on the old version/time/hash until a true cold
  // start, which 'navigate-existing' keeps avoiding. sw.js is served
  // `no-store`, so each update() reliably picks up the new worker.
  const { needRefresh, updateServiceWorker } = useSwUpdate();

  const { identity, loading: identityLoading, create, restore, restoreWithProfile, importNsec, importLiteMnemonic, addImportedPersona, markBackedUp, switchPrimary, activateNaturalPerson, updatePhoto, updateDisplayName, addPersona, setExtraPersonaHidden, removeExtraPersona, reorderExtraPersonas, applyRemotePersonas, setPersonaAvatar, clearPersonaAvatar, setPersonaContactAvatar, clearPersonaContactAvatar, setPersonaPublicProfile, clearPersonaPublicProfile, setSlotNip05Check, reload: reloadIdentity } = useIdentity(encryptionKey);
  const activePubkey = identity ? getActivePubkey(identity) : undefined;
  const npActive = identity ? isNaturalPersonActive(identity) : false;
  // Session-level hide for the Android app promo. Snooze persistence lives in
  // localStorage (shouldPromoteAndroidApp); this state hides it immediately on
  // "Not now" without waiting for a re-read. Resets next session; the 30-day
  // localStorage snooze keeps it hidden across sessions.
  const [apkPromoDismissed, setApkPromoDismissed] = useState(false);
  // Spec §9 — one-release migration for identities created under the retired
  // no-lock tier. 'notice' shows the explanation; 'setup' runs SetupAuth over
  // the SAME encryption key (re-wrap, not re-key: contacts, credentials and
  // kens are all encrypted under it). Null once migrated, or for everyone else.
  const [legacyMigration, setLegacyMigration] = useState<'notice' | 'setup' | null>(null);
  const [legacyMigrationKey, setLegacyMigrationKey] = useState<string | null>(null);
  const [legacyMigrationError, setLegacyMigrationError] = useState('');
  // Latched once the probe has found a legacy row, so it decides ONCE. The
  // effect below re-runs on every new `identity` object (a sync-rail merge or
  // persona reconcile is enough) and `getAuthMethod()` reads 'grace' for the
  // whole of the setup screen, so without this — and without
  // `nextLegacyMigrationState`'s prev-wins fold — a mid-setup re-run would
  // discard the entered PIN, and one landing mid-`endGraceWithPin` would strand
  // the user: wrap done, grace handle gone, marker row still there.
  const legacyMigrationCheckedRef = useRef(false);

  useEffect(() => {
    if (!identity) return;
    if (legacyMigrationCheckedRef.current) return;
    // The stored auth method alone decides it. The per-identity marker row used
    // to be required too, which left an install whose row had already gone —
    // an interrupted migration — falling through to an `AuthScreen` it has no
    // PIN or biometric to answer. See `isLegacyUnprotectedInstall`.
    if (!isLegacyUnprotectedInstall(getAuthMethod())) return;
    legacyMigrationCheckedRef.current = true;
    setLegacyMigration(prev => nextLegacyMigrationState(prev, true));
  }, [identity]);

  // The recovered master key must never outlive a lock. Keyed on
  // `encryptionKey` ALONE so it fires on the lock transition and not on every
  // render while locked — a legacy identity whose key the auto-lock already
  // nulled is the common case here, and a broader dep list would wipe its
  // in-progress setup. An abandoned setup falls back to the notice, where one
  // tap re-recovers the key from the stored handle.
  useEffect(() => {
    if (encryptionKey) return;
    setLegacyMigrationKey(null);
    setLegacyMigration(prev => (prev === 'setup' ? 'notice' : prev));
  }, [encryptionKey]);
  const { members, addMember, reload: reloadContacts } = useContacts(activePubkey, encryptionKey);
  const { kens, addKen: addKenEntry, removeKen: removeKenEntry, reload: reloadKens } = useKens(activePubkey);
  const { preferences, loading: prefsLoading, setTheme, securityTier, wordCount, setSecurityTier, setRelayUrl, setRelays, blossomConsent, setBlossomConsent, setDefaultBlossomUrl, resetDefaultBlossomUrl, blurIdentityNames, setBlurIdentityNames, requireNpConfirmation, setRequireNpConfirmation, preferPersonaForSignIns, setPreferPersonaForSignIns, preferredPersonaPubkey, setPreferredPersonaPubkey, bunkerServerEnabled, setBunkerServerEnabled, setBackgroundBunkerEnabled, setFallbackBunkerRelays, snoozeBackupNudge, reloadPreferences } = usePreferences();
  // One paired-child flag for the whole component (ledger T15). The signer-
  // status banner, the contacts-v2 import scope and every `isPairedChild ?`
  // branch below read THIS const — never a second copy of the same test.
  const isPairedChild = preferences.signingMode === 'paired-child';

  // M1 (2026-07-02 audit): AppPreferences.bunkerUri carries a reusable
  // NIP-46 reauth secret and is encrypted at rest (see db.savePreferences).
  // On unlock: (a) migrate any pre-existing cleartext value into encrypted
  // storage, then (b) refresh `preferences` React state with the decrypted
  // URI so the handoff/reconnect call sites that read `preferences.bunkerUri`
  // keep working unchanged. Both steps are no-ops when there's nothing to do.
  useEffect(() => {
    if (!encryptionKey) return;
    const key = encryptionKey;
    void (async () => {
      await migrateCleartextBunkerUri(key).catch(() => {
        // Non-fatal — worst case the legacy cleartext value survives this
        // unlock and migrates on a later one.
      });
      await reloadPreferences(key);
    })();
  }, [encryptionKey, reloadPreferences]);

  // Cross-device contacts sync, Phase 1.
  // Uses the NP backend (bunker / nip07 / local, in priority order).
  // Relay URL falls back to the app default when preferences haven't loaded.
  // Documents belong to the real identity, never to whichever keypair happens
  // to be primary (spec §7.3). No app surface writes documents today, so this
  // read-side pin cannot orphan an existing record.
  const { documents } = useDocuments(identity?.naturalPerson.publicKey, encryptionKey);
  const { credentials, addCredential, refresh: reloadCredentials } = useCredentials(encryptionKey);
  const { sites: authorizedSites, authorize: authorizeSite, revoke: revokeSite, updateAlias: updateSiteAlias } = useAuthorizedSites();
  // Home-ring backup nudge (spec §10) — replaces the retired no-lock nag in
  // the same slot. `identity` and `encryptionKey` gate it to the unlocked,
  // loaded state; the rule itself lives in `shouldShowBackupNudge`.
  const showBackupNudge = !!identity && !!encryptionKey && shouldShowBackupNudge({
    backedUp: identity.backedUp === true,
    hasMnemonic: !!identity.mnemonic,
    isPairedChild: preferences.signingMode === 'paired-child',
    createdAtSeconds: identity.createdAt,
    authorizedSiteCount: authorizedSites.length,
    snoozedUntilMs: preferences.backupNudgeSnoozedUntil,
    nowMs: Date.now(),
  });
  const { clients: connectedClients, disconnect: disconnectClient } = useConnectedClients();
  const { policies: originPolicies, recordSignIn: recordOriginSignIn, setPinned: setOriginPinned } = useOriginPolicies();
  const { badge: ownBadge } = useOwnBadge(activePubkey, preferences.relayUrl);
  // Pro persona pubkey — null until identity is loaded and Pro persona derived.
  // Separate from NP pubkey; used for all Pro-surface acts (§4.5).
  const [proPersonaPubkey, setProPersonaPubkey] = useState<string | null>(null);
  // Widened to DecryptingSigningBackend so a Heartwood router-backed backend
  // (bunker mode, family-bunker §11.1.3) can be assigned here alongside the
  // local-mode LocalSigningBackend — both satisfy the interface.
  const [proBackend, setProBackend] = useState<DecryptingSigningBackend | null>(null);
  // Current roster for LeadAddStaff — fetched from relay before entering the page
  // to prevent the append replacing the entire existing roster (§6.9 fix).
  // null = not yet fetched; [] = fetched and empty (first-time add); populated = fetched members.
  const [leadAddStaffRoster, setLeadAddStaffRoster] = useState<RosterMember[] | null>(null);
  const [leadAddStaffRosterLoading, setLeadAddStaffRosterLoading] = useState(false);
  // Current roster+delegates for LeadManageDelegates — same fetch-then-update pattern.
  const [manageDelegatesRoster, setManageDelegatesRoster] = useState<{ members: RosterMember[]; delegates: string[] } | null>(null);
  const [manageDelegatesLoading, setManageDelegatesLoading] = useState(false);

  const { anchor: proAnchor, isLoading: proAnchorLoading, publish: proAnchorPublish } = useProRoleAnchor(
    proPersonaPubkey
  );

  // Roster-watch: on unlock, check relay for firm roster and promote pending
  // self-cert credentials to confirmed when the chain is complete. Spec §6.10.5.
  const { runPromotionCheck } = useRosterWatch(
    proPersonaPubkey,
    credentials,
    encryptionKey,
    () => { void reloadCredentials(); },
  );

  // Trigger roster promotion check whenever the Pro persona pubkey becomes
  // available (i.e. on unlock) and credentials have loaded.
  useEffect(() => {
    if (proPersonaPubkey && encryptionKey && credentials.length > 0) {
      void runPromotionCheck();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proPersonaPubkey, encryptionKey]);

  // Derive sub-role pending state from issued self-cert credentials.
  // If the user has Pro persona but no confirmed anchor, and has issued at least
  // one pending self-cert credential, we route to SubRoleProDashboard. (§6.10.9)
  const pendingSelfCertCredentials = credentials.filter(
    c => c.verifierStatus === 'pending' && c.pendingIssuedAt !== undefined,
  );
  const hasPendingSelfCert = pendingSelfCertCredentials.length > 0;
  // Extract claimed firm/role/profession from the first pending self-cert credential's event tags.
  const firstSelfCertEvent = hasPendingSelfCert
    ? (() => {
        try { return JSON.parse(pendingSelfCertCredentials[0].event) as { tags?: string[][] }; }
        catch { return null; }
      })()
    : null;
  const selfCertClaimedFirm = firstSelfCertEvent?.tags?.find(t => t[0] === 'claimed-firm')?.[1] ?? '';
  const selfCertClaimedFirmKind = firstSelfCertEvent?.tags?.find(t => t[0] === 'claimed-firm-kind')?.[1] ?? 'URN';
  const selfCertClaimedRole = firstSelfCertEvent?.tags?.find(t => t[0] === 'claimed-role')?.[1] ?? '';
  // Profession kind is stored in the anchor data when available; otherwise infer from firm kind.
  const selfCertProfessionKind =
    selfCertClaimedFirmKind === 'URN' ? 'school' :
    selfCertClaimedFirmKind === 'CQC-ProviderID' ? 'gp-practice' :
    selfCertClaimedFirmKind === 'SRA-FirmNumber' ? 'solicitor-firm' :
    'school';

  // Derive confirmed sub-role state — credentials promoted from pending by useRosterWatch.
  // A confirmed sub-role has at least one credential with verifierStatus: 'confirmed'
  // and pendingIssuedAt set (indicating it was originally a self-cert that got promoted).
  // Phase 7, Task 16.
  const confirmedSelfCertCredentials = credentials.filter(
    c => c.verifierStatus === 'confirmed' && c.pendingIssuedAt !== undefined,
  );
  const isChainConfirmedSubRole = confirmedSelfCertCredentials.length > 0 && !proAnchor;
  const firstConfirmedSelfCertEvent = isChainConfirmedSubRole
    ? (() => {
        try { return JSON.parse(confirmedSelfCertCredentials[0].event) as { tags?: string[][] }; }
        catch { return null; }
      })()
    : null;
  const confirmedSelfCertClaimedFirm = firstConfirmedSelfCertEvent?.tags?.find(t => t[0] === 'claimed-firm')?.[1] ?? selfCertClaimedFirm;
  const confirmedSelfCertClaimedFirmKind = firstConfirmedSelfCertEvent?.tags?.find(t => t[0] === 'claimed-firm-kind')?.[1] ?? selfCertClaimedFirmKind;
  const confirmedSelfCertClaimedRole = firstConfirmedSelfCertEvent?.tags?.find(t => t[0] === 'claimed-role')?.[1] ?? selfCertClaimedRole;

  // Dependant management
  // Always use NP pubkey for dependant lookup — dependants are stored with guardianPubkey
  // as the NP key, so switching to persona must not lose sight of them.
  const guardianNpPubkey = identity?.naturalPerson.publicKey;
  const { dependants, loading: dependantsLoading, addDependant, importDependant, removeDependant, updateAutonomyStage, updateAuditVisibility, updatePetitionOnDeny, updateDependantName, updateDependantPhoto, switchDependantPrimary, updateDependantPersonaName, activateDependantNaturalPerson, addDependantPersona, updatePersonaVisibility, removeDependantExtraPersona, reorderDependants, ensureDependantBunkerEndpoint, clearDependantBunkerEndpoint, saveDependantPairingSecret, bindDependantBunkerClient, setDependantPersonaAvatar, clearDependantPersonaAvatar, setDependantPersonaContactAvatar, clearDependantPersonaContactAvatar, setDependantPersonaPublicProfile, clearDependantPersonaPublicProfile, setDependantSlotNip05Check, setDepExtraPersonaHidden, reload: reloadDependants, loadFreshDependants } = useDependants(
    guardianNpPubkey, identity?.id, encryptionKey,
  );
  const [activeDependantId, setActiveDependantId] = useState<string | null>(null);
  const activeDependant = activeDependantId ? dependants.find(d => d.id === activeDependantId) ?? null : null;

  // Carousel state (identity ring + card column) — lifted to App so we can
  // inline-approve auth requests from whichever row the user has swiped to.
  const [botsVersion, setBotsVersion] = useState(0);
  const [botsChangeVersion, setBotsChangeVersion] = useState(0);
  const [pendingBotContacts, setPendingBotContacts] = useState<string>();
  const botInventory = useBotInventory(preferences.signingMode === 'paired-child' ? null : identity?.naturalPerson.publicKey ?? null, encryptionKey, botsVersion);
  const carousel = useCarousel(identity, dependants, botInventory);
  // Refs so the __TEST__ harness (registered once) always accesses fresh values
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const addCredentialRef = useRef(addCredential);
  addCredentialRef.current = addCredential;

  // PWA update refs (avoid stale closures in effects)
  const encryptionKeyRef = useRef(encryptionKey);
  encryptionKeyRef.current = encryptionKey;
  const needRefreshRef = useRef(needRefresh);
  needRefreshRef.current = needRefresh;

  const [page, setPage] = useState<Page>('home');
  // Refs threaded into useNavigation so hardware/browser back can be PIN-gated
  // while child-mode is active. The targets (carousel.childMode, handleExitChildMode)
  // are defined later in the function body — assignment at render time is enough
  // since the refs are only read inside the popstate handler.
  const childModeActiveRef = useRef(false);
  const attemptExitChildModeRef = useRef<() => void>(() => {});
  // Hardware/browser back while a sign-in approval is in flight is pinned
  // like a bounded session and does nothing — the approval owns the answer.
  const authApprovalInFlightRef = useRef<() => boolean>(() => false);
  const { navigateTo, navigateBack, navigateReplace } = useNavigation(setPage, {
    isBounded: () => childModeActiveRef.current || authApprovalInFlightRef.current(),
    onAttemptBoundaryExit: () => {
      if (authApprovalInFlightRef.current()) return;
      attemptExitChildModeRef.current();
    },
  });
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [selectedKenPubkey, setSelectedKenPubkey] = useState<string | null>(null);
  const [selectedCredential, setSelectedCredential] = useState<StoredCredential | null>(null);
  const [powerMode, setPowerMode] = useState(false);
  // Single-shot deep-link target for GuardianSettings — set when the
  // carousel SettingsCard "Edit name" button on a dep persona row is
  // tapped, consumed by GuardianSettings on mount so it scrolls to +
  // focuses the right name editor.
  const [pendingPersonaFocus, setPendingPersonaFocus] = useState<string | null>(null);
  /**
   * Routing state for the EditPublicProfile page. `target` names the slot
   * ('natural-person' / 'persona' / 'professional-persona' / extra-persona
   * pubkey hex). `viewer` selects the editor's behaviour:
   *   - 'paired-child': kid's read-only view of a profile their guardian set up
   *   - 'race-recover': Load-latest / Keep-mine modal entered from
   *     PersonaAdvanced's PublishBlock when a §5.3 race is detected
   *     (TODO Phase 2F — entry point not wired this chunk).
   *
   * Phase 2 T28 narrowing: the field editor has moved to the persona card
   * (SlotProfileFields, T21) and the Publish flow to PersonaAdvanced
   * (PublishBlock, T23), so 'self' and 'guardian-of-dep' modes no longer
   * route here.
   */
  const [pendingPublicProfileTarget, setPendingPublicProfileTarget] = useState<{
    target: string;
    viewer: 'paired-child' | 'race-recover';
    depPubkey?: string;
  } | null>(null);
  /**
   * One-shot routing-state for the per-slot Persona Advanced page.
   * Set when the carousel `gear-fab` is tapped (`onNavigateDeepPage` below)
   * and consumed by the `persona-advanced` render branch.
   */
  const [pendingPersonaAdvancedTarget, setPendingPersonaAdvancedTarget] = useState<import('./types').PersonaAdvancedRoute | null>(null);
  // Where activation returns to. Set by every gate and by the sign-in
  // np-dormant empty state; null means "return to the new real-identity card".
  const [activationReturnTo, setActivationReturnTo] = useState<Page | null>(null);
  // Which dependant's real-identity activation ceremony is in flight, set by
  // the GuardianSettings "Set up their real identity" action. Consumed by the
  // dependant branch of the `activate-real-identity` route below.
  const [pendingDependantActivation, setPendingDependantActivation] = useState<string | null>(null);
  // Bump counter that forces the kid's bunker-setup effect to rebuild from
  // a freshly-updated PairedChildRecord. Incremented by handleRepairChild
  // See deps on the big signing-backend effect
  // near `identity?.encrypted, encryptionKey, activeDependantId`.
  const [pairedChildBumpCounter, setPairedChildBumpCounter] = useState(0);
  // One-shot anchor for SecuritySettings sub-sections. Set by callers that
  // route INTO Security settings to focus a specific control (currently just
  // the Bunker toggle from dep-pairing "Open Security" CTAs).
  // Consumed by SecuritySettings on mount; null otherwise.
  const [pendingSecurityFocus, setPendingSecurityFocus] = useState<string | null>(null);
  /** Contact policy map for dependants — keyed by dependant pubkey. Loaded on demand. */
  const [childSettingsMap, setChildSettingsMap] = useState<Map<string, ChildSettingsType>>(new Map());
  /**
   * R-34: the dependant ids whose `ChildSettings` read has actually COMPLETED.
   * Distinct from `childSettingsMap`, which holds only those that had a stored
   * row — a dependant with no row is a legitimate `DEFAULT_CHILD_CEILING`, but
   * a dependant whose read has not happened yet (or threw) is not, and must
   * not have a projection published under a stand-in ceiling.
   */
  const [childSettingsResolved, setChildSettingsResolved] = useState<Set<string>>(new Set());
  /** Tier-1 gate result for the cross-family contacts manager — cleared on leaving the page. */
  const [familyContactsUnlocked, setFamilyContactsUnlocked] = useState(false);
  /** Deferred persona switch — applied visually immediately, persisted when encryptionKey becomes available */
  const [pendingKeypairSwitch, setPendingKeypairSwitch] = useState<'natural-person' | 'persona' | null>(null);
  const [pendingVerifyRequest, setPendingVerifyRequest] = useState<VerifyRequest | null>(null);
  /** True when the pending verify request arrived via the ?verify= URL mount handler; triggers redirect-back on approve/deny. */
  const [verifyArrivedViaUrl, setVerifyArrivedViaUrl] = useState(false);
  const [pendingConnectRequest, setPendingConnectRequestState] = useState<NostrConnectRequest | null>(null);
  // Written synchronously (never from render) so an approval that waited for
  // its signer can tell at once whether this request is still the one pending.
  const pendingConnectRequestRef = useRef<NostrConnectRequest | null>(null);
  const setPendingConnectRequest = useCallback((request: NostrConnectRequest | null) => {
    pendingConnectRequestRef.current = request;
    setPendingConnectRequestState(request);
  }, []);
  // One answer per connect request (approve XOR cancel), keyed per request
  // object — the same guard sign-in uses (see connect-delivery.ts).
  const connectSettlementRef = useRef(new AuthRequestSettlement());
  // Route each connect approval installed, so Cancel can take it down at once.
  const connectRouteTrackerRef = useRef(new ConnectRouteTracker());
  /**
   * A parsed companion-rail pairing request (`signet-grant:` scheme), set by
   * the QR-scan / `?pair=1` entry point (companion-data-rail-plan Task 12)
   * and consumed by `ApproveCompanionGrant`. No entry point sets this yet —
   * this task only wires the confirm screen + approve action.
   */
  const [pendingPairingRequest, setPendingPairingRequest] = useState<PairingRequest | null>(null);
  /**
   * A contacts v2 pairing request (`v=2` on the same `signet-grant:` carrier),
   * set only by the SDK parser via `companion-pair-v2.ts` — never hand-built.
   * `ContactsGrantApprove` renders `appName` without re-sanitising it, so the
   * parser's own `sanitizeWireText` has to be the only way a value reaches it.
   */
  const [pendingContactsGrantV2, setPendingContactsGrantV2] = useState<PairingRequestV2 | null>(null);
  /**
   * SDK B1/F1 pairing verification-code check. Set by
   * `handleApproveContactsGrantV2` on EVERY path where the ack landed (the
   * normal finish and the first-projection-failed teardown), holding the
   * four values `pairingCode`/`matchesPairingCode` compare against and,
   * where relevant, the teardown's own error copy — carried as
   * `followUpError` rather than applied immediately, since it is applied
   * only once the check page itself finishes (`handleContactsGrantCodeDone`).
   * In memory only, never persisted; not tied to a lock-clearing effect
   * because `pendingContactsGrantV2` above has none either.
   */
  const [contactsGrantCodeCheck, setContactsGrantCodeCheck] = useState<ContactsGrantCodeCheck | null>(null);
  /**
   * R-33: a v2 pairing request parsed by a MOUNT carrier (the `?pair=1` web
   * URL, or the native launch URL), held until `preferences` and the
   * dependant roster have actually loaded. Both carriers are registered above
   * the `identityLoading || prefsLoading` early return, so on a cold start
   * they see `signingMode` at its bare default and an empty roster — which
   * made the paired-child gate a no-op and pre-selected the owner's own
   * directory for an app that asked for a child's.
   */
  const [heldContactsGrantV2, setHeldContactsGrantV2] = useState<PairingRequestV2 | null>(null);
  /**
   * R-35: TWO grant counters, not one.
   *
   * `contactsGrantsSetVersion` moves only when the SET of grants changes — one
   * approved, revoked, forgotten, or adopted off the rail. It drives the
   * proposal inbox's subscriptions and the grants rail's fetch, both of which
   * are per-grant and so genuinely have to be rebuilt when the set moves.
   *
   * `contactsGrantRowsVersion` moves for ANY row write, the set changes
   * included — an app label the inbox wrote, a `seenOperationIds` update, a
   * publish-state stamp. It drives only the projections' `changeToken` and the
   * connected-apps list's re-read, neither of which tears anything down.
   *
   * B/I4 is why they are separate: the inbox's own success path wrote a label
   * and bumped the single counter, which was in its OWN effect's dependency
   * list — so applying a `rename-app-label` scheduled the teardown of the run
   * still processing the batch. Both of that run's cancellation guards then
   * bailed, and a batch with two or more outcomes could drop its
   * `appLabels`/`seenOperationIds` write entirely; the next run re-fetched the
   * same replaceable event with a fresh `seenEvents`, re-accepted the rename
   * against a map that was never written, and bumped again. Even the
   * single-outcome case tore down and rebuilt every grant's subscription and
   * re-fetched every grant's backlog for a label change.
   */
  const [contactsGrantsSetVersion, setContactsGrantsSetVersion] = useState(0);
  const [contactsGrantRowsVersion, setContactsGrantRowsVersion] = useState(0);
  /** The grant set changed — implies a row change too. */
  const bumpContactsGrantSet = useCallback(() => {
    setContactsGrantsSetVersion((v) => v + 1);
    setContactsGrantRowsVersion((v) => v + 1);
  }, []);
  /** A row changed but the set did not. Never rebuilds a subscription. */
  const bumpContactsGrantRows = useCallback(() => setContactsGrantRowsVersion((v) => v + 1), []);
  /**
   * Bumped ONLY by block / unblock / revoke. `useContactProjections` publishes
   * a safety change at once — no jitter, and no hash-dedupe — so this must
   * never move for an ordinary edit.
   */
  const [contactsSafetyToken, setContactsSafetyToken] = useState('0');
  const bumpContactsSafety = useCallback(
    (reason: string) => setContactsSafetyToken(`${reason}:${Date.now()}`), [],
  );
  /** The grants rail's own byte-fitting state, fed by `onBackupStateChange`. */
  const [contactsGrantsBackupState, setContactsGrantsBackupState] = useState<ContactGrantsRailBackupState>('ok');
  /**
   * Optional `callback=` URL from the outer `?nostrconnect=` redirect
   * If present and valid, the user is
   * redirected to `callback + '?status=approved'` after successful
   * pairing, or `?status=denied` on deny — solving the "stranded on
   * mysignet.app after approving" desktop UX gap that matchpass-app's
   * `target=_blank` workaround alone couldn't fix.
   */
  const [pendingConnectCallback, setPendingConnectCallback] = useState<string | null>(null);
  /** Shown from the guardian banner when the guardian wants to hand the phone
   *  to a different dependant without exiting child-mode (spec §2). */
  const [showHandoffPicker, setShowHandoffPicker] = useState(false);
  const [bunkerPanelOpen, setBunkerPanelOpen] = useState(false);
  /**
   * Carousel-row selection captured when a nostrconnect:// QR is scanned.
   * Threads the row-at-scan-time through to ApproveConnect so NIP-46 pairings
   * sign with the persona (or other keypair) the user had active, not the
   * persisted primaryKeypair. Mirrors the kind-21236 auth flow's behaviour.
   */
  const [pendingConnectSelection, setPendingConnectSelection] = useState<AuthSelection | null>(null);
  const [nostrConnectServeRelayUrl, setNostrConnectServeRelayUrl] = useState<string | null>(null);
  const [nostrConnectTransientRoute, setNostrConnectTransientRoute] = useState<BunkerRoute | null>(null);
  const nostrConnectTransientRouteDestroyRef = useRef<(() => void) | null>(null);
  const nostrConnectTransientRoutePubkeyRef = useRef<string | null>(null);
  const nostrConnectServeRelayClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingAuthRequest, setPendingAuthRequestState] = useState<AuthRequest | LoginRequest | null>(null);
  /**
   * Selection captured at the moment a Sign-in QR was scanned from the carousel.
   * Mirrors `pendingConnectSelection` for the nostr-connect path. The carousel's
   * `row` integer can drift between scan and approve when an unrelated state
   * update (e.g. `useDependantsSync`'s post-merge reload) rebuilds `carousel.rows`,
   * which used to silently land the user back on the guardian's NP default.
   * Capturing here pins the persona the user actually scanned from.
   */
  const [pendingAuthSelection, setPendingAuthSelection] = useState<AuthSelection | null>(null);

  // Identifies one installed transient route, so a rollback can remove the
  // route IT installed and never a newer one for the same persona.
  const nostrConnectTransientRouteTokenRef = useRef(0);
  const installNostrConnectTransientRoute = useCallback((
    backend: DecryptingSigningBackend,
    destroyOnClear: boolean,
  ): number => {
    nostrConnectTransientRouteDestroyRef.current?.();
    nostrConnectTransientRouteDestroyRef.current = destroyOnClear ? () => backend.destroy() : null;
    nostrConnectTransientRoutePubkeyRef.current = backend.activePublicKeyHex;
    const token = ++nostrConnectTransientRouteTokenRef.current;
    setNostrConnectTransientRoute({
      pubkey: backend.activePublicKeyHex,
      backend,
    });
    return token;
  }, []);

  const clearNostrConnectTransientRoute = useCallback((pubkey?: string) => {
    const activePubkey = nostrConnectTransientRoutePubkeyRef.current;
    if (pubkey && activePubkey && activePubkey.toLowerCase() !== pubkey.toLowerCase()) return;
    const destroy = nostrConnectTransientRouteDestroyRef.current;
    nostrConnectTransientRouteDestroyRef.current = null;
    nostrConnectTransientRoutePubkeyRef.current = null;
    setNostrConnectTransientRoute(null);
    destroy?.();
  }, []);

  /** Clear the transient route only if it is still the one `token` installed. */
  const clearNostrConnectTransientRouteByToken = useCallback((token: number) => {
    if (nostrConnectTransientRouteTokenRef.current !== token) return;
    if (!nostrConnectTransientRoutePubkeyRef.current) return;
    const destroy = nostrConnectTransientRouteDestroyRef.current;
    nostrConnectTransientRouteDestroyRef.current = null;
    nostrConnectTransientRoutePubkeyRef.current = null;
    setNostrConnectTransientRoute(null);
    destroy?.();
  }, []);

  useEffect(() => () => {
    nostrConnectTransientRouteDestroyRef.current?.();
    nostrConnectTransientRouteDestroyRef.current = null;
    nostrConnectTransientRoutePubkeyRef.current = null;
  }, []);
  /**
   * Captures the error message when the carousel-overlay quick-approve path
   * (`handleApproveFromCarousel`) catches a throw from `handleApproveAuth`
   * and bounces the user to the full picker. Without this the cause was
   * silently swallowed and the user just saw "picker appeared, no idea why."
   * Surfaced via the `initialError` prop on ApproveAuth; cleared when the
   * auth request is otherwise resolved.
   */
  const [pickerInitialError, setPickerInitialError] = useState<string | null>(null);
  // Reset the picker error whenever the auth request itself goes away — covers
  // every deny / approve / cancel path without needing to thread a clear into
  // each cleanup block individually.
  useEffect(() => {
    if (!pendingAuthRequest) setPickerInitialError(null);
  }, [pendingAuthRequest]);
  // Live view of the request an in-flight approval belongs to. An approval
  // that awaited an unlock or a signer reconnect re-checks this before it
  // delivers anything, so a request denied, replaced or finished meanwhile
  // can never receive a second callback.
  //
  // Written SYNCHRONOUSLY by the setter below (never from render), so a
  // handler that checks it sees a clear or a replacement at once, not after
  // the next commit. Every write of pendingAuthRequest goes through it.
  const pendingAuthRequestRef = useRef(pendingAuthRequest);
  const setPendingAuthRequest = useCallback((request: AuthRequest | LoginRequest | null) => {
    pendingAuthRequestRef.current = request;
    setPendingAuthRequestState(request);
  }, []);
  // One answer per request (approve XOR deny), keyed by requestId+challenge.
  const authSettlementRef = useRef(new AuthRequestSettlement());
  // Render-visible mirror of the in-flight approval, so an approval that
  // outlived its page (a lock unmounted it mid-wait) still shows "Signing…"
  // on the remounted page instead of a fresh Approve.
  const [authApprovalInFlightKey, setAuthApprovalInFlightKey] = useState<string | null>(null);
  // The user's explicit picker choice, per request. Lives here, not in
  // ApproveAuth, because a lock unmounts the page (identity state clears) and
  // the remount must come back on the identity the user chose.
  const [authPickerChoice, setAuthPickerChoice] = useState<{ key: string; selection: AuthSelection | null } | null>(null);
  // A chosen device-held slot shows "waiting" while its route comes back;
  // once this bounded wait lapses Approve is re-enabled so the approval's own
  // bounded wait can end in the honest unavailable copy instead of a
  // permanently disabled button.
  const [routeWaitLapsed, setRouteWaitLapsed] = useState(false);
  // Same per-request choice for the NIP-46 connect picker.
  const [connectPickerChoice, setConnectPickerChoice] = useState<{ key: string; selection: AuthSelection | null } | null>(null);
  // Requests that arrived as a Sign in with Signet URL (web ?auth=1 or the
  // native App Link). Their denial goes back to the consumer's callback even
  // when the consumer sent no name= (an empty urlAuthSiteName).
  const urlAuthRequestsRef = useRef(new WeakSet<object>());
  authApprovalInFlightRef.current = () => {
    const current = pendingAuthRequestRef.current;
    if (current && authSettlementRef.current.isInFlight(authRequestKey(current))) return true;
    const connect = pendingConnectRequestRef.current;
    return !!connect && connectSettlementRef.current.isInFlight(requestObjectKey(connect));
  };
  const [urlAuthSiteName, setUrlAuthSiteName] = useState<string>('');
  /**
   * Snapshot of the Sign-in-with-Signet URL the user arrived at, captured
   * before history.replaceState clears the query string. The
   * value currently has no in-app reader after the desktop phone-pairing
   * surface was removed, but the capture/clear lifecycle is kept so the
   * snapshot stays available for future cross-device pairing surfaces.
   */
  const [, setOriginalAuthUrl] = useState<string | null>(null);
  /** Consumer hint (accept/prefer/accept_reason) from the incoming URL, if any. */
  const [consumerHint, setConsumerHint] = useState<ConsumerHint | null>(null);
  /** Parser warnings to surface back to the consumer via the redirect-back URL. */
  const [consumerWarnings, setConsumerWarnings] = useState<string[]>([]);
  /** Display name volunteered by the consumer in the sign-in request, if any. */
  const [consumerDisplayName, setConsumerDisplayName] = useState<string | null>(null);
  /**
   * Optional post-approval redirect URL from the sign-in request (`?post=<url>`).
   * Validated same-origin by `parseSignInRequest`. Surfaced on the relay-ack
   * screen as an "Open <hostname>" CTA.
   */
  const [pendingPostUrl, setPendingPostUrl] = useState<string | null>(null);
  /** Pending third-party-initiated add-dependant request. */
  const [pendingAddDependantRequest, setPendingAddDependantRequest] = useState<AddDependantRequest | null>(null);
  /** Current request's entry in the developer auth-request log. */
  const currentLogEntryRef = useRef<AuthRequestLogEntry | null>(null);

  /**
   * Short-lived auth-flow pairing register (redirect-bunker handoff).
   *
   * After "Sign in with Signet" approval, App.tsx generates a fresh
   * pairing secret, builds a `bunker://` URI, and appends it to the
   * consumer's redirect callback. The consumer's NIP-46 client will
   * later issue a `connect` carrying this secret. The guardian-route
   * connect handler in `useBunkerServer` consults this map: a hit
   * means "the user just authorised this app via redirect — auto-set
   * allowAlways on the connecting client_pubkey, no prompt".
   *
   * Held in a ref (not state) because it's mutated from the connect
   * handler without needing to re-render the tree, and TTL'd in-memory
   * so a stale entry from a never-completed pairing can't poison a
   * later sign-in.
   */
  const pendingAuthPairingsRef = useRef<Map<string, {
    origin: string;
    appName: string;
    signingPubkey: string;
    expiresAt: number;
  }>>(new Map());

  /** State for the relay-mode in-app acknowledgement screen. */
  type RelayAuthAckState =
    | { status: 'approved'; siteName: string; postUrl?: string }
    | { status: 'denied'; siteName: string }
    | { status: 'failed'; relayHost: string; retry: () => Promise<void> };
  const [relayAuthAckState, setRelayAuthAckState] = useState<RelayAuthAckState | null>(null);

  // Transient confirmation chip rendered on a dependant's card after the user
  // signs in as one of that dep's personas/extras. The parent ring shows one
  // row per dep (the NP card), so persona-level disambiguation isn't visible
  // there — the chip closes the gap by saying "Signed in as <persona name>".
  // Cleared automatically after RECENT_SIGN_IN_ACK_TTL_MS or when the user
  // navigates away from the matching dep row. Dep-NP and guardian sign-ins
  // don't set this — for those, the carousel landing card already conveys
  // the keypair.
  const [recentSignInAck, setRecentSignInAck] = useState<{ dependantId: string; label: string } | null>(null);

  // Signing backend state — created at unlock, destroyed at lock. Widened
  // from LocalSigningBackend to DecryptingSigningBackend (family-bunker
  // §11.1.3): in dependant mode a slot with no local private key (future
  // §11.1.2 key-stripping) can be routed to the device via bunkerRouter
  // instead, which hands back a RoutedBunkerSigningBackend — both satisfy
  // the interface, no runtime behaviour change for the local-key path.
  const [backends, setBackends] = useState<{
    naturalPerson: DecryptingSigningBackend;
    persona: DecryptingSigningBackend;
  } | null>(null);

  // Bunker backend state (Heartwood NIP-46 remote signer)
  const [bunkerBackend, setBunkerBackend] = useState<BunkerSigningBackend | null>(null);
  const [signerStatus, setSignerStatus] = useState<'connected' | 'connecting' | 'unavailable' | null>(null);
  // Per-slot routing over the Heartwood pairing (family-bunker §11.1.3).
  // Null when no bunker is connected OR the signer is not Heartwood-capable.
  const [bunkerRouter, setBunkerRouter] = useState<BunkerBackendRouter | null>(null);
  // Generation guard for the async BunkerBackendRouter.create() probe.
  // Incremented at every site that destroys/nulls bunkerRouter (including
  // lock). A create() site captures the generation before the async call and
  // discards its result if the generation moved on by the time it resolves —
  // guards against an out-of-order/stale probe reviving a router after a
  // newer create (or a lock) has already superseded it.
  const bunkerRouterGenRef = useRef(0);
  // Where per-persona routing stands on the current pairing, so a slot with
  // no local key can say "signer not answering yet — retrying" instead of
  // "no local signing key". Null when no probe applies (locked, no bunker).
  const [routerProbeState, setRouterProbeState] = useState<RouterProbeState | null>(null);
  // Live views of the signer state for an approval that has to WAIT for its
  // route (awaitRoutedBackend): the handler's closure is frozen at tap time,
  // but the unlock/reconnect/probe it is waiting for lands in later renders.
  const bunkerRouterRef = useRef(bunkerRouter);
  bunkerRouterRef.current = bunkerRouter;
  const signerStatusRef = useRef(signerStatus);
  signerStatusRef.current = signerStatus;
  const routerProbeStateRef = useRef(routerProbeState);
  routerProbeStateRef.current = routerProbeState;
  // Every router-install site goes through here: bumps the generation, probes
  // with retry/backoff for as long as this generation is current and the
  // primary stays connected, and installs the router only if still current.
  const startRouterProbe = useCallback((primary: BunkerSigningBackend, clientSecretHex: string) => {
    const gen = ++bunkerRouterGenRef.current;
    const isCurrent = () => bunkerRouterGenRef.current === gen;
    void createRouterWithRetry({
      primary, clientSecretHex, isCurrent,
      onState: (state) => { if (isCurrent()) setRouterProbeState(state); },
    }).then((router) => {
      if (!isCurrent()) {
        router?.destroy();
        return;
      }
      setBunkerRouter((prev) => {
        prev?.destroy();
        return router;
      });
    });
  }, []);

  // The backend that signs as the guardian's NATURAL PERSON in bunker mode.
  // On the family bunker the primary pairing is bound to the master/tree-root
  // and the NP is a derived persona with a DIFFERENT pubkey (an earlier
  // hardware finding) — so no NP-signing seam may use `bunkerBackend`
  // directly. Null until the primary has connected (nothing may queue
  // requests at a not-yet-known identity); collapses to the primary for
  // legacy NP-only bunkers and the paired-child install (identity == the
  // served dependant); on a family bunker it is the router's NP route, or
  // null while the capabilities probe is still pending / has failed (never
  // the master). `signerStatus` is a dependency because the primary's pubkey
  // only becomes known on connect.
  const npBunkerBackend = useMemo<DecryptingSigningBackend | null>(
    () => resolveNpBunkerBackend(bunkerBackend, bunkerRouter, identity?.naturalPerson.publicKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signerStatus: primary pubkey lands on connect
    [bunkerBackend, bunkerRouter, signerStatus, identity?.naturalPerson.publicKey],
  );

  /**
   * The persona slot's device-signing route. Mirrors `npBunkerBackend` — needed
   * because the NIP-46 server transport now follows `primaryKeypair` (§8), and
   * a persona-primary identity on a family bunker must serve from the persona
   * route rather than the master pairing.
   */
  const personaBunkerBackend = useMemo<DecryptingSigningBackend | null>(
    () => resolveSlotBunkerBackend(bunkerBackend, bunkerRouter, identity?.persona.publicKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signerStatus: primary pubkey lands on connect
    [bunkerBackend, bunkerRouter, signerStatus, identity?.persona.publicKey],
  );

  // Migration-wizard pending connection (family-bunker §11.1.2). Holds a
  // freshly-paired bunker backend that has NOT yet been committed — the
  // wizard drives enrolment/verification against it via its own request fn
  // before `handleMigrationFinalize` strips local keys and swaps it into
  // `bunkerBackend`. Deliberately a ref, not React state: nothing in this
  // pending window should trigger a re-render of backend-consuming effects,
  // and it must never be read by anything outside the migration handlers.
  const migrationRef = useRef<{ backend: BunkerSigningBackend; clientSecret: string; bunkerUri: string } | null>(null);
  // Set for the duration of handleMigrationFinalize's body. Lets
  // handleMigrationAbort detect "finalize is currently mid-flight" and
  // no-op instead of racing it (see handleMigrationAbort below).
  const migrationFinalizeInFlightRef = useRef(false);

  // Heartwood guard: Pro mode is blocked when the mnemonic has been deleted
  // (Heartwood-connect path). Pro persona requires the mnemonic locally. (§4.5.10)
  // Heartwood-capable routers (bunkerRouter non-null) can serve the Professional
  // key directly per persona — lifts the block once the pro pubkey is known.
  const isProModeBlocked = proModeBlockedReason({
    hasMnemonic: !!(identity?.mnemonic),
    bunkerActive: !!bunkerBackend,
    bunkerServesPersonas: !!bunkerRouter,
    proPubkeyKnown: !!identity?.professionalPersona?.publicKey,
  });

  // Effective Pro signing backend: prefer the local-mode proBackend (set by
  // applyProPersonaState when the mnemonic is present); fall back to the
  // Heartwood router resolving the Professional persona's own key when in
  // bunker mode. Single source used at every Pro-signing consumption site.
  const effectiveProBackend = useMemo(
    () => proBackend ?? bunkerRouter?.backendFor(identity?.professionalPersona?.publicKey) ?? null,
    [proBackend, bunkerRouter, identity?.professionalPersona?.publicKey]
  );

  // NIP-07 browser extension backend
  const [nip07Backend, setNip07Backend] = useState<Nip07SigningBackend | null>(null);

  // Extra persona backend — used when a dependant's active keypair is an extra persona pubkey.
  // Widened to DecryptingSigningBackend alongside `backends` (see above).
  const [extraBackend, setExtraBackend] = useState<DecryptingSigningBackend | null>(null);

  // Companion rail backends — one LocalSigningBackend per active grant, derived
  // from the mnemonic. Requires the local mnemonic (disabled in bunker mode).
  const [railBackends, setRailBackends] = useState<Map<string, DecryptingSigningBackend>>(new Map());

  useEffect(() => {
    const mnemonic = identity?.mnemonic;
    if (!mnemonic || !encryptionKey) {
      // Lock (or bunker mode with no mnemonic) — destroy outgoing backends
      // to scrub the derived rail privkeys, same hygiene as the NP/persona/
      // extra backends above.
      setRailBackends(prev => {
        for (const b of prev.values()) b.destroy();
        return new Map();
      });
      return;
    }
    let cancelled = false;
    (async () => {
      const grants = await listCompanionGrants();
      if (cancelled || !identity?.mnemonic) return;
      const map = new Map<string, DecryptingSigningBackend>();
      for (const g of grants) {
        if (g.revokedAt) continue;
        const kp = deriveRailKeypair(mnemonic, g.appPubkey);
        map.set(g.appPubkey, new LocalSigningBackend(kp.privateKey));
      }
      if (!cancelled && identity?.mnemonic) {
        // Full rebuild — every entry in `map` is a fresh instance, so the
        // outgoing map's backends are wholly superseded and safe to destroy.
        setRailBackends(prev => {
          for (const b of prev.values()) b.destroy();
          return map;
        });
      } else {
        for (const backend of map.values()) backend.destroy();
      }
    })().catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, [identity?.mnemonic, encryptionKey]);

  // Live count of companion-app grants — feeds the "Companion apps" Settings
  // row and the CompanionApps page's at-cap banner. Unlike `railBackends`,
  // this doesn't require the mnemonic/unlock (the store holds no secrets),
  // so it stays accurate in bunker mode too. Refreshed on identity change
  // and after the two mutators (approve, revoke).
  const [companionGrantCount, setCompanionGrantCount] = useState(0);
  const reloadCompanionGrantCount = useCallback(async () => {
    const grants = await listCompanionGrants();
    setCompanionGrantCount(grants.length);
  }, []);
  useEffect(() => {
    if (!identity) { setCompanionGrantCount(0); return; }
    void reloadCompanionGrantCount();
  }, [identity, reloadCompanionGrantCount]);

  // I1 retry — grants that got soft-tombstoned locally (revokedAt set, row
  // NOT deleted) because their tombstone publish failed at revoke time
  // (`revokeCompanionGrant`, companion-rail.ts). Re-attempt on every unlock
  // with a freshly-derived rail backend: `revokeCompanionGrant` itself makes
  // the same publish-succeeded -> kind-5 + delete vs. still-failing ->
  // re-save-the-soft-tombstone decision, so calling it again here is the
  // whole retry — no separate logic needed. Best-effort; a still-failing
  // relay just leaves the row soft-tombstoned for the next unlock to retry.
  useEffect(() => {
    const mnemonic = identity?.mnemonic;
    if (!mnemonic) return;
    let cancelled = false;
    (async () => {
      const grants = await listCompanionGrants();
      const pending = grants.filter(g => g.revokedAt);
      if (!pending.length) return;
      for (const g of pending) {
        if (cancelled) return;
        const backend = new LocalSigningBackend(deriveRailKeypair(mnemonic, g.appPubkey).privateKey);
        try {
          await revokeCompanionGrant(g, backend, preferences.relayUrl ?? DEFAULT_RELAY_URL);
        } catch {
          /* best-effort — retried again next unlock */
        } finally {
          backend.destroy();
        }
      }
      if (!cancelled) await reloadCompanionGrantCount();
    })().catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, [identity?.mnemonic, preferences.relayUrl, reloadCompanionGrantCount]);

  // Whole configured relay pool (sync-relays.ts) shared by every sync rail
  // below (personas, dependants, contacts, credentials, grants) — not just
  // the single legacy `relayUrl` some of these still fall back to. Declared
  // here, above the rail cluster, so every rail can consume it; it has no
  // TDZ dependencies other than `preferences`, which is declared earlier.
  const syncRelays = useMemo(() => resolveSyncRelays(preferences, DEFAULT_RELAY_URL), [preferences.relays, preferences.relayUrl]);

  // Contacts v2 (Phase B): mint this device's operation-authorship id once,
  // then lift the legacy `contacts` / `ken` rows into the v2 operation log.
  // Local only — no relay traffic, and the legacy stores keep working.
  //
  // Gated on `shouldMintContactsDeviceId` (never while `prefsLoading`):
  // Wait for initial preferences to load. The allocator patches only the ID
  // inside one transaction, preserving concurrent relay/settings changes.
  useEffect(() => {
    if (!shouldMintContactsDeviceId({ prefsLoading, encryptionKey, contactsDeviceId: preferences.contactsDeviceId })) return;
    void getOrCreateContactsDeviceId().then(() => reloadPreferences());
  }, [prefsLoading, encryptionKey, preferences.contactsDeviceId]);

  // Controller ruling: a paired-child install has no guardian roster to read —
  // its own identity IS the dependant, so it imports into its OWN
  // `dependant:${identity.id}` directory (never `owner`) with `actorRole:
  // 'dependant'`, and never touches a guardian slot. Everywhere else
  // (`signingMode !== 'paired-child'`) keeps the existing owner + dependants
  // scope. This mirrors the existing `bunkerRouter`/`heartwoodRequestFn`
  // paired-child gating pattern already used elsewhere in this file.
  //
  // ownerPubkeys/dependants are memoised (not recomputed array literals) so
  // useContactsV2Import's once-per-unlock latch isn't defeated by a fresh
  // array identity on every App.tsx render — see the hook's own comment on
  // why a failing import must not retry until the next unlock.
  //
  // C1: the import must NOT run before the dependant roster has loaded. The
  // once-per-unlock latch means the first run is the only run of this unlock,
  // and a run against an empty roster routes every dependant-owned legacy row
  // to quarantine. `dependantsLoading` gates `enabled` AND feeds the memo, so
  // the refs array is rebuilt (new identity ⇒ effect re-runs) at the moment
  // the roster lands.
  const contactsV2OwnerPubkeys = useMemo(
    () => (isPairedChild ? [] : ownerSlotPubkeys(identity)),
    [isPairedChild, identity],
  );
  const contactsV2DependantRefs = useMemo(
    () => (isPairedChild
      ? pairedChildImportRefs(identity)
      : (dependantsLoading ? [] : dependantImportRefs(dependants))),
    [isPairedChild, identity, dependants, dependantsLoading],
  );

  // Change signal for the contacts v2 rail. The rail re-reads the
  // authoritative operation log from IDB when it publishes; this counter only
  // tells it that something changed. Bumped from four places (ruling R3): both
  // Phase C hooks' `onMutated`, the hot re-import's `onImported`, and the cold
  // import finishing having written something.
  const privateVaultSupported = useMemo(() => !isPairedChild &&
    (preferences.signingMode === 'bunker' || hasLocalVaultTree(identity)),
  [isPairedChild, preferences.signingMode, identity?.id, identity?.mnemonic]);
  const privateVaultSession = `${identity?.id ?? ''}:${preferences.signingMode ?? 'local'}`;
  const [privateVaultStatus, setPrivateVaultStatus] = useState<{
    session: string; health: PrivateVaultHealth;
  } | null>(null);
  const privateVaultHealth: PrivateVaultHealth = privateVaultStatus?.session === privateVaultSession
    ? privateVaultStatus.health : { phase: 'checking', datasets: {} };
  const legacyPrivateWrite = (dataset: Parameters<typeof legacyVaultWriteAllowed>[1]) =>
    !privateVaultSupported || legacyVaultWriteAllowed(privateVaultHealth, dataset);
  const legacyExcludedDirectories = [
    ...(!legacyPrivateWrite('contacts:owner') ? ['owner'] : []),
    ...dependants.filter(d => /^dependant-(0|[1-9][0-9]*)$/.test(d.derivationPath)
      && !legacyPrivateWrite({ dependant: Number(d.derivationPath.slice(10)) }))
      .map(d => `dependant:${d.id}`),
  ];

  const [contactsV2Version, setContactsV2Version] = useState(0);
  const bumpContactsV2 = useCallback(() => setContactsV2Version((v) => v + 1), []);

  // R10: the cheap stand-in for the spec's `v2-canonical` ceremony. False until
  // `useContactsV2Sync` has READ BACK a checkpoint naming this device; until
  // then the legacy contacts and kens rails keep publishing, so there is never
  // a window in which v2 is the only writer and nothing has confirmed it
  // landed. Declared here, above the two legacy rails that consume it, rather
  // than at the rail mount further down.
  const [contactsV2Verified, setContactsV2Verified] = useState(false);

  // The hook only ever emits `true` (R10) — reset back to `false` here on
  // lock and on an identity change, so a stale "verified" from a PREVIOUS
  // identity/unlock can never wrongly gate the legacy publishers off before
  // this rail has proven itself against the current one. Mirrors the rail
  // hook's own `identityGenerationRef` reset condition.
  useEffect(() => {
    setContactsV2Verified(false);
  }, [encryptionKey, identity?.naturalPerson.publicKey]);

  // R-VERIFIED-TWO-WAY (controller ruling, whole-branch review): fed by the
  // rail hook's `onBackupStateChange` — declared here, ABOVE the legacy
  // rails' `publishEnabled` below, because `useContactsV2Sync` itself isn't
  // mounted until much further down the component. One render behind the
  // hook's own return value at worst (the callback fires synchronously
  // inside the same effect that would otherwise update the hook's state),
  // which is immaterial for a gate this coarse. Reset alongside
  // `contactsV2Verified` for the same reason: a stale 'too-large'/'stalled'
  // from a PREVIOUS identity/unlock must not linger and wrongly hold the
  // legacy publishers off (or on) for the current one before this rail has
  // evaluated it.
  const [contactsV2BackupState, setContactsV2BackupState] = useState<ContactsV2BackupState>('ok');
  useEffect(() => {
    setContactsV2BackupState('ok');
    // Same reason for the grants rail: a 'too-large' report belongs to the
    // identity/unlock that produced it, and must not be shown against the next.
    setContactsGrantsBackupState('ok');
  }, [encryptionKey, identity?.naturalPerson.publicKey]);

  // Captured (not discarded) so a reload effect further down can tell when
  // the cold import has actually written something — see the C1 note by the
  // `useContactsV2` mount below.
  const contactsImport = useContactsV2Import({
    enabled: !!encryptionKey && !!identity && !dependantsLoading,
    encryptionKey,
    deviceId: preferences.contactsDeviceId ?? null,
    // R-ACTOR: ONE stable actor pubkey per install, never the primary keypair
    // (`identity.id` moves on a switchPrimary). The guardian authors as their
    // NP pubkey — the same value `dep.guardianPubkey` holds, so the directory
    // counts their vouches and ceilings; a paired child authors as its own
    // dependant record id, which is stable there by construction.
    // I3: lowercased — `validateOperation` requires strict lowercase 64-hex,
    // and `identity.id` is user/device-sourced, not guaranteed already
    // lowercase. Must stay value-identical to `contactsActorPubkey` below.
    actorPubkey: isPairedChild ? (identity?.id?.toLowerCase() ?? null) : stableActorPubkey(identity),
    ownerPubkeys: contactsV2OwnerPubkeys,
    dependants: contactsV2DependantRefs,
  });
  // R-VERIFIED-TWO-WAY: the v2 rail is the single writer only once it has
  // BOTH proven a round trip against this device (`contactsV2Verified`, R10)
  // AND is currently able to carry the log at all (`contactsV2BackupState
  // === 'ok'`) — a later 'too-large' or 'stalled' report un-flips this even
  // after verification, so contacts always has a writer.
  const contactsV2SingleWriter = contactsV2Verified && contactsV2BackupState === 'ok';

  // Cross-device contacts sync, Phase 1.
  // Publishes on mutation (debounced), fetches + merges on unlock.
  // Bunker > NIP-07 > local NP backend, in priority order.
  const { remoteState: contactsRemoteState } = useContactsSync({
    identity,
    npBackend: npBunkerBackend ?? nip07Backend ?? backends?.naturalPerson ?? null,
    relays: syncRelays,
    encryptionKey,
    contacts: members,
    onRemoteMerged: reloadContacts,
    // R10/R-VERIFIED-TWO-WAY: single writer only while the v2 rail is BOTH
    // verified and reads 'ok'; until then (or again, if it later regresses)
    // both rails keep publishing so there is never a gap.
    publishEnabled: !contactsV2SingleWriter && legacyPrivateWrite('contacts:owner'),
  });

  // Ken cross-device sync (kindred integration).
  // Mirrors useContactsSync — fetch+merge on unlock, debounced publish on mutation.
  useKensSync({
    identity,
    npBackend: npBunkerBackend ?? nip07Backend ?? backends?.naturalPerson ?? null,
    relayUrl: preferences.relayUrl ?? DEFAULT_RELAY_URL,
    encryptionKey,
    kens,
    onRemoteMerged: reloadKens,
    publishEnabled: !contactsV2SingleWriter && legacyPrivateWrite('contacts:owner'),
  });

  // Companion data rail — publish-on-change of scoped, secret-stripped
  // snapshots to each paired companion app's grant. Mirrors useKensSync.
  useCompanionRail({
    identity,
    railBackends,
    relayUrl: preferences.relayUrl ?? DEFAULT_RELAY_URL,
    encryptionKey,
    contacts: members,
    kens,
    enabled: !!identity?.mnemonic && !!encryptionKey,
  });

  // Dependant metadata sync, Phase 2.
  // Only metadata + derivation paths cross the wire; private keys
  // re-derived on the receiver from the guardian's mnemonic. View-only
  // imports also sync. Imported-with-mnemonic dependants stay local.
  // deviceHeldKeys (family-bunker §11.1.8): this device has no mnemonic
  // of its own because its family keys live on Heartwood — a derived
  // dependant should still sync in keyless rather than being skipped.
  const { remoteState: dependantsRemoteState } = useDependantsSync({
    publishEnabled: legacyPrivateWrite('profiles'),
    identity,
    npBackend: npBunkerBackend ?? nip07Backend ?? backends?.naturalPerson ?? null,
    relays: syncRelays,
    encryptionKey,
    // Both options key off signingMode, NOT identity.mnemonic: after the
    // handover, generic signer connections may still have stale identity
    // state. signingMode is the persistent fact and prevents sync from
    // re-deriving and saving private keys after deletion.
    guardianMnemonic: preferences.signingMode === 'bunker' ? null : (identity?.mnemonic ?? null),
    deviceHeldKeys: preferences.signingMode === 'bunker',
    dependants,
    onRemoteMerged: reloadDependants,
  });

  // Credentials sync, Phase 3. Publishes full
  // StoredCredential records including merkleLeaves (encrypted in
  // transit via NIP-44). Receiver can do selective disclosure as if
  // the credential had been earned locally.
  const { remoteState: credentialsRemoteState } = useCredentialsSync({
    publishEnabled: legacyPrivateWrite('credentials'),
    identity,
    npBackend: npBunkerBackend ?? nip07Backend ?? backends?.naturalPerson ?? null,
    relays: syncRelays,
    encryptionKey,
    credentials,
    onRemoteMerged: reloadCredentials,
  });

  // Grants sync. Guardian with 2+ devices no
  // longer re-prompts on iPad after approving on phone. Publishes the
  // FULL grants set including tombstones so revocations propagate under
  // LWW. Reload is driven by onGrantMutated from useBunkerServer (local
  // writes) and by onRemoteMerged (inbound fetch).
  const [grantsForSync, setGrantsForSync] = useState<RememberedGrant[] | null>(null);
  const reloadGrants = useCallback(async () => {
    if (!encryptionKey) {
      setGrantsForSync(null);
      return;
    }
    try {
      const all = await listAllGrantsIncludingTombstones();
      setGrantsForSync(all);
    } catch { /* non-fatal — next mutation retries */ }
  }, [encryptionKey]);
  useEffect(() => {
    if (!encryptionKey) { setGrantsForSync(null); return; }
    reloadGrants();
  }, [encryptionKey, reloadGrants]);
  const { remoteState: grantsRemoteState } = useGrantsSync({
    publishEnabled: legacyPrivateWrite('settings'),
    identity,
    npBackend: npBunkerBackend ?? nip07Backend ?? backends?.naturalPerson ?? null,
    relays: syncRelays,
    encryptionKey,
    grants: grantsForSync,
    onRemoteMerged: reloadGrants,
  });

  // Guardian-side per-dependant status publisher. Signals each
  // paired child device when the dependant's autonomyStage changes, so
  // child devices can render a pre-emptive dormant surface at
  // `full-control` without round-tripping through the bunker. Safe to
  // run on the paired-child install too — it's a no-op there because
  // the dependants list is empty.
  useDependantStatusPublisher({
    dependants,
    relayUrl: preferences.relayUrl ?? DEFAULT_RELAY_URL,
    encryptionKey,
    guardianName: identity?.naturalPerson.displayName || identity?.persona.displayName,
  });

  // Guardian-side persona-inventory publisher — pushes the full persona
  // roster (built-in persona + extras, minus any in `hiddenOnPairedDeviceKeys`)
  // to each paired child device so the child carousel can render the same
  // shape the guardian sees, not just an NP stub. See
  // 2026-05-15-persona-inventory-sync-to-paired-child-design.md.
  usePersonaInventoryPublisher({
    dependants,
    relayUrl: preferences.relayUrl ?? DEFAULT_RELAY_URL,
    encryptionKey,
  });

  // Child-side subscriber — reads the guardian's latest stage from the
  // relay, caches in IDB, exposes `isDormant` for UI gating. Scoped
  // to whichever paired dependant is currently active (multi-pair).
  const { isDormant: childIsDormant, guardianName: cachedGuardianName } = useDependantStatus({
    relayUrl: preferences.relayUrl ?? DEFAULT_RELAY_URL,
    encryptionKey,
    dependantPubkey: preferences.activeAccountId ?? identity?.id ?? null,
    enabled: preferences.signingMode === 'paired-child' && !!encryptionKey,
  });

  // Child-side persona-inventory subscriber — fetches the guardian's
  // published persona roster, decrypts, merges public keys + display
  // names into the stored SignetIdentity (private keys stay empty),
  // and reloads identity state so the carousel re-renders. See
  // 2026-05-15-persona-inventory-sync-to-paired-child-design.md §2.6.
  usePersonaInventory({
    relayUrl: preferences.relayUrl ?? DEFAULT_RELAY_URL,
    encryptionKey,
    dependantPubkey: preferences.activeAccountId ?? identity?.id ?? null,
    enabled: preferences.signingMode === 'paired-child' && !!encryptionKey,
    onInventoryMerged: async () => {
      // Reload identity from IDB so the updated persona rows propagate
      // into React state and the carousel re-renders.
      await reloadIdentity();
    },
  });

  const pairedContactPolicy = useChildContactPolicy({
    enabled: isPairedChild && !!encryptionKey, child: preferences.activeAccountId ?? identity?.id ?? null,
    key: encryptionKey, relayUrl: preferences.relayUrl ?? DEFAULT_RELAY_URL,
  });
  useChildContactPolicyPublisher({
    enabled: !isPairedChild && !!identity && !!encryptionKey,
    session: JSON.stringify([identity?.naturalPerson.publicKey, encryptionKey]),
    changeToken: JSON.stringify([contactsV2Version, [...childSettingsMap], dependants.map(dep => [dep.id, dep.bunkerEndpoint?.publicKey, dep.bunkerEndpoint?.authorizedClientPubkey])]),
    relayUrl: preferences.relayUrl ?? DEFAULT_RELAY_URL,
    build: async () => {
      const key = encryptionKey, guardian = identity?.naturalPerson.publicKey;
      if (!key || !guardian) return [];
      const current = () => encryptionKeyRef.current === key && identityRef.current?.naturalPerson.publicKey === guardian;
      const fresh = await loadFreshDependants(key);
      const events = [];
      for (const dep of fresh) {
        const endpoint = dep.bunkerEndpoint;
        if (!current()) return [];
        if (dep.guardianPubkey !== guardian || !endpoint?.privateKey || !endpoint.authorizedClientPubkey) continue;
        let backend: LocalSigningBackend | undefined;
        try {
          const records = [...applyOperations(await listContactOperationsV2(`dependant:${dep.id}`, key)).values()];
          const view = projectChildContactPolicy({ child: dep.id, guardian, recipient: endpoint.authorizedClientPubkey,
            settings: await getChildSettings(dep.id), records, now: Math.floor(Date.now() / 1000) });
          backend = new LocalSigningBackend(endpoint.privateKey);
          if (backend.activePublicKeyHex !== endpoint.publicKey || !current()) continue;
          events.push(await sealChildContactPolicy(view, backend));
        } catch { /* One unavailable dependant must not block the others. */ }
        finally { backend?.destroy(); }
      }
      return current() ? events : [];
    },
  });

  useChildContactDirectoryPublisher({
    enabled: !isPairedChild && !!identity && !!encryptionKey,
    session: JSON.stringify([identity?.naturalPerson.publicKey, encryptionKey]),
    changeToken: JSON.stringify([contactsV2Version, [...childSettingsMap], dependants.map(dep => [dep.id,
      dep.autonomyStage, dep.bunkerEndpoint, childDirectoryPersonas(dep)])]),
    relayUrl: preferences.relayUrl ?? DEFAULT_RELAY_URL,
    publish: async (send, active) => {
      const key = encryptionKey, guardian = identity?.naturalPerson.publicKey;
      if (!key || !guardian) return;
      const current = () => active() && encryptionKeyRef.current === key && identityRef.current?.naturalPerson.publicKey === guardian;
      const fresh = await loadFreshDependants(key);
      for (const dep of fresh) {
        if (!current()) return;
        if (dep.guardianPubkey !== guardian || !dep.bunkerEndpoint?.authorizedClientPubkey) continue;
        try {
          await publishChildContactDirectory({ guardian, child: dep.id, key, isCurrent: current,
            readScope: async () => {
              const dependant = (await loadFreshDependants(key)).find(row => row.id === dep.id && row.guardianPubkey === guardian);
              if (!dependant) throw new Error('Dependant is no longer managed here');
              const settings = await getChildSettings(dep.id);
              const records = [...applyOperations(await listContactOperationsV2(`dependant:${dep.id}`, key)).values()];
              return { dependant, settings, records };
            },
            signer: async scope => new LocalSigningBackend(scope.dependant.bunkerEndpoint!.privateKey), send,
          });
        } catch { /* Unavailable directories expire; other dependants still receive theirs. */ }
      }
    },
  });
  const guardianChildRequestSources = useCallback(async () => {
    if (!encryptionKey || !identity || isPairedChild) return [];
    const guardian = identity.naturalPerson.publicKey;
    const fresh = await loadFreshDependants(encryptionKey);
    return fresh.filter(dep => dep.guardianPubkey === guardian && !!dep.bunkerEndpoint?.privateKey
      && !!dep.bunkerEndpoint?.publicKey && !!dep.bunkerEndpoint?.authorizedClientPubkey).map(dep => ({
        scope: { guardian, child: dep.id, endpoint: dep.bunkerEndpoint!.publicKey, client: dep.bunkerEndpoint!.authorizedClientPubkey!, personas: childDirectoryPersonas(dep) },
        endpointPrivateKey: dep.bunkerEndpoint!.privateKey,
      }));
  }, [encryptionKey, identity, isPairedChild, loadFreshDependants]);
  const guardianChildLifecycle = useRef<{
    cancel(item: GuardianChildStuckRequest, current: () => boolean): Promise<void>;
    retry(source: GuardianChildRequestSource, current: () => boolean): Promise<void>;
  }>({ cancel: async () => {}, retry: async () => {} });
  const pendingGuardianChildRequests = useGuardianChildContactRequests({
    enabled: !!encryptionKey && !!identity && !isPairedChild,
    key: encryptionKey,
    relayUrl: preferences.relayUrl ?? DEFAULT_RELAY_URL,
    sources: guardianChildRequestSources,
    changeToken: JSON.stringify(dependants.map(dep => [dep.id, dep.bunkerEndpoint?.publicKey, dep.bunkerEndpoint?.authorizedClientPubkey, childDirectoryPersonas(dep)])),
    // Defined below, after the invite services they need; read at call time.
    expireStuck: (item, current) => guardianChildLifecycle.current.cancel(item, current),
    retryReplies: (source, current) => guardianChildLifecycle.current.retry(source, current),
  });
  const guardianChildReviewCurrent = useCallback(() => !!encryptionKey && !!identity && !isPairedChild
    && inviteSession.current.key === encryptionKey && inviteSession.current.owner === identity.naturalPerson.publicKey
    && inviteSession.current.mode !== 'paired-child', [encryptionKey, identity, isPairedChild]);
  /** The live pairing still covers this request (no contact-policy check). */
  const guardianChildInScope = useCallback(async (request: ChildContactRequest | undefined, child: string) => {
    if (!guardianChildReviewCurrent()) return null;
    const fresh = await loadFreshDependants(encryptionKey!);
    const dep = fresh.find(row => row.id === child && row.guardianPubkey === identity?.naturalPerson.publicKey);
    if (!dep || !guardianChildReviewCurrent() || !request || !childContactRequestInScope(request, {
      guardian: dep.guardianPubkey, child: dep.id, endpoint: dep.bunkerEndpoint?.publicKey ?? '',
      client: dep.bunkerEndpoint?.authorizedClientPubkey ?? '', personas: childDirectoryPersonas(dep),
    })) return null;
    return dep;
  }, [encryptionKey, identity, guardianChildReviewCurrent, loadFreshDependants]);
  const guardianChildPeerAllowed = useCallback(async (peer: string, request: ChildContactRequest | undefined, child: string) => {
    const dep = await guardianChildInScope(request, child);
    if (!dep) return false;
    const settings = await getChildSettings(dep.id);
    return await storedContactInviteDecision(peer, encryptionKey!, { directoryId: `dependant:${dep.id}`, settings, activeGuardianPubkeys: guardianPubkeysFor(dep) }) === 'allow'
      && guardianChildReviewCurrent();
  }, [encryptionKey, guardianChildInScope, guardianChildReviewCurrent]);
  const guardianChildMayConnect = useCallback((peer: string, item: GuardianChildRequest) =>
    guardianChildPeerAllowed(peer, item.receipt.request, item.source.scope.child), [guardianChildPeerAllowed]);

  // Multi-pairing metas for the switcher. Public-only (display name +
  // pair timestamp); safe to load before the user has unlocked. Re-fetched
  // after any pairing mutation (add / remove) so the switcher list stays
  // fresh without re-opening the app.
  const [pairedChildMetas, setPairedChildMetas] = useState<PairedChildMeta[]>([]);
  const reloadPairedChildMetas = useCallback(async () => {
    try {
      setPairedChildMetas(await listPairedChildMetas());
    } catch { /* non-fatal — picker will refresh on next open */ }
  }, []);
  useEffect(() => {
    reloadPairedChildMetas();
  }, [reloadPairedChildMetas, preferences.signingMode, preferences.activeAccountId]);

  // Paired-child client keypair (v2). The dep's
  // device holds its NIP-46 client privkey on the `PairedChildRecord`
  // row, encrypted at rest. We load+decrypt it on unlock so the
  // child-side audit surface can decrypt the dual-address gift-wraps
  // addressed to the client pubkey. Cleared on lock — the privkey is
  // sensitive material.
  const [pairedChildClientKeypair, setPairedChildClientKeypair] = useState<{ publicKey: string; privateKey: string; guardianPubkey: string | null } | null>(null);
  useEffect(() => {
    if (preferences.signingMode !== 'paired-child') {
      setPairedChildClientKeypair(null);
      return;
    }
    if (!encryptionKey || !identity?.id) {
      setPairedChildClientKeypair(null);
      return;
    }
    let cancelled = false;
    loadPairedChild(identity.id, encryptionKey).then(record => {
      if (cancelled) return;
      if (!record) {
        setPairedChildClientKeypair(null);
        return;
      }
      setPairedChildClientKeypair({
        publicKey: record.clientKeypair.publicKey,
        privateKey: record.clientKeypair.privateKey,
        // C1: pinned at pair time — null for pre-C1 pairings until re-pair.
        guardianPubkey: record.guardianPubkey ?? null,
      });
    }).catch(() => {
      if (cancelled) return;
      setPairedChildClientKeypair(null);
    });
    return () => { cancelled = true; };
  }, [preferences.signingMode, encryptionKey, identity?.id]);

  // Which contacts directory this surface acts in, and as what role.
  const contactsScope = useMemo(() => resolveContactsScope({
    signingMode: preferences.signingMode ?? 'local',
    identityId: identity?.id ?? null,
    activeDependant: activeDependant
      ? { id: activeDependant.id, displayName: activeDependant.displayName }
      : null,
    childMode: carousel.childMode,
    dependantCount: dependants.length,
  }), [preferences.signingMode, identity, activeDependant, carousel.childMode, dependants.length]);

  const contactsIdentityLists = useMemo(() => contactIdentityLists(identity, activeDependant), [identity, activeDependant]);
  const defaultContactsIdentity = contactsIdentityLists.find(l => l.ownerIdentityPubkey === carousel.activeIdentity.publicKey)?.ownerIdentityPubkey
    ?? contactsIdentityLists[0]?.ownerIdentityPubkey ?? '';
  const [contactCardSearch, setContactCardSearch] = useState('');
  const [contactsIdentityChoice, setContactsIdentityChoice] = useState<string | null>(null);
  useEffect(() => { setContactsIdentityChoice(null); }, [contactsScope.directoryId, defaultContactsIdentity]);
  const contactsListIdentity = contactsIdentityChoice ?? defaultContactsIdentity;
  const contactsWriteIdentity = contactsListIdentity === 'all' ? defaultContactsIdentity : contactsListIdentity;
  const pairedContactDirectory = useChildContactDirectory({
    enabled: isPairedChild && !!encryptionKey,
    child: preferences.activeAccountId ?? identity?.id ?? null,
    key: encryptionKey, relayUrl: preferences.relayUrl ?? DEFAULT_RELAY_URL,
    availablePersonas: identity ? childDirectoryPersonas(identity) : [],
  });
  const pairedContactReplies = useChildContactReplyInbox({
    enabled: isPairedChild && !!encryptionKey,
    child: preferences.activeAccountId ?? identity?.id ?? null,
    key: encryptionKey,
    relayUrl: preferences.relayUrl ?? DEFAULT_RELAY_URL,
    guardian: pairedChildClientKeypair?.guardianPubkey ?? null,
    personas: identity ? childDirectoryPersonas(identity) : [],
  });

  // D4 (child): the child's own request history — the durable outbox
  // `submitChildContactRequest` writes to, merged with the reply inbox
  // above. Read-only; `childAskVersion` bumps after a new ask is queued.
  const [childAskVersion, setChildAskVersion] = useState(0);
  const childContactOutbox = useChildContactOutbox({
    enabled: isPairedChild && !!encryptionKey,
    child: preferences.activeAccountId ?? identity?.id ?? null,
    key: encryptionKey,
    guardian: pairedChildClientKeypair?.guardianPubkey ?? null,
    personas: identity ? childDirectoryPersonas(identity) : [],
    version: childAskVersion,
  });
  const childContactHistory = useMemo(() => childContactRequestHistory(childContactOutbox, pairedContactReplies),
    [childContactOutbox, pairedContactReplies]);
  // D6: ask the guardian to connect instead of connecting directly. The ask
  // screen's label and the request's persona both come from `childAskPersona`
  // — never `contactsWriteIdentity` directly, which can fall back to the
  // dormant real-identity stub the pairing URI seeded before the guardian's
  // first persona inventory lands.
  const childAskPersona = useMemo(() => isPairedChild && identity ? resolveChildAskPersona(identity, contactsWriteIdentity) : null,
    [isPairedChild, identity, contactsWriteIdentity]);
  const askGuardianToConnect = useCallback(async (invite: ContactInvite): Promise<'sent' | 'full'> => {
    if (!encryptionKey || !identity?.id || !isPairedChild) throw new Error('Unlock your Signet first.');
    const childId = preferences.activeAccountId ?? identity.id;
    const guardian = pairedChildClientKeypair?.guardianPubkey;
    if (!guardian) throw new Error('Pairing details are not available yet.');
    const key = encryptionKey;
    const current = () => encryptionKeyRef.current === key && identityRef.current?.id === identity.id;
    const pair = await loadPairedChild(childId, key);
    if (!current() || !pair || pair.guardianPubkey !== guardian) throw new Error('Pairing details are not available yet.');
    const endpoint = extractEndpointPubkey(pair.bunkerUri);
    if (!endpoint) throw new Error('Pairing details are not available yet.');
    const persona = childAskPersona?.pubkey;
    const personas = childDirectoryPersonas(identity);
    if (!persona || !personas.includes(persona)) throw new Error('Choose a persona to ask with first.');
    const scope: ChildRequestScope = { guardian, child: childId, endpoint, client: pair.clientKeypair.publicKey, personas };
    const transport = new LocalSigningBackend(pair.clientKeypair.privateKey);
    try {
      const relays = [preferences.relayUrl ?? DEFAULT_RELAY_URL].filter(isValidRelayUrl);
      await submitChildContactRequest({ scope, key, persona, invite, now: Math.floor(Date.now() / 1000), isCurrent: current,
        transport, relays, publish: (event, r) => publishToRelays(event, r, {
          beforeSend: async () => { if (!current()) throw new Error('Child request session changed'); }, isCurrent: current,
        }) });
      setChildAskVersion(v => v + 1);
      return 'sent';
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'Child request outbox is full') return 'full';
      throw cause;
    } finally { transport.destroy(); }
  }, [encryptionKey, identity, isPairedChild, preferences.activeAccountId, preferences.relayUrl, pairedChildClientKeypair, childAskPersona]);

  const contactsDefaultCeiling = activeDependant
    ? (childSettingsMap.get(activeDependant.id)?.defaultChildCeiling ?? DEFAULT_CHILD_CEILING)
    : DEFAULT_CHILD_CEILING;

  // Per the deleted NOTE this replaces: a paired-child's MutationActor is
  // `identity.id`, never the active-persona pubkey — the directory is
  // `dependant:${identity.id}` and only that id is a valid author there.
  // I3: lowercased, matching the cold `useContactsV2Import` mount's
  // `actorPubkey` above exactly — `validateOperation` requires strict
  // lowercase 64-hex, and the two must stay value-identical.
  const contactsActorPubkey = isPairedChild ? (identity?.id?.toLowerCase() ?? '') : (stableActorPubkey(identity) ?? '');

  // R-ACTOR / R-CHILD-MODE: whose vouches and ceilings count in the acting
  // directory. Deliberately never the kid's own `naturalPerson.publicKey` —
  // that is the kid's own (possibly dormant) slot, not a guardian, and using
  // it would make every guardian vouch/ceiling invisible on the kid's own
  // device. Three cases, matching `resolveContactsScope`:
  //   - paired-child: the guardian pinned on this device's pairing record
  //     (`pairedChildClientKeypair.guardianPubkey`, from the PairedChildRecord);
  //   - guardian device scoped to a dependant (child mode or a picked dep
  //     row): that dependant's own `guardianPubkey` field;
  //   - the owner's own directory: this install's one stable actor pubkey.
  const contactsActiveGuardianPubkeys = useMemo(() => {
    if (isPairedChild) {
      return guardianPubkeysFor(
        pairedChildClientKeypair
          ? { guardianPubkey: pairedChildClientKeypair.guardianPubkey ?? undefined }
          : null,
      );
    }
    if (activeDependant) return guardianPubkeysFor(activeDependant);
    const self = stableActorPubkey(identity);
    return self ? [self] : [];
  }, [isPairedChild, pairedChildClientKeypair, activeDependant, identity]);

  // I2: memoised so `useContactsV2` gets the SAME `context` object across
  // renders that don't actually change any of the three inputs, instead of
  // re-resolving the whole directory (`resolveEffectiveDirectory`) on every
  // App render. `contactsScope` and `contactsActiveGuardianPubkeys` are
  // themselves already memoised above; `contactsDefaultCeiling` is a
  // primitive string, compared by value.
  const contactsEffectiveContext = useMemo(
    () => scopeEffectiveContext(contactsScope, contactsActiveGuardianPubkeys, contactsDefaultCeiling),
    [contactsScope, contactsActiveGuardianPubkeys, contactsDefaultCeiling],
  );

  const contactsV2 = useContactsV2({
    ownerIdentityPubkey: contactsListIdentity === 'all' ? undefined : contactsWriteIdentity || undefined,
    directoryId: encryptionKey ? contactsScope.directoryId : null,
    encryptionKey,
    actor: encryptionKey && contactsActorPubkey && preferences.contactsDeviceId
      ? {
          actorPubkey: contactsActorPubkey,
          actorRole: contactsScope.actorRole,
          actorDeviceId: preferences.contactsDeviceId,
        }
      : null,
    context: contactsEffectiveContext,
    onMutated: bumpContactsV2,
  });

  const botSession = useRef({ key: encryptionKey, owner: identity?.naturalPerson.publicKey, mode: preferences.signingMode });
  botSession.current = { key: encryptionKey, owner: identity?.naturalPerson.publicKey, mode: preferences.signingMode };
  const makeBotAppSigner = useCallback(async (botPubkey: string, valid: () => boolean) => {
    const key = encryptionKey, root = identity?.naturalPerson.publicKey, mode = preferences.signingMode;
    const current = () => valid() && !!key && botSession.current.key === key && botSession.current.owner === root && botSession.current.mode === mode;
    if (!identity || !root || !key || mode === 'paired-child' || !current()) throw new Error('Unlock to use this bot.');
    return createBotSigningBackend({ identityId: identity.id, ownerRoot: root, botPubkey, encryptionKey: key, mode: mode ?? 'local',
      isCurrent: current, routed: target => mode === 'nip07' ? nip07Backend?.activePublicKeyHex === target ? nip07Backend : null
        : resolveSlotBunkerBackend(bunkerBackend, bunkerRouter, target) });
  }, [identity?.id, identity?.naturalPerson.publicKey, encryptionKey, preferences.signingMode, nip07Backend, bunkerBackend, bunkerRouter]);
  const botAppServer = useBotAppServer({ root: !isPairedChild ? identity?.naturalPerson.publicKey ?? null : null,
    encryptionKey, version: botsVersion, signer: makeBotAppSigner });
  const makeBotOwnershipService = useCallback((valid: () => boolean) => {
    const key = encryptionKey, root = identity?.naturalPerson.publicKey, mode = preferences.signingMode;
    const current = () => valid() && !!key && botSession.current.key === key && botSession.current.owner === root && botSession.current.mode === mode;
    return new BotOwnershipService({ root: root ?? '', encryptionKey: key ?? '', isCurrent: current,
      onChanged: () => { if (current()) { setBotsVersion(v => v + 1); setBotsChangeVersion(v => v + 1); } },
      sign: async (owner, event) => {
        if (!identity || !key || !current()) throw new Error('Unlock this identity first.');
        const fresh = await loadIdentityDecrypted(identity.id, key);
        if (!fresh || !current() || owner === root) throw new Error('Select an owned persona.');
        const signer = contactInviteSigner(owner, { identity: fresh, mode: mode ?? 'local', isCurrent: current,
          routed: target => mode === 'nip07' ? nip07Backend?.activePublicKeyHex === target ? nip07Backend : null
            : resolveSlotBunkerBackend(bunkerBackend, bunkerRouter, target) });
        return signer.signEvent(event);
      },
      publish: event => publishToRelays(event, syncRelays.write),
    });
  }, [identity, encryptionKey, preferences.signingMode, nip07Backend, bunkerBackend, bunkerRouter, syncRelays]);
  useBotOwnership({ root: !isPairedChild ? identity?.naturalPerson.publicKey ?? null : null,
    encryptionKey, session: preferences.signingMode ?? 'local', service: makeBotOwnershipService });

  const inviteAutomaticAttempts = useMemo(() => new Set<string>(), [encryptionKey]);
  const inviteBudget = useMemo(() => new ContactIdentityDecryptBudget(), [encryptionKey]);
  const inviteSession = useRef({ key: encryptionKey, owner: identity?.naturalPerson.publicKey, mode: preferences.signingMode });
  inviteSession.current = { key: encryptionKey, owner: identity?.naturalPerson.publicKey, mode: preferences.signingMode };
  const inviteNotifications = useRef<ReturnType<typeof contactConnectionNotifier> | null>(null);
  useEffect(() => {
    const key = encryptionKey, owner = identity?.naturalPerson.publicKey, mode = preferences.signingMode;
    const notifier = contactConnectionNotifier({ port: LocalNotifications, native: isNativeApp,
      current: () => !!key && !!owner && mode !== 'paired-child' && inviteSession.current.key === key
        && inviteSession.current.owner === owner && inviteSession.current.mode === mode,
      background: () => document.visibilityState !== 'visible',
    });
    inviteNotifications.current = notifier;
    return () => { inviteNotifications.current = null; void notifier.stop(); };
  }, [encryptionKey, identity?.naturalPerson.publicKey, preferences.signingMode]);
  const inviteScopes = useMemo(() => identity && !isPairedChild
    ? [{ directoryId: 'owner', identities: contactIdentityLists(identity, null).map(i => i.ownerIdentityPubkey) },
      ...dependants.map(dep => ({ directoryId: `dependant:${dep.id}`, identities: contactIdentityLists(identity, dep).map(i => i.ownerIdentityPubkey) }))] : [],
  [identity, isPairedChild, dependants]);
  const makeInviteService = useCallback((directoryId: string, valid: () => boolean, authority?: () => Promise<boolean>) => {
    const key = encryptionKey, owner = identity?.naturalPerson.publicKey;
    const current = () => valid() && !!key && inviteSession.current.key === key && inviteSession.current.owner === owner && inviteSession.current.mode === preferences.signingMode;
    const freshDependant = async () => {
      if (!key || !owner || !current() || isPairedChild || !directoryId.startsWith('dependant:')) throw new Error('Unlock the guardian identity first.');
      const dep = (await loadFreshDependants(key)).find(dep => `dependant:${dep.id}` === directoryId && dep.guardianPubkey === owner);
      if (!dep || !current()) throw new Error('This dependant is no longer managed here.');
      return dep;
    };
    const peerDecision = async (peer: string) => {
      if (!key || !current()) return 'deny' as const;
      if (authority && !await authority()) return 'deny' as const;
      if (directoryId === 'owner') return await contactPeerAllowed(directoryId, key, peer) ? 'allow' as const : 'deny' as const;
      const dep = await freshDependant();
      const settings = await getChildSettings(dep.id);
      return storedContactInviteDecision(peer, key, { directoryId, settings, activeGuardianPubkeys: guardianPubkeysFor(dep) });
    };
    const sendChildCompletionReply = async (dep: NonNullable<Awaited<ReturnType<typeof freshDependant>>>, exchangeId: string, contactId: string, current: () => boolean) => {
      if (!key || !owner || !dep.bunkerEndpoint?.privateKey || !dep.bunkerEndpoint.authorizedClientPubkey || !dep.bunkerEndpoint.publicKey) return;
      const scope = { guardian: owner, child: dep.id, endpoint: dep.bunkerEndpoint.publicKey, client: dep.bunkerEndpoint.authorizedClientPubkey, personas: childDirectoryPersonas(dep) };
      const plan = (await loadChildContactReview(scope, key, current)).find(row => row.exchangeId === exchangeId);
      if (!plan || plan.status !== 'approved' || !current()) return;
      const backend = new LocalSigningBackend(dep.bunkerEndpoint.privateKey);
      const mayReply = async () => {
        const fresh = await freshDependant();
        return childContactRequestInScope(plan.request, { guardian: fresh.guardianPubkey, child: fresh.id,
          endpoint: fresh.bunkerEndpoint?.publicKey ?? '', client: fresh.bunkerEndpoint?.authorizedClientPubkey ?? '',
          personas: childDirectoryPersonas(fresh) }) && await peerDecision(plan.peer) === 'allow';
      };
      try {
        if (!await mayReply()) throw new Error('Child pairing or contact policy changed');
        // D1: the receipt records completion before the completed reply is queued.
        await transitionChildContactReceipt({ scope, key, requestId: plan.requestId, from: ['pending', 'approved'], to: 'completed',
          now: Math.floor(Date.now() / 1000), isCurrent: current });
        await sendChildContactReply({ scope, key, plan, status: 'completed', exchangeId: plan.exchangeId, contactId,
          now: Math.floor(Date.now() / 1000), isCurrent: current, transport: backend, relays: syncRelays.write, mayDeliver: mayReply,
          publish: (signed, relays) => publishToRelays(signed, relays, { isCurrent: current, beforeSend: async () => {
            if (!await mayReply()) throw new Error('Child pairing or contact policy changed');
          } }) });
      } finally { backend.destroy(); }
    };
    // D5: a child exchange belongs to the pairing it was approved under.
    const childPairing = async () => {
      if (!key || !owner || !current()) throw new Error('Unlock the guardian identity first.');
      const dep = (await loadFreshDependants(key)).find(dep => `dependant:${dep.id}` === directoryId && dep.guardianPubkey === owner);
      if (!current()) throw new Error('Unlock the guardian identity first.');
      return dep?.bunkerEndpoint?.publicKey && dep.bunkerEndpoint.authorizedClientPubkey
        ? { endpoint: dep.bunkerEndpoint.publicKey, client: dep.bunkerEndpoint.authorizedClientPubkey } : null;
    };
    const childExchangeScope = async (exchange: import('./lib/contact-invite-store').StoredContactExchange) => {
      if (!key || !owner || !exchange.pairing || !current()) return null;
      const child = directoryId.slice('dependant:'.length);
      const dep = (await loadFreshDependants(key)).find(dep => dep.id === child && dep.guardianPubkey === owner);
      if (!dep || !current()) return null;
      return { dep, scope: { guardian: owner, child, endpoint: exchange.pairing.endpoint, client: exchange.pairing.client, personas: childDirectoryPersonas(dep) } };
    };
    // Review finding 1: publish or record only for an approved request.
    const childAuthority = async (exchange: import('./lib/contact-invite-store').StoredContactExchange) => {
      const found = await childExchangeScope(exchange);
      if (!found || !key) return 'withdraw' as const;
      return childExchangeAuthority({ scope: found.scope, key, exchangeId: exchange.request.id, now: Math.floor(Date.now() / 1000), isCurrent: current });
    };
    const onChildExchangeCancelled = async (exchange: import('./lib/contact-invite-store').StoredContactExchange, reason: ChildExchangeCancelReason) => {
      if (!key || !owner || !current()) return;
      if (reason === 'expired') {
        // The peer never answered: expire the approval and tell the child.
        const found = await childExchangeScope(exchange);
        if (!found?.dep.bunkerEndpoint?.privateKey) return;
        const plan = (await loadChildContactReview(found.scope, key, current)).find(row => row.exchangeId === exchange.request.id);
        if (!plan) return;
        const transport = new LocalSigningBackend(found.dep.bunkerEndpoint.privateKey);
        const inScope = async () => !!await guardianChildInScope(plan.request, found.scope.child) && current();
        try {
          await cancelChildContactRequest({ scope: found.scope, key, requestId: plan.requestId, now: Math.floor(Date.now() / 1000), isCurrent: current,
            ...(await inScope() ? { reply: { transport, relays: syncRelays.write, mayDeliver: inScope,
              publish: (signed: import('signet-protocol').NostrEvent, relays: string[]) => publishToRelays(signed, relays, { isCurrent: current, beforeSend: async () => {
                if (!await inScope()) throw new Error('Child pairing changed');
              } }) } } : {}) });
        } finally { transport.destroy(); }
        return;
      }
      const child = directoryId.slice('dependant:'.length);
      const dep = (await loadFreshDependants(key)).find(dep => dep.id === child && dep.guardianPubkey === owner);
      // An unstamped row can only be traced in the live pairing's stores.
      const endpoint = exchange.pairing?.endpoint ?? dep?.bunkerEndpoint?.publicKey, client = exchange.pairing?.client ?? dep?.bunkerEndpoint?.authorizedClientPubkey;
      if (!endpoint || !client || !current()) return;
      const scope = { guardian: owner, child, endpoint, client, personas: dep ? childDirectoryPersonas(dep) : [] };
      try {
        const plan = (await loadChildContactReview(scope, key, current)).find(row => row.exchangeId === exchange.request.id);
        if (!plan) return;
        // No reply: a re-pair's old endpoint is gone and the new pairing never
        // saw it; a withdrawn request already has its status of record.
        await cancelChildContactRequest({ scope, key, requestId: plan.requestId, now: Math.floor(Date.now() / 1000), isCurrent: current });
      } catch { if (!current()) throw new Error('Contact invite session changed'); }
    };
    return new ContactInviteService({ directoryId, encryptionKey: key ?? '', budget: inviteBudget, isCurrent: current,
      onChanged: bumpContactsV2,
      automaticAttempts: inviteAutomaticAttempts,
      appAllowed: async (app, own, action, automatic) => {
        if (!key || !current() || directoryId !== 'owner') return false;
        const grant = await getContactGrantV2(app.grantId, key);
        return !!grant && !grant.revokedAt && grant.directoryId === directoryId && grant.ownerIdentityPubkey === own
          && grant.capabilities.some(cap => (cap as string) === `signet.contacts.invites:${action === 'create' ? 'create' : 'receive'}`)
          && (!automatic || grant.autoAcceptInvites !== false) && current();
      },
      mayConnect: async peer => await peerDecision(peer) === 'allow',
      mayReceive: async peer => await peerDecision(peer) !== 'deny',
      ...(directoryId.startsWith('dependant:') ? { childPairing, onChildExchangeCancelled, childAuthority } : {}),
      onCompleted: async exchange => {
        if (!key || !owner || !current()) throw new Error('Contacts are not ready.');
        if (directoryId !== 'owner') await freshDependant();
        // A service may have been created before the preferences reload that
        // exposes this installation's ID. Resolve the durable ID at write time.
        const actorDeviceId = await getOrCreateContactsDeviceId();
        if (!current()) throw new Error('Unlock this identity first.');
        const contactId = await recordCompletedContactExchange({ directoryId, key, exchange, isCurrent: current,
          actor: { actorPubkey: owner, actorRole: directoryId === 'owner' ? 'owner' : 'guardian', actorDeviceId } });
        if (current()) {
          void contactsV2.reload(); bumpContactsV2();
          if (directoryId === 'owner') void inviteNotifications.current?.completed(exchange);
        }
        if (directoryId.startsWith('dependant:')) {
          const depForChildCompletion = await freshDependant();
          await sendChildCompletionReply(depForChildCompletion, exchange.request.id, contactId, current);
        }
        return contactId;
      },
      signer: async pubkey => {
        if (!identity || !current()) throw new Error('Unlock this identity first.');
        const fresh = directoryId === 'owner' ? key ? await loadIdentityDecrypted(identity.id, key) : null : await freshDependant();
        if (!fresh || !current()) throw new Error('Unlock this identity first.');
        return contactInviteSigner(pubkey, { identity: fresh, mode: preferences.signingMode ?? 'local', isCurrent: current,
          imported: 'derivationPath' in fresh && /^imported-(?!view-)/.test(fresh.derivationPath),
          routed: target => preferences.signingMode === 'nip07'
            ? nip07Backend?.activePublicKeyHex === target ? nip07Backend : null
            : resolveSlotBunkerBackend(bunkerBackend, bunkerRouter, target) });
      },
    });
  }, [encryptionKey, identity, inviteBudget, inviteAutomaticAttempts, preferences.signingMode, preferences.contactsDeviceId, nip07Backend, bunkerBackend, bunkerRouter, bumpContactsV2, contactsV2.reload, isPairedChild, loadFreshDependants, guardianChildInScope, syncRelays.write]);
  const ownerInviteService = useMemo(() => makeInviteService('owner', () => true), [makeInviteService]);
  const inviteService = useMemo(() => makeInviteService(contactsScope.directoryId ?? 'owner', () => true), [makeInviteService, contactsScope.directoryId]);
  const guardianChildService = useCallback((child: string, peer: string, request: ChildContactRequest) =>
    makeInviteService(`dependant:${child}`, guardianChildReviewCurrent, () => guardianChildPeerAllowed(peer, request, child)),
  [makeInviteService, guardianChildReviewCurrent, guardianChildPeerAllowed]);
  const guardianChildTransport = useCallback((source: GuardianChildRequestSource, plan: ChildContactExchangePlan, status: string, current: () => boolean) => ({
    relays: syncRelays.write,
    // Saying no, or that a request ended, cannot widen access: scope only (D2).
    mayDeliver: async () => status === 'pending' || status === 'completed'
      ? await guardianChildPeerAllowed(plan.peer, plan.request, source.scope.child) && current()
      : !!await guardianChildInScope(plan.request, source.scope.child) && current(),
    publish: (signed: import('signet-protocol').NostrEvent, relays: string[]) => publishToRelays(signed, relays, { isCurrent: current, beforeSend: async () => {
      const allowed = status === 'pending' || status === 'completed'
        ? await guardianChildPeerAllowed(plan.peer, plan.request, source.scope.child)
        : !!await guardianChildInScope(plan.request, source.scope.child);
      if (!allowed) throw new Error('Child pairing or contact policy changed');
    } }),
  }), [syncRelays.write, guardianChildPeerAllowed, guardianChildInScope]);
  const guardianChildExecute = useCallback(async (item: GuardianChildRequest, plan: ChildContactExchangePlan) => {
    if (!encryptionKey || !guardianChildReviewCurrent()) throw new Error('Unlock the guardian identity first.');
    const service = guardianChildService(item.source.scope.child, plan.peer, plan.request);
    await executeChildContactPlan({ scope: item.source.scope, key: encryptionKey, requestId: plan.requestId, now: Math.floor(Date.now() / 1000),
      isCurrent: guardianChildReviewCurrent, mayConnect: peer => guardianChildMayConnect(peer, item),
      sign: () => service.requestChildPlan({ identityPubkey: plan.persona, exchangeId: plan.exchangeId, nonce: plan.nonce,
        replySecret: plan.replySecret, invite: plan.request.invite, now: Math.floor(Date.now() / 1000),
        pairing: { endpoint: item.source.scope.endpoint, client: item.source.scope.client } }) });
  }, [encryptionKey, guardianChildReviewCurrent, guardianChildService, guardianChildMayConnect]);
  const guardianChildExchangeKey = (plan: ChildContactExchangePlan) => contactExchangeKey({ id: plan.exchangeId, from: plan.persona, to: plan.peer });
  const guardianChildAbandon = useCallback(async (item: GuardianChildRequest, plan: ChildContactExchangePlan) => {
    if (!encryptionKey || !guardianChildReviewCurrent()) return;
    await guardianChildService(item.source.scope.child, plan.peer, plan.request).cancel(guardianChildExchangeKey(plan));
    await cancelChildContactExecution({ scope: item.source.scope, key: encryptionKey, exchangeId: plan.exchangeId, now: Math.floor(Date.now() / 1000),
      isCurrent: guardianChildReviewCurrent }).catch(() => undefined);
  }, [encryptionKey, guardianChildReviewCurrent, guardianChildService]);
  const guardianChildReply = useCallback(async (item: GuardianChildRequest, plan: ChildContactExchangePlan, status: 'pending' | 'denied') => {
    if (!encryptionKey || !guardianChildReviewCurrent()) throw new Error('Unlock the guardian identity first.');
    // The exchange request publishes only after the receipt left pending.
    if (status === 'pending') await guardianChildService(item.source.scope.child, plan.peer, plan.request).flush(Math.floor(Date.now() / 1000));
    const transport = new LocalSigningBackend(item.source.endpointPrivateKey);
    try {
      await sendChildContactReply({ scope: item.source.scope, key: encryptionKey, plan, status, now: Math.floor(Date.now() / 1000),
        isCurrent: guardianChildReviewCurrent, transport, ...guardianChildTransport(item.source, plan, status, guardianChildReviewCurrent) });
    } finally { transport.destroy(); }
  }, [encryptionKey, guardianChildReviewCurrent, guardianChildService, guardianChildTransport]);
  /** D3 Cancel (and the expiry sweep): expire the receipt and tell the child. */
  const guardianChildCancel = useCallback(async (item: GuardianChildStuckRequest, current: () => boolean = guardianChildReviewCurrent) => {
    if (!encryptionKey || !current()) throw new Error('Unlock the guardian identity first.');
    const transport = new LocalSigningBackend(item.source.endpointPrivateKey);
    try {
      const live = !!await guardianChildInScope(item.plan.request, item.source.scope.child);
      await cancelChildContactRequest({ scope: item.source.scope, key: encryptionKey, requestId: item.plan.requestId, now: Math.floor(Date.now() / 1000),
        isCurrent: current,
        cancelExchange: plan => guardianChildService(item.source.scope.child, plan.peer, plan.request).cancel(guardianChildExchangeKey(plan)),
        ...(live ? { reply: { transport, ...guardianChildTransport(item.source, item.plan, 'expired', current) } } : {}) });
    } finally { transport.destroy(); }
  }, [encryptionKey, guardianChildReviewCurrent, guardianChildInScope, guardianChildService, guardianChildTransport]);
  const guardianChildRetry = useCallback(async (source: GuardianChildRequestSource, current: () => boolean) => {
    if (!encryptionKey || !current()) return;
    // D1 crash gap: a receipt swapped without its reply gets it now.
    const transport = new LocalSigningBackend(source.endpointPrivateKey);
    try {
      await reconcileChildContactReplies({ scope: source.scope, key: encryptionKey, now: Math.floor(Date.now() / 1000), isCurrent: current,
        transport: async (plan, status) => {
          const reply = guardianChildTransport(source, plan, status, current);
          return await reply.mayDeliver() ? { transport, ...reply } : null;
        },
        completedContactId: async plan => (await makeInviteService(`dependant:${source.scope.child}`, current).read()).exchanges
          .find(e => contactExchangeKey(e.request) === guardianChildExchangeKey(plan))?.contactId });
    } finally { transport.destroy(); }
    const plans = await loadChildContactReview(source.scope, encryptionKey, current);
    await deliverPendingChildContactReplies({ scope: source.scope, key: encryptionKey, now: Math.floor(Date.now() / 1000), isCurrent: current,
      mayDeliver: entry => {
        const plan = plans.find(row => row.requestId === entry.requestId);
        return !!plan && guardianChildTransport(source, plan, entry.reply!.status, current).mayDeliver();
      },
      publish: (signed, relays, entry) => {
        const plan = plans.find(row => row.requestId === entry.requestId);
        return plan ? guardianChildTransport(source, plan, entry.reply!.status, current).publish(signed, relays) : Promise.resolve(false);
      } });
  }, [encryptionKey, guardianChildTransport, makeInviteService]);
  guardianChildLifecycle.current = { cancel: guardianChildCancel, retry: guardianChildRetry };
  useContactAppInvites({ encryptionKey, enabled: !!identity && !isPairedChild,
    identities: inviteScopes[0]?.identities ?? [], relays: syncRelays.write.filter(url => url.startsWith('wss:')),
    service: valid => makeInviteService('owner', valid) });
  useContactInviteMailboxes({ encryptionKey, scopes: inviteScopes, version: contactsV2Version,
    service: makeInviteService, onChanged: bumpContactsV2 });
  const [pendingContactInvite, setPendingContactInvite] = useState<string | undefined>(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get('contact-invite');
    return value && value.length <= 8192 ? value : undefined;
  });
  useEffect(() => {
    if (!pendingContactInvite || !identity || !encryptionKey || activeDependantId) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    // D6: a paired-child install asks the guardian instead of connecting.
    navigateTo(isPairedChild ? 'child-contact-ask' : 'contact-invites');
  }, [!!identity, !!encryptionKey, isPairedChild, pendingContactInvite, activeDependantId]);

  // C1: `useContactsV2`'s own mount-time `reload()` and the cold
  // `useContactsV2Import` above are two independent async effects racing
  // each other — on the very first unlock after this upgrade, `useContactsV2`
  // typically reloads from an EMPTY operation log (the cold import hasn't
  // written anything yet), and nothing re-reads afterwards: the hot-path
  // `useContactsV2Reimport` below sees the cold import's markers already
  // written and reports `operations: 0`, so its own `onImported` never
  // fires either. Net effect without this: the contacts screen stays empty
  // for the rest of that unlock. Reload exactly once per unlock (keyed by
  // `encryptionKey`, mirroring `useContactsV2Import`'s own once-per-unlock
  // latch) the first time the cold import finishes having written
  // something.
  //
  // F2: folded with the R3 opsVersion bump below (the cold import writes
  // operations directly to IDB, bypassing both Phase C hooks, so its
  // completion is its own change signal) — the two used to be separate
  // effects with an identical guard and their own latch ref; one effect,
  // one latch.
  const contactsColdImportReloadedForKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!encryptionKey) return;
    if (contactsImport.status !== 'done') return;
    if (!contactsImport.result || contactsImport.result.operations === 0) return;
    if (contactsColdImportReloadedForKeyRef.current === encryptionKey) return;
    contactsColdImportReloadedForKeyRef.current = encryptionKey;
    void contactsV2.reload();
    bumpContactsV2();
  }, [encryptionKey, contactsImport.status, contactsImport.result, contactsV2.reload, bumpContactsV2]);

  // I4/M1: gated on the cold import having SETTLED (done or error) — before
  // that, both hooks are working from the same empty marker set and would
  // otherwise fire their own debounced imports ~400ms into the SAME cold
  // run, doubling the per-op PBKDF2 encrypt cost on every unlock for no
  // benefit (the cold import's own markers make the parallel hot run a
  // guaranteed no-op). `!!identity && !dependantsLoading` mirrors the cold
  // mount's own gate exactly, for the same C1 reason given there: a run
  // against an unloaded dependant roster quarantines every dependant-owned
  // legacy row.
  //
  // Legacy writes (AddMember, KenAdd, VouchSomeone, the v1 sync rails) still
  // own the `contacts` / `ken` stores this phase. Re-run Phase B's idempotent
  // import whenever those arrays change so v2 stays a complete mirror — the
  // ownerPubkeys/dependants inputs are the SAME memoised
  // `contactsV2OwnerPubkeys` / `contactsV2DependantRefs` locals the
  // once-per-unlock `useContactsV2Import` mount above already uses, not a
  // second computation of them.
  useContactsV2Reimport({
    enabled: !!encryptionKey && !!identity && !dependantsLoading
      && (contactsImport.status === 'done' || contactsImport.status === 'error'),
    encryptionKey,
    deviceId: preferences.contactsDeviceId ?? null,
    actorPubkey: contactsActorPubkey || null,
    ownerPubkeys: contactsV2OwnerPubkeys,
    dependants: contactsV2DependantRefs,
    contacts: members,
    kens,
    onImported: () => { void contactsV2.reload(); bumpContactsV2(); },
  });

  // Tier-1 gate for the cross-family contacts manager (Task 14). Unlocked
  // state is cleared on leaving the page so a later re-entry re-prompts.
  const handleOpenFamilyContacts = useCallback(async () => {
    const key = await requestAuth({ purpose: 'manage-family-contacts' });
    if (!key) return;
    setFamilyContactsUnlocked(true);
    navigateTo('family-contacts');
  }, [requestAuth, navigateTo]);

  const familyDirectoryRefs = useMemo<FamilyDirectoryRef[]>(() => ([
    {
      // I2: the owner directory's "active guardian" is this install's own
      // stable actor — the same value `contactsActiveGuardianPubkeys`
      // resolves to when `useContactsV2`'s scope is the owner directory
      // (no activeDependant, not paired-child). Never a dependant's
      // `guardianPubkey` here; this row IS the guardian's own directory.
      directoryId: OWNER_DIRECTORY_ID, label: OWNER_DIRECTORY_LABEL, isOwner: true,
      activeGuardianPubkeys: contactsActorPubkey ? [contactsActorPubkey] : [],
      defaultChildCeiling: DEFAULT_CHILD_CEILING,
    },
    ...dependants.map(dep => ({
      directoryId: directoryIdForDependant(dep),
      label: dep.displayName,
      isOwner: false,
      // I2: must agree with the Contacts page's own `contactsActiveGuardianPubkeys`
      // (`guardianPubkeysFor(activeDependant)` there) — an imported dependant's
      // real `guardianPubkey` can diverge from this install's own identity,
      // and using `identity.naturalPerson.publicKey` here silently dropped
      // that dependant's actual active guardian.
      activeGuardianPubkeys: guardianPubkeysFor(dep),
      defaultChildCeiling: childSettingsMap.get(dep.id)?.defaultChildCeiling ?? DEFAULT_CHILD_CEILING,
    })),
  ]), [dependants, contactsActorPubkey, childSettingsMap]);

  // P7: the family-hook `enabled` expression, pulled out to a pure,
  // independently-tested helper (contacts-v2-scope.test.ts) — see
  // `familyLogEnabled`'s docstring for why it's still exactly this
  // expression, paired-child-never and stale-`activeDependantId` cases
  // included. Also the gate for the "load every dependant's child settings"
  // effect below (I2), so both consult the same condition.
  const familyLogEnabledNow = familyLogEnabled(
    encryptionKey, page, contactsScope, familyContactsUnlocked, pendingPersonaAdvancedTarget?.depPubkey,
  );

  const familyContacts = useFamilyContactsV2({
    enabled: familyLogEnabledNow,
    encryptionKey,
    actor: encryptionKey && contactsActorPubkey && preferences.contactsDeviceId
      ? { actorPubkey: contactsActorPubkey, actorRole: 'guardian', actorDeviceId: preferences.contactsDeviceId }
      : null,
    directories: familyDirectoryRefs,
    onMutated: bumpContactsV2,
  });

  // M3: memoised so a render that touches neither the resolved directories
  // nor the actor pubkey doesn't re-run the row-grouping union-find on
  // every App render.
  const familyManagerRows = useMemo(
    () => buildManagerRows(familyContacts.directories, { actorPubkey: contactsActorPubkey }),
    [familyContacts.directories, contactsActorPubkey],
  );

  // ---- Contacts v2 app grants (Phase E, Task 22) ---------------------------

  /**
   * R-14: the projection directories, composed from the SAME memoised
   * `familyDirectoryRefs` the family manager already uses, so a grant can
   * never read a directory under a different context than the app's own
   * surfaces resolve for it. MUST stay memoised: `useContactProjections`
   * holds this array in its effect's dependency list BY REFERENCE, and a
   * fresh literal per render re-arms the publish timer forever.
   */
  const contactGrantDirectories = useMemo(
    // R-34: a dependant directory is projectable only once its `ChildSettings`
    // read has completed — see `projectableDirectoryRefs`.
    () => buildProjectionDirectories(
      projectableDirectoryRefs(familyDirectoryRefs, dependants, childSettingsResolved),
      identity, dependants,
    ),
    [familyDirectoryRefs, identity, dependants, childSettingsResolved],
  );

  /**
   * R-8: a paired-child install has no v2 grant surface at all — it publishes
   * no projections, accepts no proposals and holds no owner grants to put on
   * the registry rail. One flag for all three hooks and for the grant list.
   */
  const contactsV2GrantSurfaceEnabled = !!encryptionKey && !!identity && !isPairedChild;

  /**
   * The projection publisher's change token: any contacts change (every Phase
   * B/C mutator routes through `onMutated` → `bumpContactsV2`, as does the
   * import) plus any grant-row change. Deliberately DERIVED rather than a
   * third counter of its own — a counter some call sites remember to bump and
   * others do not is exactly how a projection goes stale unnoticed.
   */
  const contactsChangeToken = `${contactsV2Version}:${contactsGrantRowsVersion}`;

  /**
   * M1: the one option list both the approval picker and the connected-apps
   * list read — composed from the RESOLVED directories, so the picker can
   * only ever offer a choice `handleApproveContactsGrantV2` would accept.
   */
  const contactsGrantDirectoryOptions = useMemo(
    () => grantIdentityOptions(familyDirectoryRefs, contactGrantDirectories, identity, dependants),
    [familyDirectoryRefs, contactGrantDirectories, identity, dependants],
  );

  /** Surfaced on the connected-apps list when a revoke or forget fails. */
  const [contactsGrantActionError, setContactsGrantActionError] = useState<string | null>(null);
  /** M7: set when a pairing code is scanned on a paired-child install, which
   *  has no v2 grant surface at all (R-8). Dismissable; never auto-cleared,
   *  so a scan the user has walked away from is still explained when they
   *  come back. */
  const [contactsGrantPairedChildNotice, setContactsGrantPairedChildNotice] = useState(false);
  /** Inline confirm/busy state for the connected-apps rows — mirrors
   *  `CompanionApps`' own confirm toggle rather than a `window.confirm`. */
  const [contactsGrantConfirmId, setContactsGrantConfirmId] = useState<string | null>(null);
  const [contactsGrantBusyId, setContactsGrantBusyId] = useState<string | null>(null);

  /**
   * Land an app's accepted `add-ken` proposal as contact operations in the
   * named directory, authored as the APP (R-7).
   *
   * Not through `useContactsV2`: that hook is mounted for exactly one
   * directory (`contactsScope.directoryId`) and its mutators take no directory
   * argument, so a proposal for `dependant:<id>` has nowhere to land there.
   * `applyContactProposal` is the pure builder; App persists what it returns
   * and reloads both Phase C views so a proposal accepted while the contacts
   * page is open appears without waiting for the next unlock.
   */
  const handleProposedAddKen = useCallback(async (
    directoryId: string, value: { pubkey: string; displayName: string }, _appName: string, grantId: string,
  ): Promise<AddKenOutcome> => contactsMutationQueue.run(async () => {
    if (!encryptionKey) return 'refused';
    const actorDeviceId = preferences.contactsDeviceId;
    if (!contactsActorPubkey || !actorDeviceId) return 'refused';
    const grant = await getContactGrantV2(grantId, encryptionKey);
    if (!grant || grant.revokedAt || grant.directoryId !== directoryId || !grant.ownerIdentityPubkey
      || !contactsGrantDirectoryOptions.some(o => o.directoryId === directoryId && o.ownerIdentityPubkey === grant.ownerIdentityPubkey)) return 'refused';
    const existingOps = await listContactOperationsV2(directoryId, encryptionKey);
    const result = applyContactProposal(directoryId, value, {
      actorPubkey: contactsActorPubkey, actorDeviceId, existingOps, now: Date.now(),
      grantId, ownerIdentityPubkey: grant.ownerIdentityPubkey, appName: grant.appName,
    });
    // R-28: a structural refusal (a directory this device does not own, an
    // unusable key) is FINAL — throwing here would only make the inbox
    // re-attempt it forever — but `directory-full` is reported as itself, so
    // the inbox counts it as a rejection and reconsiders it if the app asks
    // again after the owner has made room.
    if (!result.ok) return result.reason === 'directory-full' ? 'directory-full' : 'refused';
    // R-28(a): the key is already in the directory, so there is nothing to
    // write. Still an acceptance — the app's requested state holds.
    if (result.outcome === 'existing') return 'existing';
    await saveContactOperationsV2(result.operations, encryptionKey);
    bumpContactsV2();
    void contactsV2.reload();
    if (familyLogEnabledNow) void familyContacts.reload();
    return 'created';
  }), [
    encryptionKey, contactsActorPubkey, preferences.contactsDeviceId, bumpContactsV2, contactsGrantDirectoryOptions,
    contactsV2.reload, familyLogEnabledNow, familyContacts.reload,
  ]);

  /**
   * `rename-app-label` never touches the contact log — the inbox hook is the
   * enforcing writer for `AppGrantV2.appLabels` and has already applied it by
   * the time this runs. Bumping the ROW version is what makes the next
   * projection carry the new label and the registry rail republish it.
   *
   * R-35/B-I4: the ROW version, never the SET version. The grant set has not
   * changed, and the set version is in the inbox's own effect dependencies —
   * bumping it here scheduled the teardown of the very run that was applying
   * the rename.
   */
  const handleProposedRenameAppLabel = useCallback(async () => {
    bumpContactsGrantRows();
  }, [bumpContactsGrantRows]);

  /**
   * Approve a contacts v2 grant: mint a grant id and a FRESH RANDOM rail
   * keypair, persist the encrypted grant, ack the app over its rendezvous
   * relay from an ephemeral key, and publish the first projection immediately
   * rather than making the app wait out the jitter.
   *
   * The ack is the hinge (fix round 1 / M3). BEFORE it reaches the relay the
   * app knows nothing — no grant id, no rail key — so any failure up to and
   * including the ack deletes the row again: a grant the app never learned
   * about is a rail nobody reads, and leaving it would consume a slot against
   * `CONTACT_GRANT_V2_CAP`. AFTER the ack the app believes it is paired and
   * will start reading that rail, so a later failure must NOT delete the
   * grant — the pairing is real, only this device's first publish fell over,
   * and the publisher retries on the next change. That is said out loud
   * rather than silently swallowed.
   *
   * Every thrown message is copy-module text — `ContactsGrantApprove` renders
   * `error.message` verbatim.
   */
  const handleApproveContactsGrantV2 = useCallback(async (choice: GrantChoice) => {
    const req = pendingContactsGrantV2;
    const deviceId = preferences.contactsDeviceId;
    if (!req || !identity || !encryptionKey || !deviceId) throw new Error(CONTACTS_GRANT_NOT_READY_COPY);
    const directory = contactGrantDirectories.find((d) => d.directoryId === choice.directoryId);
    // Both come from the same refs, so one without the other means the picked
    // directory is not one this device can resolve — refuse rather than
    // project under a borrowed context or an empty owner key.
    if (!directory || !contactsGrantDirectoryOptions.some(o => o.directoryId === choice.directoryId && o.ownerIdentityPubkey === choice.ownerIdentityPubkey)) throw new Error(CONTACTS_GRANT_DIRECTORY_UNAVAILABLE_COPY);

    // M2: the request is the CEILING (R-12), and this handler is where that
    // stops being the screen's own good behaviour and becomes a rule. A
    // capability the app never asked for must never end up on the grant, and
    // an empty tick-list is not a grant at all.
    const requested = new Set(req.capabilities);
    if (choice.directoryId !== 'owner' && choice.capabilities.some(cap => cap.startsWith('signet.contacts.invites:'))) throw new Error('App invitations are currently available for your own identities only.');
    if (choice.capabilities.length === 0 || choice.capabilities.some((c) => !requested.has(c))) {
      throw new Error(CONTACTS_GRANT_CAPABILITIES_INVALID_COPY);
    }

    // R-13: the cap counts ACTIVE grants, and it is checked BEFORE anything is
    // minted so the refusal is a plain sentence rather than a failed save.
    const active = (await listContactGrantsV2(encryptionKey)).filter((g) => !g.revokedAt);
    if (active.length >= CONTACT_GRANT_V2_CAP) throw new Error(CONTACTS_GRANT_AT_CAP_COPY);

    const relays = resolveSyncRelays(preferences, DEFAULT_RELAY_URL);
    const grantId = newGrantId();
    const rail = newRailKeypair();
    const nowS = Math.floor(Date.now() / 1000);
    const grant: AppGrantV2 = {
      grantId,
      directoryId: choice.directoryId,
      ownerIdentityPubkey: choice.ownerIdentityPubkey,
      appPubkey: req.appPubkey,
      createdAt: nowS,
      updatedAt: Date.now(),
      appName: req.appName,
      capabilities: choice.capabilities,
      railPubkey: rail.publicKey,
      railPrivateKey: rail.privateKey,
      relay: relays.write[0] ?? DEFAULT_RELAY_URL,
      maxStalenessSeconds: choice.maxStalenessSeconds,
      appLabels: {},
      seenOperationIds: [],
    };

    // Phase 1 — save the row, then ack the app. Either failing undoes both.
    //
    // A/I6: `ackSent` is the hinge, not "did we reach the end of the try".
    // The `try` also wraps the two `finally` blocks below, so a throw out of
    // `rendezvous.disconnect()` or `ephemeral.destroy()` — AFTER the relay
    // accepted the ack — landed in the `catch` and deleted the row. The app
    // then held a valid pairing (grant id, rail key, tags, relay) for a grant
    // the owner's device no longer had: it would poll that rail for ever, and
    // the owner would see nothing in the connected-apps list to disconnect.
    let ackSent = false;
    try {
      await saveContactGrantV2(grant, encryptionKey);

      const ephemeral = new LocalSigningBackend(generateBunkerClientSecret());
      try {
        const content = await buildPairingAckV2Content({
          v: 2, grantId, railPubkey: rail.publicKey,
          projectionTag: projectionTag(grantId), proposalTag: proposalTag(grantId, req.appPubkey),
          relay: grant.relay, grantedCapabilities: choice.capabilities,
          maxStalenessSeconds: choice.maxStalenessSeconds, challenge: req.challenge,
        }, ephemeral, req.appPubkey);
        // P8: the ack's event shape is the SDK's, not a hand-built copy — a
        // tag change there has to reach here, and a second spelling is a
        // second thing to keep in step.
        const ackEvent = await ephemeral.signEvent(
          ackEventTemplate(ephemeral.activePublicKeyHex, req.appPubkey, Math.floor(Date.now() / 1000), content),
        );
        const rendezvous = new RelayClient(req.rendezvousRelay);
        try {
          await rendezvous.connect();
          // M3: NOT best-effort. An ack that never landed leaves a grant the
          // app has never heard of, holding a cap slot for nothing — so a
          // relay rejection is a failed approval the owner can retry, not a
          // silent half-pairing.
          const ack = await rendezvous.publish(ackEvent);
          if (!ack.ok) throw new Error('ack rejected');
          ackSent = true;
        } finally {
          rendezvous.disconnect();
        }
      } finally {
        ephemeral.destroy();
      }
    } catch (err) {
      // A/I6: the pairing is REAL once the ack landed — only the teardown
      // fell over. Deleting the grant here is the one thing that can make the
      // two sides permanently disagree about whether they are paired, so it
      // happens only while the app still knows nothing.
      if (!ackSent) await deleteContactGrantV2(grantId).catch(() => { /* nothing to undo */ });
      if (ackSent) {
        setPendingContactsGrantV2(null);
        bumpContactsGrantSet();
        // B1/F1: the pairing code check comes first — the teardown's own
        // error is carried as `followUpError` and applied only once that
        // page finishes, not on arrival here.
        setContactsGrantCodeCheck({
          grantId, appName: req.appName,
          input: { appPubkey: req.appPubkey, challenge: req.challenge, grantId, railPubkey: rail.publicKey },
          mismatches: 0,
          followUpError: CONTACTS_GRANT_FIRST_UPDATE_FAILED_COPY,
        });
        navigateReplace('contacts-grant-code');
        return;
      }
      // I2: a cap reached in the race between the check above and the save is
      // a different fact from a relay that would not take the ack, and the
      // remedy is different too. The typed guard, not a regex over prose.
      throw new Error(isGrantCapError(err) ? CONTACTS_GRANT_AT_CAP_COPY : CONTACTS_GRANT_CONNECT_FAILED_COPY);
    }

    // Phase 2 — the app is paired. From here nothing deletes the grant.
    // B1/F1: any failure here is carried as `followUpError` rather than set
    // on `contactsGrantActionError` directly — it is applied only once the
    // pairing code check below finishes.
    let followUpError: string | undefined;
    try {
      const ops = await listContactOperationsV2(choice.directoryId, encryptionKey);
      const effective = resolveEffectiveDirectory([...applyOperations(ops).values()], {
        ...directory.context, creatingActorRole: undefined,
      });
      // R-24: one stamp from the shared per-grant chain, used for `issuedAt`
      // and `frontier.publishedAt`; the publisher draws its own for the
      // event's `created_at`.
      const issuedAt = nextProjectionStamp(grantId);
      const projection = buildContactProjection({
        grantId, capabilities: choice.capabilities, contacts: contactsForGrant(grant, effective, ops),
        frontier: {
          maxClock: 0, opCount: 0,
          publishedAt: issuedAt, deviceId: grantId,
        },
        appLabels: {},
        issuedAt, maxStalenessSeconds: choice.maxStalenessSeconds,
      });
      const res = await publishProjectionForGrant(
        grant, projection, contactsGrantPublishTargets(grant, relays.write),
      );
      // R-22: a scoped read-modify-write, not a whole-row overwrite — and no
      // `updatedAt` bump (I3), because publish state is device-local
      // bookkeeping rather than a user-meaningful edit the rail should win with.
      await updateContactGrantV2(grantId, encryptionKey, (current) => (current.revokedAt ? null : {
        ...current,
        ...(res.ok ? { lastProjectionHash: res.hash, lastProjectionAt: issuedAt } : {}),
        lastPublishState: res.state,
      }));
      if (!res.ok) followUpError = CONTACTS_GRANT_FIRST_UPDATE_FAILED_COPY;
    } catch {
      // The grant stands. Say what did not happen rather than implying the
      // connection failed — the publisher retries on the next change, and the
      // connected-apps list carries `lastPublishState` besides.
      followUpError = CONTACTS_GRANT_FIRST_UPDATE_FAILED_COPY;
    }

    setPendingContactsGrantV2(null);
    bumpContactsGrantSet();
    setContactsGrantCodeCheck({
      grantId, appName: req.appName,
      input: { appPubkey: req.appPubkey, challenge: req.challenge, grantId, railPubkey: rail.publicKey },
      mismatches: 0,
      ...(followUpError ? { followUpError } : {}),
    });
    navigateReplace('contacts-grant-code');
  }, [
    pendingContactsGrantV2, identity, encryptionKey, preferences, dependants,
    contactGrantDirectories, contactsGrantDirectoryOptions, navigateReplace, bumpContactsGrantSet,
  ]);

  const handleDenyContactsGrantV2 = useCallback(() => {
    setPendingContactsGrantV2(null);
    navigateReplace('companion-apps');
  }, [navigateReplace]);

  /**
   * B1/F1: apply a finished pairing-code check's teardown error (if any) and
   * clear the state. Shared by `handleContactsGrantCodeDone` (every in-page
   * exit) and the popstate-recovery effect below (browser/hardware back,
   * which skips the page entirely — see finding 3), so the error is applied
   * exactly once no matter which path leaves the page.
   */
  const applyContactsGrantCodeExit = useCallback((check: ContactsGrantCodeCheck) => {
    if (check.followUpError) setContactsGrantActionError(check.followUpError);
    setContactsGrantCodeCheck(null);
  }, []);

  /**
   * B1/F1: every way off the pairing-code check page — match+Done,
   * second-mismatch-disconnected+Done, Keep it, a successful not-showing
   * Disconnect, and Back/leave (wired the same as Keep it by the render
   * below) — funnels through here. The teardown-path error the approval
   * handler carried is applied now, not on arrival, because the page-leave
   * effect above clears `contactsGrantActionError` on every page that is not
   * `companion-apps`, which would have wiped it immediately had it been set
   * before this navigation.
   */
  const handleContactsGrantCodeDone = useCallback(() => {
    if (contactsGrantCodeCheck) applyContactsGrantCodeExit(contactsGrantCodeCheck);
    navigateReplace('companion-apps');
  }, [contactsGrantCodeCheck, applyContactsGrantCodeExit, navigateReplace]);

  /** Finding 1: the mismatch count lives here, not in the page — a remount
   *  after an auto-lock must not hand back tries already used. */
  const handleContactsGrantCodeMismatch = useCallback(() => {
    setContactsGrantCodeCheck((prev) => (prev ? { ...prev, mismatches: prev.mismatches + 1 } : prev));
  }, []);

  /** A match survives a remount too — see `ContactsGrantCodeCheck.matched`. */
  const handleContactsGrantCodeMatch = useCallback(() => {
    setContactsGrantCodeCheck((prev) => (prev ? { ...prev, matched: true } : prev));
  }, []);

  /**
   * Finding 3: browser/hardware back goes through popstate (`setPage`
   * directly — see `useNavigation.ts`), which skips `handleContactsGrantCodeDone`
   * entirely: `followUpError` is lost, `contactsGrantCodeCheck` is left set,
   * and Forward can re-enter the page (the render guard below only checks
   * that the state is gone). This is the fallback: whenever `page` has moved
   * off `'contacts-grant-code'` while the check is still set, it applies the
   * teardown error and clears the state, sharing `applyContactsGrantCodeExit`
   * with the in-page exit above so the error is applied exactly once.
   *
   * Guarded on `encryptionKey`: locking never itself changes `page` (nothing
   * calls `setPage` on lock), so this stays inert while locked regardless —
   * kept explicit anyway so a future change there can't silently wipe the
   * mismatch count finding 1 relies on surviving a lock.
   */
  useEffect(() => {
    if (page === 'contacts-grant-code') return;
    if (!contactsGrantCodeCheck) return;
    if (!encryptionKey) return;
    applyContactsGrantCodeExit(contactsGrantCodeCheck);
  }, [page, contactsGrantCodeCheck, encryptionKey, applyContactsGrantCodeExit]);

  /**
   * Revoke a contacts v2 grant.
   *
   * B-Critical (whole-branch review B), resolved by R-31: the tombstone is
   * built from the GRANT ROW ALONE — grant id, capabilities, rail key, relay.
   * It used to re-derive the directory's owner persona from live roster state,
   * which returns null in at least three reachable states (the dependant has
   * since been removed, `dependants` has not finished loading, the record has
   * no persona slot) — and the handler then took a bare `return` AFTER the row
   * was already stamped `revokedAt`, so the owner was told the app was
   * disconnected while no tombstone was ever published. R-31 took `ownerPubkey`
   * off the wire entirely, so there is nothing left to re-derive and no path
   * out of this handler between "revoked locally" and "tombstone attempted".
   *
   * The LOCAL record is stamped first and the tombstone published second: the
   * local row is the authority for "stop publishing", so a relay that cannot
   * be reached must never leave the grant live. The publish is awaited inside
   * its own guard for the same reason — the grant is already revoked by then,
   * and the consumer's own staleness window bounds how long it keeps trusting
   * what it already holds, which is exactly what the approval screen says out
   * loud. The registry rail republishes on its own, because `revokedAt` makes
   * the merged registry strictly richer (R-25).
   */
  const handleRevokeContactsGrantV2 = useCallback(async (grantId: string) => {
    if (!encryptionKey) return;
    setContactsGrantActionError(null);
    try {
      const nowS = Math.floor(Date.now() / 1000);
      let didRevoke = false;
      const revoked = await updateContactGrantV2(grantId, encryptionKey, (current) => {
        if (current.revokedAt) return null;
        didRevoke = true;
        // `updatedAt` IS bumped here: a revocation is the most user-meaningful
        // edit a grant ever gets, and it has to win the rail's last-writer race.
        return { ...current, revokedAt: nowS, updatedAt: Date.now() };
      });
      if (!revoked || !didRevoke) return;
      await ownerInviteService.disableAppInvites(grantId, nowS).catch(() => {});
      bumpContactsGrantSet();
      bumpContactsSafety(`revoke:${grantId}`);

      const relays = resolveSyncRelays(preferences, DEFAULT_RELAY_URL);
      const targets = contactsGrantPublishTargets(revoked, relays.write);
      try {
        await publishProjectionForGrant(
          revoked,
          buildRevocationProjection(
            grantId,
            revoked.capabilities,
            nextProjectionStamp(grantId, await liveProjectionStampFloor(revoked, targets)),
            tombstoneDeviceId(revoked, preferences.contactsDeviceId),
          ),
          targets,
        );
      } catch {
        // Guarded: the grant is already revoked locally, and a failed
        // tombstone must never read as a failed revocation.
      }
    } catch {
      setContactsGrantActionError(CONTACTS_GRANT_DISCONNECT_FAILED_COPY);
    }
  }, [encryptionKey, preferences, bumpContactsGrantSet, bumpContactsSafety, ownerInviteService]);

  /**
   * The pairing-code page's own revoke call. `handleRevokeContactsGrantV2`
   * above never throws — every failure path there sets
   * `contactsGrantActionError` (app state) and resolves normally, which
   * suits the connected-apps list's fire-and-forget disconnect button but
   * gives THIS caller no signal: a state update made inside the awaited call
   * is not visible through this closure until the next render. Success is
   * proven independently instead, by reading the row back and checking
   * `revokedAt` — throwing here (rather than returning a boolean) is what
   * lets the page's own retry-on-failure logic reuse the same shape as every
   * other action on this screen.
   */
  const revokeContactsGrantForCodeCheck = useCallback(async (grantId: string): Promise<void> => {
    await handleRevokeContactsGrantV2(grantId);
    const row = encryptionKey ? await getContactGrantV2(grantId, encryptionKey).catch(() => undefined) : undefined;
    if (!row?.revokedAt) throw new Error(CONTACTS_GRANT_DISCONNECT_FAILED_COPY);
  }, [handleRevokeContactsGrantV2, encryptionKey]);

  /**
   * B/I7: tombstone every matching active grant, best-effort, inside one
   * shared budget.
   *
   * Account deletion retracted public profiles but published no revocation
   * projections, and `purgeAllUserData` then dropped the rail keys — so
   * nothing could ever publish one afterwards, and a connected app went on
   * reading the last live projection (names, tiers, identity pubkeys,
   * methods) for up to its `maxStalenessSeconds` (seven days) after the
   * identity had been deleted. Removing a dependant had the same shape: its
   * grants were neither revoked nor listed as orphaned.
   *
   * `markRevoked` is what separates the two. A removed dependant's grant rows
   * SURVIVE the removal (nothing else deletes them), so they are stamped
   * `revokedAt` — otherwise the publisher would go on treating them as live
   * against a directory that no longer exists. On account deletion every row
   * is about to be purged, so stamping first would only be work.
   *
   * Nothing here throws, and the whole thing is bounded: the caller's own
   * budget must still expire on a relay that never answers, because the
   * destructive operation this precedes has to happen either way.
   */
  const tombstoneGrantsFor = useCallback(async (
    matches: (grant: AppGrantV2) => boolean,
    markRevoked: boolean,
  ): Promise<Array<Promise<unknown>>> => {
    if (!encryptionKey) return [];
    let active: AppGrantV2[];
    try {
      active = (await listContactGrantsV2(encryptionKey)).filter((g) => !g.revokedAt && matches(g));
    } catch {
      return [];
    }
    const relays = resolveSyncRelays(preferences, DEFAULT_RELAY_URL);
    const published: Array<Promise<unknown>> = [];
    for (const grant of active) {
      if (markRevoked) {
        const nowS = Math.floor(Date.now() / 1000);
        await updateContactGrantV2(grant.grantId, encryptionKey, (current) => (
          current.revokedAt ? null : { ...current, revokedAt: nowS, updatedAt: Date.now() }
        )).catch(() => { /* the tombstone below is still worth attempting */ });
      }
      const targets = contactsGrantPublishTargets(grant, relays.write);
      published.push((async () => {
        try {
          await publishProjectionForGrant(
            grant,
            buildRevocationProjection(
              grant.grantId,
              grant.capabilities,
              nextProjectionStamp(grant.grantId, await liveProjectionStampFloor(grant, targets)),
              tombstoneDeviceId(grant, preferences.contactsDeviceId),
            ),
            targets,
          );
        } catch { /* best-effort — the local record is already the authority */ }
      })());
    }
    return published;
  }, [encryptionKey, preferences]);

  /**
   * R-13: forget a REVOKED grant outright. Revoked rows are kept for audit by
   * default, but an owner who wants one gone can have it gone — and since the
   * cap counts active grants only, this is about tidiness, not headroom. A
   * live grant is never forgotten: deleting it would stop the publisher
   * without ever telling the app.
   */
  const handleForgetContactsGrantV2 = useCallback(async (grantId: string) => {
    if (!encryptionKey) return;
    setContactsGrantActionError(null);
    try {
      const grant = await getContactGrantV2(grantId, encryptionKey);
      if (!grant || !grant.revokedAt) return;
      await deleteContactGrantV2(grantId);
      bumpContactsGrantSet();
    } catch {
      setContactsGrantActionError(CONTACTS_GRANT_FORGET_FAILED_COPY);
    }
  }, [encryptionKey, bumpContactsGrantSet]);

  // Publish each active grant's projection on a contacts or grant change.
  useContactProjections({
    enabled: contactsV2GrantSurfaceEnabled,
    encryptionKey,
    relays: syncRelays,
    directories: contactGrantDirectories,
    deviceId: preferences.contactsDeviceId ?? null,
    changeToken: contactsChangeToken,
    safetyToken: contactsSafetyToken,
  });

  const contactsProposalScopedIds = useCallback(async (directoryId: string, grantId: string) => {
    if (!encryptionKey) return new Map<string, string>();
    const ops = await listContactOperationsV2(directoryId, encryptionKey);
    const grant = await getContactGrantV2(grantId, encryptionKey);
    const directory = contactGrantDirectories.find(d => d.directoryId === directoryId);
    if (!grant || !directory || grant.directoryId !== directoryId) return new Map<string, string>();
    const effective = resolveEffectiveDirectory([...applyOperations(ops).values()], directory.context);
    const scoped = contactsForGrant(grant, directory.ownerIdentityPubkeys?.includes(grant.ownerIdentityPubkey ?? '') ? effective : [], ops);
    const visible = buildContactProjection({ grantId, capabilities: grant.capabilities, contacts: scoped,
      frontier: { maxClock: 0, opCount: 0, deviceId: grantId, publishedAt: 1 }, issuedAt: 1,
      maxStalenessSeconds: grant.maxStalenessSeconds, appLabels: {},
    });
    const index = scopedIdIndex(grantId, scoped);
    return new Map(visible.contacts.map(c => [c.contactId, index.get(c.contactId)!]));
  }, [encryptionKey, contactGrantDirectories]);

  // Inbound app proposals. `grantsToken` is the grant SET version (R-35) — the
  // inbox subscribes per grant, so neither an ordinary contact edit nor a row
  // write (an app label the inbox itself just applied) may tear down and
  // rebuild every subscription.
  useContactProposals({
    enabled: contactsV2GrantSurfaceEnabled,
    encryptionKey,
    relays: syncRelays,
    grantsToken: String(contactsGrantsSetVersion),
    directoryScopedIds: contactsProposalScopedIds,
    onAddKen: handleProposedAddKen,
    onRenameAppLabel: handleProposedRenameAppLabel,
  });

  // R-2: the grant registry's own sealed rail, so a second device can publish
  // the same grant's projections. Never on a paired-child install.
  const { skippedRemote: contactsGrantsSkippedRemote, remoteState: contactsGrantsRemoteState } = useContactGrantsRail({
    publishExcludedDirectories: legacyExcludedDirectories,
    enabled: contactsV2GrantSurfaceEnabled,
    encryptionKey,
    backend: npBunkerBackend ?? nip07Backend ?? backends?.naturalPerson ?? null,
    relays: syncRelays,
    grantsVersion: contactsGrantsSetVersion,
    onMerged: bumpContactsGrantSet,
    onBackupStateChange: setContactsGrantsBackupState,
  });

  // The connected-apps list's own view of the registry. Re-read on every
  // grant-row change (approval, revoke, forget, a rail merge, a label the
  // inbox wrote). A failed read leaves the previous rows on screen rather
  // than blanking a list the owner may be part-way through acting on.
  const [contactsGrantRows, setContactsGrantRows] = useState<AppGrantV2[]>([]);
  useEffect(() => {
    if (!contactsV2GrantSurfaceEnabled || !encryptionKey) { setContactsGrantRows([]); return; }
    let cancelled = false;
    void listContactGrantsV2(encryptionKey)
      .then((rows) => { if (!cancelled) setContactsGrantRows(rows); })
      .catch(() => { /* keep what is on screen */ });
    return () => { cancelled = true; };
  }, [contactsV2GrantSurfaceEnabled, encryptionKey, contactsGrantRowsVersion]);

  /**
   * M4: a failed disconnect/forget is about the page the owner was on. Leaving
   * `companion-apps` clears it (and any half-open confirm), so returning later
   * does not re-present a stale failure as if it had just happened. The
   * approval handler sets the error and navigates TO this page in the same
   * commit, so its own warning survives.
   */
  useEffect(() => {
    if (page === 'companion-apps') return;
    setContactsGrantActionError(null);
    setContactsGrantConfirmId(null);
  }, [page]);

  /** One wrapper for both row actions: neither handler throws (each surfaces
   *  its own failure through `contactsGrantActionError`), so this only has to
   *  clear the confirm toggle and hold the busy marker. */
  const runContactsGrantAction = useCallback(async (
    grantId: string, action: (id: string) => Promise<void>,
  ) => {
    setContactsGrantConfirmId(null);
    setContactsGrantBusyId(grantId);
    try {
      await action(grantId);
    } finally {
      setContactsGrantBusyId(null);
    }
  }, []);

  // Contacts v2 relay rail. Single writer for contacts once `contactsV2Verified`
  // flips; until then the legacy rails above keep publishing too (R10).
  //
  // R8: NOT mounted on a paired-child install. The kid's own
  // `dependant:<id>` directory stays device-local this phase — the guardian's
  // family manager holds the authoritative dependant directory, and re-homing
  // the kid's own log is Phase E. A kid's self-added contacts are therefore
  // lost with the device until then; that is an accepted limitation.
  //
  // `backupState` is NOT destructured here — `contactsV2SingleWriter`
  // (consumed by the legacy rails ABOVE this mount) needs the current value
  // before this hook's own return value exists in this render, so
  // `onBackupStateChange` feeds the `contactsV2BackupState` state declared
  // near `contactsV2Verified` instead; that state is the one source of
  // truth this component reads (here for the banner too, further down).
  const { remoteState: contactsV2RemoteState } = useContactsV2Sync({
    publishExcludedDirectories: legacyExcludedDirectories,
    identity: isPairedChild ? null : identity,
    npBackend: npBunkerBackend ?? nip07Backend ?? backends?.naturalPerson ?? null,
    relays: syncRelays,
    encryptionKey,
    deviceId: preferences.contactsDeviceId ?? null,
    opsVersion: contactsV2Version,
    // R4: a counter bump is not a reload. Both hooks reseed their Lamport
    // clocks from the merged frontier; without this the next local mutation
    // would stamp a clock below what just arrived and lose every conflict
    // against it. `familyContacts` is only reloaded when it is actually loaded.
    onRemoteMerged: () => {
      void contactsV2.reload();
      if (familyLogEnabledNow) void familyContacts.reload();
    },
    onVerifiedChange: setContactsV2Verified,
    onBackupStateChange: setContactsV2BackupState,
  });

  // Post-restore re-pair prompt. The per-dependant endpoint
  // keypairs don't round-trip through the mnemonic, so every
  // paired child device is orphaned after the guardian restores onto
  // a new phone. Show a banner while ALL three hold:
  //   - a restore happened in the last 7 days (recent-restore marker)
  //   - the guardian has at least one dependant (synced cross-device)
  //   - no dependant has a bunkerEndpoint record
  const needsRepair = dependants.length > 0 && dependants.every(d => !d.bunkerEndpoint);
  const [showRepairBanner, setShowRepairBanner] = useState(false);
  useEffect(() => {
    if (!encryptionKey) { setShowRepairBanner(false); return; }
    // Re-check on every dependants change so the banner disappears the
    // moment the guardian pairs any one of them.
    setShowRepairBanner(hasRecentRestore() && needsRepair);
  }, [encryptionKey, needsRepair]);

  // Rate-limit notification. When the bunker server rate-limits a
  // dependant's sign requests, surface a banner so the guardian can
  // check whether the flood is benign (chatty app) or hostile
  // (compromised child device). Auto-dismisses after 5 minutes per
  // spec. Only the most-recent dependant-in-trouble is shown — a flood
  // across multiple dependants collapses to whichever fired last,
  // matching holodeck OQ8's serial-modal principle.
  const [rateLimitAlert, setRateLimitAlert] = useState<{ dependantId: string; name: string; firedAt: number } | null>(null);
  const rateLimitAutoDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (rateLimitAutoDismissRef.current) clearTimeout(rateLimitAutoDismissRef.current);
  }, []);

  // NIP-46 bunker server (Phase 2; per-dependant
  // routes added later).
  //
  // Off by default — users opt in via Security settings. When on, listens
  // for inbound sign_event requests and surfaces an approval modal (see
  // BunkerApprovalModal below).
  //
  // Routes list:
  // - Guardian route (always present when the server is enabled): identifies
  //   the PRIMARY keypair's pubkey — the persona for new identities and Lite
  //   imports, the natural person for existing real-name identities. See
  //   `resolveServerTransportBackend`: a generic pairing made while the real
  //   identity is dormant must never bind to the real-name pubkey.
  // - One dependant route per dependant that has a `bunkerEndpoint` keypair
  //   (generated via `ensureDependantBunkerEndpoint` when the guardian pairs
  //   a child device). Endpoint backend handles transport; a fresh
  //   `LocalSigningBackend` over the dependant's natural-person private key
  //   signs inner templates. Dependants lacking `bunkerEndpoint` are skipped
  //   — they simply don't have a paired device yet.
  const bunkerBackendForServer = resolveServerTransportBackend({
    primaryKeypair: identity?.primaryKeypair ?? 'natural-person',
    npBunkerBackend,
    personaBunkerBackend,
    nip07Backend,
    localNaturalPerson: backends?.naturalPerson ?? null,
    localPersona: backends?.persona ?? null,
  });

  // The NATURAL PERSON's own serving backend — the pre-§8 resolution, verbatim.
  // Two consumers, deliberately gated differently:
  //
  // - Audit publishing (ungated). Audit gift-wraps are addressed to, and
  //   decrypted with, the NP key: `GuardianActivityRoute` queries `#p` =
  //   `identity.naturalPerson.publicKey` and `guardianAuditBackend` decrypts
  //   with the NP route. Publishing to the persona would put every record where
  //   the Activity page can never find it, so audit does NOT follow
  //   `primaryKeypair`.
  // - The NP owner route below (gated on `npActive`). A dormant real identity
  //   gets no NP route — exactly as before §8 — but an ACTIVATED one keeps a
  //   persistent route even on a persona-primary install, so a client paired to
  //   the NP pubkey still resolves after a reload.
  const naturalPersonServingBackend = npBunkerBackend ?? nip07Backend ?? backends?.naturalPerson ?? null;

  const bunkerRoutes = useMemo(() => {
    const routes: BunkerRoute[] = [];
    // Owner-persona routes (NP + default Persona + extra personas +
    // Professional). The "Sign in with Signet" redirect-flow auto-pair
    // (#redirect-bunker) needs a NIP-46 listener for whichever keypair the
    // user picked at approval time. Each route is guardian-shape (transport
    // key === signing key, no dependantId). Extracted to a pure, tested
    // builder — see src/lib/persona-bunker-routes.ts.
    routes.push(
      ...buildOwnerPersonaRoutes(
        {
          primaryBackend: bunkerBackendForServer,
          naturalPersonBackend: npActive ? naturalPersonServingBackend : null,
          unlocked: !!encryptionKey,
          personaBackend: backends?.persona ?? null,
          extraPersonas: identity?.extraPersonas,
          professionalPersona: identity?.professionalPersona ?? null,
        },
        (priv) => new LocalSigningBackend(priv),
      ),
    );
    if (nostrConnectTransientRoute
        && !routes.some(r => r.pubkey.toLowerCase() === nostrConnectTransientRoute.pubkey.toLowerCase())) {
      routes.push(nostrConnectTransientRoute);
    }
    // Dependant routes — only once the user is unlocked (private keys must
    // be decrypted for LocalSigningBackend construction to succeed).
    if (encryptionKey) {
      for (const dep of dependants) {
        const slots = resolveDependantRouteSlots(dep);
        const endpoint = dep.bunkerEndpoint;
        const guarded = (backend: LocalSigningBackend, routeKind: 'device' | 'app') => contactPolicySigningBackend(backend, async (peer, signer) => {
          const guardian = identity?.naturalPerson.publicKey;
          const current = () => encryptionKeyRef.current === encryptionKey && identityRef.current?.naturalPerson.publicKey === guardian;
          if (!guardian || !current()) return 'deny';
          const fresh = (await loadFreshDependants(encryptionKey)).find(row => row.id === dep.id && row.guardianPubkey === guardian);
          const oldEndpoint = routeKind === 'device' ? dep.bunkerEndpoint : dep.appBunkerEndpoint;
          const freshEndpoint = routeKind === 'device' ? fresh?.bunkerEndpoint : fresh?.appBunkerEndpoint;
          if (!fresh || !oldEndpoint || freshEndpoint?.publicKey !== oldEndpoint.publicKey
            || (routeKind === 'device' && fresh.bunkerEndpoint?.authorizedClientPubkey !== dep.bunkerEndpoint?.authorizedClientPubkey)
            || !resolveDependantRouteSlots(fresh)?.addressableSlots.some(slot => slot.publicKey === signer)) return 'deny';
          const result = await storedContactInviteDecision(peer, encryptionKey, {
            directoryId: `dependant:${dep.id}`, settings: await getChildSettings(dep.id), activeGuardianPubkeys: [guardian],
          });
          return current() ? result : 'deny';
        });
        // I4: a route whose DEFAULT slot cannot sign answers get_public_key and
        // then fails every signature, so skip the dependant outright — both
        // halves — before constructing any backend. This used to depend on
        // `new LocalSigningBackend('')` throwing inside the try/catch below,
        // which dropped the device and app routes silently and by accident.
        const routable = !!slots && slots.defaultSlotSignable;
        if (routable && slots && endpoint?.publicKey && endpoint?.privateKey) {
          try {
            // Per-persona signing-backend resolver — §5.4.1 publicProfile
            // pre-auth needs to sign kind-0 as the right slot. A DORMANT real
            // identity is absent from `addressableSlots`, so the resolver
            // returns null for it and the bunker falls back to manual approval
            // rather than signing under a key the guardian has not activated.
            const defaultBackend = guarded(new LocalSigningBackend(slots.defaultSlot.privateKey), 'device');
            const personaBackends = new Map<string, ReturnType<typeof guarded>>();
            for (const s of slots.addressableSlots) {
              if (s.publicKey.toLowerCase() === slots.defaultSlot.publicKey.toLowerCase()) {
                personaBackends.set(s.publicKey.toLowerCase(), defaultBackend);
                continue;
              }
              try { personaBackends.set(s.publicKey.toLowerCase(), guarded(new LocalSigningBackend(s.privateKey), 'device')); } catch { /* skip slot */ }
            }
            routes.push({
              pubkey: endpoint.publicKey,
              backend: new LocalSigningBackend(endpoint.privateKey),
              signingBackend: defaultBackend,
              dependantId: dep.id,
              autonomyStage: dep.autonomyStage,
              defaultSchedule: dep.defaultSchedule,
              pairingSecret: endpoint.pairingSecret,
              authorizedClientPubkey: endpoint.authorizedClientPubkey,
              routeKind: 'device',
              personaSigningBackendByPubkey: (eventPubkey) =>
                personaBackends.get(eventPubkey.toLowerCase()) ?? null,
            });
          } catch {
            // Malformed private keys for this dependant — skip rather than
            // failing the entire guardian bunker.
          }
        }
        // App-bunker route — additive, not replacement. Allows
        // third-party apps to act-as-dependant without evicting the
        // child's own paired device. Pairings live in
        // dep.appBunkerEndpoint.pairings; the per-request gate consults
        // IDB on each inbound request via listAppBunkerPairings.
        const appEndpoint = dep.appBunkerEndpoint;
        if (routable && slots && appEndpoint?.publicKey && appEndpoint?.privateKey) {
          try {
            routes.push({
              pubkey: appEndpoint.publicKey,
              backend: new LocalSigningBackend(appEndpoint.privateKey),
              signingBackend: guarded(new LocalSigningBackend(slots.defaultSlot.privateKey), 'app'),
              dependantId: dep.id,
              autonomyStage: dep.autonomyStage,
              defaultSchedule: dep.defaultSchedule,
              pairingSecret: appEndpoint.pairingSecret,
              routeKind: 'app',
            });
          } catch {
            // Malformed private keys — skip this app endpoint, leave
            // the device endpoint above intact.
          }
        }
      }
    }
    return routes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bunkerBackendForServer, naturalPersonServingBackend, npActive, dependants, encryptionKey, backends, identity, nostrConnectTransientRoute]);
  // Subscription is live for dependant reachability (guardian approval must
  // work whenever the app is open) OR while an owner serve session is armed.
  // Owner-route requests are additionally gated per-request on the session
  // (isOwnerServingActive below); dependant routes are always served.
  const hasDependantRoutes = bunkerRoutes.some((r) => !!r.dependantId);
  // Native: handles for which we posted a "needs approval" local notification,
  // so we can cancel each one once its approval leaves the pending queue
  // (resolved in-app, or dropped when serving stops). Cancelling an id that was
  // never posted or already dismissed is a harmless no-op.
  const notifiedApprovalHandlesRef = useRef<Set<number>>(new Set());
  const { pendingApproval: bunkerPendingApproval, pendingApprovals: bunkerPendingApprovals, approveOnce: bunkerApproveOnce, approveAlways: bunkerApproveAlways, deny: bunkerDeny, serveStatus: bunkerServeStatus } = useBunkerServer({
    // Subscription live when dependant routes exist (guardian approval must
    // work whenever the app is open) OR while an owner serve session is armed.
    // Owner-route requests are gated per-request via isOwnerServingActive.
    enabled: bunkerServerEnabled && !!encryptionKey && (hasDependantRoutes || stayAwakeUntil !== null || backgroundServing),
    // Owner serving is time-boxed (stay-awake) or always-on (native background):
    // read live (via ref) at request time.
    isOwnerServingActive: () => backgroundServingRef.current || (stayAwakeUntilRef.current !== null && Date.now() < stayAwakeUntilRef.current),
    reconnectNonce: bunkerReconnectNonce,
    relayUrl: nostrConnectServeRelayUrl ?? preferences.relayUrl ?? DEFAULT_RELAY_URL,
    routes: bunkerRoutes,
    onApprovalPending: (entry) => {
      // Native: raise a local notification when the app isn't visible —
      // the screen-off guardian must learn a human decision is needed.
      // Foregrounded, the in-app modal is already showing; skip the banner.
      if (!isNativeApp() || document.visibilityState === 'visible') return;
      const who = entry.route.dependantId
        ? (dependants.find(d => d.id === entry.route.dependantId)?.displayName ?? 'Your child')
        : entry.client.appName;
      notifiedApprovalHandlesRef.current.add(entry.handle);
      void LocalNotifications.schedule({
        notifications: [{
          id: entry.handle,
          channelId: 'signet-requests',
          title: `${who} needs an approval`,
          body: entry.description,
          smallIcon: 'ic_stat_signet',
        }],
      }).catch(() => { /* permission denied / not granted yet — non-fatal */ });
    },
    onPairingComplete: async (dependantId, clientPubkey) => {
      // Lock-during-bind: if the encryption key was nulled between the
      // secret check (in useBunkerServer) and now, we can't persist the
      // pairing. Throw so the dispatcher refuses to ACK the connect
      // rather than ACK-without-persist (silent lie that breaks every
      // subsequent request from this client with 'not paired'). Matches
      // the app-pairing callback below; previously silently `return`-ed,
      // which was the root cause of a bug where a kid's app
      // stored a PairedChildRecord and considered itself paired, but
      // guardian's `authorizedClientPubkey` was never written, breaking
      // every downstream feature that gates on the bound client.
      if (!encryptionKey) throw new Error('locked');
      await bindDependantBunkerClient(dependantId, clientPubkey, encryptionKey);
    },
    onAppPairingComplete: async (dependantId, clientPubkey, label, origin) => {
      // Lock-during-bind: if the encryption key was nulled between the
      // secret check (in useBunkerServer) and now, we cannot persist the
      // pairing. Throw so the dispatcher surfaces an error to the
      // consumer rather than ACK-without-persist (silent lie that breaks
      // every subsequent request from this client with 'not paired').
      if (!encryptionKey) throw new Error('locked');
      // Append to the dependant's appBunkerEndpoint.pairings AND clear
      // the in-flight pairing secret in a SINGLE saveDependant write
      // (TOCTOU fix). Splitting the two writes leaves a window
      // where the just-used secret is still valid in IDB and a second
      // concurrent connect from a different clientPubkey could pass
      // the secret check and consume an extra slot. The
      // bindingInFlightRef in useBunkerServer only covers this call's
      // duration — it does NOT span the gap between two writes.
      // Bubbles up as Error('pairing slot limit reached') on cap; the
      // dispatcher surfaces it to the consumer as the NIP-46 error.
      const now = Math.floor(Date.now() / 1000);
      await dbAddAppBunkerPairingAndClearSecret(dependantId, {
        clientPubkey: clientPubkey.toLowerCase(),
        label,
        origin,
        pairedAt: now,
        lastSeenAt: now,
      }, encryptionKey);
      await reloadDependants();
    },
    appPairingsEncryptionKey: encryptionKey ?? null,
    pendingAuthPairingsRef,
    onAuthFlowPairingComplete: async ({ clientPubkey, appName, origin }) => {
      // Persist the connecting client with allowAlways: true. The user
      // already authorised this app via the redirect-flow approval
      // screen, so it'd be redundant to prompt them again on first
      // sign_event. The standard Connections settings page exposes
      // a Revoke button that flips allowAlways back off (or deletes the
      // record entirely) if they change their mind.
      const now = Math.floor(Date.now() / 1000);
      await saveConnectedClient({
        clientPubkey: clientPubkey.toLowerCase(),
        appName,
        appUrl: origin,
        connectedAt: now,
        lastSeenAt: now,
        allowAlways: true,
      });
    },
    onAuditEvent: (params) => {
      // Publish asynchronously — audit must never block the signing flow
      // that triggered it. Failure is logged by returning false from
      // publishAuditEvent; the caller's try/catch here swallows throws.
      const guardianPubkey = naturalPersonServingBackend?.activePublicKeyHex;
      const relayUrl = preferences.relayUrl ?? DEFAULT_RELAY_URL;
      if (!naturalPersonServingBackend || !guardianPubkey) return;

      // Dual-address gift-wrap (v2). When audit
      // visibility resolves to true for the dep AND the dep has an
      // active paired-child binding (so there's an actual recipient
      // pubkey to address), pass the child's NIP-46 client pubkey
      // through. The publisher emits a SECOND wrap addressed there.
      // We use `bunkerEndpoint.authorizedClientPubkey` (the child's
      // OWN paired device), NOT `appBunkerEndpoint` (which is for
      // trusted apps like Fathom — those clients aren't the dep).
      let childClientPubkey: string | undefined;
      const dep = dependants.find(d => d.id === params.dependantPubkey);
      if (dep) {
        const visible = resolveAuditVisibility(dep.autonomyStage, dep.auditVisibility);
        if (visible) {
          childClientPubkey = dep.bunkerEndpoint?.authorizedClientPubkey;
        }
      }

      publishAuditEvent(params, guardianPubkey, naturalPersonServingBackend, relayUrl, childClientPubkey).catch(() => {
        // Non-fatal — auditing is secondary. A dropped audit record does
        // not break the child's sign flow.
      });
    },
    onGrantMutated: () => {
      // Refresh local grants state so useGrantsSync's debounced publish
      // picks up the change. Non-blocking — a miss here just delays sync
      // until the next mutation.
      reloadGrants();
    },
    onRateLimit: (dependantId) => {
      // Rate-limit notification UI. Debounced at the hook layer (once per 60s
      // window), so a flood produces one banner, not 600. Look up the
      // dependant name at fire time — if the record is gone we still
      // surface a generic fallback so the guardian knows something fired.
      const dep = dependants.find(d => d.id === dependantId);
      const name = dep?.displayName ?? 'A paired child device';
      setRateLimitAlert({ dependantId, name, firedAt: Date.now() });
      if (rateLimitAutoDismissRef.current) clearTimeout(rateLimitAutoDismissRef.current);
      rateLimitAutoDismissRef.current = setTimeout(() => {
        setRateLimitAlert(null);
        rateLimitAutoDismissRef.current = null;
      }, 5 * 60 * 1000);
    },
  });

  // NIP-55: requests from other apps on this phone (Amethyst, KithMoot,
  // anything Amber-shaped), served by the same owner-persona backends the
  // NIP-46 server signs with, decided by the table in src/lib/nip55.ts.
  // Native only; the web bundle never registers a listener.
  const nip55 = useNip55Server({
    enabled: isNativeApp(),
    routes: bunkerRoutes,
    locked: !encryptionKey,
    activePubkey: activePubkey ?? null,
    onNeedsUnlock: () => { setAuthPromptContext(undefined); setShowAuthPrompt(true); },
    onServed: () => { phoneAppsUntilRef.current = Date.now() + PHONE_APPS_WINDOW_MS; },
  });
  // The remembered NIP-55 decisions, as the Connected Sites page lists them; grants keep milliseconds, the page reads seconds.
  const phoneApps = useMemo<PhoneApp[]>(() => Object.entries(nip55.grants)
    .map(([packageName, g]) => ({ packageName, label: g.label ?? null, pubkey: g.pubkey, allowAlways: g.allowAlways, denyAlways: g.denyAlways, grantedAt: Math.floor(g.grantedAt / 1000) }))
    .sort((a, b) => b.grantedAt - a.grantedAt), [nip55.grants]);
  const nip55Identities = useMemo(() => {
    if (!identity) return [];
    // Persona first, and the real identity only once activated — same rule as
    // the NIP-46 server: a dormant real identity has no owner route, so it can
    // never be the key another app on this phone signs with.
    const out = [{ pubkey: identity.persona.publicKey.toLowerCase(), label: identity.persona.displayName || 'Persona' }];
    if (npActive) {
      out.push({ pubkey: identity.naturalPerson.publicKey.toLowerCase(), label: identity.naturalPerson.displayName || 'Real identity' });
    }
    for (const ep of identity.extraPersonas ?? []) if (ep.publicKey) out.push({ pubkey: ep.publicKey.toLowerCase(), label: ep.displayName });
    if (identity.professionalPersona?.publicKey) out.push({ pubkey: identity.professionalPersona.publicKey.toLowerCase(), label: identity.professionalPersona.displayName || 'Professional' });
    const owned = new Set(bunkerRoutes.filter(r => !r.dependantId).map(r => r.pubkey.toLowerCase()));
    return out.filter((id, i) => owned.has(id.pubkey) && out.findIndex(o => o.pubkey === id.pubkey) === i);
  }, [identity, npActive, bunkerRoutes]);
  const bunkerServeStatusRef = useRef(bunkerServeStatus);
  bunkerServeStatusRef.current = bunkerServeStatus;

  // Native: cancel the "needs an approval" notification once its request leaves
  // the pending queue — the guardian resolved it in-app (approve/deny) or it
  // was dropped when serving stopped. Without this a stale banner lingers in
  // the shade after the decision is already made.
  useEffect(() => {
    if (!isNativeApp()) return;
    const tracked = notifiedApprovalHandlesRef.current;
    if (tracked.size === 0) return;
    const stillPending = new Set(bunkerPendingApprovals.map((a) => a.handle));
    const toCancel: number[] = [];
    tracked.forEach((handle) => {
      if (!stillPending.has(handle)) { toCancel.push(handle); tracked.delete(handle); }
    });
    if (toCancel.length > 0) {
      void LocalNotifications.cancel({ notifications: toCancel.map((id) => ({ id })) }).catch(() => { /* already dismissed — no-op */ });
    }
  }, [bunkerPendingApprovals]);

  const armNostrConnectServe = useCallback(async (
    routePubkey: string,
    relayUrl: string,
    timeoutMs: number = NOSTRCONNECT_SINGLE_RELAY_OPEN_TIMEOUT_MS,
  ) => {
    const until = computeStayAwakeUntil(Date.now(), NOSTRCONNECT_SERVE_MINUTES);
    setNostrConnectServeRelayUrl(relayUrl);
    if (nostrConnectServeRelayClearTimerRef.current) {
      clearTimeout(nostrConnectServeRelayClearTimerRef.current);
      nostrConnectServeRelayClearTimerRef.current = null;
    }
    nostrConnectServeRelayClearTimerRef.current = setTimeout(() => {
      nostrConnectServeRelayClearTimerRef.current = null;
      setNostrConnectServeRelayUrl(current => current === relayUrl ? null : current);
      clearNostrConnectTransientRoute(routePubkey);
    }, NOSTRCONNECT_SERVE_MINUTES * 60_000 + 5_000);
    setStayAwakeUntil(prev => (prev !== null && prev > until ? prev : until));
    if (!bunkerServerEnabled) await setBunkerServerEnabled(true);

    const target = routePubkey.toLowerCase();
    const targetRelay = relayUrl.toLowerCase();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = bunkerServeStatusRef.current;
      if (
        status.phase === 'open'
        && status.relayUrl?.toLowerCase() === targetRelay
        && status.routePubkeys.some(pk => pk.toLowerCase() === target)
      ) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`listener not ready (${formatNostrConnectServeStatus(
      bunkerServeStatusRef.current,
      relayUrl,
      routePubkey,
    )})`);
  }, [bunkerServerEnabled, setBunkerServerEnabled, clearNostrConnectTransientRoute]);

  useEffect(() => () => {
    if (nostrConnectServeRelayClearTimerRef.current) {
      clearTimeout(nostrConnectServeRelayClearTimerRef.current);
      nostrConnectServeRelayClearTimerRef.current = null;
    }
  }, []);

  const effectivePrimaryKeypair = activeDependant
    ? activeDependant.primaryKeypair
    : (pendingKeypairSwitch ?? identity?.primaryKeypair);

  const isExtraPersonaActive = !!effectivePrimaryKeypair
    && effectivePrimaryKeypair !== 'natural-person'
    && effectivePrimaryKeypair !== 'persona';

  const rawActiveBackend: SigningBackend | null = !activeDependant
    && isImportedGuardianPersona(identity, effectivePrimaryKeypair)
    ? extraBackend
    : (bunkerBackend && !activeDependant)
    ? (isExtraPersonaActive
        ? (bunkerRouter?.backendFor(effectivePrimaryKeypair)
            ?? extraBackend
            ?? null)
        : effectivePrimaryKeypair === 'persona'
          // Persona: routed slot, else the local persona key (pre-strip);
          // never the primary — on the family bunker that's the master, and
          // on a legacy NP-only bunker it's the NP, neither is the persona.
          ? (bunkerRouter?.backendFor(identity?.persona.publicKey)
              ?? backends?.persona
              ?? null)
          // NP is a DERIVED persona on the family bunker — never the
          // master-bound primary (an earlier hardware finding); see npBunkerBackend.
          : npBunkerBackend)
    : (nip07Backend && !activeDependant)
      ? nip07Backend
      : isExtraPersonaActive && extraBackend
        ? extraBackend
        : backends
          ? (effectivePrimaryKeypair === 'persona' ? backends.persona : backends.naturalPerson)
          : null;

  const rawNpBackend: SigningBackend | null = (bunkerBackend && !activeDependant)
    ? npBunkerBackend
    : (nip07Backend && !activeDependant)
      ? nip07Backend
      : backends?.naturalPerson
      ?? null;

  const handoffBunkerUriForBackend = useCallback((backend: SigningBackend): string | undefined => {
    return runtimeBunkerUriForBackend(backend, bunkerBackend, preferences);
  }, [bunkerBackend, preferences.signingMode, preferences.bunkerUri]);

  const resolveBunkerHandoffUri = useCallback(async (
    backend: SigningBackend,
    selection: AuthSelection,
    signingPubkey: string,
  ): Promise<string | undefined> => {
    const runtimeUri = handoffBunkerUriForBackend(backend);
    if (runtimeUri) return runtimeUri;

    // Heartwood onboarding persists signingMode/bunkerUri directly to IDB
    // before the preferences hook necessarily re-renders. When an approval
    // lands in that window, fall back to fresh persisted prefs so the brokered
    // auth response can still hand the consumer the live hardware signer URI.
    const stateUri = storedBunkerUriForGuardianNaturalPerson(selection, signingPubkey, identity, preferences);
    if (stateUri) return stateUri;

    try {
      // M1: bunkerUri is encrypted at rest — pass the key so this fallback
      // gets a usable URI, not ciphertext.
      const freshPrefs = await getPreferences(encryptionKey ?? undefined);
      return storedBunkerUriForGuardianNaturalPerson(selection, signingPubkey, identity, freshPrefs);
    } catch {
      // Plain auth still works if IDB is temporarily unavailable.
    }
    return undefined;
  }, [
    handoffBunkerUriForBackend,
    identity,
    encryptionKey,
    preferences.activeAccountId,
    preferences.signingMode,
    preferences.bunkerUri,
  ]);

  const authResponseCredentialForSigner = useCallback((
    request: AuthRequest | LoginRequest,
    signingPubkey: string,
  ): AuthResponse['credential'] | undefined => {
    if (request.type !== 'signet-login-request') return undefined;
    const selected = pickCredentialForSubject(
      credentials,
      request,
      signingPubkey,
      Math.floor(Date.now() / 1000),
    );
    if (!selected) return undefined;
    const parsed = parseStoredCredentialEvent(selected);
    if (!parsed || parsed.pubkey.toLowerCase() !== signingPubkey.toLowerCase()) return undefined;
    return parsed;
  }, [credentials]);

  const authSelectionLabel = useCallback((selection: AuthSelection): string => {
    return selection.source === 'guardian'
      ? selection.keypairType
      : `dependant:${selection.dependantId}:${selection.keypairType}`;
  }, []);

  const npBackend = rawNpBackend;
  const activeBackend = rawActiveBackend;

  /**
   * Guardian's NIP-44 decrypt backend, kept independent of dependant
   * activation so `useAuditLog` works while viewing a child's settings.
   * Audit gift-wraps are addressed to the guardian's pubkey; without this,
   * `npBackend` would point at the dependant's NP whenever a dependant is
   * active and decrypt would silently return empty.
   *
   * Falls back to a fresh LocalSigningBackend over the guardian's NP
   * private key when no remote signer is connected. Returns null when the
   * guardian's key isn't available locally (e.g. bunker mode without a
   * connected signer) — the audit page surfaces this as a load error.
   */
  const guardianAuditBackend = useMemo<DecryptingSigningBackend | null>(() => {
    if (npBunkerBackend) return npBunkerBackend; // NP route, never the master-bound primary
    if (nip07Backend) return nip07Backend;
    if (identity && !identity.encrypted && isValidHexKey(identity.naturalPerson.privateKey)) {
      return new LocalSigningBackend(identity.naturalPerson.privateKey);
    }
    return null;
  }, [npBunkerBackend, nip07Backend, identity]);

  // "Family asks" inbox (C4/C5) — parked-approval + petition notices a
  // Heartwood-connected guardian device has published for itself. Gated on
  // the same "Heartwood-connected guardian surface" shape as the rest of
  // the bunker UI: mnemonic gone (Heartwood connect deletes it), a bunker
  // signer connected, unlocked, and not currently viewing as a dependant.
  const escalationsEnabled = !identity?.mnemonic && !!bunkerBackend && !!encryptionKey && !activeDependant;

  // Resolve an escalation notice's `identityPubkey` (the dependant slot the
  // parked/petitioned request would sign as) to a display name. Checks the
  // dependant's NP (== `id`), persona, and extra-persona pubkeys — mirrors
  // the `dependantNameFor` lookup passed to BunkerPanel below, but keyed on
  // a raw pubkey rather than a dependant id since escalation notices don't
  // carry the dependant id itself.
  const resolveEscalationIdentityName = useCallback((identityPubkey: string): string | undefined => {
    const pk = identityPubkey.toLowerCase();
    for (const dep of dependants) {
      if (dep.naturalPerson.publicKey.toLowerCase() === pk) return dep.displayName;
      if (dep.persona.publicKey.toLowerCase() === pk) return dep.displayName;
      if ((dep.extraPersonas ?? []).some((ep) => ep.publicKey.toLowerCase() === pk)) return dep.displayName;
    }
    return undefined;
  }, [dependants]);

  // Native nudge — fired by the hook itself, ONLY for a genuinely-new LIVE
  // notice (never the backlog; see useEscalations.ts's header comment for
  // why that decision lives inside the hook rather than as an App-level
  // "have I seen this id before" baseline: the hook re-seeds its knowledge
  // of what's backlog vs. live on every effect re-run, so it stays correct
  // across a mid-session relay-URL edit or Heartwood reconnect, not just
  // across enable/disable). Distinct id range from the pending-approval
  // notifications above (`entry.handle`, small sequential ints) so the two
  // notification id spaces can't collide.
  const handleLiveEscalationNotice = useCallback((notice: EscalationNotice) => {
    if (notice.kind !== 'approval' || !isNativeApp()) return;
    const name = resolveEscalationIdentityName(notice.identityPubkey) ?? notice.identityPubkey.slice(0, 8);
    void LocalNotifications.schedule({
      notifications: [{
        id: ESCALATION_NOTIFICATION_ID_BASE + (hashToUint32(notice.id) % ESCALATION_NOTIFICATION_ID_RANGE),
        channelId: 'signet-requests',
        title: `${name} is waiting for a sign-in approval`,
        body: 'Open Signet to review it.',
        smallIcon: 'ic_stat_signet',
      }],
    }).catch(() => { /* permission denied / not granted yet — non-fatal */ });
  }, [resolveEscalationIdentityName]);

  const escalations = useEscalations({
    relayUrl: preferences.relayUrl ?? DEFAULT_RELAY_URL,
    guardianPubkey: identity?.naturalPerson.publicKey,
    backend: guardianAuditBackend,
    enabled: escalationsEnabled,
    onLiveNotice: handleLiveEscalationNotice,
  });

  // Heartwood operator key + kind-24134 management client (C3, family-bunker
  // §11.1.4/9). Loaded on unlock, stopped on lock by the hook itself (the
  // `enabled`/`encryptionKey` flip is the same trigger as the lock effect
  // below). NEVER on a paired-child install — the operator key manages the
  // FAMILY device and has no business on the kid's phone; the kid's own
  // signing goes through its NIP-46 client, not the operator channel.
  const operatorEnabled = !!encryptionKey && preferences.signingMode !== 'paired-child';
  const heartwoodOperator = useHeartwoodOperator({ encryptionKey, enabled: operatorEnabled });

  // C3 policy push: whenever dependants / grants change (or the client
  // comes up), debounce and push each changed family slot's compiled
  // policy to the device. `grantsForSync` is the live set incl. tombstones.
  const policyPush = usePolicyPush({
    client: heartwoodOperator.client,
    enabled: operatorEnabled,
    encryptionKey,
    signingMode: preferences.signingMode,
    dependants,
    grants: grantsForSync,
  });

  // C4 verdict leg — `resolve_approval` for a parked "Family asks" row.
  // Single stale-challenge retry lives in `submitVerdict`. Requires the
  // notice to carry a park id (petitions don't — the panel never offers
  // Approve/Deny on those).
  const handleEscalationVerdict = useCallback(async (notice: EscalationNotice, action: PanelVerdictAction) => {
    const c = heartwoodOperator.client;
    if (!c) throw new Error('Operator key not loaded — Settings → Advanced → Heartwood operator key');
    if (!notice.parkId) throw new Error('This ask carries no park id — nothing to resolve');
    return submitVerdict({ resolveApproval: (p) => mgmtResolveApproval(c, p) }, notice.parkId, action);
  }, [heartwoodOperator.client]);
  const verdictAvailability = resolveVerdictAvailability(!!heartwoodOperator.credential, heartwoodOperator.status);
  const forgetHeartwoodOperator = heartwoodOperator.forget;

  // A Sapwood handoff link scanned from the carousel lands here and is
  // handed to the Advanced-settings import card pre-filled.
  const [pendingOperatorImportText, setPendingOperatorImportText] = useState<string | null>(null);

  // Live values for the DEV bench helpers below (the harness effect has [] deps).
  const benchRef = useRef({ setRelayUrl, encryptionKey, dependants, updateAutonomyStage, updateAuditVisibility, updatePetitionOnDeny, reloadDependants });
  benchRef.current = { setRelayUrl, encryptionKey, dependants, updateAutonomyStage, updateAuditVisibility, updatePetitionOnDeny, reloadDependants };
  // The harness effect has [] deps, so the grant-set bump is read through a
  // ref too rather than captured from the first render's closure.
  const bumpContactsGrantSetRef = useRef(bumpContactsGrantSet);
  bumpContactsGrantSetRef.current = bumpContactsGrantSet;
  // Test harness — DEV only, tree-shaken in production builds
  useEffect(() => {
    if (!(import.meta as any).env?.DEV) return;
    (window as any).__TEST__ = {
      setPage,
      setSelectedCredential,
      setPendingConnectRequest,
      setPendingVerifyRequest,
      setPendingAuthRequest,
      // D6 e2e seam: inject a scanned/opened contact invite without a real
      // camera or link click. Same state the QR scanner and the `#contact-
      // invite=` link both feed — takes the JSON-stringified ContactInvite.
      setPendingContactInvite,
      setRelayUrl: (url: string) => benchRef.current.setRelayUrl(url),
      getRelayUrl: () => getRelayServiceUrl(),
      setInactivityTimeout: (ms: number) => { inactivityTimeoutRef.current = ms; },
      // Deterministically lock the app, as the inactivity / visibility-hidden
      // grace timers do at runtime. Lets e2e exercise an auto-lock landing on an
      // approval screen without waiting out the 30s grace.
      lock: () => {
        setEncryptionKey(null);
        setAuthPromptContext(undefined);
        setShowAuthPrompt(true);
      },
      isLocked: () => encryptionKeyRef.current === null,
      // True once the unlocked identity's key material is decrypted. Unlocking
      // sets the key first and decrypts the stored record afterwards, so for a
      // moment the public (still-encrypted) record is what the pages hold.
      isIdentityDecrypted: () => encryptionKeyRef.current !== null && identityRef.current?.encrypted === false,
      getActivePubkey: () => identityRef.current ? getActivePubkey(identityRef.current) : null,
      addCredential: (cred: Parameters<typeof addCredentialRef.current>[0]) => addCredentialRef.current(cred),
      injectGetVerifiedSaved: (eventJsons: string[]) => getVerifiedSavedInjectorRef.current?.(eventJsons),
      // Hardware-bench helpers — go through the real setters so the change
      // republishes on the dependants sync rail (a raw IDB write is
      // reverted by the remote-wins merge on the next unlock).
      // (Read live values through the ref — this effect has [] deps.)
      setDependantStage: (pubkey: string, stage: import('./types').AutonomyStage) => benchRef.current.updateAutonomyStage(pubkey, stage),
      setDependantVisibility: (pubkey: string, v: 'default' | 'force-visible' | 'force-hidden') => benchRef.current.updateAuditVisibility(pubkey, v),
      setDependantPetition: (pubkey: string, on: boolean) => benchRef.current.updatePetitionOnDeny(pubkey, on),
      /**
       * Seed one contacts-v2 grant row, for the connected-apps e2e.
       *
       * The real approval path cannot be driven headlessly: the pairing ack
       * is a hard gate (Task 22 ruling), so without a reachable rendezvous
       * relay every approval fails by design. Writing the row through the
       * SAME encrypted writer the approval handler uses — and bumping the
       * same version — exercises everything downstream of the ack, which is
       * the half the list actually renders.
       */
      seedContactsGrantV2: async (over: Partial<AppGrantV2> & { grantId: string; appName: string }) => {
        const key = benchRef.current.encryptionKey;
        if (!key) throw new Error('locked');
        const rail = newRailKeypair();
        await saveContactGrantV2({
          directoryId: 'owner',
          appPubkey: 'a'.repeat(64),
          createdAt: Math.floor(Date.now() / 1000),
          updatedAt: Date.now(),
          capabilities: ['signet.contacts.read:directory'],
          railPubkey: rail.publicKey,
          railPrivateKey: rail.privateKey,
          relay: DEFAULT_RELAY_URL,
          maxStalenessSeconds: 21600,
          appLabels: {},
          seenOperationIds: [],
          ...over,
        }, key);
        bumpContactsGrantSetRef.current();
      },
      setDependantDefaultSchedule: async (pubkey: string, schedule: import('./types').GrantSchedule | undefined) => {
        const { encryptionKey: key, dependants: deps, reloadDependants: reload } = benchRef.current;
        if (!key) throw new Error('locked');
        const dep = deps.find(d => d.id === pubkey);
        if (!dep) throw new Error('no such dependant');
        const next = { ...dep } as typeof dep;
        if (schedule) next.defaultSchedule = schedule; else delete next.defaultSchedule;
        await saveDependant(next, key);
        await reload();
      },
    };
    return () => { delete (window as any).__TEST__; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Create backends when identity is decrypted, destroy on lock
  const backendsIdentityId = useRef<string | null>(null);
  useEffect(() => {
    if (!identity || !encryptionKey) {
      // A pending (not-yet-finalized) migration connection must never
      // survive a lock — it holds a live bunker secret + socket that
      // nothing else will ever tear down once the wizard's own state is
      // gone. Best-effort: the secret delete is fire-and-forget here (no
      // caller left to await/report it), mirroring handleMigrationAbort.
      if (migrationRef.current) {
        const pending = migrationRef.current;
        migrationRef.current = null;
        void deleteBunkerSecret();
        pending.backend.destroy();
      }
      if (backends) {
        backends.naturalPerson.destroy();
        backends.persona.destroy();
        setBackends(null);
        backendsIdentityId.current = null;
      }
      // Read via functional update — bunkerRouter isn't in this effect's
      // deps array, so a closure read here could be stale. Bump the
      // generation so any in-flight create() from before lock discards its
      // result instead of reviving a router post-lock.
      bunkerRouterGenRef.current++;
      setBunkerRouter((prev) => {
        prev?.destroy();
        return null;
      });
      setRouterProbeState(null);
      if (bunkerBackend) {
        bunkerBackend.destroy();
        setBunkerBackend(null);
        setSignerStatus(null);
        backendsIdentityId.current = null;
      }
      // Drop the memoised sync-cache AES keys (family-bunker §11.1.10). The
      // encrypted rows stay in IDB — only the derived key is forgotten, so a
      // locked device can't read the cached sync plaintexts.
      forgetSyncCacheKeys();
      // The Heartwood operator client (kind-24134) is stopped by
      // useHeartwoodOperator's own effect on the same encryptionKey flip.
      if (nip07Backend) {
        nip07Backend.destroy();
        setNip07Backend(null);
        backendsIdentityId.current = null;
      }
      if (extraBackend) {
        extraBackend.destroy();
        setExtraBackend(null);
      }
      // Clear Pro persona state on lock
      setProBackend(null);
      setProPersonaPubkey(null);
      return;
    }

    // Composite target ID includes dependant context so backends switch when
    // the guardian selects a different dependant (or switches back).
    // Include encrypted flag so the dedup guard doesn't match across
    // encrypted (public-only) and decrypted (full key material) states.
    const targetId = activeDependant
      ? `dep:${activeDependant.id}:${activeDependant.primaryKeypair}`
      : `${identity.id}:${identity.encrypted ? 'enc' : 'dec'}`;

    // Already created for this target
    if (backendsIdentityId.current === targetId) return;

    // Dependant mode — create backends from the dependant's own keys,
    // bypassing bunker/NIP-07 (those only know the guardian's key). Local
    // key first; when a slot has no local private key (future §11.1.2
    // key-stripping), fall back to routing the same pubkey over the
    // Heartwood pairing via bunkerRouter (family-bunker §11.1.3). Routes are
    // shared/cached RoutedBunkerSigningBackend instances from
    // BunkerBackendRouter — this effect's own teardown (below, and the
    // lock-teardown block above) destroys whatever it's handed, but
    // backendFor() self-heals a destroyed cached route on the next lookup
    // (src/lib/bunker-router.ts), so destroying a routed dep backend here is
    // harmless for the router's other consumers.
    //
    // Always returns once inside this block (success or not) — an
    // activeDependant with decrypted data must never fall through to the
    // guardian-mode branches below, which would build backends from the
    // *guardian's* identity/prefs.
    if (activeDependant && !activeDependant.encrypted) {
      const depBackendFor = (privKey: string | undefined, pubKey: string | undefined): DecryptingSigningBackend | null =>
        privKey ? new LocalSigningBackend(privKey) : (bunkerRouter?.backendFor(pubKey) ?? null);

      const np = depBackendFor(activeDependant.naturalPerson.privateKey, activeDependant.naturalPerson.publicKey);
      // Preserve legacy behaviour: when the persona slot has no local key of
      // its own, prefer routing the persona's own pubkey; only if that also
      // fails do we fall back to the legacy "reuse NP's private key" path.
      // Invariant: the legacy NP fallback is local-key only — never satisfy
      // the persona slot with a routed NP backend (identity conflation: the
      // persona pubkey is this app's privacy correlator, so a persona-context
      // sign must never silently go out under the NP's on-device identity
      // just because that's what the router happened to resolve for NP).
      const persona = activeDependant.persona.privateKey
        ? new LocalSigningBackend(activeDependant.persona.privateKey)
        : (depBackendFor(undefined, activeDependant.persona.publicKey)
            // The legacy NP fallback only applies to a dependant whose real
            // identity is ACTIVE. Borrowing a dormant NP key here would make a
            // persona-context act sign under a real-name slot the guardian has
            // never activated (spec §7.6).
            ?? (activeDependant.naturalPerson.privateKey
                && isDependantNaturalPersonActive(activeDependant)
                ? new LocalSigningBackend(activeDependant.naturalPerson.privateKey)
                : null));

      if (np && persona) {
        if (backends) {
          backends.naturalPerson.destroy();
          backends.persona.destroy();
        }
        if (extraBackend) {
          extraBackend.destroy();
          setExtraBackend(null);
        }
        setBackends({ naturalPerson: np, persona });

        // If the active keypair is an extra persona, create its backend
        const pk = activeDependant.primaryKeypair;
        if (pk !== 'natural-person' && pk !== 'persona') {
          const ep = (activeDependant.extraPersonas ?? []).find(e => e.publicKey === pk);
          if (ep) {
            const extra = depBackendFor(ep.privateKey, ep.publicKey);
            if (extra) setExtraBackend(extra);
          }
        }
        backendsIdentityId.current = targetId;
      }
      // If np/persona couldn't be resolved (no local key and no router yet
      // — e.g. a Heartwood connect is still in flight), leave
      // backendsIdentityId unset so a later re-run (bunkerRouter is in this
      // effect's deps, see below) retries once the router resolves.
      return;
    }

    // Guardian re-entry after dependant mode (regression guard — misroute
    // this prevents): every branch below either rebuilds `backends`
    // unconditionally OR can early-return without touching it (bunker mode's
    // `buildLocalBackends()` returns null once local key material has been
    // stripped after a Heartwood connect; nip07 mode never touches `backends`
    // at all). Left alone, the dependant's `backends` from the block above
    // would stay live under `bunkerBackend && !activeDependant`, letting a
    // GUARDIAN persona/extra act resolve to the DEPENDANT's persona key via
    // the `backends?.persona` fallbacks in `rawActiveBackend` and the
    // approval handlers (and via `bunkerRoutes`'s `personaBackend`). Clear
    // synchronously, before any branch below (including the async
    // preferences read) runs, so there is no window where stale dependant
    // backends are live under a guardian target. Destroying is safe even for
    // routed (RoutedBunkerSigningBackend) instances — `backendFor()`
    // self-heals a destroyed cached route on the next lookup (see the
    // dependant-mode comment above).
    if (backendsIdentityId.current?.startsWith('dep:')) {
      if (backends) {
        backends.naturalPerson.destroy();
        backends.persona.destroy();
        setBackends(null);
      }
      if (extraBackend) {
        extraBackend.destroy();
        setExtraBackend(null);
      }
    }

    // Read preferences from IndexedDB directly — React state may lag behind
    // direct DB writes during onboarding (handleConnectHeartwood writes to
    // IndexedDB but doesn't update the usePreferences hook state). M1: pass
    // encryptionKey (guaranteed non-null by the guard above) so bunkerUri
    // decrypts to a usable URI rather than staying ciphertext.
    void getPreferences(encryptionKey).then(prefs => {
      // Guard again after async — identity or key may have changed
      if (backendsIdentityId.current === targetId) return;

      /** Create local backends from the best available key material */
      function buildLocalBackends() {
        if (!identity) return null;
        if (!identity.encrypted) {
          const mnemonic = identity.mnemonic && validateMnemonic(identity.mnemonic)
            ? identity.mnemonic
            : undefined;
          const stored = createLocalBackendsFromKeyMaterial({
            naturalPersonPrivateKey: identity.naturalPerson.privateKey,
            personaPrivateKey: identity.persona.privateKey,
            professionalPrivateKey: identity.professionalPersona?.privateKey,
            mnemonicForProfessional: mnemonic,
          });
          if (stored) return stored;
          if (mnemonic) return createLocalBackends(mnemonic);
        }
        return null;
      }

      /** Sync Pro persona pubkey + backend from local backends (§4.5.10) */
      function applyProPersonaState(local: ReturnType<typeof buildLocalBackends>) {
        if (!local) return;
        if ('professional' in local && local.professional) {
          setProBackend(local.professional);
          // Populate pubkey from stored professionalPersona if available; otherwise
          // derive from the backend (activePublicKeyHex was set in LocalSigningBackend).
          setProPersonaPubkey(
            identity?.professionalPersona?.publicKey ?? local.professional.activePublicKeyHex
          );
        }
      }

      if (prefs.signingMode === 'bunker' && prefs.bunkerUri) {
        backendsIdentityId.current = targetId;

        // Always create local backends as fallback — needed for persona switching
        // and dependant signing when bunker is unavailable
        const local = buildLocalBackends();
        if (local) { setBackends(local); applyProPersonaState(local); }

        // Skip reconnect if already connected (e.g. after initial onboarding)
        if (bunkerBackend && bunkerBackend.activePublicKeyHex) {
          setSignerStatus('connected');
          return;
        }

        // Bunker mode: reconnect in background
        setSignerStatus('connecting');
        loadBunkerSecret(encryptionKey).then(clientSecret => {
          if (!clientSecret || !prefs.bunkerUri) {
            setSignerStatus(null);
            return;
          }
          const bunker = new BunkerSigningBackend(clientSecret);
          setBunkerBackend(bunker);
          // resendConnect: re-authorise this client into the Heartwood slot's
          // allowed-pubkey set on every reopen (see BunkerSigningBackend.reconnect).
          bunker.reconnect(prefs.bunkerUri, 30_000, undefined, true)
            .then(() => {
              setSignerStatus('connected');
              // Probe for Heartwood per-slot routing (auto-approved; generic
              // bunkers fail the probe and stay NP-only). Capture the
              // generation before the async probe so a stale/out-of-order
              // resolution (superseded by a newer create or a lock) can
              // discard its result instead of reviving a superseded router.
              startRouterProbe(bunker, clientSecret);
            })
            .catch(() => setSignerStatus('unavailable'));
        }).catch(() => setSignerStatus(null));
        return;
      }

      if (prefs.signingMode === 'paired-child') {
        // Paired-child install: signing goes to the guardian's phone bunker.
        // Credentials live in the PairedChildRecord, not the
        // bunkerSecret + prefs.bunkerUri pair used for Heartwood mode.
        backendsIdentityId.current = targetId;
        // No local backends — there's no signing material on this device.

        if (bunkerBackend && bunkerBackend.activePublicKeyHex) {
          setSignerStatus('connected');
          return;
        }

        setSignerStatus('connecting');
        // In paired-child mode `identity.id` IS the dependant pubkey — it was
        // written at pair time from `parsed.dependantPubkey`. After multi-pairing support, it's
        // also the row key of this device's PairedChildRecord, so the same
        // identifier lets us load the right pairing when multiple exist.
        loadPairedChild(identity.id, encryptionKey).then(async record => {
          if (!record) {
            setSignerStatus(null);
            return;
          }
          const bunker = new BunkerSigningBackend(record.clientKeypair.privateKey);
          setBunkerBackend(bunker);
          try {
            if (!record.hasPaired) {
              // First unlock after onboarding: send `connect` with the
              // secret baked into the bunker URI. On success the server
              // (guardian phone) binds our client pubkey and clears the
              // secret, after which only this device can reach the route.
              await bunker.connect(record.bunkerUri, 30_000);
              // Signer's activePublicKeyHex is set by connect. Verify
              // against the dependant pubkey from the pairing URI —
              // defence against a MITM relay subbing a different identity.
              if (bunker.activePublicKeyHex.toLowerCase() !== record.dependantPubkey.toLowerCase()) {
                bunker.destroy();
                setSignerStatus('unavailable');
                return;
              }
              await markPairedChildConnected(identity.id, encryptionKey).catch(() => {
                // Best-effort — if this fails we retry `connect` on next
                // unlock, which is safe (server rebinds same client pubkey).
              });
              setSignerStatus('connected');
            } else {
              // Subsequent unlocks — client pubkey already bound server-
              // side, `reconnect` skips the handshake and only fetches
              // the dependant pubkey for local verification.
              await bunker.reconnect(record.bunkerUri, 30_000, record.dependantPubkey);
              setSignerStatus('connected');
            }
            // Probe for Heartwood per-slot routing on the family device
            // (family-bunker §11.1.7). One call for both legs — the
            // first-pair branch returns early on the pubkey-mismatch path, so
            // reaching here means a verified connection either way. A guardian
            // *phone* bunker fails the capabilities probe, so the router stays
            // null and the dormant copy is unchanged. Generation-guarded
            // exactly like the Heartwood branch above so a stale resolution
            // can't revive a superseded router.
            startRouterProbe(bunker, record.clientKeypair.privateKey);
          } catch {
            setSignerStatus('unavailable');
          }
        }).catch(() => setSignerStatus(null));
        return;
      }

      if (prefs.signingMode === 'nip07') {
        backendsIdentityId.current = targetId;
        // Skip recreating if already set
        if (nip07Backend && nip07Backend.activePublicKeyHex) return;
        const ext = new Nip07SigningBackend(identity.id);
        setNip07Backend(ext);
        return;
      }

      const local = buildLocalBackends();
      if (local) {
        setBackends(local);
        applyProPersonaState(local);
        backendsIdentityId.current = targetId;
      }
    }).catch(() => {
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // `bunkerRouter` is included so the dependant branch above retries once
    // an in-flight Heartwood connect resolves the router (it's set
    // asynchronously after connect — see the create() probe below). This is
    // safe for every other branch: the `backendsIdentityId.current ===
    // targetId` dedup guard a few lines up returns before any work runs
    // once a target has already been built, so a bunkerRouter-only re-run
    // is a no-op there. Only the dependant branch's "couldn't resolve yet"
    // path leaves backendsIdentityId unset, so only it actually redoes work
    // on this dependency changing.
  }, [identity?.id, identity?.encrypted, encryptionKey, activeDependantId, activeDependant?.primaryKeypair, pairedChildBumpCounter, bunkerRouter]);

  // Load child settings whenever the active dependant changes
  useEffect(() => {
    if (!activeDependantId) return;
    getChildSettings(activeDependantId).then(s => {
      if (!s) return;
      setChildSettingsMap(prev => {
        const next = new Map(prev);
        next.set(activeDependantId, s);
        return next;
      });
    }).catch(() => {});
  }, [activeDependantId]);

  /**
   * R-34: every dependant's `ChildSettings`, loaded independent of which page
   * the user is on.
   *
   * I2 loaded the whole roster only while the family log was enabled, and the
   * effect above only ever the ACTIVE dependant — so everywhere else a
   * dependant directory resolved under `DEFAULT_CHILD_CEILING` regardless of
   * the guardian's configured ceiling. That is a display problem in the family
   * manager and a WIRE problem in the projections: child-authored contacts
   * were projected at a different tier from the one every in-app surface
   * showed, and opening the family manager re-armed the publish effect and
   * republished the same directory with different tiers. The app on the other
   * end watched the owner's tiers flip according to the owner's navigation.
   *
   * `childSettingsResolved` is the separate half of this: a dependant with no
   * stored row is a legitimate `DEFAULT_CHILD_CEILING`, so "resolved" has to
   * mean "the read completed", not "the map has an entry". An id that never
   * resolves (a throwing read) is left out, and `contactGrantDirectories`
   * below then publishes nothing for it — fail closed, never a stand-in
   * ceiling on the wire.
   */
  const dependantIdsKey = dependants.map(d => d.id).join(',');
  useEffect(() => {
    const missing = dependantIdsMissingChildSettings(dependants.map(d => d.id), [...childSettingsResolved]);
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const id of missing) {
        let settings: ChildSettingsType | undefined;
        try {
          settings = await getChildSettings(id) ?? undefined;
        } catch {
          // Unresolved, deliberately: the next roster change retries, and
          // until then this dependant's directory publishes nothing.
          continue;
        }
        if (cancelled) return;
        if (settings) setChildSettingsMap(prev => (prev.has(id) ? prev : new Map(prev).set(id, settings)));
        setChildSettingsResolved(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dependantIdsKey]);

  // Wire the preferences relay set into the relay-service pool. `setRelays`
  // recomputes the primary internally, so getRelayUrl() stays correct for the
  // single-URL consumers. No persisted set yet → the 6 defaults (the pool also
  // defaults to these at module load; we set explicitly so connectRelay targets
  // the right primary and a later edit is a no-op diff).
  useEffect(() => {
    if (prefsLoading) return;
    try {
      const set = (Array.isArray(preferences.relays) && preferences.relays.length > 0)
        ? preferences.relays
        : preferences.relayUrl
          ? [{ url: preferences.relayUrl, enabled: true, read: true, write: true }]
          : defaultRelays();
      setRelayServiceRelays(set);
      connectRelay().catch(() => {});
    } catch { /* invalid set — pool keeps its last good config */ }
  }, [preferences.relays, preferences.relayUrl, prefsLoading]);

  // Persist deferred persona switch when encryptionKey becomes available
  useEffect(() => {
    if (encryptionKey && pendingKeypairSwitch) {
      switchPrimary(pendingKeypairSwitch, encryptionKey).catch(() => {});
      setPendingKeypairSwitch(null);
    }
  }, [encryptionKey, pendingKeypairSwitch, switchPrimary]);

  // Display identity reflects pending switch immediately (before persistence)
  const displayIdentity = pendingKeypairSwitch && identity
    ? { ...identity, primaryKeypair: pendingKeypairSwitch }
    : identity;

  // Reset inactivity timer on user activity
  const resetInactivityTimer = useCallback(() => {
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    inactivityTimer.current = setTimeout(function fire() {
      if (backgroundServingRef.current || (stayAwakeUntilRef.current !== null && Date.now() < stayAwakeUntilRef.current)) {
        // Stay-awake window or native always-on serving active — hold off the
        // foreground auto-lock, but RE-ARM so the idle countdown resumes after
        // the window. (A bare return left the app unlocked forever once this
        // fired mid-window.)
        inactivityTimer.current = setTimeout(fire, inactivityTimeoutRef.current);
        return;
      }
      if (document.visibilityState === 'hidden' && phoneAppsUntilRef.current !== null && Date.now() < phoneAppsUntilRef.current) {
        // Hidden behind a phone app it is serving: the phone-apps window
        // decides when to lock (see the visibility handler), not idleness.
        inactivityTimer.current = setTimeout(fire, inactivityTimeoutRef.current);
        return;
      }
      setEncryptionKey(null); // lock the app
    }, inactivityTimeoutRef.current);
  }, []);

  // Stay-awake controls — consumed by the Bunker tab (Task 5).
  const armStayAwake = useCallback((minutes: number) => {
    setStayAwakeUntil(computeStayAwakeUntil(Date.now(), minutes));
  }, []);
  const closeStayAwake = useCallback(() => {
    setStayAwakeUntil(null);
  }, []);

  // Native always-on background serving: arm = permissions + battery
  // exemption + foreground service; disarm = stop service. The preference
  // (`backgroundBunkerEnabled`) survives restarts; re-arm happens in the
  // unlock effect below.
  const bunkerServePubkeysCsv = bunkerRoutes.map(r => r.pubkey).join(',');
  const bunkerServeRelayUrl = nostrConnectServeRelayUrl ?? preferences.relayUrl ?? DEFAULT_RELAY_URL;
  const handleSetBackgroundServing = useCallback(async (on: boolean) => {
    if (!isNativeApp()) return;
    if (on) {
      try {
        await LocalNotifications.requestPermissions();
        await LocalNotifications.createChannel({
          id: 'signet-requests',
          name: 'Signing requests',
          description: 'A child or connected app is waiting for your approval',
          importance: 5,
          visibility: 0,
        });
      } catch { /* channel/permission best-effort */ }
      try {
        const { exempt } = await SignetNative.isBatteryExempt();
        if (!exempt) await SignetNative.requestBatteryExemption();
      } catch { /* user can grant later from settings */ }
      try {
        await SignetNative.startBunkerService({ pubkeysCsv: bunkerServePubkeysCsv, relayUrl: bunkerServeRelayUrl });
      } catch { return; }
      setBackgroundServing(true);
      void setBackgroundBunkerEnabled(true);
    } else {
      try { await SignetNative.stopBunkerService(); } catch { /* already stopped */ }
      setBackgroundServing(false);
      void setBackgroundBunkerEnabled(false);
    }
  }, [bunkerServePubkeysCsv, bunkerServeRelayUrl, setBackgroundBunkerEnabled]);

  // When user clicks +X while locked, BunkerPanel calls this to:
  // 1. Track the pending minutes
  // 2. Close the panel for clean PIN entry
  // 3. Request unlock (PIN modal)
  // After unlock succeeds, panel reopens and arms with the pending time.
  const handleBunkerPendingArm = useCallback((minutes: number) => {
    setPendingBunkerArm(minutes);
    setBunkerPanelOpen(false);
    requestAuth();
  }, [requestAuth]);

  // Screen stays on while a stay-awake window is open (foreground only).
  useScreenWakeLock(stayAwakeUntil !== null);

  // Upgrade path: existing account without auth — trigger setup once
  useEffect(() => {
    if (!identityLoading && !prefsLoading && identity && !isAuthSetUp() && !pendingEncryptionKey && !encryptionKey) {
      setPendingEncryptionKey(generateEncryptionKey());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityLoading, prefsLoading, identity?.id]);

  // Auto-prompt for unlock on paired-child installs. The kid's app is
  // functionally useless while locked: the persona-inventory consumer
  // can't decrypt the PairedChildRecord's transport privkey, the bunker
  // signing client can't connect, and the carousel stays stuck on the
  // NP stub. Fire ONCE per app mount — if the kid cancels, leave them
  // alone (they can still see their NP card). Re-prompts naturally on
  // next reload. Guardian and other surfaces are unaffected — auth
  // stays on-demand for them.
  const pairedChildAutoPromptRef = useRef(false);
  useEffect(() => {
    if (pairedChildAutoPromptRef.current) return;
    if (identityLoading || prefsLoading) return;
    if (!identity) return;
    if (preferences.signingMode !== 'paired-child') return;
    if (!isAuthSetUp() || pendingEncryptionKey || encryptionKey) return;
    if (showAuthPrompt) return;
    pairedChildAutoPromptRef.current = true;
    void requestAuth();
  }, [identityLoading, prefsLoading, identity, preferences.signingMode, pendingEncryptionKey, encryptionKey, showAuthPrompt, requestAuth]);

  // Attach activity listeners when authenticated
  useEffect(() => {
    if (!encryptionKey) return;

    const events = ['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll'] as const;
    const handler = () => resetInactivityTimer();

    events.forEach(ev => window.addEventListener(ev, handler, { passive: true }));
    resetInactivityTimer(); // start the timer immediately on unlock

    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        // An ACTIVE stay-awake window suspends the hide-lock. Arming the
        // window is the user's explicit consent to serve for that period —
        // the phone's own lock screen is the security boundary while it
        // runs. Wiping the key here killed the NIP-46 server mid-window
        // (found in the 2026-06-11 stash-sync debug: "Serving" UI over a
        // dead, keyless server). Normal posture resumes at window end —
        // see the expiry effect below. Native always-on serving suspends the
        // hide-lock indefinitely (the foreground service keeps the WebView
        // alive with the screen off) until the user disarms it.
        if (backgroundServingRef.current || (stayAwakeUntilRef.current !== null && Date.now() < stayAwakeUntilRef.current)) {
          return;
        }
        // A phone app served over NIP-55 in the last few minutes: hold the
        // key until that window ends, and let a request served meanwhile
        // push the end out. Its content provider answers from here without
        // a screen, and an intent brings the app up without a PIN.
        const phoneAppsUntil = phoneAppsUntilRef.current;
        if (phoneAppsUntil !== null && Date.now() < phoneAppsUntil) {
          if (graceTimer) clearTimeout(graceTimer);
          const lockWhenWindowEnds = () => {
            graceTimer = null;
            if (document.visibilityState !== 'hidden') return;
            const until = phoneAppsUntilRef.current;
            if (until !== null && Date.now() < until) { graceTimer = setTimeout(lockWhenWindowEnds, until - Date.now()); return; }
            setEncryptionKey(null);
          };
          graceTimer = setTimeout(lockWhenWindowEnds, phoneAppsUntil - Date.now());
          return;
        }
        if (pendingVerifyRequest || pendingAuthRequest || page === 'venue-entry') {
          if (graceTimer) clearTimeout(graceTimer);
          graceTimer = setTimeout(() => { graceTimer = null; setEncryptionKey(null); }, 30000);
        } else {
          setEncryptionKey(null);
        }
      } else {
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      events.forEach(ev => window.removeEventListener(ev, handler));
      document.removeEventListener('visibilitychange', handleVisibility);
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      if (graceTimer) clearTimeout(graceTimer);
    };
  }, [encryptionKey, resetInactivityTimer, pendingVerifyRequest, pendingAuthRequest, page]);

  // Stay-awake window expiry: when the deadline passes, end the window and
  // restore the normal security posture at once — a hidden app locks NOW
  // (the hide-lock was suspended for the window's duration); a visible app
  // restarts the idle countdown from zero.
  useEffect(() => {
    if (stayAwakeUntil === null) return;
    const ms = stayAwakeUntil - Date.now();
    if (ms <= 0) { setStayAwakeUntil(null); return; }
    const timer = setTimeout(() => {
      setStayAwakeUntil(null);
      if (document.visibilityState === 'hidden') {
        setEncryptionKey(null);
      } else {
        resetInactivityTimer();
      }
    }, ms);
    return () => clearTimeout(timer);
  }, [stayAwakeUntil, resetInactivityTimer]);

  // When the window ends (expiry or Close now), resume normal auto-lock by
  // re-arming the inactivity timer from this moment.
  useEffect(() => {
    if (stayAwakeUntil === null && encryptionKey) {
      resetInactivityTimer();
    }
  }, [stayAwakeUntil, encryptionKey, resetInactivityTimer]);

  // Keep the Android process serving during an explicitly approved, bounded
  // connection window. This never enables the persistent always-on preference.
  useEffect(() => {
    if (!isNativeApp() || backgroundServing) return;
    if (!encryptionKey || stayAwakeUntil === null) {
      void SignetNative.stopTemporaryBunkerService().catch(() => {});
      return;
    }
    const durationMs = stayAwakeUntil - Date.now();
    if (durationMs <= 0) return;
    void SignetNative.startTemporaryBunkerService({
      pubkeysCsv: bunkerServePubkeysCsv,
      relayUrl: bunkerServeRelayUrl,
      durationMs,
    }).catch(() => {});
  }, [encryptionKey, stayAwakeUntil, backgroundServing, bunkerServePubkeysCsv, bunkerServeRelayUrl]);

  // Native: re-arm background serving on unlock when the preference is set.
  useEffect(() => {
    if (!isNativeApp() || !encryptionKey) return;
    if (preferences.backgroundBunkerEnabled && !backgroundServing) {
      void handleSetBackgroundServing(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encryptionKey, preferences.backgroundBunkerEnabled]);

  // Native: liveness heartbeat to the foreground service while serving.
  // A stale heartbeat (>90s) flips the service into fallback-poll mode.
  useEffect(() => {
    if (!isNativeApp() || !backgroundServing || !encryptionKey) return;
    const beat = () => {
      void SignetNative.serviceHeartbeat({ pubkeysCsv: bunkerServePubkeysCsv, relayUrl: bunkerServeRelayUrl }).catch(() => {});
    };
    beat();
    const t = setInterval(beat, 20_000);
    return () => clearInterval(t);
  }, [backgroundServing, encryptionKey, bunkerServePubkeysCsv, bunkerServeRelayUrl]);

  // Native: on app resume, kick the serve socket if it isn't open — Android
  // can kill a socket without delivering onclose to the WebView.
  useEffect(() => {
    if (!isNativeApp()) return;
    const sub = CapacitorApp.addListener('resume', () => {
      if (bunkerServeStatusRef.current.phase !== 'open') {
        setBunkerReconnectNonce(n => n + 1);
      }
    });
    return () => { void sub.then(s => s.remove()); };
  }, []);

  // Close the Bunker panel if navigation lands on a bar-hidden page (e.g. an
  // inbound approve/venue flow): the panel hides on those pages, but leaving
  // bunkerPanelOpen=true would keep suppressing the auto-approval overlay there.
  useEffect(() => {
    if (bunkerPanelOpen && isBarHiddenPage(page)) setBunkerPanelOpen(false);
  }, [bunkerPanelOpen, page]);

  // PWA update: auto-reload when update arrives while already locked
  useEffect(() => {
    if (needRefresh && !encryptionKeyRef.current) {
      updateServiceWorker();
    }
  }, [needRefresh, updateServiceWorker]);

  // PWA update: auto-reload when user locks while update is pending
  useEffect(() => {
    if (!encryptionKey && needRefreshRef.current) {
      updateServiceWorker();
    }
  }, [encryptionKey, updateServiceWorker]);

  // handleUnlock replaced by handleAuthPromptUnlock (on-demand auth modal)

  // Clear pending auth prompt when navigating away — prevents stale overlay on the next page
  useEffect(() => {
    if (showAuthPrompt) handleAuthPromptCancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // On-demand auth gate: pages that require signing trigger auth prompt automatically.
  // `manage-carousel` is also gated here even though it doesn't sign anything —
  // its hide/reorder buttons call `setExtraPersonaHidden` / `reorderExtraPersonas`
  // / `reorderDependants`, all of which throw `'Cannot save identity without
  // encryption key'` when locked. Without the gate, the page renders the persona
  // list (loaded from public IDB state) and the buttons appear active, but every
  // click silently throws and the user sees no change. Listing it here turns
  // every entry into either "unlocked, buttons work" or "unlock cancelled, route
  // back to home" — no silent-failure path.
  useEffect(() => {
    // The consumer-facing approval screens ('approve-auth' / 'approve-verification'
    // / 'approve-connect' / 'approve-add-dependant' / 'approve-companion-grant')
    // are gated too: each renders from public-only IDB state, so when the app
    // auto-locks while one is open (inactivity timer / the 30s visibility-hidden
    // grace timer nulls encryptionKey) — or the screen is reached directly via a
    // cold ?pair=1 / ?auth=1-style URL load that never went through unlock —
    // the screen still *looks* unlocked but signing throws "Identity keys are
    // not yet decrypted". Listing them here re-prompts unlock the moment the
    // lock lands, instead of stranding the user on a dead screen (Task 13
    // end-to-end verification caught 'approve-companion-grant' missing here:
    // Approve silently failed with "No pending pairing request" instead of
    // prompting for the PIN).
    const signingPages: Page[] = ['venue-entry', 'photo-capture', 'approve-auth', 'approve-verification', 'approve-connect', 'approve-add-dependant', 'approve-companion-grant', 'vouch-someone', 'add-dependant', 'import-dependant', 'roster', 'manage-carousel', 'migrate-heartwood'];
    if (signingPages.includes(page) && !encryptionKey) {
      requestAuth().then(key => {
        if (!key) navigateReplace('home'); // user cancelled or auth not set up — go back
      });
    }
  }, [page, encryptionKey, requestAuth]);

  // A picker choice belongs to one request; drop it once that request is gone.
  useEffect(() => {
    if (!pendingAuthRequest) setAuthPickerChoice(null);
  }, [pendingAuthRequest]);
  useEffect(() => {
    if (!pendingConnectRequest) setConnectPickerChoice(null);
  }, [pendingConnectRequest]);

  // Bounded "waiting for your Heartwood" on the approval page: while unlocked
  // in bunker mode with the per-persona route not back, waiting slots keep
  // Approve disabled for at most ROUTED_APPROVAL_WAIT_MS.
  const approvalRouteWaiting = (page === 'approve-auth' || page === 'approve-connect')
    && (preferences.signingMode === 'bunker' || preferences.signingMode === 'paired-child')
    && !!encryptionKey
    && !(bunkerRouter && signerStatus === 'connected')
    && routerProbeState !== 'unsupported';
  useEffect(() => {
    if (!approvalRouteWaiting) { setRouteWaitLapsed(false); return; }
    const timer = setTimeout(() => setRouteWaitLapsed(true), ROUTED_APPROVAL_WAIT_MS);
    return () => clearTimeout(timer);
  }, [approvalRouteWaiting]);

  // Never strand the user on a nav-less screen: an approval page whose request
  // has gone (denied, delivered, withdrawn) goes home, which restores the nav.
  useEffect(() => {
    if (identityLoading) return;
    if (isOrphanedApprovalPage(page, { hasAuthRequest: !!pendingAuthRequest, hasRelayAuthAck: !!relayAuthAckState })) {
      navigateReplace('home');
    }
  }, [page, pendingAuthRequest, relayAuthAckState, identityLoading, navigateReplace]);

  // After unlock, navigate to approve-auth ONLY if the pending request came via
  // URL auth (?auth=1 handler set urlAuthSiteName). QR-scanned and BroadcastChannel
  // requests stay on home so the ApprovalOverlay can handle them in-place.
  useEffect(() => {
    if (!pendingAuthRequest || page !== 'home') return;
    if (!encryptionKey) {
      // No identity yet — let the !identity render branch consume pendingAuthRequest
      // and show the staged onboarding flow. Don't prompt for auth that doesn't exist.
      if (!isAuthSetUp()) return;
      requestAuth().then(key => {
        if (!key) {
          if (currentLogEntryRef.current) {
            updateAuthRequestOutcome(currentLogEntryRef.current, 'cancelled');
            currentLogEntryRef.current = null;
          }
          setPendingAuthRequest(null);
          setPendingAuthSelection(null);
          setOriginalAuthUrl(null);
          setConsumerHint(null);
          setConsumerWarnings([]);
          setConsumerDisplayName(null);
          setPendingPostUrl(null);
        }
      });
      return;
    }
    if (urlAuthSiteName || urlAuthRequestsRef.current.has(pendingAuthRequest)) {
      navigateReplace('approve-auth');
    }
  }, [encryptionKey, pendingAuthRequest, urlAuthSiteName, page, requestAuth]);

  // After unlock, navigate to the third-party add-dependant approval page
  // Mirrors the auth-request unlock flow but
  // simpler — no carousel context, no consumer hint, just a single page.
  useEffect(() => {
    if (!pendingAddDependantRequest) return;
    if (page === 'approve-add-dependant') return; // already there
    if (!encryptionKey) {
      // No identity / not unlocked yet. If auth is set up, prompt the user.
      // Otherwise wait — the !identity onboarding branch will eventually
      // surface and the user can complete onboarding before we route them.
      if (!isAuthSetUp()) return;
      requestAuth().then(key => {
        if (!key) {
          // User cancelled the auth prompt — silently drop the request.
          // Don't redirect-back to the consumer; treat as "user closed the
          // tab" semantically. The consumer's `t` will time out and the
          // request becomes stale on a retry.
          setPendingAddDependantRequest(null);
        }
      });
      return;
    }
    navigateReplace('approve-add-dependant');
  }, [encryptionKey, pendingAddDependantRequest, page, requestAuth, navigateReplace]);

  const handleSetupComplete = useCallback(() => {
    if (pendingEncryptionKey) {
      setEncryptionKey(pendingEncryptionKey);
      setPendingEncryptionKey(null);
    }
  }, [pendingEncryptionKey]);

  const handleCreate = useCallback(async (displayName: string, primaryKeypair: 'natural-person' | 'persona', isChild: boolean, guardianPubkey?: string) => {
    const key = generateEncryptionKey();
    await create(displayName, primaryKeypair, isChild, guardianPubkey, key);
    setPendingEncryptionKey(key);
  }, [create]);

  /**
   * Create my Signet (spec §4.2): one persona name, always persona-primary,
   * never a child, real-name slot dormant. Chains into `SetupAuth` via
   * `setPendingEncryptionKey`, exactly like every other create path.
   */
  const handleCreateSignet = useCallback(async (displayName: string) => {
    await handleCreate(displayName, 'persona', false);
  }, [handleCreate]);

  // Spec §9 — legacy no-lock migration handlers.
  //
  // `handleLegacyGuestSecure` resolves the key the identity is ALREADY
  // encrypted under (recovering it from the stored handle when the auto-lock
  // nulled it) and hands it to SetupAuth; nothing is written until the user
  // completes a lock there.
  const handleLegacyGuestSecure = useCallback(async () => {
    setLegacyMigrationError('');
    try {
      const key = await resolveLegacyGuestKey(encryptionKey, getAuthMethod(), authenticateGrace);
      setLegacyMigrationKey(key);
      setLegacyMigration('setup');
    } catch (e) {
      setLegacyMigrationError(e instanceof Error ? e.message : 'Could not secure this Signet — please try again');
    }
  }, [encryptionKey]);

  const handleLegacyGuestComplete = useCallback(async () => {
    if (!identity) return;
    // `endGrace*` inside SetupAuth already cleared the stored handle; drop the
    // per-identity marker so the notice never fires again, then unlock with the
    // same key the identity has always used.
    await clearGraceState(identity.id);
    await clearGraceKey();
    if (legacyMigrationKey) setEncryptionKey(legacyMigrationKey);
    setLegacyMigrationKey(null);
    setLegacyMigration(null);
  }, [identity, legacyMigrationKey]);

  // True once this session has restored an identity from a seed phrase (any
  // of the three import paths). A restored identity SHOULD have a persona
  // backup on its relay — so "no backup found" means something different
  // here than it does on a genuine first run, where there's nothing to have
  // lost. Session-scoped on purpose: cleared on lock, never persisted.
  const restoredThisSessionRef = useRef(false);

  const handleImport = useCallback(async (mnemonic: string, displayName: string, primaryKeypair: 'natural-person' | 'persona', isChild: boolean, guardianPubkey?: string) => {
    const key = generateEncryptionKey();
    await restore(mnemonic, displayName, primaryKeypair, isChild, guardianPubkey, key);
    restoredThisSessionRef.current = true;
    // The home banner prompts the guardian to re-pair
    // child devices, since per-dependant endpoint keypairs aren't
    // derived from the mnemonic and so don't restore with the identity.
    markRecentRestore();
    setPendingEncryptionKey(key);
  }, [restore]);

  const handleImportWithProfile = useCallback(async (
    mnemonic: string,
    profile: import('./lib/profile-restore').RestoredProfile,
  ) => {
    const key = generateEncryptionKey();
    await restoreWithProfile(mnemonic, profile, key);
    restoredThisSessionRef.current = true;
    markRecentRestore();
    setPendingEncryptionKey(key);
  }, [restoreWithProfile]);

  const handleImportLiteMnemonic = useCallback(async (mnemonic: string, liteIdentityName: string, displayName: string) => {
    const key = generateEncryptionKey();
    await importLiteMnemonic(mnemonic, liteIdentityName, displayName, key);
    restoredThisSessionRef.current = true;
    markRecentRestore();
    setPendingEncryptionKey(key);
  }, [importLiteMnemonic]);

  const handleConnectHeartwood = useCallback(async (bunkerUri: string, displayName: string) => {
    // Generate encryption key for auth setup
    const key = generateEncryptionKey();

    // Generate and save bunker client secret
    const clientSecret = generateBunkerClientSecret();

    // Connect to the bunker to get the public key
    const bunker = new BunkerSigningBackend(clientSecret);
    try {
      await bunker.connect(bunkerUri, 30_000);
    } catch (err) {
      bunker.destroy();
      throw err;
    }

    // On a family Heartwood the pairing is bound to the MASTER, so
    // `get_public_key` returns the master pubkey — but the guardian's NP is
    // the device's derived `natural-person` persona, and that is the key the
    // firmware addresses every C4/C5 gift-wrap to. Ask the device which
    // identities it serves (auto-approved extension) and adopt NP/Persona
    // from there; a generic bunker answers nothing and keeps the master.
    let npPubkey = bunker.activePublicKeyHex;
    let personaPubkey = '';
    try {
      const raw = await Promise.race([
        bunker.request('heartwood_list_identities', []),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
      ]);
      const owner = pickOwnerIdentities(parseHeartwoodIdentities(raw));
      if (owner.naturalPerson) npPubkey = owner.naturalPerson;
      if (owner.persona) personaPubkey = owner.persona;
      // The registry only lists personas someone has derived; on a fresh
      // family device the NP/Persona usually aren't there yet even though
      // the firmware addresses notices to the (deterministic) NP. Derive
      // them now — idempotent, auto-approved when the pairing lists the
      // extension (the legacy manager slot), a button/timeout otherwise, in
      // which case the master stays the NP and the wizard can enrol later.
      const requestFn = (method: string, params: string[]) => bunker.request(method, params);
      if (!owner.naturalPerson) {
        const d = await derivePersonaToken(requestFn, 'natural-person', 10_000);
        if (d.status === 'ok') npPubkey = d.pubkeyHex;
      }
      if (!owner.persona && npPubkey !== bunker.activePublicKeyHex) {
        const d = await derivePersonaToken(requestFn, 'persona', 10_000);
        if (d.status === 'ok') personaPubkey = d.pubkeyHex;
      }
    } catch {
      // Not a Heartwood (or no personas yet) — master stays the NP.
    }

    // Create minimal identity record (pubkeys only, no mnemonic/private keys)
    const identityRecord: import('./types').SignetIdentity = {
      id: npPubkey,
      mnemonic: '',
      naturalPerson: { publicKey: npPubkey, privateKey: '', displayName },
      persona: { publicKey: personaPubkey, privateKey: '', displayName: personaPubkey ? 'Persona' : '' },
      primaryKeypair: 'natural-person',
      isChild: false,
      createdAt: Math.floor(Date.now() / 1000),
      encrypted: true,
      backedUp: true,
    };

    // Save identity (encrypt with the new key — fields are empty but flag must be set)
    await saveIdentityEncrypted(identityRecord, key);
    // M1: encrypt bunkerUri at rest — `key` is the freshly-generated
    // encryption key for this brand-new identity (global `encryptionKey`
    // state isn't set until the auth-setup flow below completes).
    await savePreferences({ ...(await getPreferences(key)), activeAccountId: npPubkey, signingMode: 'bunker', bunkerUri }, key);
    await reloadPreferences(key);
    await saveBunkerSecret(clientSecret, key);

    // Set bunker backend state
    setBunkerBackend(bunker);
    setSignerStatus('connected');

    // Probe for Heartwood per-slot routing (auto-approved; generic
    // bunkers fail the probe and stay NP-only). Capture the generation
    // before the async probe so a stale/out-of-order resolution discards
    // its result instead of reviving a superseded router.
    startRouterProbe(bunker, clientSecret);

    // Trigger auth setup flow
    setPendingEncryptionKey(key);
  }, [reloadPreferences]);

  const handleConnectNip07 = useCallback(async (displayName: string) => {
    if (!window.nostr) throw new Error('NIP-07 extension not available');

    // Generate encryption key for auth setup
    const key = generateEncryptionKey();

    // Fetch public key from the browser extension
    const npPubkey = await window.nostr.getPublicKey();

    // Create minimal identity record (pubkey only — private key held by extension)
    const identityRecord: import('./types').SignetIdentity = {
      id: npPubkey,
      mnemonic: '',
      naturalPerson: { publicKey: npPubkey, privateKey: '', displayName },
      persona: { publicKey: '', privateKey: '', displayName: '' },
      primaryKeypair: 'natural-person',
      isChild: false,
      createdAt: Math.floor(Date.now() / 1000),
      encrypted: true,
      backedUp: true,
    };

    // Save identity and preferences
    await saveIdentityEncrypted(identityRecord, key);
    await savePreferences({ ...(await getPreferences()), activeAccountId: npPubkey, signingMode: 'nip07' });

    // Set NIP-07 backend state
    const nip07 = new Nip07SigningBackend(npPubkey);
    setNip07Backend(nip07);

    // Trigger auth setup flow
    setPendingEncryptionKey(key);
  }, []);

  const handleMarkBackedUp = useCallback(async () => {
    await markBackedUp();
  }, [markBackedUp]);

  const handleSelectKen = useCallback((pubkey: string) => {
    setSelectedKenPubkey(pubkey);
    navigateTo('ken-detail');
  }, [navigateTo]);

  const handleAddDone = useCallback(() => {
    navigateReplace('contacts');
  }, [navigateReplace]);

  const handleImportNsec = useCallback(async (
    nsec: string,
    displayName: string,
    primaryKeypair: 'natural-person' | 'persona',
    opts?: {
      publishProfile?: boolean;
      existingProfile?: Partial<import('./types').PublicProfileConfig>;
      existingEventId?: string;
      existingCreatedAt?: number;
      existingRelay?: string;
    },
  ) => {
    const key = generateEncryptionKey();
    await importNsec(nsec, displayName, primaryKeypair, key, opts);
    setPendingEncryptionKey(key);
  }, [importNsec]);

  /**
   * Paired-child onboarding. Persists everything the device needs to
   * reach the guardian's bunker on every subsequent unlock:
   *
   * - A minimal `SignetIdentity` record (pubkey only, no mnemonic / private
   *   keys) so the existing App.tsx `!identity` guard lands us on the home
   *   surface rather than back at Onboarding.
   * - A `PairedChildRecord` with the bunker URI + NIP-46 client keypair,
   *   both encrypted at rest.
   *
   * Chains into SetupAuth via `setPendingEncryptionKey` — the user picks PIN
   * or biometric there. Runtime wiring of `BunkerSigningBackend` against
   * this record lands in follow-up work.
   */
  const handlePairChild = useCallback(async (parsed: import('./lib/pairing-uri').PairingURIParams, rawUri: string) => {
    const key = generateEncryptionKey();

    // Generate the NIP-46 communication keypair for this device's transport
    // identity. Random, not mnemonic-derived — re-pair generates a new one.
    const clientPrivHex = generateBunkerClientSecret();
    const clientPubHex = getPublicKey(hexToBytes(clientPrivHex));

    const now = Math.floor(Date.now() / 1000);

    // Minimal identity record for this device — no signing material.
    const identityRecord: import('./types').SignetIdentity = {
      id: parsed.dependantPubkey,
      mnemonic: '',
      naturalPerson: { publicKey: parsed.dependantPubkey, privateKey: '', displayName: parsed.dependantName },
      persona: { publicKey: '', privateKey: '', displayName: '' },
      primaryKeypair: 'natural-person',
      // Dormant until the guardian's first persona inventory lands and says
      // otherwise — a paired child must not show a real-identity row built
      // from a name that arrived in a pairing URI (spec §3.1, §7.6).
      naturalPersonActive: false,
      isChild: true,
      createdAt: now,
      encrypted: true,
      backedUp: true, // no local mnemonic to back up — the guardian holds the signing key
    };

    await saveIdentityEncrypted(identityRecord, key);
    await savePreferences({
      ...(await getPreferences()),
      activeAccountId: parsed.dependantPubkey,
      signingMode: 'paired-child',
    });
    // Force usePreferences React state to re-read IDB. Without this, the
    // Carousel reads stale `preferences.signingMode === undefined` for the
    // remainder of this session and shows the guardian "Create persona"
    // AddCard variant instead of the paired-child "Personas are managed
    // for you" empty state; the persona-inventory consumer and auto-
    // unlock prompt also gate on signingMode and silently no-op until
    // the next full reload. The bunker-setup effect reads prefs straight
    // from IDB so it's unaffected, but every consumer that reads from
    // React state breaks. See systematic-debugging session 2026-05-16.
    await reloadPreferences();
    // Store the raw URI byte-for-byte as scanned. Re-encoding from `parsed`
    // fields risks drift vs. whatever the guardian's `buildPairingURI`
    // produced (URLSearchParams vs encodeURIComponent differ on spaces /
    // reserved chars). BunkerSigner.fromBunker parses this exact string.
    await savePairedChild({
      bunkerUri: rawUri,
      clientKeypair: { publicKey: clientPubHex, privateKey: clientPrivHex },
      dependantPubkey: parsed.dependantPubkey,
      dependantName: parsed.dependantName,
      pairedAt: now,
      guardianPubkey: parsed.guardianPubkey,
    }, key);

    setPendingEncryptionKey(key);
  }, [reloadPreferences]);

  const [pairChildFlow, setPairChildFlow] = useState(false);

  /**
   * Paired-child re-pair handler. When the
   * guardian's per-dep bunker endpoint has been revoked + regenerated
   * (typically because the guardian replaced their phone), the kid's
   * `PairedChildRecord` still points at the dead endpoint. This handler
   * lets the kid scan a fresh QR and update the record in place,
   * preserving PIN, audit cache, persona-inventory revision cache, etc.
   *
   * The mismatch gate (PairChildOnboarding `expectedDependantPubkey`
   * prop) already filtered out codes intended for a different
   * dependant; here we just trust the parser and write.
   *
   * After the IDB update, tear down the existing bunker backend and
   * bump `pairedChildBumpCounter` (declared near other state above) to
   * force the bunker-setup effect to re-run with the fresh record. The
   * connect handshake will use the new secret and the guardian will
   * bind this device's NEW client pubkey.
   */
  const handleRepairChild = useCallback(async (parsed: import('./lib/pairing-uri').PairingURIParams, rawUri: string) => {
    if (!encryptionKey) throw new Error('Please unlock first.');
    if (!identity) throw new Error('No identity loaded.');
    if (parsed.dependantPubkey.toLowerCase() !== identity.id.toLowerCase()) {
      // Defence-in-depth — PairChildOnboarding already gates on this.
      throw new Error('This code is for a different account.');
    }
    // Preserve the existing client keypair across re-pair. Rotation was
    // considered (for correlation-surface reduction) but rejected: it
    // breaks two things downstream — (1) `usePersonaInventory` caches a
    // `LocalSigningBackend` over the client privkey by dependant pubkey,
    // and a fresh keypair under the same pubkey leaves a stale backend
    // that can't decrypt the new guardian endpoint's NIP-44 envelopes;
    // (2) the kid's existing on-relay audit gift-wraps are encrypted to
    // the OLD client pubkey — rotating loses history. The new guardian
    // endpoint will bind whatever client pubkey turns up, so reusing
    // the existing one is fine. Verified by code review on 2026-05-16
    // before live-test.
    const existingRecord = await loadPairedChild(identity.id, encryptionKey);
    if (!existingRecord) throw new Error('No existing pairing to repair.');
    await repairPairedChild(
      identity.id,
      rawUri,
      existingRecord.clientKeypair,
      encryptionKey,
      parsed.guardianPubkey,
    );
    // Drop the cached persona-inventory revision so the next consumer
    // fetch isn't blocked by a stale revision counter (the new guardian
    // device may republish at a smaller revision if clocks differ).
    await clearPairedChildPersonaRevision().catch(() => { /* tolerated */ });
    // Force the bunker-setup effect to rebuild from the new record.
    if (bunkerBackend) {
      bunkerBackend.destroy();
      setBunkerBackend(null);
    }
    setSignerStatus(null);
    setPairedChildBumpCounter(n => n + 1);
  }, [encryptionKey, identity, bunkerBackend]);

  const handleDeleteIdentity = useCallback(async () => {
    // Proof-of-presence gate: the most destructive action in the app must cost
    // an unlock. Falls through only if no PIN/biometric was ever set up.
    if (isAuthSetUp()) {
      const key = await requestFreshAuth();
      if (!key) return;
    }

    // Native only: tear down the foreground bunker service before wiping
    // IDB. Without this, the FGS keeps running post-delete and
    // BootReceiver re-arms it across reboots, polling the relay for the
    // just-deleted pubkeys. Best-effort — deletion proceeds regardless.
    if (isNativeApp()) {
      try { await SignetNative.stopBunkerService(); } catch { /* best-effort */ }
      setBackgroundServing(false);
    }

    // §6.9 best-effort public-profile retraction. Before wiping IDB, fire a
    // kind-5 + tombstone-kind-0 for every keypair slot with
    // `publicProfile.enabled === true && lastEventId`. Parallel, 5s total
    // budget — deletion proceeds regardless of relay outcome (success /
    // timeout / reject). Without this the relay would keep the kind-0
    // forever after local wipe, leaving the user's public profile online
    // with no way for them to reach it.
    if (identity) {
      const relayUrl = preferences.relayUrl ?? DEFAULT_RELAY_URL;
      const retractions: Array<Promise<unknown>> = [];

      const tryRetract = (slot: {
        publicKey?: string;
        privateKey?: string;
        publicProfile?: import('./types').PersonaPublicProfile;
      }) => {
        const pp = slot.publicProfile;
        if (!pp?.enabled || !pp.lastEventId) return;
        // Bunker mode (or any slot with stripped local key material) has no
        // `slot.privateKey` — every slot in bunker mode, in fact — so a local-
        // key-only check here would retract nothing and the account would be
        // wiped with the public profile still live and unrecoverable. Fall
        // back to the router's per-slot route, same Task-8 pattern used by
        // `publishPersonaProfile`/`retractPersonaProfile` above. Router-sourced
        // backend is a SHARED, CACHED route — only a locally-constructed
        // (owned) backend may be destroy()'d.
        const owned = !!slot.privateKey;
        const backend: DecryptingSigningBackend | null = owned
          ? (() => { try { return new LocalSigningBackend(slot.privateKey!); } catch { return null; } })()
          : (bunkerRouter?.backendFor(slot.publicKey) ?? null);
        if (!backend) return;
        const targetRelay = pp.lastPublishedRelay || relayUrl;
        retractions.push(
          retractPublicProfile(pp.lastEventId, backend, targetRelay, pp.lastPublishedAt)
            .finally(() => { if (owned) backend.destroy(); }),
        );
      };
      tryRetract(identity.naturalPerson);
      tryRetract(identity.persona);
      if (identity.professionalPersona) tryRetract(identity.professionalPersona);
      for (const ep of identity.extraPersonas ?? []) tryRetract(ep);

      // Dep slots: every dep persona the guardian still has on this device.
      for (const dep of dependants) {
        tryRetract(dep.naturalPerson);
        tryRetract(dep.persona);
        for (const ep of dep.extraPersonas ?? []) tryRetract(ep);
      }

      // B/I7: revocation tombstones for every active contacts-v2 grant, in the
      // SAME 5 s budget. `purgeAllUserData` drops the rail keys a moment from
      // now, so this is the last point at which a tombstone can be published
      // at all — without it a connected app keeps reading the owner's whole
      // directory for up to seven days after the identity is deleted.
      retractions.push(...await tombstoneGrantsFor(() => true, false));

      if (retractions.length > 0) {
        try {
          await Promise.race([
            Promise.allSettled(retractions),
            new Promise(resolve => setTimeout(resolve, 5_000)),
          ]);
        } catch { /* non-fatal — proceed with deletion */ }
      }
    }

    // Operator credential lives in the `identity` store, so the purge below
    // covers it — explicit for symmetry with deleteBunkerSecret call sites.
    try { await deleteHeartwoodOperator(); } catch { /* purge below covers it */ }
    await purgeAllUserData();
    clearAuthData();
    setEncryptionKey(null);
    window.location.reload();
  }, [requestFreshAuth, identity, dependants, preferences.relayUrl, bunkerRouter, tombstoneGrantsFor]);

  const handleConnectSigner = useCallback(async (bunkerUri: string) => {
    if (!encryptionKey) return;
    if (!identity) return;
    // Backup gate: deleting the mnemonic below is irreversible without a
    // prior backup. Enforce here, not just in the UI, so any caller-path
    // hits the same check.
    if (!identity.backedUp) {
      throw new Error('Identity must be backed up before connecting a signer');
    }

    // Generate a new client secret
    const clientSecret = generateBunkerClientSecret();

    // Save encrypted client secret
    await saveBunkerSecret(clientSecret, encryptionKey);

    // Create and connect bunker backend
    const bunker = new BunkerSigningBackend(clientSecret);
    try {
      await bunker.connect(bunkerUri, 30_000);
    } catch (err) {
      await deleteBunkerSecret();
      bunker.destroy();
      throw err;
    }

    // Strip local signing material BEFORE committing bunker preferences.
    // If the encrypted save fails, roll back: the bunker secret is deleted,
    // preferences stay on 'local', and the caller sees an error. This way
    // the app can never end up in "bunker mode with local mnemonic still
    // on disk" — the scenario that would silently defeat the whole point
    // of moving root-key custody to Heartwood.
    try {
      const stripped: import('./types').SignetIdentity = {
        ...identity,
        mnemonic: '',
        naturalPerson: { ...identity.naturalPerson, privateKey: '' },
        persona: { ...identity.persona, privateKey: '' },
        extraPersonas: identity.extraPersonas?.map((ep) => ({ ...ep, privateKey: '' })),
      };
      await saveIdentityEncrypted(stripped, encryptionKey);
    } catch (err) {
      await deleteBunkerSecret();
      bunker.destroy();
      throw err;
    }

    // Save preferences now that local keys are gone — switching signingMode
    // before the strip would open a crash window where the next unlock
    // finds bunker-mode preferences but still-present local keys. M1:
    // encrypt the new bunkerUri at rest.
    const prefs = await getPreferences(encryptionKey);
    await savePreferences({ ...prefs, signingMode: 'bunker', bunkerUri }, encryptionKey);

    // Destroy local backends, switch to bunker. Destroy any stale bunker
    // first to avoid leaking a live WebSocket + client secret in memory.
    if (backends) {
      backends.naturalPerson.destroy();
      backends.persona.destroy();
      setBackends(null);
    }
    // Bump unconditionally — even if bunkerRouter is currently null, an
    // earlier create() probe may still be in flight and must not install
    // a router superseded by this connect.
    bunkerRouterGenRef.current++;
    if (bunkerRouter) {
      bunkerRouter.destroy();
      setBunkerRouter(null);
    }
    setRouterProbeState(null);
    if (bunkerBackend) bunkerBackend.destroy();
    setBunkerBackend(bunker);
    setSignerStatus('connected');

    // Probe for Heartwood per-slot routing (auto-approved; generic
    // bunkers fail the probe and stay NP-only). Capture the generation
    // before the async probe so a stale/out-of-order resolution discards
    // its result instead of reviving a superseded router.
    startRouterProbe(bunker, clientSecret);
  }, [encryptionKey, backends, bunkerBackend, bunkerRouter, identity]);

  // --- Migration wizard (family-bunker §11.1.2) ---
  // Decomposed connect/finalize/abort so the wizard can drive enrolment +
  // verification against a freshly-paired bunker BEFORE any local key
  // material is touched. `handleConnectSigner` above stays untouched — the
  // Settings "connect a signer" path keeps using it as-is.

  const handleMigrationConnect = useCallback(async (
    bunkerUri: string,
  ): Promise<(method: string, params: string[]) => Promise<string>> => {
    if (!encryptionKey) throw new Error('Please unlock first.');
    if (!identity) throw new Error('No identity loaded.');
    // Backup gate: identical guard + message to handleConnectSigner —
    // handleMigrationFinalize strips local keys, same irreversibility
    // argument applies here.
    if (!identity.backedUp) {
      throw new Error('Identity must be backed up before connecting a signer');
    }

    const clientSecret = generateBunkerClientSecret();
    await saveBunkerSecret(clientSecret, encryptionKey);

    const backend = new BunkerSigningBackend(clientSecret);
    try {
      await backend.connect(bunkerUri, 30_000);
    } catch (err) {
      await deleteBunkerSecret();
      backend.destroy();
      throw err;
    }

    // NOT yet committed: no strip, no prefs, no state swap. The wizard
    // drives enrolment/verification against the returned request fn;
    // handleMigrationFinalize (success) or handleMigrationAbort (bail)
    // resolve this pending connection.
    migrationRef.current = { backend, clientSecret, bunkerUri };
    return (method: string, params: string[]) => backend.request(method, params);
  }, [encryptionKey, identity]);

  const handleMigrationRequestFn = useCallback((): ((method: string, params: string[]) => Promise<string>) | null => {
    if (migrationRef.current) {
      const { backend } = migrationRef.current;
      return (method: string, params: string[]) => backend.request(method, params);
    }
    // Already-bunker entry: re-run enrolment for newly-added deps without a
    // fresh pairing, over the already-connected/committed backend.
    if (bunkerBackend && signerStatus === 'connected') {
      return (method: string, params: string[]) => bunkerBackend.request(method, params);
    }
    return null;
  }, [bunkerBackend, signerStatus]);

  // Bunker-mode dependant / persona creation (family-bunker §11.1.8, D4).
  // Post-migration the phone holds no mnemonic; the device derives the new
  // identity from ITS tree over the master pairing (heartwood_derive_persona
  // is auto-approved on the app slot) and we keep public keys only.
  //
  // `bunkerRouter` is THE signal, deliberately — not `identity.mnemonic`:
  //   - it means the paired signer answered `heartwood_capabilities`, i.e. it
  //     can actually derive. A generic bunker:// signer leaves the router null,
  //     so `deviceDerive` stays undefined and the local path (with its own
  //     "guardian has no mnemonic" error) is what fires — as it must.
  //   - it describes actual signer capability, independently of when identity
  //     state refreshes after migration or a generic signer connection.
  //
  // Excluded on a paired-child install even though its router can be non-null
  // (the kid's probe reaches the family Heartwood too, §11.1.7): the derive
  // tokens are OWNER-namespace (dependant-N-np, persona-N), so a kid-side call
  // would derive a GUARDIAN slot on the device. Kid surfaces never create
  // dependants or personas, so the functions simply stay undefined there.
  const heartwoodRequestFn = useMemo<HeartwoodRequestFn | null>(() => {
    if (!bunkerBackend || !bunkerRouter || signerStatus !== 'connected') return null;
    if (preferences.signingMode === 'paired-child') return null;
    return (method, params) => bunkerBackend.request(method, params);
  }, [bunkerBackend, bunkerRouter, signerStatus, preferences.signingMode]);

  // Owner personas cross-device sync (personas-sync rail, follow-on to
  // the earlier sync-rail phases). Placed here (rather than beside the other rails
  // near useDependantsSync above) because it needs heartwoodRequestFn,
  // which is declared above this line — hooks are unconditional, so the
  // later position in the component body doesn't change render order.
  // relays: whole configured relay pool (sync-relays.ts), declared up near
  // the rest of the rail cluster (see `syncRelays` above `useContactsSync`).
  // identity: null on a paired-child install — a paired child has no
  // owner personas of its own to sync.
  const { remoteState: personasRemoteState, skipped: personasSkipped } = usePersonasSync({
    publishEnabled: legacyPrivateWrite('profiles'),
    identity: preferences.signingMode === 'paired-child' ? null : identity,
    npBackend: npBunkerBackend ?? nip07Backend ?? backends?.naturalPerson ?? null,
    relays: syncRelays,
    encryptionKey,
    // Both options key off signingMode, NOT identity.mnemonic — see the
    // same rationale on useDependantsSync above (stale mnemonic post-
    // migration would re-derive and persist real private keys).
    mnemonic: preferences.signingMode === 'bunker' ? null : (identity?.mnemonic ?? null),
    deviceHeldKeys: preferences.signingMode === 'bunker',
    heartwoodRequestFn,
    applyRemotePersonas,
  });
  const refreshPrivateVaultData = () => {
    setBotsVersion(v => v + 1);
    void reloadIdentity(); void reloadDependants(); void reloadCredentials(); void reloadGrants();
    void reloadPreferences(encryptionKey ?? undefined); void contactsV2.reload();
    const key = encryptionKey, owner = identity?.naturalPerson.publicKey;
    void Promise.all(dependants.map(async dep => [dep.id, await getChildSettings(dep.id)] as const)).then(rows => {
      if (encryptionKeyRef.current !== key || identityRef.current?.naturalPerson.publicKey !== owner) return;
      setChildSettingsMap(new Map(rows.filter((row): row is readonly [string, ChildSettingsType] => !!row[1])));
    }).catch(() => { /* Keep the current policy view until the next successful reload. */ });
    if (familyLogEnabledNow) void familyContacts.reload();
    bumpContactsGrantSet();
  };
  const rotationContext = useRef({ session: privateVaultSession, activeDependant: !!activeDependant, key: encryptionKey, generation: 0 });
  const priorRotationContext = rotationContext.current;
  rotationContext.current = { session: privateVaultSession, activeDependant: !!activeDependant, key: encryptionKey,
    generation: priorRotationContext.generation + Number(priorRotationContext.session !== privateVaultSession
      || priorRotationContext.key !== encryptionKey || priorRotationContext.activeDependant !== !!activeDependant) };
  const rotatePrivateBackup = async (purpose: string): Promise<string> => {
    const root = identity?.naturalPerson.publicKey;
    if (!identity || !root || isPairedChild || activeDependant || !privateVaultSupported) throw new Error('Owner backup session required');
    const generation = rotationContext.current.generation;
    const key = await requestFreshAuth();
    if (!key) return 'Backup key change cancelled.';
    const isCurrent = () => encryptionKeyRef.current === key && identityRef.current?.naturalPerson.publicKey === root
      && rotationContext.current.generation === generation && rotationContext.current.session === privateVaultSession && !rotationContext.current.activeDependant;
    if (!isCurrent()) return 'Backup session changed. Unlock and try again.';
    const fresh = await loadIdentityDecrypted(identity.id, key);
    if (!fresh || fresh.naturalPerson.publicKey !== root || !isCurrent()) return 'Backup session changed. Unlock and try again.';
    const jobs = await privateVaultJobs({ identity: fresh, encryptionKey: key,
      deviceHeldKeys: preferences.signingMode === 'bunker', bunker: bunkerBackend, isCurrent });
    const job = jobs.find(item => vaultPurpose(item.adapter.dataset) === purpose);
    if (!job || !isCurrent()) return 'This backup is no longer available in this session.';
    const result = await rotatePrivateVaultDataset({ ...job, ownerPubkey: root, encryptionKey: key,
      relays: syncRelays, isCurrent, now: Math.floor(Date.now() / 1000), allowInitialPublish: false });
    if (!isCurrent()) return 'Backup session changed. Check its status after unlocking.';
    refreshPrivateVaultData();
    setBotsChangeVersion(v => v + 1);
    if (result.state === 'complete') return 'Backup key changed and verified. Your recovery words still restore this backup.';
    if (result.state === 'unusable') return 'The key change needs attention. Existing backups are retained; the new recovery path could not be validated.';
    if (result.state === 'cancelled') return 'Backup key change interrupted. Check its status after unlocking.';
    return 'The key change is unfinished. Existing backups are retained. Use Resume key change to try again; a signed handover may also finish during sync.';
  };
  usePrivateVaults({
    sessionKey: identity && encryptionKey ? privateVaultSession : null,
    ownerPubkey: identity?.naturalPerson.publicKey ?? null,
    encryptionKey,
    supported: privateVaultSupported,
    ready: contactsImport.status === 'done' && !dependantsLoading
      && (preferences.signingMode !== 'bunker' || signerStatus === 'connected'),
    migrationReady: [personasRemoteState, dependantsRemoteState, credentialsRemoteState, grantsRemoteState,
        contactsRemoteState, contactsV2RemoteState, contactsGrantsRemoteState]
        .every(state => state === 'present' || state === 'never-seen'),
    changeToken: JSON.stringify([botsChangeVersion, personasRemoteState, dependantsRemoteState, credentialsRemoteState, grantsRemoteState,
      contactsRemoteState, contactsV2RemoteState, contactsGrantsRemoteState, contactsChangeToken, contactsGrantsSetVersion,
      identity?.persona.displayName, identity?.naturalPerson.displayName,
      identity ? profilesChangeWire(identity) : null,
      dependants.map(dependantChangeWire), credentials?.map(c => c.id), grantsForSync,
      portableSettingsValues(preferences), [...childSettingsMap].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]),
    relays: syncRelays,
    jobs: isCurrent => privateVaultJobs({ identity: identity!, encryptionKey: encryptionKey!,
      deviceHeldKeys: preferences.signingMode === 'bunker', bunker: bunkerBackend, isCurrent }),
    onMerged: refreshPrivateVaultData,
    onHealth: health => setPrivateVaultStatus({ session: privateVaultSession, health }),
  });
  // "N imported personas could not be added here" banner is dismissable
  // but reappears next unlock if still relevant — reset alongside lock.
  const [personasSkippedDismissed, setPersonasSkippedDismissed] = useState(false);
  // Scenario (e): the post-restore "no backup found" line is dismissable and
  // session-scoped, like the skipped-personas note.
  const [restoreNoBackupDismissed, setRestoreNoBackupDismissed] = useState(false);
  useEffect(() => {
    if (!encryptionKey) {
      setPersonasSkippedDismissed(false);
      setRestoreNoBackupDismissed(false);
      restoredThisSessionRef.current = false;
      // M5: the family-contacts Tier-1 gate is per-unlock, not per-session —
      // a lock must force the next visit back through requestAuth.
      setFamilyContactsUnlocked(false);
      // N3: after I2, childSettingsMap holds every dependant's row (not just
      // the active one) — encrypted data held in React state must not
      // survive a lock, same as every other decrypted-on-unlock cache here.
      setChildSettingsMap(new Map());
    }
  }, [encryptionKey]);

  const dependantDeviceDerive = useMemo<DependantDeviceDerive | undefined>(() => {
    // Same paired-child exclusion as heartwoodRequestFn — a kid install can
    // have a non-null router, and undefined (not a throwing stub) is the right
    // shape there, so useDependants takes the local path and its own error.
    if (!bunkerRouter || preferences.signingMode === 'paired-child') return undefined;
    if (!heartwoodRequestFn) {
      return async () => { throw new Error("Your Heartwood signer isn't connected. Connect it in Settings → Advanced, then add the dependant."); };
    }
    return (path) => deriveDependantOnDevice(heartwoodRequestFn, path);
  }, [bunkerRouter, heartwoodRequestFn, preferences.signingMode]);

  const extraPersonaDeviceDerive = useMemo<ExtraPersonaDeviceDerive | undefined>(() => {
    if (!bunkerRouter || preferences.signingMode === 'paired-child') return undefined; // see dependantDeviceDerive
    if (!heartwoodRequestFn) {
      return async () => { throw new Error("Your Heartwood signer isn't connected. Connect it in Settings → Advanced, then add the persona."); };
    }
    return (name) => deriveExtraPersonaOnDevice(heartwoodRequestFn, name);
  }, [bunkerRouter, heartwoodRequestFn, preferences.signingMode]);

  const handleMigrationFinalize = useCallback(async (verifiedSlots: EnrolmentSlot[]) => {
    migrationFinalizeInFlightRef.current = true;
    try {
    if (!encryptionKey) throw new Error('Please unlock first.');
    if (!identity) throw new Error('No identity loaded.');

    // Strip EXACTLY the verified slot set — the wizard passes the slots
    // that actually round-tripped and verified against the device this
    // run, not a recomputed plan. This is what makes the strip immune to
    // missing-pubkey slots, a vacuous zero-slot plan, and a dependant
    // merged in mid-ceremony by cross-device sync: any of those produce a
    // token that's simply absent from `verifiedTokens`, so the
    // corresponding key survives.
    const verifiedTokens = new Set(verifiedSlots.map((s) => s.token));

    // Capture originals BEFORE any write — rollback restores from these,
    // never from post-write state.
    const originalIdentity = identity;
    const originalDeps = [...dependants];
    let originalPro = await loadProPersonaDecrypted(encryptionKey);

    const strippedDepIds: string[] = [];
    try {
      // 1. Strip the identity record — mnemonic + NP/Persona/Pro/
      // tree-derived-extras private keys whose token verified.
      await saveIdentityEncrypted(stripIdentityKeys(originalIdentity, verifiedTokens), encryptionKey);

      // 2. Strip the separate Pro-persona row. This row (PRO_PERSONA_KEY in
      // db.ts) is the canonical store for the Pro private key; pubkey +
      // metadata live on the identity record's professionalPersona slot,
      // already stripped above. Only touch it if a row actually exists AND
      // the 'professional' token verified this run — a pro row can exist
      // while pro was never in the plan (missing-pubkey) or never verified.
      if (originalPro !== null && verifiedTokens.has('professional')) {
        await saveProPersonaEncrypted('', encryptionKey);
      }

      // 3. Strip each tree-derived dependant against the verified set.
      // stripDependantKeys returns null for an imported dependant OR a
      // dependant with no verified tokens this run — leave it untouched,
      // don't save.
      for (const dep of originalDeps) {
        const s = stripDependantKeys(dep, verifiedTokens);
        if (s) {
          await saveDependant(s, encryptionKey);
          strippedDepIds.push(dep.id);
        }
      }
    } catch (err) {
      // Rollback: best-effort, each restore in its own try so one restore
      // failure doesn't abandon the rest. Restore identity, then the pro
      // record, then every already-stripped dep's original; then tear down
      // a pending (not-yet-committed) migration connection if one exists;
      // then rethrow the ORIGINAL error.
      try { await saveIdentityEncrypted(originalIdentity, encryptionKey); } catch { /* best-effort */ }
      if (originalPro !== null) {
        try { await saveProPersonaEncrypted(originalPro, encryptionKey); } catch { /* best-effort */ }
      }
      for (const depId of strippedDepIds) {
        const orig = originalDeps.find((d) => d.id === depId);
        if (orig) {
          try { await saveDependant(orig, encryptionKey); } catch { /* best-effort */ }
        }
      }
      if (migrationRef.current) {
        const pending = migrationRef.current;
        migrationRef.current = null;
        try { await deleteBunkerSecret(); } catch { /* best-effort */ }
        pending.backend.destroy();
      }
      throw err;
    }

    // Durable deletion succeeded: clear existing objects before any further
    // await, including refs held by older render closures. Failed writes above
    // retain the originals for rollback. This is reference cleanup, not secure
    // erasure of immutable strings or historical storage copies.
    const removedKeys = clearMigratedKeyReferences(originalIdentity, originalDeps, verifiedTokens);
    originalPro = null;
    backendsIdentityId.current = null;
    for (const backend of [backends?.naturalPerson, backends?.persona, proBackend, extraBackend]) {
      if (backend?.type === 'local' && removedKeys.has(backend.activePublicKeyHex)) backend.destroy();
    }
    if (proBackend?.type === 'local' && removedKeys.has(proBackend.activePublicKeyHex)) setProBackend(null);
    if (extraBackend?.type === 'local' && removedKeys.has(extraBackend.activePublicKeyHex)) setExtraBackend(null);
    if (!originalIdentity.mnemonic) {
      for (const backend of railBackends.values()) backend.destroy();
      setRailBackends(new Map());
    }

    // Save preferences now that local keys are gone — switching signingMode
    // before the strip would open a crash window where the next unlock
    // finds bunker-mode preferences but still-present local keys (same
    // ordering rationale as handleConnectSigner). bunkerUri comes from the
    // pending migration connection; for an already-bunker entry prefs are
    // already committed, so this falls back to the existing value (no-op).
    //
    // Everything from here on runs AFTER the strip block has committed —
    // there is no rollback path left (keys are already gone from local
    // storage). Errors here are marked `postStrip` so the wizard can show
    // the "your keys already moved, just re-run migration" copy instead of
    // "nothing was committed" (which would be false).
    try {
      const prefs = await getPreferences(encryptionKey);
      const bunkerUri = migrationRef.current?.bunkerUri ?? prefs.bunkerUri;
      await savePreferences({ ...prefs, signingMode: 'bunker', bunkerUri }, encryptionKey);

      // Backend swap — fresh-pairing entry only (mirrors handleConnectSigner
      // steps 9-10 exactly). An already-bunker entry keeps its already-
      // committed `bunkerBackend`; migrationRef was never set in that case.
      if (migrationRef.current) {
        const { backend, clientSecret } = migrationRef.current;

        // Destroy local backends, switch to bunker. Destroy any stale bunker
        // first to avoid leaking a live WebSocket + client secret in memory.
        if (backends) {
          backends.naturalPerson.destroy();
          backends.persona.destroy();
          setBackends(null);
        }
        // Bump unconditionally — even if bunkerRouter is currently null, an
        // earlier create() probe may still be in flight and must not install
        // a router superseded by this connect.
        bunkerRouterGenRef.current++;
        if (bunkerRouter) {
          bunkerRouter.destroy();
          setBunkerRouter(null);
        }
        setRouterProbeState(null);
        if (bunkerBackend) bunkerBackend.destroy();
        setBunkerBackend(backend);
        setSignerStatus('connected');

        // Probe for Heartwood per-slot routing (auto-approved; generic
        // bunkers fail the probe and stay NP-only). Capture the generation
        // before the async probe so a stale/out-of-order resolution discards
        // its result instead of reviving a router superseded by a later
        // connect or a lock.
        startRouterProbe(backend, clientSecret);

        migrationRef.current = null;
      }

      // Replace identity/dependant state with the persisted keyless records.
      await reloadIdentity();
      await reloadDependants();
      // And preferences, so `signingMode === 'bunker'` is visible to the
      // React tree this session (operator-key row, petitions toggle,
      // "Connected to Heartwood signer" copy) rather than only after the
      // next reload. The prefs row was already committed above.
      await reloadPreferences(encryptionKey);
    } catch (err) {
      const normalized = err instanceof Error ? err : new Error(String(err));
      (normalized as Error & { postStrip?: boolean }).postStrip = true;
      throw normalized;
    }
    } finally {
      migrationFinalizeInFlightRef.current = false;
    }
  }, [encryptionKey, identity, dependants, backends, proBackend, extraBackend, railBackends, bunkerBackend, bunkerRouter, reloadIdentity, reloadDependants, reloadPreferences]);

  const handleMigrationAbort = useCallback(async () => {
    // finalize owns the pending backend's fate; an abort during finalize
    // would yank migrationRef mid-swap.
    if (migrationFinalizeInFlightRef.current) return;
    if (!migrationRef.current) return;
    const pending = migrationRef.current;
    migrationRef.current = null;
    await deleteBunkerSecret();
    pending.backend.destroy();
  }, []);

  const handleDisconnectSigner = useCallback(async () => {
    // Destroy per-slot router before the primary backend it routes over.
    // Bump the generation unconditionally — an earlier create() probe may
    // still be in flight (bunkerRouter still null) and must not install a
    // router after this explicit disconnect.
    bunkerRouterGenRef.current++;
    if (bunkerRouter) {
      bunkerRouter.destroy();
      setBunkerRouter(null);
    }
    setRouterProbeState(null);
    // Destroy bunker backend
    if (bunkerBackend) {
      bunkerBackend.destroy();
      setBunkerBackend(null);
    }

    // Clear preferences
    const prefs = await getPreferences();
    await savePreferences({ ...prefs, signingMode: 'local', bunkerUri: undefined });

    // Delete bunker secret
    await deleteBunkerSecret();

    // The operator key manages the device we just walked away from — drop
    // it too (stops the kind-24134 client and deletes the encrypted row).
    await forgetHeartwoodOperator();

    setSignerStatus(null);
  }, [bunkerBackend, bunkerRouter, forgetHeartwoodOperator]);

  const handleUpdateDependantName = useCallback(async (name: string) => {
    if (!activeDependant) return;
    await updateDependantName(activeDependant.id, name);
  }, [activeDependant, updateDependantName]);

  const handleUpdateAutonomyStage = useCallback(async (stage: import('./types').AutonomyStage) => {
    if (!activeDependant) return;
    await updateAutonomyStage(activeDependant.id, stage);
  }, [activeDependant, updateAutonomyStage]);

  const handleUpdateAuditVisibility = useCallback(async (
    override: import('./lib/audit-visibility').AuditVisibilityOverride,
  ) => {
    if (!activeDependant) return;
    await updateAuditVisibility(activeDependant.id, override);
  }, [activeDependant, updateAuditVisibility]);

  /**
   * §6.9-equivalent best-effort retract for every persona slot on a single
   * dependant. The dep is about to be removed — once `removeDependant`
   * runs, the signing keys are gone with the record and there is no
   * recovery path for any kind-0 still live on the relay. Same parallel +
   * 5s budget shape as `handleDeleteIdentity`; deletion proceeds
   * regardless of relay outcome.
   *
   * Defined here (not in useDependants) because retract uses
   * LocalSigningBackend + retractPublicProfile, both of which are
   * already imported into App.tsx.
   */
  const retractDepProfilesBeforePurge = useCallback(async (dep: import('./types').DependantIdentity) => {
    const relayUrl = preferences.relayUrl ?? DEFAULT_RELAY_URL;
    const retractions: Array<Promise<unknown>> = [];
    const tryOne = (slot: { publicKey?: string; privateKey?: string; publicProfile?: import('./types').PersonaPublicProfile }) => {
      const pp = slot.publicProfile;
      if (!pp?.enabled || !pp.lastEventId) return;
      // Same Task-8 router fallback as `tryRetract` in `handleDeleteIdentity`
      // above — in bunker mode dep slots have no local private key either, so
      // a local-key-only check would skip every retract and the dep's public
      // profile would stay live on the relay after the record is purged.
      const owned = !!slot.privateKey;
      const backend: DecryptingSigningBackend | null = owned
        ? (() => { try { return new LocalSigningBackend(slot.privateKey!); } catch { return null; } })()
        : (bunkerRouter?.backendFor(slot.publicKey) ?? null);
      if (!backend) return;
      const target = pp.lastPublishedRelay || relayUrl;
      retractions.push(
        retractPublicProfile(pp.lastEventId, backend, target, pp.lastPublishedAt)
          .finally(() => { if (owned) backend.destroy(); }),
      );
    };
    tryOne(dep.naturalPerson);
    tryOne(dep.persona);
    // If/when DependantIdentity gains a `professionalPersona` slot (mirroring
    // SignetIdentity), add `if (dep.professionalPersona) tryOne(dep.professionalPersona);`
    // here so the dep's Pro public profile gets retracted on removal too.
    // handleDeleteIdentity (line ~1738) already covers the user's own
    // professionalPersona; keeping the dep-side path symmetric on day one
    // of dep Pro-surface launch prevents an orphan kind-0 from going live
    // on the relay after the dep is removed.
    for (const ep of dep.extraPersonas ?? []) tryOne(ep);

    // B/I7: this dependant's own contacts-v2 grants are revoked AND
    // tombstoned before the record goes. Their rows survive the removal —
    // nothing else deletes them — so they are stamped `revokedAt` too, which
    // is what stops the publisher treating them as live against a directory
    // that no longer exists. The grant-set bump repaints the connected-apps
    // list and re-runs the rail so the revocations reach the owner's other
    // devices.
    const depDirectoryId = directoryIdForDependant(dep);
    retractions.push(...await tombstoneGrantsFor((g) => g.directoryId === depDirectoryId, true));
    bumpContactsGrantSet();

    if (retractions.length === 0) return;
    await Promise.race([
      Promise.allSettled(retractions),
      new Promise(resolve => setTimeout(resolve, 5_000)),
    ]).catch(() => { /* non-fatal */ });
  }, [preferences.relayUrl, bunkerRouter, tombstoneGrantsFor, bumpContactsGrantSet]);

  /**
   * Phase 2F shared publish helper. Resolves the per-slot signing backend
   * (LocalSigningBackend over the slot's privateKey for user extras / Pro /
   * any dep slot today — design §5.4 Phase D divergence: guardian publishes
   * for the dep until multi-key NIP-46 lands), calls `publishPublicProfile`,
   * and — on success only — persists the new `PersonaPublicProfile` state to
   * the slot via the identity / dependants hooks. Atomicity contract §5.1.3.
   *
   * Returns `{ ok, message }` so callers can surface relay errors verbatim
   * without throwing.
   */
  const publishPersonaProfile = useCallback(async (
    slotTarget: 'natural-person' | 'persona' | 'professional-persona' | string,
    depPubkey: string | undefined,
    opts?: { displayNameOverride?: string },
  ): Promise<{ ok: boolean; message?: string }> => {
    if (!identity) return { ok: false, message: 'No identity loaded.' };
    const relayUrl = preferences.relayUrl ?? DEFAULT_RELAY_URL;

	    // Resolve the slot config + state + signing key.
	    let slot:
	      | {
	          publicKey: string;
          privateKey: string;
          displayName: string;
          about?: string;
          pictureUrl?: string;
          pictureBlossomHash?: string;
          bannerUrl?: string;
          bannerBlossomHash?: string;
          nip05?: string;
          lud16?: string;
          website?: string;
	          publicProfile?: import('./types').PersonaPublicProfile;
	        }
	      | undefined;
	    const resolveOwnerSlot = (source: SignetIdentity) => {
	      if (slotTarget === 'natural-person') return source.naturalPerson;
	      if (slotTarget === 'persona') return source.persona;
	      if (slotTarget === 'professional-persona') return source.professionalPersona;
	      return source.extraPersonas?.find(p => p.publicKey === slotTarget);
	    };
	    if (depPubkey) {
	      const dep = dependants.find(d => d.id === depPubkey);
	      if (!dep) return { ok: false, message: 'Dependant not found.' };
	      if (slotTarget === 'natural-person') slot = dep.naturalPerson;
	      else if (slotTarget === 'persona') slot = dep.persona;
	      else slot = dep.extraPersonas?.find(p => p.publicKey === slotTarget);
	    } else {
	      slot = resolveOwnerSlot(identity);
	    }
	    if (!slot) return { ok: false, message: 'Slot not found.' };
	    if (slot.privateKey && !isValidHexKey(slot.privateKey) && !depPubkey && encryptionKey) {
	      const fresh = await loadIdentityDecrypted(identity.id, encryptionKey);
	      const freshSlot = fresh ? resolveOwnerSlot(fresh) : undefined;
	      if (freshSlot) slot = freshSlot;
	    }
	    if (slot.privateKey && !isValidHexKey(slot.privateKey)) {
	      return {
	        ok: false,
	        message: 'Unlock Signet to publish this profile.',
	      };
	    }
	    // Bunker mode (NP key stripped) or stripped extras — Phase D divergence:
	    // publishing as non-NP personas needs multi-key NIP-46 (not wired), so
	    // fall back to the router's per-slot route when the local key is gone.
	    // `routedBackend` is a SHARED, CACHED route owned by `bunkerRouter` — it
	    // must never be destroy()'d here, only a locally-constructed backend may.
	    const routedBackend = slot.privateKey ? null : (bunkerRouter?.backendFor(slot.publicKey) ?? null);
	    if (!slot.privateKey && !routedBackend) {
	      // Locked: the router is torn down on lock by design, so this is not
	      // "no signer" — ask for the unlock that brings the pairing back.
	      if (!encryptionKey) void requestAuth();
	      return {
	        ok: false,
	        message: routedSignerUnavailableMessage({
	          unlocked: !!encryptionKey,
	          signingMode: preferences.signingMode,
	          signerStatus,
	          routerProbeState,
	        }),
	      };
	    }

    // When the caller supplies a displayNameOverride (a freshly-typed name
    // that loadAll() has not yet propagated into this closure's `identity`),
    // use it for both the config displayName and the fallback. All other
    // slot fields (about,
    // picture, banner, etc.) are always sourced from the slot as normal.
    const effectiveName = (opts?.displayNameOverride && opts.displayNameOverride.trim())
      ? opts.displayNameOverride.trim()
      : slot.displayName;

    const config: import('./types').PublicProfileConfig = {
      displayName: effectiveName,
      about: slot.about,
      pictureUrl: slot.pictureUrl,
      pictureBlossomHash: slot.pictureBlossomHash,
      bannerUrl: slot.bannerUrl,
      bannerBlossomHash: slot.bannerBlossomHash,
      nip05: slot.nip05,
      lud16: slot.lud16,
      website: slot.website,
    };
    const fallbackDisplayName = effectiveName || '';

    // §5.3.3 content-hash short-circuit. Pass the hash of what was LAST
    // PUBLISHED (persisted on the slot state) — NOT the candidate config.
    // The publisher recomputes the candidate hash internally and compares.
    // A match means the kind-0 we'd emit is byte-for-byte identical to the
    // last one, so the relay round-trip is skipped. A mismatch falls
    // through to a real publish. (Earlier revision compared the candidate
    // to itself — the short-circuit always won, so every Republish silently
    // never reached the relay.)
    const priorHash = slot.publicProfile?.lastPublishedContentHash;

    const owned = !!slot.privateKey;
    const backend: DecryptingSigningBackend = owned ? new LocalSigningBackend(slot.privateKey) : routedBackend!;
    let result: import('./lib/public-profile-publish').PublishResult;
    try {
      result = await publishPublicProfile(
        config,
        slot.publicProfile,
        fallbackDisplayName,
        backend,
        relayUrl,
        priorHash,
      );
    } finally {
      if (owned) backend.destroy();
    }
    if (!result.ok) return { ok: false, message: result.message };

    // Compute the hash of the content we just emitted so the next publish
    // can short-circuit cleanly when nothing changed. Re-derives from the
    // same `config` the publisher consumed so the candidate-hash on the
    // next publish is comparing apples to apples.
    const publishedContentHash = contentHashFor(config, fallbackDisplayName);

    const newState: import('./types').PersonaPublicProfile = {
      enabled: true,
      lastEventId: result.eventId,
      lastPublishedAt: result.createdAt,
      lastPublishedRelay: result.relayUrl,
      lastPublishedContentHash: publishedContentHash,
    };
    // Pass the full slot config so the persisted slot fields align with the
    // config we just emitted. Earlier revisions passed `config: undefined`,
    // which the hook interprets as "clear all 8 slot config fields" — that
    // wiped about/picture/banner/etc. on every publish.
    if (depPubkey) {
      await setDependantPersonaPublicProfile(depPubkey, slotTarget, config, newState);
    } else {
      await setPersonaPublicProfile(slotTarget, config, newState);
    }
    return { ok: true };
	  }, [identity, dependants, preferences.relayUrl, preferences.signingMode, setPersonaPublicProfile, setDependantPersonaPublicProfile, encryptionKey, bunkerRouter, requestAuth, signerStatus, routerProbeState]);

  /**
   * Phase 2F shared retract helper. Mirror of `publishPersonaProfile`:
   * resolves the per-slot backend, fires kind-5 + tombstone-kind-0, and
   * clears the slot's `publicProfile` state on success.
   *
   * The retract publishes to `lastPublishedRelay` (where the kind-0 we're
   * deleting actually lives), falling back to the current default relay
   * only when no published-relay was recorded (legacy state). Best-effort
   * — relay outcome is surfaced via the resolved promise but the local
   * state is always cleared, mirroring the publisher's §6.7 "local can
   * always reduce" contract.
   */
  const retractPersonaProfile = useCallback(async (
    slotTarget: 'natural-person' | 'persona' | 'professional-persona' | string,
    depPubkey: string | undefined,
  ): Promise<void> => {
    if (!identity) return;
    let slot:
      | { publicKey: string; privateKey: string; publicProfile?: import('./types').PersonaPublicProfile }
      | undefined;
    if (depPubkey) {
      const dep = dependants.find(d => d.id === depPubkey);
      if (!dep) return;
      if (slotTarget === 'natural-person') slot = dep.naturalPerson;
      else if (slotTarget === 'persona') slot = dep.persona;
      else slot = dep.extraPersonas?.find(p => p.publicKey === slotTarget);
    } else {
      if (slotTarget === 'natural-person') slot = identity.naturalPerson;
      else if (slotTarget === 'persona') slot = identity.persona;
      else if (slotTarget === 'professional-persona') slot = identity.professionalPersona;
      else slot = identity.extraPersonas?.find(p => p.publicKey === slotTarget);
    }
    if (!slot) return;
    const pp = slot.publicProfile;
    if (!pp?.enabled || !pp.lastEventId) {
      // Nothing to retract on the relay; still clear local state for safety.
      // Use the dedicated clear helper — passing `config: undefined` to
      // setDependantPersonaPublicProfile would wipe all 8 slot config
      // fields (about/picture/banner/etc.), which we never want here.
      if (depPubkey) {
        await clearDependantPersonaPublicProfile(depPubkey, slotTarget);
      } else {
        await clearPersonaPublicProfile(slotTarget);
      }
      return;
    }
    const targetRelay = pp.lastPublishedRelay || preferences.relayUrl || DEFAULT_RELAY_URL;
    const ownedRetract = !!(slot.privateKey && isValidHexKey(slot.privateKey));
    // Router-sourced fallback is a SHARED, CACHED route — only a locally-
    // constructed backend (ownedRetract) may be destroy()'d below.
    const retractBackend: DecryptingSigningBackend | null = ownedRetract
      ? new LocalSigningBackend(slot.privateKey)
      : (bunkerRouter?.backendFor(slot.publicKey) ?? null);
    if (retractBackend) {
      try {
        await retractPublicProfile(pp.lastEventId, retractBackend, targetRelay, pp.lastPublishedAt);
      } catch { /* best-effort — clear local state regardless */ }
      finally { if (ownedRetract) retractBackend.destroy(); }
    }
    // State-only clear — slot config fields stay intact so the user can
    // re-enable + republish without losing their about/picture/etc.
    if (depPubkey) {
      await clearDependantPersonaPublicProfile(depPubkey, slotTarget);
    } else {
      await clearPersonaPublicProfile(slotTarget);
    }
  }, [identity, dependants, preferences.relayUrl, clearDependantPersonaPublicProfile, clearPersonaPublicProfile, bunkerRouter]);

  const handleRetryConnect = useCallback(async () => {
    if (!encryptionKey) return;
    // M1: pass the key so prefs.bunkerUri decrypts to a usable URI for the
    // reconnect calls below (bunker.reconnect(prefs.bunkerUri, ...)).
    const prefs = await getPreferences(encryptionKey);

    // Paired-child install — credentials live in PairedChildRecord, not
    // loadBunkerSecret + prefs.bunkerUri. Branch early before the
    // Heartwood path below.
    if (prefs.signingMode === 'paired-child') {
      setSignerStatus('connecting');
      // Active pairing is whichever the user is currently signed in as —
      // that's `preferences.activeAccountId`, seeded from `handlePairChild`
      // and flipped by the pairing switcher. Falls back to the identity id
      // for devices that never had multiple pairings.
      const dependantPubkey = prefs.activeAccountId ?? identity?.id ?? '';
      if (!dependantPubkey) {
        setSignerStatus(null);
        return;
      }
      const record = await loadPairedChild(dependantPubkey, encryptionKey);
      if (!record) {
        setSignerStatus(null);
        return;
      }
      if (bunkerBackend) bunkerBackend.destroy();
      const bunker = new BunkerSigningBackend(record.clientKeypair.privateKey);
      setBunkerBackend(bunker);
      try {
        if (!record.hasPaired) {
          await bunker.connect(record.bunkerUri, 30_000);
          if (bunker.activePublicKeyHex.toLowerCase() !== record.dependantPubkey.toLowerCase()) {
            bunker.destroy();
            setSignerStatus('unavailable');
            return;
          }
          await markPairedChildConnected(dependantPubkey, encryptionKey).catch(() => { /* retry next unlock */ });
          setSignerStatus('connected');
        } else {
          await bunker.reconnect(record.bunkerUri, 30_000, record.dependantPubkey);
          setSignerStatus('connected');
        }
      } catch {
        setSignerStatus('unavailable');
      }
      return;
    }

    // Heartwood bunker path.
    if (!prefs.bunkerUri) return;
    setSignerStatus('connecting');
    const clientSecret = await loadBunkerSecret(encryptionKey);
    if (!clientSecret || !prefs.bunkerUri) {
      setSignerStatus(null);
      return;
    }
    // Bump unconditionally — even if bunkerRouter is currently null, an
    // earlier create() probe may still be in flight and must not install
    // a router superseded by this retry.
    bunkerRouterGenRef.current++;
    if (bunkerRouter) {
      bunkerRouter.destroy();
      setBunkerRouter(null);
    }
    setRouterProbeState(null);
    if (bunkerBackend) bunkerBackend.destroy();
    const bunker = new BunkerSigningBackend(clientSecret);
    setBunkerBackend(bunker);
    try {
      // resendConnect: re-authorise this client into the Heartwood slot's
      // allowed-pubkey set on every reopen (see BunkerSigningBackend.reconnect).
      await bunker.reconnect(prefs.bunkerUri, 30_000, undefined, true);
      setSignerStatus('connected');
      // Probe for Heartwood per-slot routing (auto-approved; generic
      // bunkers fail the probe and stay NP-only). Capture the generation
      // before the async probe so a stale/out-of-order resolution discards
      // its result instead of reviving a superseded router.
      startRouterProbe(bunker, clientSecret);
    } catch {
      setSignerStatus('unavailable');
    }
  }, [encryptionKey, bunkerBackend, bunkerRouter]);

  // Auto-retry the kid's bunker connect when status is 'unavailable'. The
  // The subscription only delivers persona inventory if the guardian
  // actually published it — and the publisher gates on
  // `authorizedClientPubkey`, which only gets set when the bind fires.
  // The bind fires only when the kid's `bunker.connect` is ACKed by the
  // guardian. So if the guardian's app was closed / locked / Bunker off /
  // network blip at pair time, the connect fails, bind never happens, the
  // publisher silently skips this dep, and the kid stays stuck.
  //
  // Auto-retrying the connect at 10s/30s/60s/60s/… intervals means the kid
  // recovers as soon as the guardian comes back online — without the user
  // having to spot the banner and tap "Retry". As soon as the connect
  // succeeds, bind fires, publisher publishes, subscription delivers
  // personas. Only runs on paired-child surface; guardian/Heartwood paths
  // use the same `handleRetryConnect` but their failure modes are different
  // and tapping Retry manually is appropriate there.
  //
  // `handleRetryConnect` is stashed in a ref so its identity churn (it
  // depends on `bunkerBackend`, which changes every reconnect) doesn't
  // reset the backoff timer mid-wait.
  const retryConnectRef = useRef(handleRetryConnect);
  retryConnectRef.current = handleRetryConnect;
  const retryAttemptRef = useRef(0);
  useEffect(() => {
    if (signerStatus === 'connected') {
      retryAttemptRef.current = 0;
      return;
    }
    if (signerStatus !== 'unavailable') return;
    if (preferences.signingMode !== 'paired-child') return;
    if (!encryptionKey) return;
    const attempt = retryAttemptRef.current;
    const delays = [10_000, 30_000];
    const delay = delays[attempt] ?? 60_000;
    const timer = setTimeout(() => {
      retryAttemptRef.current += 1;
      void retryConnectRef.current();
    }, delay);
    return () => clearTimeout(timer);
  }, [signerStatus, preferences.signingMode, encryptionKey]);

  const handleApproveVerification = useCallback(() => {
    if (!pendingVerifyRequest) return;
    const credToUse = pickCredential(credentials, pendingVerifyRequest, Math.floor(Date.now() / 1000));
    if (!credToUse) {
      setPendingVerifyRequest(null);
      navigateReplace('home');
      return;
    }
    let parsedEvent: VerifyResponse['credential'] | null = null;
    try {
      const raw: unknown = JSON.parse(credToUse.event);
      if (typeof raw === 'object' && raw !== null) {
        const e = raw as Record<string, unknown>;
        parsedEvent = {
          id: typeof e.id === 'string' ? e.id : credToUse.id,
          kind: typeof e.kind === 'number' ? e.kind : 30470,
          pubkey: typeof e.pubkey === 'string' ? e.pubkey : '',
          tags: Array.isArray(e.tags) ? (e.tags as string[][]) : [],
          content: typeof e.content === 'string' ? e.content : '',
          sig: typeof e.sig === 'string' ? e.sig : '',
          created_at: typeof e.created_at === 'number' ? e.created_at : credToUse.verifiedAt,
        };
      }
    } catch {
      // If event parsing fails, build a minimal object from stored fields
      parsedEvent = {
        id: credToUse.id,
        kind: 30470,
        pubkey: '',
        tags: [],
        content: credToUse.event,
        sig: '',
        created_at: credToUse.verifiedAt,
      };
    }
    if (parsedEvent) {
      const subjectPubkey = activePubkey ?? '';
      const response = buildVerifyResponse(pendingVerifyRequest.requestId, parsedEvent, subjectPubkey);
      sendResponseViaBroadcast(response);
      // Cross-device flow: also publish to relay if request came with a relayUrl
      // AND a sessionPubkey to gift-wrap to. Without a recipient key we'd be
      // putting a credential on the relay in cleartext, which is no longer
      // permitted (see relay-publish.ts).
      if (pendingVerifyRequest.relayUrl && activeBackend && pendingVerifyRequest.sessionPubkey) {
        publishVerifyResponseToRelay(response, pendingVerifyRequest.relayUrl, activeBackend, pendingVerifyRequest.sessionPubkey).catch(() => {
          // Relay publish is best-effort — the same-device broadcast above
          // already delivered the response.
        });
      }
    }
    const callback = pendingVerifyRequest.callbackUrl;
    const viaUrl = verifyArrivedViaUrl;
    setPendingVerifyRequest(null);
    setVerifyArrivedViaUrl(false);
    if (viaUrl && callback && parsedEvent) {
      const response = buildVerifyResponse(pendingVerifyRequest.requestId, parsedEvent, activePubkey ?? '');
      window.location.href = buildVerifyCallbackUrl(callback, response);
      return;
    }
    navigateReplace('home');
  }, [pendingVerifyRequest, credentials, activePubkey, activeBackend, navigateReplace, verifyArrivedViaUrl]);

  const handleDenyVerification = useCallback(() => {
    // Same gift-wrap requirement as the approval path — skip the publish
    // when no sessionPubkey is available to wrap to.
    if (pendingVerifyRequest?.relayUrl && activeBackend && pendingVerifyRequest.sessionPubkey) {
      publishVerifyRejectionToRelay(pendingVerifyRequest.requestId, pendingVerifyRequest.relayUrl, activeBackend, pendingVerifyRequest.sessionPubkey).catch(() => {});
    }
    const callback = pendingVerifyRequest?.callbackUrl;
    const viaUrl = verifyArrivedViaUrl;
    setPendingVerifyRequest(null);
    setVerifyArrivedViaUrl(false);
    if (viaUrl && callback) {
      window.location.href = buildVerifyDeniedUrl(callback);
      return;
    }
    navigateReplace('home');
  }, [pendingVerifyRequest, activeBackend, navigateReplace, verifyArrivedViaUrl]);

  const handleNostrConnect = useCallback((data: string): boolean => {
    const request = parseNostrConnectURI(data);
    if (!request) return false;
    setPendingConnectRequest(request);
    navigateReplace('approve-connect');
    return true;
  }, [navigateReplace]);

  // After a Sign-in (or NIP-46 connect) approval, land the home carousel on
  // the card that matches the user's selection — visual confirmation of which
  // persona / dependant they just signed in with. Without this, the carousel
  // stays where it was at scan time, which can leave the user looking at a
  // dependant card after signing as guardian (or vice versa) and second-
  // guessing what they just authorized.
  //
  // Child-mode is silently exited when the selection escapes the locked
  // dependant. The auth picker already lets the user pick guardian or any
  // dependant from inside child-mode (existing behaviour), so the visual
  // lock is cosmetic at that point — we make it match the selection.
  const alignCarouselToApprovedSelection = useCallback((selection: AuthSelection) => {
    if (!identity) return;
    if (selection.source === 'guardian') {
      if (carousel.childMode) {
        carousel.exitChildMode();
        clearChildModeSession().catch(() => {});
      }
      setActiveDependantId(null);
      // Guardian's persona/extras are separate rows in the parent ring, so
      // the landing card itself conveys the keypair — no ack chip needed.
      setRecentSignInAck(null);
      carousel.commitPosition(findRowForGuardianKeypair(identity, selection.keypairType, botInventory), 0);
      return;
    }
    if (carousel.childMode) {
      carousel.exitChildMode();
      clearChildModeSession().catch(() => {});
    }
    setActiveDependantId(selection.dependantId);
    // Resolve the persona/extra display name when the dep selection is a
    // non-NP keypair. Drives the transient ack chip on the dep card so the
    // user can confirm which of Sara's personas they just signed in with —
    // the parent ring doesn't expose dep persona rows. Dep-NP signs need
    // no chip (the dep card itself is the right answer).
    let ackLabel: string | null = null;
    if (selection.keypairType !== 'natural-person') {
      const targetDep = dependants.find(d => d.id === selection.dependantId);
      if (targetDep) {
        if (selection.keypairType === 'persona' && targetDep.persona.publicKey) {
          ackLabel = targetDep.persona.displayName || 'Persona';
        } else {
          const ep = targetDep.extraPersonas?.find(e => e.publicKey === selection.keypairType);
          if (ep) ackLabel = ep.displayName || 'Persona';
        }
      }
    }
    setRecentSignInAck(ackLabel ? { dependantId: selection.dependantId, label: ackLabel } : null);
    const targetRow = findRowForDependant(identity, dependants, selection.dependantId, botInventory);
    if (targetRow !== null) carousel.commitPosition(targetRow, 0);
  }, [identity, dependants, botInventory, carousel.childMode, carousel.exitChildMode, carousel.commitPosition, setActiveDependantId]);

  // Auto-clear the transient sign-in ack chip after a few seconds. Long enough
  // for the user to register the confirmation, short enough that it doesn't
  // linger when they swipe to do something else.
  const RECENT_SIGN_IN_ACK_TTL_MS = 5000;
  useEffect(() => {
    if (!recentSignInAck) return;
    const t = setTimeout(() => setRecentSignInAck(null), RECENT_SIGN_IN_ACK_TTL_MS);
    return () => clearTimeout(t);
  }, [recentSignInAck]);

  /**
   * Resolve an AuthSelection → SigningBackend, then publish the NIP-46
   * connect response. Mirrors handleApproveAuth's resolution (building a
   * temporary LocalSigningBackend from raw private-key material for
   * extra-personas and dependants) so the companion app receives a
   * response signed by the SELECTED keypair, not whatever activeBackend
   * happened to be. The previous naive fall-through to activeBackend
   * silently returned NP's pubkey whenever the user picked an extra
   * persona from the picker — matchpass-app and similar consumers
   * rejected those because the pubkey didn't match their whitelist.
   */
  // Honest copy for a device-held slot whose route is not (yet) there, read
  // from the LIVE signer state — an approval that waited sees the state the
  // wait ended in, not the one it started from.
  const routedApprovalUnavailableMessage = useCallback(() => routedSignerUnavailableMessage({
    unlocked: !!encryptionKeyRef.current,
    signingMode: preferences.signingMode,
    signerStatus: signerStatusRef.current,
    routerProbeState: routerProbeStateRef.current,
  }), [preferences.signingMode]);

  const assertApprovalStillPending = useCallback((request: AuthRequest | LoginRequest) => {
    if (pendingAuthRequestRef.current !== request) {
      throw new Error('This sign-in request is no longer pending.');
    }
  }, []);

  // Bounded wait for a device-held slot's route after an unlock / signer
  // reconnect. Gives up early when the signer says it cannot route personas,
  // the app locks again, or the request is withdrawn — never hangs.
  const waitForApprovalRoute = useCallback((slotPubkey: string, stillPending: () => boolean) => (
    awaitRoutedBackend<SigningBackend>({
      lookup: () => (signerStatusRef.current === 'connected'
        ? bunkerRouterRef.current?.backendFor(slotPubkey) ?? null
        : null),
      isHopeless: () => !encryptionKeyRef.current
        || routerProbeStateRef.current === 'unsupported'
        || !stillPending(),
      timeoutMs: ROUTED_APPROVAL_WAIT_MS,
    })
  ), []);

  // Guardian slots: the route, or an honest error (unavailable / withdrawn).
  const acquireApprovalRoute = useCallback((slotPubkey: string, stillPending: () => boolean, withdrawnMessage: string) => (
    acquireRoutedBackend<SigningBackend>({
      lookup: () => (signerStatusRef.current === 'connected'
        ? bunkerRouterRef.current?.backendFor(slotPubkey) ?? null
        : null),
      isHopeless: () => !encryptionKeyRef.current || routerProbeStateRef.current === 'unsupported',
      stillPending,
      unavailableMessage: routedApprovalUnavailableMessage,
      withdrawnMessage,
    })
  ), [routedApprovalUnavailableMessage]);

  const approveConnectUnguarded = useCallback(async (sel: AuthSelection) => {
    if (!pendingConnectRequest || !identity) throw new Error('No pending connect request');
    const connectRequest = pendingConnectRequest;
    const connectKey = requestObjectKey(connectRequest);
    const connectStillPending = () => pendingConnectRequestRef.current === connectRequest;
    // Still this request AND its approval not taken over by a Cancel/Deny.
    const connectStillOpen = () => connectStillPending()
      && connectSettlementRef.current.isInFlight(connectKey);

    // Autonomy-stage gate. When we're acting as
    // a dependant (child mode), the guardian's chosen stage decides
    // whether this sign-off proceeds silently, needs a fresh PIN, or is
    // blocked entirely. No-op when the guardian themselves is signing.
    if (activeDependant) {
      const decision = checkAutonomy(activeDependant.autonomyStage);
      if (decision.kind === 'block') throw new Error(decision.message);
      if (decision.kind === 'require-pin') {
        const key = await requestFreshAuth();
        if (!key) throw new Error('Guardian approval cancelled');
      }
    }

    let selectedBackend: SigningBackend;
    let tempBackend: LocalSigningBackend | null = null;
    let tempBackendRetainedForRoute = false;

    if (sel.source === 'dependant') {
      const dep = dependants.find(d => d.id === sel.dependantId);
      if (!dep) throw new Error('Dependant not found');
      if (dep.encrypted) throw new Error('Dependant keys are encrypted');
      let privKey: string;
      let depSlotPubkey: string;
      if (sel.keypairType === 'natural-person') {
        privKey = dep.naturalPerson.privateKey;
        depSlotPubkey = dep.naturalPerson.publicKey;
      } else if (sel.keypairType === 'persona') {
        privKey = dep.persona.privateKey;
        depSlotPubkey = dep.persona.publicKey;
      } else {
        const ep = (dep.extraPersonas ?? []).find(e => e.publicKey === sel.keypairType);
        if (!ep) throw new Error('Extra persona not found');
        privKey = ep.privateKey;
        depSlotPubkey = ep.publicKey;
      }
      if (privKey) {
        tempBackend = new LocalSigningBackend(privKey);
        selectedBackend = tempBackend;
      } else {
        // No local key material for this dep slot (post-strip §11.1.2, or
        // never stored locally) — fall back to the routed per-slot bunker
        // backend. NOT assigned to `tempBackend`: `BunkerBackendRouter`
        // caches routes internally and reuses them across approvals, so
        // destroying it in this handler's `finally` (as happens to
        // `tempBackend`) would poison every later signing over that route
        // for the lifetime of the router. Only genuinely-owned, one-shot
        // local backends go through `tempBackend`.
        const routed = bunkerRouter?.backendFor(depSlotPubkey)
          ?? (preferences.signingMode === 'bunker' ? await waitForApprovalRoute(depSlotPubkey, connectStillPending) : null);
        if (routed) {
          selectedBackend = routed;
        } else if (preferences.signingMode === 'bunker') {
          // Device-held dependant slot: no local key to fall back to.
          throw new Error(routedApprovalUnavailableMessage());
        } else {
          // Neither local key nor a routed bunker fallback — surface the
          // same error the pre-routing code produced for empty/missing key
          // material (LocalSigningBackend's constructor validates and throws).
          tempBackend = new LocalSigningBackend(privKey);
          selectedBackend = tempBackend;
        }
      }
    } else {
      const isNP = sel.keypairType === 'natural-person';
      const isBuiltInPersona = sel.keypairType === 'persona';
      const isExtraPersona = !isNP && !isBuiltInPersona;

      // A ready remote/local backend covers NP (bunker/nip07/local) or the
      // built-in persona (local) without needing raw key material here.
      const selectedSlotPubkey = isNP
        ? identity.naturalPerson.publicKey
        : isBuiltInPersona
          ? identity.persona.publicKey
          : sel.keypairType;
      const connectedBunker = signerStatus === 'connected'
        && !isImportedGuardianPersona(identity, selectedSlotPubkey)
        // NP is a derived persona on the family bunker — route it too, not the
        // master-bound primary (an earlier hardware finding). backendFor collapses
        // to the primary when NP==master (legacy NP-only bunker).
        ? (bunkerRouter?.backendFor(selectedSlotPubkey) ?? (isNP ? npBunkerBackend : null))
        : null;
      const ext = isNP ? nip07Backend : null;
      const readyBackend = connectedBunker ?? ext
        ?? (isBuiltInPersona ? backends?.persona : isNP ? backends?.naturalPerson : null)
        ?? null;

      // Same device-held rule as sign-in: local key material wins when
      // present, but its absence waits (bounded) for the signer's route.
      const deviceHeld = (preferences.signingMode === 'bunker' || preferences.signingMode === 'paired-child')
        && !isImportedGuardianPersona(identity, selectedSlotPubkey);

      if (readyBackend) {
        selectedBackend = readyBackend;
      } else {
        let guardianIdentity = identity;
        tempBackend = resolveGuardianBackend(sel.keypairType, guardianIdentity);
        if (!tempBackend) {
          // Same auto-lock recovery as handleApproveAuth: if the app locked
          // while this connect approval was open, `identity` may be public-only
          // or simply stale while the freshly-unlocked identity is still being
          // rebuilt. Re-acquire auth and fresh-decrypt before failing.
          const key = encryptionKey || await requestAuth();
          if (!key) {
            throw new Error(deviceHeld ? routedApprovalUnavailableMessage() : 'Authentication required');
          }
          if (!connectStillPending()) throw new Error('This connection request is no longer pending.');
          const fresh = await loadIdentityDecrypted(guardianIdentity.id, key);
          if (fresh) guardianIdentity = fresh;
          tempBackend = resolveGuardianBackend(sel.keypairType, guardianIdentity);
        }
        if (tempBackend) {
          selectedBackend = tempBackend;
        } else if (deviceHeld) {
          // Router-owned and cached — never assigned to tempBackend.
          selectedBackend = await acquireApprovalRoute(selectedSlotPubkey, connectStillPending, 'This connection request is no longer pending.');
        } else {
          throw new Error(isExtraPersona
            ? 'Extra persona key is not available — please unlock first'
            : 'Identity keys are not yet decrypted — please unlock first');
        }
      }
    }

    try {
      // The resolution above may have awaited an unlock or a reconnect.
      if (!connectStillPending()) throw new Error('This connection request is no longer pending.');
      assertSigningIdentity(selectedBackend, resolveSelectedPubkey(sel, identity, dependants));
      const routeBackend = requireNostrConnectRouteBackend(selectedBackend);
      const relayCandidates = (pendingConnectRequest.relayUrls?.length
        ? pendingConnectRequest.relayUrls
        : [pendingConnectRequest.relayUrl])
        .filter((relay, idx, arr) => relay.length > 0 && arr.indexOf(relay) === idx);
      const relayOpenTimeoutMs = relayCandidates.length > 1
        ? NOSTRCONNECT_MULTI_RELAY_OPEN_TIMEOUT_MS
        : NOSTRCONNECT_SINGLE_RELAY_OPEN_TIMEOUT_MS;

      // Every outward effect (route, listener, persisted pairing, connect
      // response) is gated on the one-answer guard; a Cancel during any of
      // it tears down what this approval set up and sends nothing. The
      // rollback is scoped to THIS approval: its route install token and the
      // nonce on the record it saved.
      const pairingNonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
      let installedRouteToken: number | null = null;
      const delivery = await deliverConnectApproval({
        relayCandidates,
        stillOpen: connectStillOpen,
        claim: () => connectStillPending() && connectSettlementRef.current.claimDelivery(connectKey),
        unclaim: () => connectSettlementRef.current.unclaimDelivery(connectKey),
        finishDelivery: () => connectSettlementRef.current.finishDelivery(connectKey),
        installRoute: () => {
          tempBackendRetainedForRoute = tempBackend === routeBackend;
          installedRouteToken = installNostrConnectTransientRoute(routeBackend, tempBackendRetainedForRoute);
          connectRouteTrackerRef.current.record(connectKey, installedRouteToken);
        },
        clearRoute: () => {
          if (installedRouteToken !== null) clearNostrConnectTransientRouteByToken(installedRouteToken);
        },
        arm: (relayUrl) => armNostrConnectServe(routeBackend.activePublicKeyHex, relayUrl, relayOpenTimeoutMs),
        loadExisting: () => getConnectedClient(connectRequest.clientPubkey),
        restoreClient: (previous) => saveConnectedClient(previous),
        saveClient: (relayUrl) => saveConnectedClient({
          ...buildConnectedClientFromNostrConnect({
            ...connectRequest,
            relayUrl,
            relayUrls: relayCandidates,
          }),
          pairingNonce,
        }),
        stillOurs: async () => (await getConnectedClient(connectRequest.clientPubkey))?.pairingNonce === pairingNonce,
        deleteClient: () => deleteConnectedClient(connectRequest.clientPubkey),
        // Encrypt + sign first (for a device-held key that opens the routed
        // connection and takes seconds); the claim guards only the publish.
        send: (relayUrl, beforePublish) => sendConnectResponse(connectRequest, selectedBackend, relayUrl, async () => {
          if (!beforePublish()) throw new ConnectWithdrawnError();
        }),
      });

      if (delivery.status === 'withdrawn' || delivery.status === 'cancelled') return;
      if (delivery.status === 'failed') {
        const relayFailures = delivery.failures;
        const attempts = relayFailures.length > 0 ? relayFailures.join(' | ') : 'no valid relay candidates';
        throw new Error(`Could not complete NostrConnect pairing. Tried ${relayFailures.length} relay${relayFailures.length === 1 ? '' : 's'}: ${attempts}`);
      }

      // Connected: the route now serves the new pairing, so a later Cancel
      // on this request must leave it alone.
      connectRouteTrackerRef.current.forget(connectKey);

      // Capture the callback before state is cleared — the setTimeout
      // below closes over the value at resolution time, not at queue time.
      const callback = pendingConnectCallback;
      // Delay so the user briefly sees the "Connected!" state before we close.
      setTimeout(() => {
        // A newer request that arrived meanwhile is not this one's to clear.
        if (pendingConnectRequestRef.current !== connectRequest) return;
        setPendingConnectRequest(null);
        setPendingConnectSelection(null);
        setPendingConnectCallback(null);
        if (callback) {
          // Bounce the user back to the companion app.
          window.location.href = buildCallbackRedirect(callback, 'approved');
          return;
        }
        alignCarouselToApprovedSelection(sel);
        navigateReplace('home');
      }, 1500);
    } finally {
      if (tempBackend && !tempBackendRetainedForRoute) tempBackend.destroy();
    }
  }, [pendingConnectRequest, pendingConnectCallback, identity, dependants, activeDependant, backends, bunkerBackend, bunkerRouter, npBunkerBackend, nip07Backend, signerStatus, navigateReplace, requestFreshAuth, requestAuth, encryptionKey, alignCarouselToApprovedSelection, armNostrConnectServe, installNostrConnectTransientRoute, preferences.signingMode, waitForApprovalRoute, routedApprovalUnavailableMessage, acquireApprovalRoute, clearNostrConnectTransientRouteByToken, setPendingConnectRequest]);

  // One answer per connect request, as for sign-in: starts the in-flight
  // approval synchronously, dismisses a request already answered, and reopens
  // it for retry/cancel if the approval failed without connecting.
  const handleApproveConnect = useCallback(async (sel: AuthSelection) => {
    const request = pendingConnectRequestRef.current;
    if (!request) throw new Error('No pending connect request');
    const key = requestObjectKey(request);
    const began = connectSettlementRef.current.beginApproval(key);
    if (began === 'settled') {
      setPendingConnectRequest(null);
      setPendingConnectSelection(null);
      setPendingConnectCallback(null);
      navigateReplace('home');
      return;
    }
    if (began === 'in-flight') throw new Error('Already connecting this request.');
    try {
      await approveConnectUnguarded(sel);
    } finally {
      connectSettlementRef.current.endApproval(key);
    }
  }, [approveConnectUnguarded, navigateReplace, setPendingConnectRequest]);

  const handleConnectDone = useCallback(() => {
    const request = pendingConnectRequestRef.current;
    if (request) {
      // Cancel/Deny/back chevron takes over an in-flight connect (its later
      // claim fails and it tears down what it armed). A request already
      // answered is dismissed without a second, contradictory callback.
      const key = requestObjectKey(request);
      const outcome = connectSettlementRef.current.deny(key);
      const cancelRecorded = outcome === 'already-answered'
        // A connect response already on its way: the approval undoes the
        // pairing once that send resolves (see connect-delivery).
        && connectSettlementRef.current.requestCancelDuringDelivery(key);
      // Stop serving an abandoned approval's route now, not when the approval
      // next reaches a checkpoint (a routed sign or relay arm can take seconds).
      const routeToken = connectRouteTrackerRef.current.takeOnCancel(key, outcome, cancelRecorded);
      if (routeToken !== null) clearNostrConnectTransientRouteByToken(routeToken);
      if (outcome === 'already-answered') {
        setPendingConnectRequest(null);
        setPendingConnectSelection(null);
        setPendingConnectCallback(null);
        navigateReplace('home');
        return;
      }
    }
    const callback = pendingConnectCallback;
    setPendingConnectRequest(null);
    setPendingConnectSelection(null);
    setPendingConnectCallback(null);
    if (callback) {
      // Deny path — also redirect back with a status indicator so the
      // companion app can show a "user cancelled" state.
      window.location.href = buildCallbackRedirect(callback, 'denied');
      return;
    }
    navigateReplace('home');
  }, [pendingConnectCallback, navigateReplace, setPendingConnectRequest, clearNostrConnectTransientRouteByToken]);

  const handleDenyCompanionGrant = useCallback(() => {
    setPendingPairingRequest(null);
    navigateReplace('companion-apps');
  }, [navigateReplace]);

  /**
   * Approve a companion-rail pairing request: derive the per-app rail key,
   * persist the grant, publish the ack back to the requesting app over the
   * rendezvous relay, and publish the first snapshot immediately (rather
   * than waiting for `useCompanionRail`'s debounced publish-on-change).
   */
  const handleApproveCompanionGrant = useCallback(async (scope: GrantScope) => {
    const req = pendingPairingRequest;
    const mnemonic = identity?.mnemonic;
    if (!req || !identity || !mnemonic || !encryptionKey) throw new Error('No pending pairing request');
    const snapshotRelay = preferences.relayUrl ?? DEFAULT_RELAY_URL;

    // 1) Derive the per-app rail key (deterministic — re-pairing the same
    // app after a phone loss re-derives the same key) and persist the grant.
    const rail = deriveRailKeypair(mnemonic, req.appPubkey);
    const railBackend = new LocalSigningBackend(rail.privateKey);
    try {
      await saveCompanionGrant({
        appPubkey: req.appPubkey,
        appName: req.appName,
        railPubkey: rail.publicKey,
        snapshotRelay,
        scope,
        createdAt: Math.floor(Date.now() / 1000),
      });

      // Register the new backend immediately (functional update — never drops
      // whatever the unlock-time rebuild effect already derived) so
      // useCompanionRail's publish-on-change hook covers this grant without
      // waiting for the next unlock. M2 — a re-pair of an already-paired app
      // re-derives the SAME rail key (deterministic), but destroy whatever
      // backend instance was already sitting at this appPubkey before
      // overwriting it, for the same key-hygiene reason every other
      // superseded backend in this file is destroyed rather than dropped.
      setRailBackends(prev => {
        prev.get(req.appPubkey)?.destroy();
        return new Map(prev).set(req.appPubkey, railBackend);
      });
      await reloadCompanionGrantCount();

      // 2) Publish the pairing ack to the rendezvous relay. Ephemeral author —
      // the companion app learns the derived rail pubkey (inside the
      // encrypted content) but never which of the user's real keys approved it.
      const ephemeral = new LocalSigningBackend(generateBunkerClientSecret());
      try {
        const ackContent = await buildPairingAckContent(
          { v: 1, railPubkey: rail.publicKey, dTag: SNAPSHOT_D_TAG, snapshotRelay, grantedScope: scope, challenge: req.challenge },
          ephemeral, req.appPubkey,
        );
        const ackEvent = await ephemeral.signEvent({
          kind: ACK_KIND,
          pubkey: ephemeral.activePublicKeyHex,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', req.appPubkey]],
          content: ackContent,
        });
        const rendezvous = new RelayClient(req.rendezvousRelay);
        try {
          await rendezvous.connect();
          await rendezvous.publish(ackEvent);
        } catch {
          // Best-effort — the companion app retries pairing on its own timeout.
        } finally {
          rendezvous.disconnect();
        }
      } finally {
        // Scrub the ephemeral privkey — same key-hygiene convention as every
        // other transient LocalSigningBackend in this file (see e.g.
        // handleConnectSigner's `bunker.destroy()` above).
        ephemeral.destroy();
      }

      // 3) Publish the first snapshot right away so the companion app sees
      // data immediately, instead of waiting for the debounced publish-on-
      // change hook to pick up the newly-registered rail backend. Best-effort
      // (kenspeckle 0.2.0 companion-rail maintainer finding): the grant is
      // already saved and the ack already sent above, so a snapshot failure
      // here (e.g. buildGrantEnvelope rejecting one bad contact) must not
      // fail the whole approval — useCompanionRail's debounced publish-on-
      // change picks the grant up on the very next mutation/unlock anyway.
      try {
        const owners = identityKeypairs(identity);
        // No sanitising/dropping here — publishSnapshot -> filterByScope
        // (companion-rail.ts) sanitises addedAt and drops what it can't
        // make valid, for contacts AND kens alike.
        const contactEntries = (await Promise.all(owners.map(pk => getContacts(pk, encryptionKey)))).flat().map(contactToKindredEntry);
        const kenEntries = (await Promise.all(owners.map(pk => getKens(pk)))).flat();
        await publishSnapshot(scope, [...contactEntries, ...kenEntries], Math.floor(Date.now() / 1000), railBackend, req.appPubkey, snapshotRelay);
      } catch { /* non-fatal — the debounced publish-on-change hook retries */ }

      setPendingPairingRequest(null);
      navigateReplace('companion-apps');
    } catch (err) {
      // Any failure past this point (saveCompanionGrant or later) leaves
      // railBackend un-destroyed — it's a freshly-derived key that nothing
      // else references yet. Scrub it and drop it from railBackends (if the
      // failure happened after registration) rather than leaving a
      // zeroed-out backend live in state; the key is deterministically
      // re-derivable, so a retried approval re-creates it identically.
      railBackend.destroy();
      setRailBackends(prev => {
        if (prev.get(req.appPubkey) !== railBackend) return prev;
        const next = new Map(prev);
        next.delete(req.appPubkey);
        return next;
      });
      throw err;
    }
  }, [pendingPairingRequest, identity, encryptionKey, preferences.relayUrl, navigateReplace, reloadCompanionGrantCount]);

  /**
   * Revoke a companion-app grant from the CompanionApps list: derive the
   * same per-app rail key used to publish snapshots, publish the tombstone
   * + best-effort kind-5, and delete the local grant record
   * (`revokeCompanionGrant`, companion-rail.ts). Re-derives rather than
   * reusing `railBackends.get` — same deterministic-derivation convention
   * as `handleApproveCompanionGrant` — and scrubs the transient key
   * afterward (this backend isn't retained; the entry it might have
   * shadowed in `railBackends` is dropped below instead).
   */
  const handleRevoke = useCallback(async (grant: CompanionGrant) => {
    const mnemonic = identity?.mnemonic;
    if (!mnemonic) return;
    // I2 — drop (and destroy) the live rail backend from the map BEFORE
    // revoking, not after. useCompanionRail's debounced publish-on-change
    // effect reads this map; if it fires mid-revoke while the entry is
    // still live, it can publish a fresh (non-revoked) snapshot and write
    // back a new lastPayloadHash right after (or while) revokeCompanionGrant
    // tombstones/deletes the grant, resurrecting it. Removing the backend
    // first means that race can no longer find a live backend to publish
    // with (see also useCompanionRail's own revokedAt/gone re-check).
    setRailBackends(prev => {
      const next = new Map(prev);
      next.get(grant.appPubkey)?.destroy();
      next.delete(grant.appPubkey);
      return next;
    });
    const backend = new LocalSigningBackend(deriveRailKeypair(mnemonic, grant.appPubkey).privateKey);
    try {
      await revokeCompanionGrant(grant, backend, preferences.relayUrl ?? DEFAULT_RELAY_URL);
    } finally {
      backend.destroy();
    }
    await reloadCompanionGrantCount();
  }, [identity, preferences.relayUrl, reloadCompanionGrantCount]);


  // Clear every piece of per-request approval state (no answer is sent).
  const retireAuthRequestState = useCallback(() => {
    setPendingAuthRequest(null);
    setPendingAuthSelection(null);
    setOriginalAuthUrl(null);
    setUrlAuthSiteName('');
    setConsumerHint(null);
    setConsumerWarnings([]);
    setConsumerDisplayName(null);
    setPendingPostUrl(null);
  }, [setPendingAuthRequest]);

  // Delivery gates (see AuthRequestSettlement). `still open` is a check for
  // work that must not happen for a denied/withdrawn request; `claim` takes
  // the request's one delivery and must immediately precede it.
  const authDeliveryStillOpen = useCallback((request: AuthRequest | LoginRequest) => (
    pendingAuthRequestRef.current === request
      && authSettlementRef.current.isInFlight(authRequestKey(request))
  ), []);
  const claimAuthDelivery = useCallback((request: AuthRequest | LoginRequest) => (
    pendingAuthRequestRef.current === request
      && authSettlementRef.current.claimDelivery(authRequestKey(request))
  ), []);

  const approveAuthUnguarded = useCallback(async (selection: AuthSelection, shareHandle: boolean = false) => {
    if (!pendingAuthRequest || !identity) throw new Error('No pending auth request');
    const request = pendingAuthRequest;

    // Autonomy-stage gate. Block / PIN-gate /
    // allow based on the active dependant's autonomyStage. Fires only
    // when child-mode is active AND the selection targets the dependant
    // (a guardian signing as themselves goes through unchecked).
    if (activeDependant && selection.source === 'dependant' && selection.dependantId === activeDependant.id) {
      const decision = checkAutonomy(activeDependant.autonomyStage);
      if (decision.kind === 'block') throw new Error(decision.message);
      if (decision.kind === 'require-pin') {
        // Surface guardian-approval context so the second PIN prompt is
        // visually + verbally distinct from the initial app unlock.
        // Site name comes from URL-auth (urlAuthSiteName) or the request's
        // origin host. Action description is the operation type from the
        // pending request.
        let depActionSiteName = urlAuthSiteName;
        if (!depActionSiteName) {
          try { depActionSiteName = new URL(pendingAuthRequest.origin).hostname; }
          catch { depActionSiteName = pendingAuthRequest.origin.slice(0, 64); }
        }
        const depActionDescription = pendingAuthRequest.type === 'signet-login-request'
          ? 'sign in and present a credential'
          : 'sign in';
        const key = await requestFreshAuth({
          purpose: 'guardian-approve-dep-action',
          depName: activeDependant.displayName,
          actionDescription: depActionDescription,
          siteName: depActionSiteName,
        });
        if (!key) throw new Error('Guardian approval cancelled');
      }
    }

    let selectedBackend: SigningBackend;
    let tempBackend: LocalSigningBackend | null = null;
    let tempBackendRetainedForRoute = false;

    if (selection.source === 'dependant') {
      // Acquire a fresh-decrypted dependant record at the moment of signing.
      // The React-state `dependants` array can hold ciphertext records if
      // the auto-lock fired between scan and approve and the user has just
      // re-unlocked — `useDependants.loadDependants` is async, so for a
      // window after `encryptionKey` flips back to non-null the closure
      // still sees the pre-unlock ciphertext array and we'd throw
      // "Dependant keys are encrypted" with the silent catch bouncing the
      // user to the picker. `loadFreshDependants` is the hook's imperative
      // fresh-decrypt for exactly this case (see its doc in useDependants.ts).
      const key = encryptionKey || await requestAuth();
      if (!key) throw new Error('Authentication required');
      const freshDeps = await loadFreshDependants(key);
      const dep = freshDeps.find(d => d.id === selection.dependantId);
      if (!dep) throw new Error('Dependant not found');
      if (dep.encrypted) throw new Error('Dependant keys are encrypted');

      // Resolve which private key to use from the selection's keypairType —
      // which `resolveSigningSelection` took from the shared acting-slot
      // resolver, so it is the slot the card showed the user.
      let privKey: string;
      let depSlotPubkey: string;
      if (selection.keypairType === 'natural-person') {
        privKey = dep.naturalPerson.privateKey;
        depSlotPubkey = dep.naturalPerson.publicKey;
      } else if (selection.keypairType === 'persona') {
        privKey = dep.persona.privateKey;
        depSlotPubkey = dep.persona.publicKey;
      } else {
        const ep = (dep.extraPersonas ?? []).find(e => e.publicKey === selection.keypairType);
        if (!ep) throw new Error('Extra persona not found');
        privKey = ep.privateKey;
        depSlotPubkey = ep.publicKey;
      }
      if (privKey) {
        tempBackend = new LocalSigningBackend(privKey);
        selectedBackend = tempBackend;
      } else {
        // No local key material for this dep slot — fall back to the routed
        // per-slot bunker backend. NOT assigned to `tempBackend`: the router
        // caches routes and reuses them across approvals, so destroying it
        // in this handler's unconditional `finally` (as happens to
        // `tempBackend`) would poison every later signing over that route.
        const routed = bunkerRouter?.backendFor(depSlotPubkey)
          ?? (preferences.signingMode === 'bunker' ? await waitForApprovalRoute(depSlotPubkey, () => pendingAuthRequestRef.current === request) : null);
        if (routed) {
          selectedBackend = routed;
        } else if (preferences.signingMode === 'bunker') {
          // Device-held dependant slot: no local key to fall back to.
          throw new Error(routedApprovalUnavailableMessage());
        } else {
          // Neither local key nor a routed bunker fallback — surface the
          // same error the pre-routing code produced for empty/missing key
          // material (LocalSigningBackend's constructor validates and throws).
          tempBackend = new LocalSigningBackend(privKey);
          selectedBackend = tempBackend;
        }
      }
    } else {
      // Guardian's own keypair.
      // keypairType is 'natural-person' | 'persona' | <extra-persona pubkey hex>
      const isNP = selection.keypairType === 'natural-person';
      const isBuiltInPersona = selection.keypairType === 'persona';
      const isExtraPersona = !isNP && !isBuiltInPersona;

      // A ready remote/external/local backend covers NP (bunker/nip07/local)
      // or the built-in persona (local) without needing raw key material here.
      // Extra personas are always local — they fall through to resolution below.
      const selectedSlotPubkey = isNP
        ? identity.naturalPerson.publicKey
        : isBuiltInPersona
          ? identity.persona.publicKey
          : selection.keypairType;
      const connectedBunker = signerStatus === 'connected'
        && !isImportedGuardianPersona(identity, selectedSlotPubkey)
        // NP is a derived persona on the family bunker — route it too, not the
        // master-bound primary (an earlier hardware finding). backendFor collapses
        // to the primary when NP==master (legacy NP-only bunker).
        ? (bunkerRouter?.backendFor(selectedSlotPubkey) ?? (isNP ? npBunkerBackend : null))
        : null;
      const ext = isNP ? nip07Backend : null;
      const readyBackend = connectedBunker ?? ext
        ?? (isBuiltInPersona ? backends?.persona : isNP ? backends?.naturalPerson : null)
        ?? null;

      // A slot whose key lives on the paired signer (stripped by the Heartwood
      // migration, or accepted keyless): local key material is used when it
      // happens to be present, but its absence is never a local-key dead end.
      const deviceHeld = (preferences.signingMode === 'bunker' || preferences.signingMode === 'paired-child')
        && !isImportedGuardianPersona(identity, selectedSlotPubkey);

      if (readyBackend) {
        selectedBackend = readyBackend;
      } else {
        let guardianIdentity = identity;
        tempBackend = resolveGuardianBackend(selection.keypairType, guardianIdentity);
        if (!tempBackend) {
          // No ready backend. If the app auto-locked while this approval screen
          // was open — or the user just unlocked and React state has not yet
          // caught up — fresh-decrypt the guardian identity from IDB at the
          // moment of signing instead of throwing a dead-end locked-keys error.
          // For a device-held slot the unlock is what brings the pairing (and
          // the per-persona router) back; the wait below picks the route up.
          const key = encryptionKey || await requestAuth();
          if (!key) {
            throw new Error(deviceHeld
              ? routedApprovalUnavailableMessage()
              : 'Authentication required');
          }
          assertApprovalStillPending(request);
          const fresh = await loadIdentityDecrypted(guardianIdentity.id, key);
          if (fresh) guardianIdentity = fresh;
          tempBackend = resolveGuardianBackend(selection.keypairType, guardianIdentity);
        }
        if (tempBackend) {
          selectedBackend = tempBackend;
        } else if (deviceHeld) {
          // Router-owned and cached — never assigned to tempBackend, so the
          // finally below cannot destroy a route later approvals reuse.
          selectedBackend = await acquireApprovalRoute(selectedSlotPubkey, () => pendingAuthRequestRef.current === request, 'This sign-in request is no longer pending.');
        } else {
          throw new Error(isExtraPersona
            ? 'Extra persona key is not available — please unlock first'
            : 'Identity keys are not yet decrypted — please unlock first');
        }
      }
    }

    try {
      // The resolution above may have awaited an unlock or a reconnect.
      assertApprovalStillPending(request);
      assertSigningIdentity(selectedBackend, resolveSelectedPubkey(selection, identity, dependants));
      const pubkey = selectedBackend.activePublicKeyHex;

      // Sign the challenge (empty string for nostr+connect flows that have no challenge)
      const challenge = pendingAuthRequest.challenge ?? '';
      if (!challenge) throw new Error('No challenge to sign');

      // Both modes use the same signing ceremony — a kind-21236 Signet-ephemeral event.
      // Redirect mode sends the signature + event ID via URL params; relay mode
      // publishes the full signed event via NIP-17 gift-wrap. One ceremony, two deliveries.
      const relayUrl = pendingAuthRequest.relay;
      const sessionPubkey = pendingAuthRequest.sessionPubkey;
      const isRelayMode = !!(relayUrl && sessionPubkey);

      // Resolve display name for site authorisation and ack screen
      let siteName = urlAuthSiteName;
      if (!siteName) {
        try { siteName = new URL(pendingAuthRequest.origin).hostname; }
        catch { siteName = pendingAuthRequest.origin.slice(0, 64); }
      }
      const keypairLabel = authSelectionLabel(selection);

      // Resolve the picked persona's local display-name + token so we can
      // honour the user's shareHandle choice in the redirect-back URL.
      const pickedToken: 'natural-person' | 'persona' | 'extra-persona' =
        selection.keypairType === 'natural-person' ? 'natural-person'
        : selection.keypairType === 'persona' ? 'persona'
        : 'extra-persona';

      let pickedDisplayName: string | undefined;
      // Phase 4 of per-persona avatars: at sign-in time, pull the avatar
      // metadata (encrypted Blossom blob + AES key) for the keypair the user
      // selected, so we can ship it to the consumer alongside the handle.
      // Consumers that care will decrypt and render the picture; those that
      // don't will ignore the extra fields. Same resolution shape as
      // pickedDisplayName — separate per-slot lookups for guardian vs dep.
      let pickedAvatar: { hash: string; blossomUrl: string; keyHex: string } | undefined;
      const pickAvatarFromSlot = (slot: { avatarHash?: string; avatarBlossomUrl?: string; avatarKey?: string } | undefined): typeof pickedAvatar => {
        if (!slot?.avatarHash || !slot.avatarBlossomUrl || !slot.avatarKey) return undefined;
        return { hash: slot.avatarHash, blossomUrl: slot.avatarBlossomUrl, keyHex: slot.avatarKey };
      };
      if (selection.source === 'guardian') {
        if (selection.keypairType === 'natural-person') {
          pickedDisplayName = identity?.naturalPerson.displayName || undefined;
          pickedAvatar = pickAvatarFromSlot(identity?.naturalPerson);
        } else if (selection.keypairType === 'persona') {
          pickedDisplayName = identity?.persona.displayName || undefined;
          pickedAvatar = pickAvatarFromSlot(identity?.persona);
        } else {
          const ep = identity?.extraPersonas?.find(p => p.publicKey === selection.keypairType);
          pickedDisplayName = ep?.displayName || undefined;
          pickedAvatar = pickAvatarFromSlot(ep);
        }
      } else {
        const dep = dependants.find(d => d.id === selection.dependantId);
        if (dep) {
          if (selection.keypairType === 'natural-person') {
            pickedDisplayName = dep.naturalPerson.displayName || undefined;
            pickedAvatar = pickAvatarFromSlot(dep.naturalPerson);
          } else if (selection.keypairType === 'persona') {
            pickedDisplayName = dep.persona.displayName || undefined;
            pickedAvatar = pickAvatarFromSlot(dep.persona);
          } else {
            const ep = dep.extraPersonas?.find(p => p.publicKey === selection.keypairType);
            pickedDisplayName = ep?.displayName || undefined;
            pickedAvatar = pickAvatarFromSlot(ep);
          }
        }
      }

      // NP never shares a handle — it's the real-name keypair and "your real name"
      // is already a separate row in the share preview.
      const handleToShare = (pickedToken !== 'natural-person' && shareHandle)
        ? pickedDisplayName
        : undefined;

      // ── Relay delivery mode ───────────────────────────────────────────────────
      if (isRelayMode) {
        // Sign the kind-21236 event. Works with every backend (local, bunker, NIP-07).
        // pickedAvatar (if any) becomes avatar_hash / avatar_url / avatar_key tags
        // on the event — Phase 4 of per-persona-avatars.
        const { authEvent } = await signAuthChallenge(selectedBackend, challenge, pendingAuthRequest.origin, pickedAvatar);

        // Find credential for login+verify flows
        const credential = authResponseCredentialForSigner(pendingAuthRequest, authEvent.pubkey);

        // Hand the consumer a bunker URI so it can upgrade its auth-only
        // EphemeralSigner to a live signer that signs cross-device.
        let bunkerUri: string | undefined;
        // Pubkey of a transient serving route this approval installed, so a
        // delivery lost to a Deny can tear it down again.
        let installedRouteToken: number | null = null;
        const remoteBunkerUri = await resolveBunkerHandoffUri(selectedBackend, selection, authEvent.pubkey);
        // Denied/withdrawn while signing: arm nothing, deliver nothing.
        if (!authDeliveryStillOpen(request)) return;
        if (remoteBunkerUri) {
          // Bunker-backed persona (e.g. an ESP32 hardware signer): hand over the
          // REAL, persistent bunker URI so the consumer connects directly to the
          // signer — no dependence on this app (a phone) staying open, which is
          // what made the bunker-server passthrough flaky cross-device. Safe
          // because the bunker gates every signature with a per-sign approval on
          // the device: the consumer can request a signature but cannot produce
          // one without the user physically approving it on the bunker.
          bunkerUri = remoteBunkerUri;
        } else if (bunkerServerEnabled) {
          // A handoff must point to a live listener for the approved persona.
          const routeBackend = requireNostrConnectRouteBackend(selectedBackend);
          tempBackendRetainedForRoute = tempBackend === routeBackend;
          installedRouteToken = installNostrConnectTransientRoute(routeBackend, tempBackendRetainedForRoute);
          await armNostrConnectServe(routeBackend.activePublicKeyHex, relayUrl);
          // Local-key persona: no standalone bunker to hand over, so mint a
          // one-shot pairing URI to our own NIP-46 server (passthrough). Reliable
          // on same-device redirect; over cross-device QR it depends on this app
          // staying reachable. (Non-bunker cross-device signing is better served
          // by per-request QR back to Signet — a later piece.)
          try {
            const pairingSecret = generatePairingSecret();
            const relaysForBunker = [
              pendingAuthRequest.relay,
              preferences.relayUrl ?? DEFAULT_RELAY_URL,
              ...(preferences.fallbackBunkerRelays ?? []),
              ...AUTH_FLOW_BUNKER_FALLBACK_RELAYS,
            ].filter((relay): relay is string => typeof relay === 'string' && relay.length > 0);
            const candidate = buildAuthFlowBunkerUrl(authEvent.pubkey, relaysForBunker, pairingSecret);
            if (candidate) {
              const ttlMs = 5 * 60 * 1000;  // 5-minute pairing window
              pendingAuthPairingsRef.current.set(pairingSecret, {
                origin: pendingAuthRequest.origin,
                appName: siteName.slice(0, 64),
                signingPubkey: authEvent.pubkey.toLowerCase(),
                expiresAt: Date.now() + ttlMs,
              });
              const now = Date.now();
              for (const [k, v] of pendingAuthPairingsRef.current) {
                if (v.expiresAt < now) pendingAuthPairingsRef.current.delete(k);
              }
              bunkerUri = candidate;
            }
          } catch {
            // Drop bunker URI — auth still completes via the plain response.
          }
        }

        const response: AuthResponse = {
          type: 'signet-auth-response',
          requestId: pendingAuthRequest.requestId,
          authEvent,
          ...(credential ? { credential } : {}),
          ...(handleToShare ? { displayName: handleToShare } : {}),
          ...(bunkerUri ? { bunkerUri } : {}),
        };

        // Capture values needed by the retry closure before clearing pendingAuthRequest
        const capturedRequest = pendingAuthRequest;
        const capturedResponse = response;
        const capturedBackend = selectedBackend;
        const capturedSiteName = siteName;
        const capturedKeypairLabel = keypairLabel;

        // Clear the auth request immediately so the approval screen doesn't
        // re-render while the publish is in flight.
        // Capture transient state BEFORE the `set*(null)` cleanup below — the
        // retry closure runs later and would see cleared values otherwise.
        const capturedAllow = consumerHint?.allow;
        const capturedConsumerDisplayName = consumerDisplayName;
        const capturedPostUrl = pendingPostUrl;

        // Denied, withdrawn or replaced while signing: deliver nothing, and
        // take down any serving route armed for this approval.
        if (!claimAuthDelivery(request)) {
          if (installedRouteToken !== null) clearNostrConnectTransientRouteByToken(installedRouteToken);
          return;
        }

        setPendingAuthRequest(null);
        setPendingAuthSelection(null);
        setOriginalAuthUrl(null);
        setUrlAuthSiteName('');
        setConsumerHint(null);
        setConsumerWarnings([]);
        setConsumerDisplayName(null);
        setPendingPostUrl(null);

        // Targets for the response gift-wrap. `targetRelays[0]` is ALWAYS the
        // consumer's chosen relay — that's the one the consumer is guaranteed
        // to be subscribed to, so success in the ack screen must reflect
        // whether THAT publish was accepted. The user's preferred relay is a
        // best-effort additional copy for consumers that happen to subscribe
        // to multiple relays (they'll dedupe by inner event id); a publish
        // there cannot rescue a consumer whose chosen relay rejected, because
        // the consumer won't see events on a relay they aren't subscribed to.
        // Previously `ok = results.some(r => r)` meant a successful publish to
        // the user's relay masked a rejection on the consumer's — Signet
        // showed "approved" while the consumer's site stayed unauthenticated.
        const userRelay = preferences.relayUrl;
        const targetRelays = (userRelay && userRelay !== relayUrl)
          ? [relayUrl, userRelay]
          : [relayUrl];

        /** Publish (or re-publish on retry) and update ack state accordingly. */
        const doPublish = async () => {
          const results = await Promise.all(
            targetRelays.map(url => publishAuthResponseToRelay(capturedResponse, url, capturedBackend, sessionPubkey)),
          );
          // Consumer-relay acceptance is the only outcome that delivers the
          // response to the consumer's listener; see comment block above.
          const ok = results[0] === true;
          if (ok) {
            // Record the authorised site in the Connections manager
            authorizeSite(
              capturedRequest.origin,
              capturedSiteName,
              capturedKeypairLabel,
              pubkey,
              {
                shareHandle: pickedToken !== 'natural-person' ? shareHandle : undefined,
                consumerDisplayName: capturedConsumerDisplayName ?? undefined,
              },
            ).catch(() => {});

            // Record per-origin policy memory.
            recordOriginSignIn(capturedRequest.origin, capturedKeypairLabel, {
              allow: capturedAllow,
            }).catch(() => {});

            // Update the developer log entry with the final outcome.
            if (currentLogEntryRef.current) {
              updateAuthRequestOutcome(currentLogEntryRef.current, 'approved', capturedKeypairLabel);
              currentLogEntryRef.current = null;
            }


            setRelayAuthAckState({
              status: 'approved',
              siteName: capturedSiteName,
              ...(capturedPostUrl ? { postUrl: capturedPostUrl } : {}),
            });
            // Align home carousel before showing the ack — the user's next move
            // is dismissing the ack which lands them on home, and we want that
            // landing to match what they just signed as (not where the carousel
            // happened to be at scan time).
            alignCarouselToApprovedSelection(selection);
            navigateReplace('relay-auth-ack');
          } else {
            // Name only the relays that actually rejected — under the new
            // consumer-relay-required success rule, the user's preferred
            // relay may have accepted while the consumer's didn't, and
            // listing both as "failed" would be misleading.
            const hosts = targetRelays
              .map((url, i) => ({ url, ok: results[i] }))
              .filter(r => !r.ok)
              .map(r => {
                try { return new URL(r.url).host; }
                catch { return r.url.slice(0, 64); }
              });
            // A swallowed publish throw (e.g. gift-wrap signing) surfaces here as
            // a false result mislabeled as a relay failure — show the real reason
            // captured in relay-publish so the ack screen tells the truth.
            const realErr = getLastAuthPublishError();
            const relayHost = realErr
              ? `${realErr}${hosts.length ? ' [' + hosts.join(' / ') + ']' : ''}`
              : hosts.join(' / ');
            setRelayAuthAckState({
              status: 'failed',
              relayHost,
              retry: doPublish,
            });
            navigateReplace('relay-auth-ack');
          }
        };

        await doPublish();
        return;
      }

      // ── Redirect mode (no relay) ──────────────────────────────────────────────
      // pickedAvatar (if any) becomes tags on the kind-21236 event AND URL
      // params on the callback redirect — see buildAuthCallbackUrl below.
      const { signature, eventId, authEvent } = await signAuthChallenge(selectedBackend, challenge, pendingAuthRequest.origin, pickedAvatar);

      // Find credential for login+verify flows
      const credential = authResponseCredentialForSigner(pendingAuthRequest, authEvent.pubkey);

      // URL redirect flow (Sign in with Signet)
      if (pendingAuthRequest.callbackUrl) {
        if (!isValidHexKey(pubkey)) throw new Error('Signing produced invalid public key');
        const npub = encodeNpub(hexToBytes(pubkey));

        // Annotate the response when the user took the NP fallback despite the
        // consumer asking for a persona. Lets the consumer decide server-side
        // whether to accept it (phone empty-state fallback).
        const pickedNp = selection.keypairType === 'natural-person';
        const npAllowed = !consumerHint
          || consumerHint.allow.length === 0
          || consumerHint.allow.includes('natural-person');
        const fromNP = pickedNp && !npAllowed;

        // Bunker handoff for the SAME-TAB redirect. Only a persistent bunker
        // (signingMode === 'bunker') can be handed over here — see the block
        // below for why the in-page-server auto-pair (valid on relay/QR) is not.
        // Absent that, the consumer gets the plain auth-only EphemeralSigner
        // callback, same as before redirect-bunker shipped.
        let bunkerUri: string | undefined;
        const remoteBunkerUri = await resolveBunkerHandoffUri(selectedBackend, selection, authEvent.pubkey);
        if (remoteBunkerUri) {
          // Bunker-backed persona (e.g. an ESP32 hardware signer): hand over the
          // REAL, persistent bunker URI so the consumer connects directly to the
          // signer instead of through this app's NIP-46 server. Safe because the
          // bunker gates every signature with a per-sign device approval. Mirror
          // of the relay/QR path — keep the two in lockstep. This URI outlives
          // the redirect, so it's the only bunker handoff valid on the same-tab
          // path.
          bunkerUri = remoteBunkerUri;
        }
        // Deliberately NOT minting an in-page-server pairing URI here (the
        // `bunkerServerEnabled` auto-pair used on the relay/QR path). This is the
        // SAME-TAB redirect: the `window.location.href = callbackUrl` below
        // unloads this app and tears down the in-page NIP-46 server
        // (`useBunkerServer`) before the consumer has even loaded to connect. The
        // consumer's `connect` request would then hang against a dead bunker —
        // nostr-tools' NIP-46 client has no per-request timeout — stranding it on
        // a blank screen (the internal issue tracker: pallasite empty-screen-on-signin).
        // The in-page auto-pair only works where this app stays alive across the
        // handoff (relay/QR, or a popup). On same-tab redirect the consumer gets
        // the plain auth-only EphemeralSigner session, as it did before
        // redirect-bunker shipped.

        const callbackUrl = buildAuthCallbackUrl(
          pendingAuthRequest.callbackUrl,
          pubkey,
          npub,
          signature,
          eventId,
          {
            // Forward the actual signed `created_at` so consumers (e.g.
            // signet-login redirect mode) can rebuild the event hash and
            // verify the signature without an extra round-trip. Must be
            // the value the signer used — not Date.now() — or the
            // reconstruction won't match.
            createdAt: authEvent.created_at,
            warnings: consumerWarnings.length > 0 ? consumerWarnings : undefined,
            fromNP: fromNP || undefined,
            displayName: handleToShare,
            bunker: bunkerUri,
            // Phase 4 of per-persona-avatars: avatar fields ride in URL
            // params so consumers can decrypt the encrypted Blossom blob
            // without needing to fetch the kind-21236 event from a relay.
            // The same three values are also tags on the signed event, so
            // consumers that verify signature still see them in the
            // canonical event reconstruction.
            avatarHash: pickedAvatar?.hash,
            avatarUrl: pickedAvatar?.blossomUrl,
            avatarKey: pickedAvatar?.keyHex,
          },
        );

        // Denied, withdrawn or replaced while signing: record and deliver nothing.
        if (!authDeliveryStillOpen(request)) return;

        // Commit the connection before navigation can unload this page.
        await authorizeSite(
          pendingAuthRequest.origin,
          siteName,
          keypairLabel,
          pubkey,
          {
            shareHandle: pickedToken !== 'natural-person' ? shareHandle : undefined,
            consumerDisplayName: consumerDisplayName ?? undefined,
          },
        );

        // Record per-origin policy memory.
        await recordOriginSignIn(pendingAuthRequest.origin, keypairLabel, {
          allow: consumerHint?.allow,
          userOverrode: fromNP,
        }).catch(() => {});

        // Update the developer log entry with the final outcome.
        if (currentLogEntryRef.current) {
          updateAuthRequestOutcome(currentLogEntryRef.current, 'approved', keypairLabel);
          currentLogEntryRef.current = null;
        }

        // Take the request's one answer (Deny is a no-op from here on).
        if (!claimAuthDelivery(request)) return;

        // Retire the request, leave the approval page, then redirect. On
        // native the WebView does not unload on this redirect (the browser
        // opens the callback), so without this the app would keep showing the
        // finished request on "Signing…" with a live Deny.
        handOffAuthCallback(callbackUrl, {
          retireRequest: () => {
            setPendingAuthRequest(null);
            setPendingAuthSelection(null);
            setOriginalAuthUrl(null);
            setUrlAuthSiteName('');
            setConsumerHint(null);
            setConsumerWarnings([]);
            setConsumerDisplayName(null);
            setPendingPostUrl(null);
          },
          leaveApprovalPage: () => {
            alignCarouselToApprovedSelection(selection);
            navigateReplace('home');
          },
          redirect: (url) => { window.location.href = url; },
        });
        return;
      }

      const response: AuthResponse = {
        type: 'signet-auth-response',
        requestId: pendingAuthRequest.requestId,
        authEvent,
        ...(credential ? { credential } : {}),
        ...(handleToShare ? { displayName: handleToShare } : {}),
      };

      if (!claimAuthDelivery(request)) return;

      // Same-device: BroadcastChannel
      if (pendingAuthRequest.requestId) {
        const channel = new BroadcastChannel('signet-auth-' + pendingAuthRequest.requestId);
        channel.postMessage(response);
        channel.close();
      }

      if (currentLogEntryRef.current) {
        const keypairLabel = authSelectionLabel(selection);
        updateAuthRequestOutcome(currentLogEntryRef.current, 'approved', keypairLabel);
        currentLogEntryRef.current = null;
      }

      setPendingAuthRequest(null);
      setPendingAuthSelection(null);
      setOriginalAuthUrl(null);
      setConsumerHint(null);
      setConsumerWarnings([]);
      setConsumerDisplayName(null);
      setPendingPostUrl(null);
      alignCarouselToApprovedSelection(selection);
      navigateReplace('home');
    } finally {
      // The temporary serving route owns its backend until expiry or lock.
      if (tempBackend && !tempBackendRetainedForRoute) tempBackend.destroy();
    }
  }, [pendingAuthRequest, identity, dependants, activeDependant, authorizeSite, recordOriginSignIn, urlAuthSiteName, signerStatus, bunkerBackend, bunkerRouter, npBunkerBackend, nip07Backend, backends, navigateReplace, consumerHint, consumerWarnings, consumerDisplayName, pendingPostUrl, requestFreshAuth, requestAuth, encryptionKey, loadFreshDependants, alignCarouselToApprovedSelection, resolveBunkerHandoffUri, authResponseCredentialForSigner, authSelectionLabel, bunkerServerEnabled, armNostrConnectServe, installNostrConnectTransientRoute, preferences.signingMode, waitForApprovalRoute, acquireApprovalRoute, routedApprovalUnavailableMessage, assertApprovalStillPending, authDeliveryStillOpen, claimAuthDelivery, clearNostrConnectTransientRouteByToken]);

  // One answer per request: starts the in-flight approval synchronously so a
  // Deny/Back tapped while signing is a no-op, refuses a request that has
  // already been answered, and reopens it if the approval failed undelivered.
  const handleApproveAuth = useCallback(async (selection: AuthSelection, shareHandle: boolean = false) => {
    const request = pendingAuthRequestRef.current;
    if (!request) throw new Error('No pending auth request');
    const key = authRequestKey(request);
    const began = authSettlementRef.current.beginApproval(key);
    if (began === 'settled') {
      // Already answered (e.g. the same link opened again): nothing to send,
      // just dismiss it — never a page stuck on "already answered".
      retireAuthRequestState();
      navigateReplace('home');
      return;
    }
    if (began === 'in-flight') throw new Error('Already signing this request.');
    setAuthApprovalInFlightKey(key);
    try {
      await approveAuthUnguarded(selection, shareHandle);
    } finally {
      authSettlementRef.current.endApproval(key);
      setAuthApprovalInFlightKey(current => (current === key ? null : current));
    }
  }, [approveAuthUnguarded, retireAuthRequestState, navigateReplace]);

  const handleApproveAuthGuarded = useCallback(async (selection: AuthSelection, shareHandle: boolean = false) => {
    const request = pendingAuthRequestRef.current;
    setPickerInitialError(null);
    try {
      await handleApproveAuth(selection, shareHandle);
    } catch (e) {
      // An approval that waited through a lock/unlock may finish after the
      // ApproveAuth instance that started it has been unmounted and remounted
      // (the lock clears identity state, which unmounts the page). Its own
      // catch is then gone, so hand the error to whichever instance is on
      // screen now — the page must end usable, never silently reset.
      if (request && pendingAuthRequestRef.current === request) {
        setPickerInitialError(e instanceof Error ? e.message : String(e));
      }
      throw e;
    }
  }, [handleApproveAuth]);

  const handleDenyAuth = useCallback(() => {
    const request = pendingAuthRequestRef.current;
    if (!request) {
      retireAuthRequestState();
      navigateReplace('home');
      return;
    }
    // One answer per request. An explicit Deny/Cancel/back chevron may take
    // over an in-flight approval (that approval then delivers nothing). A
    // request already answered is just dismissed — no second callback, and
    // never a page stuck on a request nothing can clear.
    const outcome = authSettlementRef.current.deny(authRequestKey(request));
    if (outcome === 'already-answered') {
      retireAuthRequestState();
      navigateReplace('home');
      return;
    }
    // Record deny outcome in the developer log.
    if (currentLogEntryRef.current) {
      updateAuthRequestOutcome(currentLogEntryRef.current, 'denied');
      currentLogEntryRef.current = null;
    }

    // Relay mode deny: publish a rejection event (gift-wrapped) rather than redirecting.
    const relayUrl = request.relay;
    const sessionPubkey = request.sessionPubkey;
    if (relayUrl && sessionPubkey) {
      const challenge = request.challenge ?? request.requestId;
      let siteName = urlAuthSiteName;
      if (!siteName) {
        try { siteName = new URL(request.origin).hostname; }
        catch { siteName = request.origin.slice(0, 64); }
      }

      // Fire-and-forget rejection publish — denial UX must not block on network.
      // The ack screen confirms the local intent; relay delivery is best-effort.
      // Refusing access must work while the owner's signer is locked or
      // reconnecting, and must not disclose an identity they declined to share.
      const refusalBackend = new LocalSigningBackend(generateBunkerClientSecret());
      publishVerifyRejectionToRelay(challenge, relayUrl, refusalBackend, sessionPubkey)
        .catch(() => {})
        .finally(() => refusalBackend.destroy());

      retireAuthRequestState();
      setRelayAuthAckState({ status: 'denied', siteName });
      navigateReplace('relay-auth-ack');
      return;
    }

    // Redirect the denial to the callback only for a request that arrived as
    // a Sign in with Signet URL. QR-scanned / BroadcastChannel requests
    // originated while the user was already in the app — navigating them to a
    // foreign callback URL is disorienting and wasn't what they expected.
    if (request.callbackUrl && shouldRedirectDenial({
      fromUrlAuth: urlAuthRequestsRef.current.has(request),
      siteName: urlAuthSiteName,
      callbackUrl: request.callbackUrl,
    })) {
      // On native the callback opens in the browser and this WebView stays
      // put — leave the approval page, or it strands without its request.
      handOffAuthCallback(buildAuthDeniedUrl(request.callbackUrl), {
        retireRequest: retireAuthRequestState,
        leaveApprovalPage: () => navigateReplace('home'),
        redirect: (u) => { window.location.href = u; },
      });
      return;
    }
    retireAuthRequestState();
    navigateReplace('home');
  }, [urlAuthSiteName, navigateReplace, retireAuthRequestState]);

  // ── Third-party add-dependant approval ─────────────────────────────
  //
  // Mints a new dependant, signs a kind-21236 proof event tying it to the
  // consumer's challenge, optionally provisions a one-shot bunker pairing
  // for the new dependant's appBunkerEndpoint slot, and redirects
  // back via the consumer's callback URL.

  const handleApproveAddDependant = useCallback(async (
    params: { childName: string; dateOfBirth?: string; autoPair: boolean },
  ): Promise<void> => {
    const req = pendingAddDependantRequest;
    if (!req) throw new Error('No pending add-dependant request');
    // Encryption-key absence means the app got into an inconsistent state
    // (the page should only render when a key is present). Surface as an
    // in-app error rather than redirect — leaking state via a `create_failed`
    // redirect on a locked app is the wrong signal to the consumer.
    if (!encryptionKey) throw new Error('App is locked — please unlock first');

    // Choose the guardian backend that signs the proof event.
    // Bunker > NIP-07 > local NP. NP-only here because this is a guardian
    // act, not a persona act, so persona backends don't apply.
    const npBackend = npBunkerBackend ?? nip07Backend ?? backends?.naturalPerson ?? null;
    if (!npBackend) {
      throw new Error('Guardian signing key is not available — please unlock first');
    }

    let dependantPubkey: string;
    try {
      // 1. Mint the dependant (NP under the guardian's identity).
      const newDep = await addDependant(params.childName, params.dateOfBirth, { deviceDerive: dependantDeviceDerive });
      dependantPubkey = newDep.id;
    } catch {
      // Per the issue's error matrix, dependant-creation failures redirect
      // with `?error=create_failed` so the consumer can show its own retry UX.
      // The error builder returns null for non-http(s) callbacks (defence in
      // depth — the dispatcher pre-validates, so this should always succeed
      // for requests that reach this handler); on null we drop silently to
      // home rather than coercing into a malformed `window.location.href`.
      setPendingAddDependantRequest(null);
      const errUrl = buildAddDependantErrorUrl(req.callback, 'create_failed');
      if (errUrl) window.location.href = errUrl;
      else navigateReplace('home');
      return;
    }

    try {
      // 2. Sign the kind-21236 proof event. Tag triplet ties consumer
      //    challenge + origin + the *new* dependant pubkey together so the
      //    consumer can verify all three with a single Schnorr check against
      //    the guardian pubkey on the event.
      const guardianPubkey = npBackend.activePublicKeyHex;
      const authEvent = await npBackend.signEvent(
        buildAddDependantProofTemplate(req, dependantPubkey, guardianPubkey),
      );

      // 3. Optional: provision a fresh one-shot pairing into the new
      //    dependant's appBunkerEndpoint slot. Best-effort — if any
      //    step fails we still complete the redirect-back (the consumer can
      //    fall back to a manual pairing flow).
      let bunkerUri: string | undefined;
      if (params.autoPair && bunkerServerEnabled) {
        try {
          const endpoint = await dbEnsureAppBunkerEndpoint(dependantPubkey, encryptionKey);
          const pairingSecret = generatePairingSecret();
          await dbSetAppBunkerPairingSecret(dependantPubkey, pairingSecret, encryptionKey);
          const relayUrl = preferences.relayUrl ?? DEFAULT_RELAY_URL;
          bunkerUri = buildPairingURI({
            endpointPubkey: endpoint.publicKey,
            relays: [relayUrl],
            secret: pairingSecret,
            dependantPubkey,
            dependantName: params.childName,
          });
          // Refresh the React `dependants` state so `useBunkerServer` picks
          // up the new dependant's appBunkerEndpoint as a route. Without
          // this the consumer's `connect` request — fired moments after
          // the redirect below — has no listener on this device. Even with
          // it, completion is best-effort: once we redirect, this tab's
          // websocket subscription tears down. The relay's 60s replay
          // window (see `useBunkerServer.openSocket`) plus the 5-min secret
          // TTL keep the pairing reachable on the user's next visit.
          await reloadDependants();
        } catch {
          // Bunker provisioning is opportunistic — drop the URI on any failure.
          bunkerUri = undefined;
        }
      }

      // 4. Build callback URL and redirect back to the consumer.
      //
      // Param layout: `dependantPubkey` (hex) + `npub` (bech32 of the SAME
      // dependant pubkey) identify the new subject; `guardianPubkey` is the
      // signer the consumer verifies the proof against. Mirrors the
      // `buildAddDependantCallbackUrl` doc-comment — keep these aligned.
      const dependantNpub = encodeNpub(hexToBytes(dependantPubkey));
      const callbackUrl = buildAddDependantCallbackUrl(
        req.callback,
        dependantPubkey,
        dependantNpub,
        guardianPubkey,
        authEvent.sig,
        authEvent.id,
        bunkerUri ? { bunker: bunkerUri } : undefined,
      );

      setPendingAddDependantRequest(null);
      if (callbackUrl) window.location.href = callbackUrl;
      else navigateReplace('home');
    } catch {
      // Dependant was created but the post-mint flow blew up (signing,
      // npub encoding, etc.). Roll the dependant back so the user
      // doesn't end up with a phantom entry in their family screen
      // that they don't recognise. removeDependant clears the grants
      // table too, so we don't leak guardian-policy state for a
      // dependant the consumer never received. Best-effort — even if
      // rollback fails, we still report create_failed.
      try { await removeDependant(dependantPubkey); } catch { /* best-effort */ }
      setPendingAddDependantRequest(null);
      const errUrl = buildAddDependantErrorUrl(req.callback, 'create_failed');
      if (errUrl) window.location.href = errUrl;
      else navigateReplace('home');
    }
  }, [
    pendingAddDependantRequest,
    encryptionKey,
    addDependant,
    dependantDeviceDerive,
    npBunkerBackend,
    nip07Backend,
    backends,
    bunkerServerEnabled,
    preferences.relayUrl,
    reloadDependants,
    removeDependant,
    identity,
  ]);

  const handleDenyAddDependant = useCallback(() => {
    const req = pendingAddDependantRequest;
    if (!req) {
      navigateReplace('home');
      return;
    }
    setPendingAddDependantRequest(null);
    const errUrl = buildAddDependantErrorUrl(req.callback, 'denied');
    if (errUrl) window.location.href = errUrl;
    else navigateReplace('home');
  }, [pendingAddDependantRequest, navigateReplace]);

  // Carousel helpers — child mode, QR routing, and inline approval from current row

  const handleEnterChildMode = useCallback((dependantId: string) => {
    carousel.enterChildMode(dependantId);
    setActiveDependantId(dependantId);
    // Persist so the boundary survives reload / process-kill — without this,
    // the child can escape child-mode by closing and reopening the app.
    // Exit remains PIN-gated via handleExitChildMode. See spec §3.
    saveChildModeSession(dependantId).catch(() => {});
    // Mark the auto-restore effect as already-handled. Otherwise, when
    // `dependants` later changes (e.g. `useDependantsSync` reloads after a
    // remote merge), that effect re-fires, sees a session on disk, and
    // calls `enterChildMode` again — which resets `row` to 0 mid-flow,
    // bouncing a user who'd swiped to a persona row back to the dependant
    // NP row.
    childModeRestoredRef.current = true;
  }, [carousel.enterChildMode, setActiveDependantId]);

  const handleExitChildMode = useCallback(async () => {
    // Load-bearing safety boundary: exit requires the guardian's PIN/biometric.
    // Without this, "child-mode" is just a UI state the child can flip. See spec §2.
    const key = await requestFreshAuth();
    if (!key) return; // Cancelled or failed — stay in child-mode.
    carousel.exitChildMode();
    setActiveDependantId(null);
    clearChildModeSession().catch(() => {});
  }, [carousel.exitChildMode, setActiveDependantId, requestFreshAuth]);

  // Publish current child-mode state + exit handler to useNavigation's refs so
  // hardware back / browser back can trigger the same gated exit while inside
  // child-mode. These are ref-assignments, not setState — no extra renders.
  childModeActiveRef.current = carousel.childMode;
  attemptExitChildModeRef.current = () => { handleExitChildMode(); };

  // Restore child-mode from persistence on mount. If the guardian closed the app
  // (or the child tried to escape via reload), we re-enter the same child-mode
  // session. The PIN gate still applies on the next exit attempt.
  //
  // The `encryptionKey` guard and the deferred "restored" flag together fix a race.
  // Previously the ref flipped to true synchronously before dependants had been
  // decrypted, so `dependants.find(...)` returned undefined and we'd clear the
  // session — a child-mode reload escaped back to the guardian account. Now we
  // wait for unlock, only mark restored after the async lookup resolves, and
  // never clear on "not found" (a stale session is harmless: enterChildMode only
  // fires when the dep is present, and the next enter/exit overwrites or clears).
  const childModeRestoredRef = useRef(false);
  useEffect(() => {
    if (childModeRestoredRef.current) return;
    if (identityLoading || prefsLoading) return;
    if (!encryptionKey) return;
    loadChildModeSession().then(session => {
      if (childModeRestoredRef.current) return;
      if (!session) {
        childModeRestoredRef.current = true;
        return;
      }
      const dep = dependants.find(d => d.id === session.activeDependantId);
      if (dep) {
        childModeRestoredRef.current = true;
        carousel.enterChildMode(session.activeDependantId);
        setActiveDependantId(session.activeDependantId);
      }
    }).catch(() => {});
  }, [identityLoading, prefsLoading, encryptionKey, dependants, carousel.enterChildMode]);

  const resolveSigningSelection = useCallback((row: CarouselRow): AuthSelection | null => {
    switch (row.type) {
      case 'natural-person':
        return { source: 'guardian', keypairType: 'natural-person' };
      case 'persona':
        return { source: 'guardian', keypairType: 'persona' };
      case 'extra-persona': {
        const ep = row.identity.extraPersonas?.[row.personaIndex];
        if (!ep) return null;
        return { source: 'guardian', keypairType: ep.publicKey };
      }
      case 'dependant':
        // Same resolver the card itself uses — what is SHOWN is what SIGNS.
        // Reading `primaryKeypair` raw would offer a dormant real identity for
        // signing on a dep whose card shows the persona (spec §7.6).
        return {
          source: 'dependant',
          dependantId: row.dependant.id,
          keypairType: resolveDependantCardSlot(row.dependant).slotTarget,
        };
      case 'dependant-persona':
        return {
          source: 'dependant',
          dependantId: row.dependant.id,
          keypairType: 'persona',
        };
      case 'dependant-extra-persona': {
        const ep = row.dependant.extraPersonas?.[row.personaIndex];
        if (!ep) return null;
        return {
          source: 'dependant',
          dependantId: row.dependant.id,
          keypairType: ep.publicKey,
        };
      }
      case 'bot': return null;
      case 'add':
        // Empty-state affordance row — not a signing context. Callers fall
        // through to the full approve-auth picker.
        return null;
    }
  }, []);

  const handleCarouselQRScanned = useCallback((data: string) => {
    if (carousel.rows[carousel.row]?.type === 'bot') return;
    const action = routeQR(data);
    switch (action.type) {
      case 'contact-invite':
        // D6: a paired-child install offers "Ask {guardian} to connect"
        // instead of connecting directly — see the navigation effect below.
        setPendingContactInvite(JSON.stringify(action.invite));
        break;
      case 'verify':
        setPendingVerifyRequest(action.request);
        navigateTo('approve-verification');
        break;
      case 'auth':
      case 'login': {
        // Stay on home. ApprovalOverlay (rendered inside the Carousel) will show
        // "Signing as: <carousel row identity>" and approve/deny buttons — the
        // row the user swiped to IS the identity selection. No picker UI.
        // Capture the row-at-scan-time so a later state update that rebuilds
        // `carousel.rows` (e.g. `useDependantsSync`'s post-merge reload) can't
        // shift the user onto a different row before they tap Approve.
        const currentRow = carousel.rows[carousel.row];
        const selection = currentRow ? resolveSigningSelection(currentRow) : null;
        setPendingAuthSelection(selection);
        setPendingAuthRequest(action.request);
        break;
      }
      case 'nostr-connect': {
        // Capture the carousel row the user was on so ApproveConnect can sign
        // with that specific keypair — not whatever primaryKeypair says.
        const currentRow = carousel.rows[carousel.row];
        const selection = currentRow ? resolveSigningSelection(currentRow) : null;
        setPendingConnectSelection(selection);
        handleNostrConnect(data);
        break;
      }
      case 'companion-pair':
        setPendingPairingRequest(action.request);
        navigateTo('approve-companion-grant');
        break;
      case 'contacts-pair-v2':
        // R-8: a paired-child install has no v2 grant surface at all — it
        // publishes no projections and accepts no proposals, so approving one
        // would mint a grant that can never do anything. M7: fail closed WITH
        // a reason rather than silently doing nothing.
        if (isPairedChild) { setContactsGrantPairedChildNotice(true); break; }
        setPendingContactsGrantV2(action.request);
        navigateTo('contacts-grant-approve');
        break;
      case 'heartwood-operator-import':
        // Sapwood "Manage from your phone" QR — hand the raw link to the
        // Advanced-settings import card. Never on the paired-child surface
        // (the operator key manages the family device, not the kid's).
        if (preferences.signingMode !== 'paired-child') {
          setPendingOperatorImportText(action.raw);
          navigateTo('settings-advanced');
        }
        break;
      default:
        // contact/unknown — fall back to the dedicated scan flow
        navigateTo('web-verify');
        break;
    }
  }, [navigateTo, handleNostrConnect, carousel.rows, carousel.row, resolveSigningSelection, preferences.signingMode, isPairedChild]);

  const handleApproveFromCarousel = useCallback(() => {
    if (!pendingAuthRequest) return;

    // Mirror ApproveAuth's credential guard: login-requests with required age-range
    // must attach a persona credential. If none exists, bounce to the full page
    // which shows the "Get Verified" warning screen.
    const VALID_AGE_RANGES = ['0-3', '4-7', '8-12', '13-17', '18+'];
    const isLogin = pendingAuthRequest.type === 'signet-login-request';
    const needsCredential = isLogin
      && typeof pendingAuthRequest.requiredAgeRange === 'string'
      && VALID_AGE_RANGES.includes(pendingAuthRequest.requiredAgeRange);

    // Use the selection captured at scan time. Re-reading from the
    // carousel here would race with `useDependantsSync`'s post-merge reload —
    // if it rebuilt `carousel.rows` after the scan, the user could end up
    // signing as a different row's identity (typically falling back to NP).
    const selection = pendingAuthSelection;
    if (!selection) {
      navigateTo('approve-auth');
      return;
    }

    const signingPubkey = identity ? resolveSelectedPubkey(selection, identity, dependants) : null;
    const hasCredential = isLogin
      && !!signingPubkey
      && !!pickCredentialForSubject(credentials, pendingAuthRequest, signingPubkey, Math.floor(Date.now() / 1000));
    if (needsCredential && !hasCredential) {
      navigateTo('approve-auth');
      return;
    }

    handleApproveAuth(selection, true).catch((e) => {
      setPickerInitialError(e instanceof Error ? e.message : String(e));
      navigateTo('approve-auth');
    });
  }, [pendingAuthRequest, identity, dependants, credentials, pendingAuthSelection, handleApproveAuth, navigateTo]);

  // Listen for same-device verification requests via BroadcastChannel
  useEffect(() => {
    const channel = new BroadcastChannel('signet-verify-request');
    const handleMessage = (event: MessageEvent) => {
      const request = parseVerifyRequest(JSON.stringify(event.data));
      if (!request) return;
      setPendingVerifyRequest(request);
      navigateReplace('approve-verification');
    };
    channel.addEventListener('message', handleMessage);
    return () => {
      channel.removeEventListener('message', handleMessage);
      channel.close();
    };
  }, [navigateReplace]);

  useEffect(() => {
    cleanupUnencryptedIdentities().catch(() => {});
  }, []);

  const consumeUrlAuthRequest = useCallback((targetHref?: string) => {
    let url: URL;
    try {
      url = targetHref ? new URL(targetHref, window.location.href) : new URL(window.location.href);
    } catch {
      return false;
    }
    const search = url.search;
    if (!search) return false;
    const parsed = parseSignInRequest(search);
    if (!parsed) return false;

    // Store site name before clearing URL
    setUrlAuthSiteName(getUrlAuthSiteName(search));

    // Capture the consumer hint (accept/prefer/accept_reason) and parser warnings.
    // Warnings are surfaced back to the consumer via the redirect-back URL
    // (§7 — structured diagnostics instead of console.warn).
    setConsumerHint(parsed.hint);
    setConsumerWarnings(parsed.warnings);
    setConsumerDisplayName(parsed.consumerDisplayName ?? null);
    setPendingPostUrl(parsed.postUrl ?? null);

    // Record in the developer auth-request log (power-mode diagnostics).
    currentLogEntryRef.current = logAuthRequest({
      origin: parsed.request.origin,
      hint: parsed.hint,
      warnings: parsed.warnings,
    });

    // Capture the full URL before we strip query params — the desktop
    // phone-pairing QR rebuilds from it.
    setOriginalAuthUrl(url.toString());

    // Clear URL params to prevent re-triggering on refresh
    window.history.replaceState({ page: 'home' }, '', url.pathname || window.location.pathname);

    // Set as pending auth request and route immediately. The old post-unlock
    // effect only routed when `page === 'home'`, so a QR-opened auth URL could
    // be staged invisibly if MySignet was backgrounded on Settings/Bunker.
    setPendingAuthSelection(null);
    urlAuthRequestsRef.current.add(parsed.request);
    setPendingAuthRequest(parsed.request);
    navigateReplace('approve-auth');
    return true;
  }, [navigateReplace]);

  // Read URL auth params on mount (Sign in with Signet redirect flow).
  useEffect(() => {
    consumeUrlAuthRequest();
  }, [consumeUrlAuthRequest]);

  // Installed PWAs may be reused instead of navigated on a fresh QR/open-link
  // launch. Chromium exposes that target URL via Web Launch Handler; consume it
  // directly so the first scan opens the approval screen instead of only
  // focusing the existing app window.
  useEffect(() => {
    type LaunchParams = { targetURL?: string };
    type LaunchQueue = { setConsumer: (consumer: (params: LaunchParams) => void) => void };
    const launchQueue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue;
    if (!launchQueue) return;
    launchQueue.setConsumer((params) => {
      if (typeof params.targetURL === 'string') {
        consumeUrlAuthRequest(params.targetURL);
      }
    });
  }, [consumeUrlAuthRequest]);

  // Installed/mobile app launches can reuse an already-running client. In that
  // case React does not remount, so consume a newly focused URL too.
  useEffect(() => {
    const consumeVisibleUrl = () => {
      if (document.visibilityState === 'visible') consumeUrlAuthRequest();
    };
    const consumeFocusedUrl = () => {
      consumeUrlAuthRequest();
    };
    window.addEventListener('focus', consumeFocusedUrl);
    window.addEventListener('pageshow', consumeFocusedUrl);
    document.addEventListener('visibilitychange', consumeVisibleUrl);
    return () => {
      window.removeEventListener('focus', consumeFocusedUrl);
      window.removeEventListener('pageshow', consumeFocusedUrl);
      document.removeEventListener('visibilitychange', consumeVisibleUrl);
    };
  }, [consumeUrlAuthRequest]);

  // Read URL verify params on mount (external-site redirect flow for age verification).
  // Mirrors the ?auth=1 handler above. Parser delegates validation (timestamp,
  // hex requestId, age-range allowlist, callbackUrl scheme) to
  // protocol-level parseVerifyRequest — no additional checks here.
  //
  // Extracted to a callback (rather than inlined in the effect below) so the
  // native `root-carrier` App Link path (see `handleNativeUrl` further down)
  // can feed it a query string that never touches `window.location` — the
  // APK's WebView location is always `https://localhost/`. Returns whether it
  // found and consumed a verify request.
  const consumeVerifyUrl = useCallback((search: string): boolean => {
    if (!search) return false;
    const request = parseVerifyRequestFromUrl(search);
    if (!request) return false;
    // Clear URL params to prevent re-triggering on refresh.
    window.history.replaceState({ page: 'home' }, '', window.location.pathname);
    setPendingVerifyRequest(request);
    setVerifyArrivedViaUrl(true);
    return true;
  }, []);

  useEffect(() => {
    consumeVerifyUrl(window.location.search);
  }, [consumeVerifyUrl]);

  /**
   * Read URL params on mount for the third-party add-dependant flow
   * (`?action=add-dependant&...`). Mirrors the ?auth=1 handler.
   *
   * The parser is signet-app-local — see §"Implementation
   * scope: app-only". The URL contract is the public surface, not the parser.
   *
   * Coarse pre-check before parsing so we can route stale-timestamp failures
   * to a distinct `?error=stale_request` callback instead of the catch-all
   * `invalid_request`. Both `t` validation paths (parser + pre-check) use
   * the same 5-minute window, so the only path into the stale-redirect branch
   * is when timestamp parsing/window checks fail.
   *
   * Extracted to a callback for the same reason as `consumeVerifyUrl` above —
   * the native `root-carrier` App Link path feeds it a query string directly,
   * bypassing `window.location`. Returns whether it found and consumed an
   * add-dependant request (true once `action=add-dependant` matches, even if
   * the request itself turns out stale/malformed and gets error-redirected —
   * that's still "consumed", just consumed into a failure path).
   */
  const consumeAddDependantUrl = useCallback((search: string): boolean => {
    if (!search) return false;
    const params = new URLSearchParams(search);
    if (params.get('action') !== 'add-dependant') return false;

    // Extract a callback we'd be safe to redirect-back to on parse failure.
    // Same-origin enforcement: callback origin must match the declared origin
    // AND both schemes must validate. We only redirect on parse failure when
    // these basic checks pass — otherwise we surface the error in-app rather
    // than risk bouncing the user to an attacker-controlled URL.
    const safeCallback: string | null = (() => {
      const rawOrigin = params.get('origin');
      const rawCallback = params.get('callback');
      if (!rawOrigin || !rawCallback) return null;
      try {
        const o = new URL(rawOrigin);
        const cb = new URL(rawCallback);
        const okScheme = (u: URL) =>
          u.protocol === 'https:'
          || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
        if (!okScheme(o) || !okScheme(cb)) return null;
        if (cb.origin !== o.origin) return null;
        return cb.toString();
      } catch {
        return null;
      }
    })();

    // Pre-check the timestamp so we can distinguish stale_request from invalid_request.
    const isStale = (() => {
      const rawT = params.get('t');
      if (!rawT) return false;
      const t = Number(rawT);
      if (!Number.isInteger(t)) return false;
      return Math.abs(Math.floor(Date.now() / 1000) - t) > 5 * 60;
    })();

    const parsed = parseAddDependantRequest(search);

    // Always clear the URL params — refresh shouldn't re-trigger the flow.
    window.history.replaceState({ page: 'home' }, '', window.location.pathname);

    if (!parsed) {
      if (safeCallback) {
        const errUrl = buildAddDependantErrorUrl(
          safeCallback,
          isStale ? 'stale_request' : 'invalid_request',
        );
        // safeCallback already passed the same scheme check the builder
        // re-applies, so errUrl is non-null in the steady state. Guard
        // anyway — no redirect on null is the safe failure mode.
        if (errUrl) window.location.href = errUrl;
      }
      // No safe callback to redirect to → drop silently rather than
      // surface a half-state UI. The user is back on home as if the
      // bad URL never arrived.
      return true;
    }

    // Just stash; the post-unlock effect (above, near pendingAuthRequest's
    // unlock handler) navigates once identity + encryption key are ready.
    setPendingAddDependantRequest(parsed);
    return true;
  }, []);

  useEffect(() => {
    consumeAddDependantUrl(window.location.search);
  }, [consumeAddDependantUrl]);

  /**
   * Web-redirect entry point for NIP-46 pairing (desktop fallback).
   *
   * Companion apps that can't rely on native `nostrconnect://` scheme
   * handlers (e.g. desktop browsers on Linux, where the scheme just
   * drops users into a "pick an app" prompt) redirect to
   *   https://mysignet.app/?nostrconnect=<encodeURIComponent(URI)>
   * instead. We percent-decode the param, feed it to the existing
   * parse + approve pipeline, and clear the URL.
   *
   * Precedence: the auth useEffect above runs first and clears the URL
   * if it matched. If the incoming URL had both `?auth=1` and
   * `?nostrconnect=`, auth wins. Realistic URLs won't combine them —
   * they're distinct protocols.
   *
   * Validation stays inside `parseNostrConnectURI` (hex-64 pubkey,
   * `wss://` or `ws://localhost` relay, metadata sanitisation). The
   * companion app is expected to wrap the inner URI with a single
   * `encodeURIComponent`; `URLSearchParams.get` decodes once on our
   * side. No further `decodeURIComponent` — doing so would double-
   * decode and mangle any pre-escaped `%XX` inside the inner URI
   * (e.g. the metadata JSON's quote characters).
   *
   * Extracted to a callback for the same reason as `consumeVerifyUrl` above
   * — the native `root-carrier` App Link path feeds it a query string
   * directly, bypassing `window.location`. Returns whether it found and
   * consumed a nostrconnect request.
   */
  const consumeNostrConnectUrl = useCallback((search: string): boolean => {
    const params = new URLSearchParams(search);
    const uri = params.get('nostrconnect');
    if (!uri) return false;
    const request = parseNostrConnectURI(uri);
    if (!request) return false;

    // Optional callback= URL. The helper enforces
    // scheme (https or http-loopback) and anti-phishing origin match
    // against the inner nostrconnect metadata's appUrl. A rejected
    // callback drops silently — pairing still succeeds; the user just
    // lands on home instead of being bounced.
    const callback = parseCallback(params.get('callback'), request.appUrl);

    // Clear the URL before routing so a page refresh doesn't re-trigger.
    window.history.replaceState({ page: 'home' }, '', window.location.pathname);

    setPendingConnectRequest(request);
    setPendingConnectCallback(callback);
    navigateReplace('approve-connect');
    return true;
  }, [navigateReplace]);

  useEffect(() => {
    consumeNostrConnectUrl(window.location.search);
  }, [consumeNostrConnectUrl]);

  // Native (APK): URLs that open the app — the `signet-grant://` scheme and
  // verified https://mysignet.app App Links (`/pair` and the root path, see
  // AndroidManifest.xml). Two delivery paths, one handler:
  //   - `appUrlOpen` fires on warm reopen (singleTask → onNewIntent) AND on
  //     cold start (BridgeActivity.onCreate replays the launch intent through
  //     onNewIntent; the plugin retains the event until JS subscribes);
  //   - `getLaunchUrl()` is read once on mount as belt-and-braces for cold
  //     start. Both can deliver the same URL, so exact-string dedupe.
  // A Sign-in-with-Signet URL goes through `consumeUrlAuthRequest`, the same
  // entry point the web `?auth=1` load uses — same parser, same approval
  // screen. Consumers using relay delivery (the SDK default) get their result
  // over the relay, so no browser window is involved; redirect-mode callbacks
  // navigate to a foreign host, which Capacitor hands to the system browser.
  // A `root-carrier` action is a root-path URL that isn't sign-in — its query
  // string is handed to the same `consumeVerifyUrl` / `consumeAddDependantUrl`
  // / `consumeNostrConnectUrl` callbacks the web mount effects above use, in
  // that order, so those carriers keep working when claiming the root path
  // as an App Link makes the web page's own mount-time
  // `window.location.search` effects inert inside the APK's WebView.
  const lastNativeUrlRef = useRef<string | null>(null);
  const launchUrlReadRef = useRef(false);
  const handleNativeUrl = useCallback((url: string) => {
    if (!url || lastNativeUrlRef.current === url) return;
    lastNativeUrlRef.current = url;
    const contactInvite = parseContactInviteLink(url);
    if (contactInvite) { setPendingContactInvite(JSON.stringify(contactInvite)); return; }
    const action = routeNativeUrl(url);
    switch (action.type) {
      case 'companion-pair':
        setPendingPairingRequest(action.request);
        navigateReplace('approve-companion-grant');
        return;
      case 'contacts-pair-v2':
        // R-33: HELD, never routed from here. This callback is fed by
        // `getLaunchUrl()` on mount, which runs above the
        // `identityLoading || prefsLoading` early return — so `isPairedChild`
        // and the dependant roster are both still at their defaults. The
        // held-request effect below applies the paired-child gate (with the
        // notice, R-8/M7) and navigates, once real state has loaded.
        setHeldContactsGrantV2(action.request);
        return;
      case 'sign-in':
        consumeUrlAuthRequest(action.href);
        return;
      case 'root-carrier': {
        let search = '';
        try { search = new URL(action.href).search; } catch { return; }
        if (consumeVerifyUrl(search)) return;
        if (consumeAddDependantUrl(search)) return;
        consumeNostrConnectUrl(search);
        return;
      }
      case 'none':
        return;
    }
  }, [consumeUrlAuthRequest, navigateReplace, consumeVerifyUrl, consumeAddDependantUrl, consumeNostrConnectUrl, isPairedChild]);

  useEffect(() => {
    if (!isNativeApp()) return;
    const sub = CapacitorApp.addListener('appUrlOpen', (event) => { handleNativeUrl(event.url); });
    if (!launchUrlReadRef.current) {
      launchUrlReadRef.current = true;
      void CapacitorApp.getLaunchUrl().then((launch) => {
        if (launch?.url) handleNativeUrl(launch.url);
      }).catch(() => { /* no launch URL — normal launcher start */ });
    }
    return () => { void sub.then(s => s.remove()); };
  }, [handleNativeUrl]);

  /**
   * Same-device web carrier for companion-rail pairing (desktop/laptop
   * companion app redirects the browser to
   *   https://mysignet.app/?pair=1&app=...&relay=...&t=...&challenge=...
   * so a phone that already has MySignet open — or is nudged to open it —
   * lands straight on the approve screen). Mirrors the ?auth=1 handler
   * above: parse from the query string, clear the URL so a refresh doesn't
   * re-trigger, then stage the request and navigate.
   */
  useEffect(() => {
    const search = window.location.search;
    if (!search) return;
    const params = new URLSearchParams(search);
    if (params.get('pair') !== '1') return;
    // v2 first, by its explicit `v=2` marker rather than by "did the other
    // parser fail" — the same order and the same reason as `qr-router`, so
    // neither version can ever be silently read as the other.
    const v2Request = parseContactsPairingRequestV2(search).request;
    const v1Request = v2Request ? null : parsePairingRequest(search).request;

    // Clear the URL before routing so a page refresh doesn't re-trigger.
    window.history.replaceState({ page: 'home' }, '', window.location.pathname);

    if (v2Request) {
      // R-33: HELD until preferences and the dependant roster have loaded —
      // this effect is registered above the `identityLoading || prefsLoading`
      // early return, so it runs on the first commit, when `isPairedChild` is
      // still the bare default and `dependants` is still empty. Routing from
      // here refused itself at the render guard one commit later (leaving a
      // paired-child user on a fallthrough with no explanation and no
      // `?pair=1` left to retry), and pre-selected the OWNER's directory for
      // an app that asked for a child's — the larger disclosure of the two.
      setHeldContactsGrantV2(v2Request);
      return;
    }
    if (!v1Request) return;
    setPendingPairingRequest(v1Request);
    navigateReplace('approve-companion-grant');
  }, [navigateReplace]);

  /**
   * R-33: apply a held v2 pairing request once real state exists.
   *
   * Both mount carriers park their parsed request rather than routing it. The
   * URL has already been cleared by then, so this is the only thing that can
   * still act on it — which is also what makes the paired-child branch here
   * the one place that has to say so out loud (M7): a silent `return` would
   * leave the request in limbo with nothing left to retry.
   */
  useEffect(() => {
    if (!heldContactsGrantV2) return;
    if (prefsLoading || dependantsLoading) return;
    setHeldContactsGrantV2(null);
    if (isPairedChild) { setContactsGrantPairedChildNotice(true); return; }
    setPendingContactsGrantV2(heldContactsGrantV2);
    navigateReplace('contacts-grant-approve');
  }, [heldContactsGrantV2, prefsLoading, dependantsLoading, isPairedChild, navigateReplace]);

  /**
   * B/M4: a staged request the approve page's own guard would refuse is
   * cleared rather than left set for the rest of the session with no surface
   * that can consume it. R-33 means this should now be unreachable for the
   * carriers; the QR route can still stage one and then have preferences
   * change underneath it.
   */
  useEffect(() => {
    if (!pendingContactsGrantV2 || prefsLoading || !isPairedChild) return;
    setPendingContactsGrantV2(null);
    setContactsGrantPairedChildNotice(true);
  }, [pendingContactsGrantV2, prefsLoading, isPairedChild]);

  // Loading
  if (identityLoading || prefsLoading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--text-secondary)' }}>Loading...</div>;
  }

  // Pending auth setup (new account or bunker onboarding) — must check before !identity
  // because bunker onboarding saves identity to IndexedDB but useIdentity hasn't reloaded yet
  if (pendingEncryptionKey) {
    return <SetupAuth encryptionKey={pendingEncryptionKey} onComplete={handleSetupComplete} />;
  }

  // Auth gate removed from app entry — identity public data loads without auth.
  // PIN/biometric is now prompted on-demand when a signing operation is needed.
  // The AuthScreen is shown as a modal overlay via showAuthPrompt state.

  // No identity — show onboarding.
  if (!identity) {
    if (pendingAuthRequest) {
      let originHost: string;
      try { originHost = new URL(pendingAuthRequest.origin).hostname; }
      catch { originHost = pendingAuthRequest.origin.slice(0, 64); }
      return (
        <Onboarding
          siteName={urlAuthSiteName}
          originHost={originHost}
          onCreate={(displayName, primary, isChild) => handleCreate(displayName, primary, isChild, undefined)}
          onImport={(mnemonic, displayName, primary, isChild) => handleImport(mnemonic, displayName, primary, isChild, undefined)}
          onCancel={handleDenyAuth}
          mode="auth"
        />
      );
    }
    if (pendingConnectRequest) {
      // Pairing-context onboarding. Surfaces the companion app's
      // name in the consumer bar so the user knows why they're being
      // asked to set up a Signet. After onboarding completes the
      // pendingConnectRequest survives and ApproveConnect renders via
      // the page='approve-connect' state my URL handler set on mount.
      const appName = pendingConnectRequest.appName;
      let originHost = appName;
      if (pendingConnectRequest.appUrl) {
        try { originHost = new URL(pendingConnectRequest.appUrl).hostname; }
        catch { /* keep appName */ }
      }
      return (
        <Onboarding
          siteName={appName}
          originHost={originHost}
          onCreate={(displayName, primary, isChild) => handleCreate(displayName, primary, isChild, undefined)}
          onImport={(mnemonic, displayName, primary, isChild) => handleImport(mnemonic, displayName, primary, isChild, undefined)}
          onCancel={handleConnectDone}
          mode="connect"
        />
      );
    }
    if (pairChildFlow) {
      return (
        <PairChildOnboarding
          onConfirm={async (parsed, rawUri) => {
            await handlePairChild(parsed, rawUri);
            setPairChildFlow(false);
          }}
          onCancel={() => setPairChildFlow(false)}
        />
      );
    }
    return <OnboardingApp onCreate={handleCreateSignet} onImport={handleImport} onImportLiteMnemonic={handleImportLiteMnemonic} onImportWithProfile={handleImportWithProfile} onImportNsec={handleImportNsec} onConnectHeartwood={handleConnectHeartwood} onConnectNip07={handleConnectNip07} onStartChildPair={() => setPairChildFlow(true)} />;
  }

  // Past the !identity guard — both identity and displayIdentity are non-null
  // When acting as a dependant, build a synthetic identity for display
  const currentIdentity: import('./types').SignetIdentity = activeDependant
    ? {
        id: activeDependant.primaryKeypair === 'natural-person'
          ? activeDependant.naturalPerson.publicKey
          : activeDependant.primaryKeypair === 'persona'
            ? activeDependant.persona.publicKey
            : activeDependant.primaryKeypair,
        mnemonic: '',
        naturalPerson: activeDependant.naturalPerson,
        persona: activeDependant.persona,
        extraPersonas: activeDependant.extraPersonas,
        primaryKeypair: (activeDependant.primaryKeypair === 'natural-person' || activeDependant.primaryKeypair === 'persona')
          ? activeDependant.primaryKeypair
          : 'persona',
        naturalPersonActive: isDependantNaturalPersonActive(activeDependant),
        isChild: true,
        guardianPubkey: activeDependant.guardianPubkey,
        createdAt: activeDependant.createdAt,
        encrypted: false,
        photoHash: activeDependant.photoHash,
        blossomUrl: activeDependant.blossomUrl,
        photoKey: activeDependant.photoKey,
        photoUpdatedAt: activeDependant.photoUpdatedAt,
      }
    : displayIdentity!;

  const guardianLayoutProps = activeDependant ? {
    guardianMode: true,
    guardianDependantName: activeDependant.displayName,
    guardianActingAs: carousel.childMode,
    // Route the banner "Back to me" through the PIN-gated exit only when in
    // true child-mode (guardian handed device to kid). When the guardian is
    // just deep-paged to a dep-scoped page (carousel col-2 → Phone & Pairing
    // etc.), they're still in guardian context — exiting is just collapsing
    // the dep scope, no PIN required. Without this split, banner copy says
    // "Managing X" but the exit still demands the PIN, which is confusing.
    onExitGuardianMode: carousel.childMode
      ? () => { handleExitChildMode(); }
      : () => { setActiveDependantId(null); navigateTo('home'); },
    // Only offer the hand-off picker if there's actually someone to switch to.
    onOpenHandoffPicker: dependants.length > 1 ? () => setShowHandoffPicker(true) : undefined,
  } : {};


  // PWA update banner — fires when a new service worker is installed and
  // waiting to activate. The existing auto-update at lines 1291-1303 only
  // triggers on lock transitions, which is the right call for casual users
  // (the app naturally cycles in/out of lock as they background it). But a
  // user testing actively in the foreground never locks — so `needRefresh`
  // ticks true and the new SW sits waiting indefinitely, and the user keeps
  // seeing the old VersionBadge build hash. This banner gives unlocked-
  // continuous-use a visible "tap to apply" affordance. `updateServiceWorker`
  // calls SW.skipWaiting() and reloads the page; on next paint the new SW
  // serves the new build. Hidden once `needRefresh` flips false (which
  // happens during the reload), so the banner self-clears.
  const updateBanner = needRefresh ? (
    <div style={{ background: 'var(--accent-light)', padding: '10px 16px', fontSize: 13, color: 'var(--accent-text)', display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ flex: 1 }}>A new version of MySignet is ready.</span>
      <button
        onClick={() => updateServiceWorker(true)}
        className="btn btn-primary"
        style={{ fontSize: 13, padding: '4px 12px' }}
      >
        Update
      </button>
    </div>
  ) : null;

  // Signer status banner. The 'unavailable' copy branches on signing
  // mode — paired-child installs get the actionable failure UX
  // (check network, ask the guardian to add a fallback relay) instead
  // of the generic bunker-mode line, because the child typically
  // doesn't know what "signer" means and the remedy is different.
  const signerBanner = signerStatus === 'connecting' ? (
    <div style={{ background: 'var(--bg-secondary)', padding: '8px 16px', textAlign: 'center', fontSize: 14, color: 'var(--text-secondary)' }}>
      {isPairedChild ? 'Reaching your guardian…' : 'Connecting to signer...'}
    </div>
  ) : signerStatus === 'unavailable' ? (
    isPairedChild ? (
      <div style={{ background: 'var(--danger-light)', padding: '10px 16px', fontSize: 13, color: 'var(--danger)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontWeight: 600 }}>Can't reach your guardian's bunker.</div>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.4 }}>
          Check your internet. If you still can't connect, ask them to add a fallback relay in their app.
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={handleRetryConnect} className="btn btn-primary" style={{ flex: 1, fontSize: 13, padding: '4px 10px' }}>
            Retry
          </button>
        </div>
      </div>
    ) : (
      <div style={{ background: 'var(--danger-light)', padding: '8px 16px', textAlign: 'center', fontSize: 14, color: 'var(--danger)' }}>
        Signer unavailable
        <button onClick={handleRetryConnect} className="btn btn-ghost" style={{ marginLeft: 8, fontSize: 14, padding: '2px 8px' }}>
          Retry
        </button>
      </div>
    )
  ) : null;

  // Sync-rail backup-missing banner (see usePersonasSync/useDependantsSync/
  // useContactsSync/useCredentialsSync/useGrantsSync above). Fires whenever
  // ANY rail reports 'missing-after-seen' — a relay record this device
  // previously saw is now gone. Gated per rail on "there's something to
  // lose/recover": personas/dependants/grants have a local list in scope to
  // check against; contacts/credentials don't have an ungated accurate
  // count at this call site (`members` is scoped to the active persona,
  // not the full cross-keypair contacts set the rail actually publishes),
  // so those two rails go ungated — except on a paired-child install, where
  // the kid's device has no owner contacts/credentials rail of its own and
  // an empty relay there is normal, not a lost backup.
  //
  // Contacts has two rails (legacy read-only + v2) sharing one entry — see
  // missingBackupRailsFor in src/lib/sync-banner.ts.
  const missingBackupRails = missingBackupRailsFor({
    personas: personasRemoteState,
    dependants: dependantsRemoteState,
    contacts: contactsRemoteState,
    contactsV2: contactsV2RemoteState,
    credentials: credentialsRemoteState,
    grants: grantsRemoteState,
    extraPersonaCount: identity?.extraPersonas?.length ?? 0,
    dependantCount: dependants?.length ?? 0,
    grantCount: grantsForSync?.length ?? 0,
    isPairedChild,
  });
  // Plain-English join: "a", "a and b", "a, b and c".
  const missingBackupList = missingBackupRails.length <= 1
    ? (missingBackupRails[0] ?? '')
    : `${missingBackupRails.slice(0, -1).join(', ')} and ${missingBackupRails[missingBackupRails.length - 1]}`;
  const syncBackupBanner = missingBackupRails.length > 0 ? (
    <div style={{ background: 'var(--danger-light)', padding: '10px 16px', fontSize: 13, color: 'var(--danger)' }}>
      {/* No unconditional "this device still has it": the rail may be
          missing precisely because this device is the one that can't
          represent it (a restored device with no Pro slot, a persona it
          couldn't reconstitute). */}
      {missingBackupRails.length === 1
        ? `Your ${missingBackupList} backup is missing from your relay. If this device holds it it will be republished; check the relay if this keeps happening.`
        : `Your ${missingBackupList} backups are missing from your relay. If this device holds them they will be republished; check the relay if this keeps happening.`}
    </div>
  ) : null;

  // R6: the v2 contacts log has either outgrown what the rail can carry
  // ('too-large') or has a relay round trip stuck with no leg left that
  // could succeed ('stalled', Task 6 review ruling). Distinct from a missing
  // backup — nothing was lost, the copy to the relay stopped.
  //
  // F2: one banner, one copy ternary — was two near-identical divs sharing
  // every prop but the text.
  const contactsBackupTooLargeBanner = contactsV2BackupState === 'ok' ? null : (
    <div style={{ background: 'var(--danger-light)', padding: '10px 16px', fontSize: 13, color: 'var(--danger)' }}>
      {contactsV2BackupState === 'too-large' ? CONTACTS_BACKUP_TOO_LARGE_COPY : CONTACTS_BACKUP_STALLED_COPY}
    </div>
  );

  // The grant registry's own rail, beside the contacts one rather than folded
  // into the five-rail missing-backup aggregate: a registry that will not fit
  // is a different fact from a backup that has gone missing, and the remedy
  // (disconnect an app) is different too.
  const contactsGrantsBackupBanner = contactsGrantsBackupState === 'ok' ? null : (
    <div style={{ background: 'var(--danger-light)', padding: '10px 16px', fontSize: 13, color: 'var(--danger)' }}>
      {GRANTS_BACKUP_TOO_LARGE_COPY}
    </div>
  );

  // R-26: apps connected on ANOTHER device that this one could not adopt,
  // because it is already at `CONTACT_GRANT_V2_CAP` active grants. Said out
  // loud — an app that quietly never arrives is indistinguishable from one
  // that was never connected.
  const contactsGrantsSkippedBanner = contactsGrantsSkippedRemote > 0 ? (
    <div style={{ background: 'var(--bg-secondary)', padding: '8px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>
      {GRANTS_SKIPPED_REMOTE_COPY(contactsGrantsSkippedRemote)}
    </div>
  ) : null;

  /**
   * The contacts v2 half of the connected-apps page (fix round 1 / I3: the
   * markup and every string it renders now live in
   * `components/ContactsGrantList.tsx`, so the contacts-v2 vocabulary guard's
   * `src/components/Contact*.tsx` glob binds them). State and actions stay
   * here; the component is presentational.
   */
  const contactsGrantsSection = !contactsV2GrantSurfaceEnabled ? null : (
    <ContactsGrantList
      grants={contactsGrantRows}
      directories={contactsGrantDirectoryOptions}
      error={contactsGrantActionError}
      confirmingGrantId={contactsGrantConfirmId}
      busyGrantId={contactsGrantBusyId}
      onConfirmDisconnect={(grantId) => { setContactsGrantActionError(null); setContactsGrantConfirmId(grantId); }}
      onCancelDisconnect={() => setContactsGrantConfirmId(null)}
      onDisconnect={(grantId) => { void runContactsGrantAction(grantId, handleRevokeContactsGrantV2); }}
      onAutoAcceptChange={(grantId, enabled) => { void runContactsGrantAction(grantId, async id => {
        if (!encryptionKey) return;
        await updateContactGrantV2(id, encryptionKey, current => current.revokedAt ? null
          : { ...current, autoAcceptInvites: enabled, updatedAt: Math.max(Date.now(), current.updatedAt + 1) });
        bumpContactsGrantSet();
      }); }}
      onForget={(grantId) => { void runContactsGrantAction(grantId, handleForgetContactsGrantV2); }}
    />
  );

  /**
   * M7: a pairing code scanned on a paired-child install. R-8 means there is
   * no v2 grant surface there at all, so the scan fails closed — but WITH a
   * reason: a scan that silently does nothing reads as a broken camera, and
   * the person holding the phone has no way to learn that the guardian device
   * is the one that can do this.
   */
  const contactsGrantPairedChildBanner = contactsGrantPairedChildNotice ? (
    <div style={{ background: 'var(--bg-secondary)', padding: '8px 16px', fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ flex: 1 }}>{CONTACTS_GRANT_PAIRED_CHILD_COPY}</span>
      <button onClick={() => setContactsGrantPairedChildNotice(false)} className="btn btn-ghost" style={{ fontSize: 13, padding: '2px 8px' }}>
        {CONTACTS_GRANT_DISMISS_LABEL}
      </button>
    </div>
  ) : null;

  // `skipped` means "arrived on the wire but could not be reconstituted on
  // this device" — never "imported": imported extras aren't on the wire at
  // all (toWire drops them), so they can't be skipped.
  const personasSkippedBanner = (personasSkipped.length > 0 && !personasSkippedDismissed) ? (
    <div style={{ background: 'var(--bg-secondary)', padding: '8px 16px', fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ flex: 1 }}>
        {personasSkipped.length} {personasSkipped.length === 1 ? 'persona' : 'personas'} from another device could not be added on this device.
      </span>
      <button onClick={() => setPersonasSkippedDismissed(true)} className="btn btn-ghost" style={{ fontSize: 13, padding: '2px 8px' }}>
        Dismiss
      </button>
    </div>
  ) : null;

  // Scenario (e): a seed-phrase restore this session found NO persona record
  // on the relay. On a genuine first run that's simply the normal state and
  // gets no banner at all; after a restore it's worth a soft, non-alarming
  // word, because adding new personas before fixing a wrong relay setting is
  // how a user ends up with two divergent persona-N sequences.
  const restoreNoBackupBanner = (
    personasRemoteState === 'never-seen' && restoredThisSessionRef.current && !restoreNoBackupDismissed
  ) ? (
    <div style={{ background: 'var(--bg-secondary)', padding: '8px 16px', fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ flex: 1 }}>
        No persona backup found on your relay. If you had extra personas, check your relay setting before adding new ones.
      </span>
      <button onClick={() => setRestoreNoBackupDismissed(true)} className="btn btn-ghost" style={{ fontSize: 13, padding: '2px 8px' }}>
        Dismiss
      </button>
    </div>
  ) : null;

  // Composed banner — update sits ABOVE signer status because it's more
  // actionable (a tap actually completes the flow, vs. signer-status which
  // is often informational). Threaded through every existing signerBanner
  // render site below, so the user sees it regardless of which page they're
  // on when the new SW lands. Sync banners are informational, so they sit
  // below signer status.
  const privateVaultBanner = !isPairedChild && encryptionKey ? <PrivateVaultStatus key={privateVaultSession}
    onRotate={privateVaultSupported && !activeDependant && supportsPrivateVaultRotationLock() ? rotatePrivateBackup : undefined}
    health={privateVaultSupported ? privateVaultHealth : { phase: 'unsupported', datasets: {} }}
    importedDependants={dependants.filter(d => !/^dependant-(0|[1-9][0-9]*)$/.test(d.derivationPath)).length}
  /> : null;
  const topBanners = (privateVaultBanner || updateBanner || signerBanner || syncBackupBanner || contactsBackupTooLargeBanner
    || contactsGrantsBackupBanner || contactsGrantsSkippedBanner || contactsGrantPairedChildBanner
    || personasSkippedBanner || restoreNoBackupBanner) ? (
    <>{updateBanner}{signerBanner}{privateVaultBanner}{syncBackupBanner}{contactsBackupTooLargeBanner}
      {contactsGrantsBackupBanner}{contactsGrantsSkippedBanner}{contactsGrantPairedChildBanner}
      {personasSkippedBanner}{restoreNoBackupBanner}</>
  ) : null;

  // On-demand auth prompt overlay — rendered on any page that triggers requestAuth
  const authOverlay = showAuthPrompt ? (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: Z.overlay, background: 'var(--scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={(e) => { if (e.target === e.currentTarget) handleAuthPromptCancel(); }}
    >
      <div style={{ width: '100%', maxWidth: 400 }}>
        <AuthScreen
          onUnlock={handleAuthPromptUnlock}
          onCancel={handleAuthPromptCancel}
          purposeContext={authPromptContext}
        />
      </div>
    </div>
  ) : null;

  // NIP-46 bunker server approval UI (Phase 2).
  // Rendered alongside authOverlay on every page so inbound sign_event
  // requests surface immediately regardless of where the user is.
  //
  // Single-modal serial flow (holodeck OQ8). Exposed as one variable so
  // per-page renders don't need to branch — they just drop it in.
  const bunkerApprovalOverlay = bunkerPanelOpen ? null : (bunkerPendingApproval ? (
        <BunkerApprovalModal
          approval={bunkerPendingApproval}
          onApproveOnce={bunkerApproveOnce}
          onApproveAlways={bunkerApproveAlways}
          onDeny={bunkerDeny}
        />
      ) : null);

  // A request from an app on this phone. Rendered wherever the auth overlay
  // is, which is every page including the guest home: the request may have
  // arrived on any of them, and the person was brought here to answer it.
  // Waits its turn behind a relay request, and never shows over the PIN.
  const nip55Overlay = nip55.pending && !showAuthPrompt && !bunkerPendingApproval ? (
        <Nip55ApprovalModal
          approval={nip55.pending}
          identities={nip55Identities}
          onApproveOnce={nip55.approveOnce}
          onApproveAlways={nip55.approveAlways}
          onDeny={nip55.deny}
          onDenyAlways={nip55.denyAlways}
        />
      ) : null;

  // Hand-off picker overlay — shown when the guardian taps the banner while in
  // child-mode to hand the phone to a different dependant. No PIN required
  // (guardian is already holding the device). Rendered alongside authOverlay
  // on every page so it works inside deep pages too. Spec §2.
  const handoffPickerOverlay = showHandoffPicker && activeDependant ? (
    <DependantSwitchPicker
      dependants={dependants}
      activeDependantId={activeDependant.id}
      onSwitch={(depId) => { handleEnterChildMode(depId); setShowHandoffPicker(false); }}
      onClose={() => setShowHandoffPicker(false)}
    />
  ) : null;

  // Spec §9 — the legacy no-lock migration takes precedence over every other
  // screen: an identity with no lock has no way back in until it has one.
  if (legacyMigration === 'setup' && legacyMigrationKey) {
    return <SetupAuth encryptionKey={legacyMigrationKey} mode="legacy-guest" onComplete={handleLegacyGuestComplete} />;
  }

  if (legacyMigration === 'notice') {
    return (
      <>
        {legacyMigrationError && (
          <div style={{ padding: 12, background: 'var(--danger-light)', color: 'var(--danger)', fontSize: '0.9rem' }}>
            {legacyMigrationError}
          </div>
        )}
        <LegacyGuestNotice onSecure={handleLegacyGuestSecure} />
      </>
    );
  }

  // Authenticated page routing, wrapped by <AppShell> (persistent nav) below.
  const renderPage = (): React.ReactNode => {

  if (page === 'venue-entry' && identity && !activeDependant && !npActive) {
    return renderRealIdentityGate(
      'A venue reads your legal name at the door, so venue entry needs your real identity.',
      'venue-entry',
    );
  }

  if (page === 'venue-entry' && identity && activeDependant && !isDependantNaturalPersonActive(activeDependant)) {
    return renderDependantRealIdentityGate(
      dependantGateReason('venue-entry', activeDependant.displayName),
      'venue-entry',
      activeDependant.id,
    );
  }

  // Venue Entry — full-screen, no Layout wrapper
  if (page === 'venue-entry') {
    if (!npBackend) {
      return (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--text-secondary)' }}>
            Unlocking...
          </div>
          {authOverlay}{nip55Overlay}
          {bunkerApprovalOverlay}
          {handoffPickerOverlay}
        </>
      );
    }
    return (
      <VenueEntry
        identity={currentIdentity}
        backend={npBackend}
        onBack={() => navigateBack()}
        onNavigatePhoto={() => navigateTo('photo-capture')}
      />
    );
  }

  // Photo Capture — Blossom upload
  if (page === 'photo-capture') {
    if (!npBackend) {
      return (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--text-secondary)' }}>
            Unlocking...
          </div>
          {authOverlay}{nip55Overlay}
          {bunkerApprovalOverlay}
          {handoffPickerOverlay}
        </>
      );
    }
    return (
      <Layout title="Add Photo" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <PhotoCapture
          identity={currentIdentity}
          backend={npBackend}
          blossomConsent={blossomConsent}
          onSetBlossomConsent={setBlossomConsent}
          onUpdatePhoto={activeDependant
            ? (photoHash, blossomUrl, photoKey) =>
                updateDependantPhoto(activeDependant.id, photoHash, blossomUrl, photoKey)
            : updatePhoto}
          onBack={() => navigateBack()}
          defaultBlossomUrl={preferences.defaultBlossomUrl ?? DEFAULT_BLOSSOM_URL}
        />
      </Layout>
    );
  }

  // Badge Embed — embed code generator
  if (page === 'badge-embed') {
    const activePubkeyForBadge = activePubkey ?? '';
    const npubForBadge = isValidHexKey(activePubkeyForBadge) ? encodeNpub(hexToBytes(activePubkeyForBadge)) : '';
    return (
      <Layout title="Embed Codes" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <BadgeEmbed npub={npubForBadge} badge={ownBadge} />
      </Layout>
    );
  }

  /**
   * Render the "activate your real identity" interstitial for a gated feature
   * (spec §7.3). `returnTo` is where activation drops the user afterwards, so
   * the feature they were reaching for opens by itself.
   */
  function renderRealIdentityGate(reason: string, returnTo: Page) {
    return (
      <Layout title="Your real identity" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <RequireRealIdentity
          reason={reason}
          onActivate={() => { setActivationReturnTo(returnTo); navigateTo('activate-real-identity'); }}
          onCancel={() => navigateBack()}
        />
      </Layout>
    );
  }

  /**
   * Dependant flavour of the §7.3 gate. Guardian-device only by construction,
   * not by a branch: `activeDependant` resolves out of `dependants`, which on a
   * paired-child install is always empty (that install is created by
   * `handlePairChild` from the no-identity onboarding door, writes no dependant
   * records, and its dependants rail is addressed to the child's own pubkey).
   * So this gate is only ever rendered on a guardian device, and the button
   * always leads to the real ceremony. The previous paired-child branch offered
   * a `btn-primary` "Activate my real identity" that only navigated back.
   *
   * The card title names the subject rather than saying "your" — the person
   * reading it is the guardian, and the identity being activated is the child's.
   */
  function renderDependantRealIdentityGate(reason: string, returnTo: Page, depId: string) {
    const dep = dependants.find(d => d.id === depId);
    const who = dep?.displayName || 'This dependant';
    return (
      <Layout title="Real identity" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <RequireRealIdentity
          title={`${who}'s real identity`}
          activateLabel="Activate their real identity"
          reason={reason}
          onActivate={() => {
            setPendingDependantActivation(depId);
            setActivationReturnTo(returnTo);
            navigateTo('activate-real-identity');
          }}
          onCancel={() => navigateBack()}
        />
      </Layout>
    );
  }

  const renderSettingsPage = (_activePage: Page, title: string, content: React.ReactNode, extras?: React.ReactNode) => {
    return (
      <Layout title={title} showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        {authOverlay}{nip55Overlay}
          {handoffPickerOverlay}
        {extras}
        {content}
      </Layout>
    );
  };

  if (page === 'connections') {
    return renderSettingsPage('connections', 'Connected Sites', (
      <Connections
        sites={authorizedSites}
        identity={identity}
        originPolicies={originPolicies}
        connectedClients={connectedClients}
        onRevoke={revokeSite}
        onDisconnectClient={disconnectClient}
        phoneApps={phoneApps}
        onForgetPhoneApp={nip55.forget}
        onSetPinned={setOriginPinned}
        onUpdateAlias={updateSiteAlias}
        onBack={() => navigateBack()}
      />
    ));
  }

  if (page === 'companion-apps') {
    return renderSettingsPage('companion-apps', 'Companion apps', (
      <>
        {contactsGrantsSection}
        <CompanionApps
          atCap={companionGrantCount >= COMPANION_GRANT_CAP}
          bunkerMode={!identity?.mnemonic}
          onRevoke={handleRevoke}
          onBack={() => navigateBack()}
        />
      </>
    ));
  }

  if (page === 'roster') {
    if (!npBackend) {
      return (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--text-secondary)' }}>
            Unlocking...
          </div>
          {authOverlay}{nip55Overlay}
          {bunkerApprovalOverlay}
          {handoffPickerOverlay}
        </>
      );
    }
    return (
      <Layout title="Manage Roster" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <Roster
          backend={activeBackend ?? npBackend}
          signerDisplayName={identity ? getActiveDisplayName(identity) : undefined}
          onBack={() => navigateBack()}
        />
      </Layout>
    );
  }

  // Settings page — guardian mode vs owner menu
  if (page === 'settings') {
    if (activeDependant) {
      return (
        <Layout title="Settings" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
          {authOverlay}{nip55Overlay}
          {bunkerApprovalOverlay}
          {handoffPickerOverlay}
          {topBanners}
          <GuardianSettings
            activeDependant={activeDependant}
            onUpdateDependantName={handleUpdateDependantName}
            onUpdateAutonomyStage={handleUpdateAutonomyStage}
            auditVisibility={activeDependant.auditVisibility ?? 'default'}
            onChangeAuditVisibility={handleUpdateAuditVisibility}
            onBeginCeremony={() => navigateTo('transition-ceremony')}
            onPairDevice={() => navigateTo('pair-dependant-device')}
            onPairApp={() => navigateTo('pair-dependant-app')}
            onViewActivity={() => navigateTo('activity')}
            appPairings={activeDependant.appBunkerEndpoint?.pairings ?? []}
            onRevokeAppPairing={async (clientPubkey) => {
              const key = encryptionKey || await requestAuth();
              if (!key) throw new Error('Authentication required');
              await dbRemoveAppBunkerPairing(activeDependant.id, clientPubkey, key);
              await reloadDependants();
            }}
            onSwitchDependantPrimary={async (kp) => {
              const key = encryptionKey || await requestAuth();
              if (!key) throw new Error('Authentication required');
              await switchDependantPrimary(activeDependant.id, kp, key);
            }}
            onUpdateDependantPersonaName={async (target, name) => {
              const key = encryptionKey || await requestAuth();
              if (!key) throw new Error('Authentication required');
              await updateDependantPersonaName(activeDependant.id, target, name, key);
            }}
            onAddDependantPersona={async (displayName) => {
              const key = encryptionKey || await requestAuth();
              if (!key) throw new Error('Authentication required');
              await addDependantPersona(activeDependant.id, displayName, key, { deviceDerive: extraPersonaDeviceDerive });
            }}
            onUpdatePersonaVisibility={async (pubkey, visible) => {
              if (!activeDependant) return;
              await updatePersonaVisibility(activeDependant.id, pubkey, visible);
            }}
            guardianHasMnemonic={!!identity?.mnemonic || !!heartwoodRequestFn}
            requestAuth={requestAuth}
            ownerTier={securityTier}
            onUpdatePhoto={() => navigateTo('photo-capture')}
            currentContactPolicy={childSettingsMap.get(activeDependant.id)?.contactPolicy ?? 'kin-only'}
            contactPolicyConflicted={childSettingsMap.get(activeDependant.id)?.contactPolicyConflicted}
            onUpdateContactPolicy={async (policy) => {
              const key = await requestAuth();
              if (!key) return;
              const guardian = identity?.naturalPerson.publicKey;
              const current = () => encryptionKeyRef.current === key && identityRef.current?.naturalPerson.publicKey === guardian;
              if (!guardian || !current()) throw new Error('Unlock the guardian identity first.');
              const dep = (await loadFreshDependants(key)).find(dep => dep.id === activeDependant.id && dep.guardianPubkey === guardian);
              if (!dep || !current()) throw new Error('This dependant is no longer managed here.');
              const next = await updateChildContactSettings(
                dep.id,
                guardian,
                { contactPolicy: policy },
                identity ? [identity.id, identity.persona.publicKey] : [],
              );
              if (current()) setChildSettingsMap(prev => new Map(prev).set(dep.id, next));
            }}
            currentDefaultChildCeiling={childSettingsMap.get(activeDependant.id)?.defaultChildCeiling ?? DEFAULT_CHILD_CEILING}
            onUpdateDefaultChildCeiling={async (ceiling) => {
              const key = await requestAuth();
              if (!key) return;
              const guardian = identity?.naturalPerson.publicKey;
              const current = () => encryptionKeyRef.current === key && identityRef.current?.naturalPerson.publicKey === guardian;
              if (!guardian || !current()) throw new Error('Unlock the guardian identity first.');
              const dep = (await loadFreshDependants(key)).find(dep => dep.id === activeDependant.id && dep.guardianPubkey === guardian);
              if (!dep || !current()) throw new Error('This dependant is no longer managed here.');
              const next = await updateChildContactSettings(
                dep.id,
                guardian,
                { defaultChildCeiling: ceiling },
                identity ? [identity.id, identity.persona.publicKey] : [],
              );
              if (current()) setChildSettingsMap(prev => new Map(prev).set(dep.id, next));
            }}
            viewer={resolveSettingsViewer(preferences.signingMode, carousel.childMode)}
            onActivateDependantRealIdentity={
              resolveSettingsViewer(preferences.signingMode, carousel.childMode) === 'guardian'
                ? () => {
                    setPendingDependantActivation(activeDependant.id);
                    setActivationReturnTo('settings');
                    navigateTo('activate-real-identity');
                  }
                : undefined
            }
            startEditPersona={pendingPersonaFocus}
            onConsumeFocus={() => setPendingPersonaFocus(null)}
          />
        </Layout>
      );
    }
    return renderSettingsPage('settings', 'Settings', (
      <SettingsMenu
        identity={identity}
        preferences={preferences}
        onSetTheme={setTheme}
        onDeleteIdentity={handleDeleteIdentity}
        onRequestDeleteAuth={async () => {
          // PIN-gate Delete My Signet.
          // A fresh PIN/biometric prompt must succeed before the user
          // even sees the "Delete forever" confirm card — proof of
          // presence for the most destructive action the app offers.
          const key = await requestFreshAuth();
          return key !== null;
        }}
        powerMode={powerMode}
        onSetPowerMode={setPowerMode}
        onNavigate={async target => {
          if (target === 'bots') {
            setPendingBotContacts(undefined);
            if (!encryptionKey && !await requestAuth()) return;
          }
          navigateTo(target);
        }}
        showPairedChildSwitcher={preferences.signingMode === 'paired-child' && pairedChildMetas.length > 1}
        connectedSiteCount={authorizedSites.length}
        dependantsCount={dependants.length}
        companionGrantCount={companionGrantCount}
        webUpdateReady={needRefresh}
        onApplyWebUpdate={() => updateServiceWorker(true)}
      />
    ), topBanners);
  }

  if (page === 'bots' && !isPairedChild && !activeDependant && encryptionKey) {
    const root = identity.naturalPerson.publicKey;
    const personas = [identity.persona, ...(identity.professionalPersona ? [identity.professionalPersona] : []), ...(identity.extraPersonas ?? [])];
    return renderSettingsPage('bots', 'Bots', <Bots key={root} root={root} encryptionKey={encryptionKey}
      appConnections={{
        connect: async (botPubkey, request, eventKinds, duration, valid) => {
          const mode = preferences.signingMode;
          const key = await requestFreshAuth();
          const current = () => valid() && !!key && botSession.current.key === key && botSession.current.owner === root && botSession.current.mode === mode;
          if (!key || !current()) throw new Error('Bot app approval cancelled.');
          const signer = await makeBotAppSigner(botPubkey, current);
          const now = Math.floor(Date.now() / 1000), grantId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
          let saved = false;
          try {
            const existing = await loadBotAppGrants(root, key);
            if (!current()) throw new Error('Bot session changed');
            const relays = new Set(existing.filter(g => g.revokedAt === undefined && g.expiresAt > now).map(g => g.relayUrl));
            relays.add(request.relayUrl);
            if (relays.size > 16) throw new Error('Revoke an unused bot app connection before adding another relay.');
            await approveBotAppGrant({ root, encryptionKey: key, isCurrent: current,
              grant: { id: grantId, botPubkey, clientPubkey: request.clientPubkey, appName: request.appName, relayUrl: request.relayUrl,
                eventKinds, createdAt: now, expiresAt: now + duration } });
            saved = true; setBotsVersion(v => v + 1);
            await botAppServer.waitForReady(botPubkey, request.relayUrl, grantId, current);
            const assertGrantCurrent = async () => {
              const fresh = (await loadBotAppGrants(root, key)).find(g => g.id === grantId);
              if (!current() || !fresh || fresh.revokedAt !== undefined || fresh.expiresAt <= Date.now() / 1000) throw new Error('Bot app permission changed');
            };
            await assertGrantCurrent();
            if (!await sendConnectResponse(request, signer, request.relayUrl, assertGrantCurrent)) throw new Error('Bot app did not confirm the connection. Try again.');
            if (!current()) throw new Error('Bot session changed');
          } catch (error) {
            if (saved && current()) {
              await revokeBotAppGrant({ root, encryptionKey: key, isCurrent: current, grantId });
              setBotsVersion(v => v + 1);
            }
            throw error;
          } finally { signer.destroy(); }
        },
        revoke: async (grantId, valid) => {
          const key = encryptionKey;
          const current = () => valid() && botSession.current.key === key && botSession.current.owner === root;
          await revokeBotAppGrant({ root, encryptionKey: key, isCurrent: current, grantId });
          setBotsVersion(v => v + 1);
        },
      }}
      initialContactsBot={pendingBotContacts} personas={personas} identity={identity} deviceId={preferences.contactsDeviceId ?? ''} relayUrl={preferences.relayUrl ?? DEFAULT_RELAY_URL} version={botsVersion} onChanged={() => { setBotsVersion(v => v + 1); setBotsChangeVersion(v => v + 1); }}
      onCreate={async input => {
        const key = await requestFreshAuth();
        const current = () => encryptionKeyRef.current === key && identityRef.current?.naturalPerson.publicKey === root;
        if (!key || !current()) throw new Error('Unlock to create a bot.');
        const fresh = await loadIdentityDecrypted(identity.id, key);
        if (!fresh || fresh.naturalPerson.publicKey !== root || !current()) throw new Error('Bot session changed');
        let importedKey = input.importedKey?.trim();
        if (importedKey?.startsWith('nsec1')) {
          const secret = decodeNsec(importedKey);
          try { importedKey = bytesToHex(secret); } finally { secret.fill(0); }
        }
        await createBot({ ...input, importedKey, root, encryptionKey: key, now: Math.floor(Date.now() / 1000),
          ownedPersonas: [fresh.persona.publicKey, ...(fresh.professionalPersona ? [fresh.professionalPersona.publicKey] : []), ...(fresh.extraPersonas ?? []).map(p => p.publicKey)],
          occupiedKeys: dependants.flatMap(dep => [dep.naturalPerson.publicKey, dep.persona.publicKey, ...(dep.extraPersonas ?? []).map(p => p.publicKey)]),
          isCurrent: current, deriveRegistered: async name => {
            if (!current()) throw new Error('Bot session changed');
            if (preferences.signingMode !== 'bunker') {
              if (!fresh.mnemonic) throw new Error('This identity has no recovery tree.');
              return deriveExtraPersonaPubkey(fresh.mnemonic, name);
            }
            if (!heartwoodRequestFn) throw new Error('Connect your Heartwood signer first.');
            return (await deriveExtraPersonaOnDevice(heartwoodRequestFn, name)).publicKey;
          } });
      }}
      onOwnership={async (pubkey, action, days) => {
        const key = await requestFreshAuth();
        if (!key || encryptionKeyRef.current !== key || identityRef.current?.naturalPerson.publicKey !== root) throw new Error('Unlock to manage bot ownership.');
        const service = makeBotOwnershipService(() => true), now = Math.floor(Date.now() / 1000);
        if (action === 'create') await service.create(pubkey, now, days);
        else if (action === 'revoke') await service.revoke(pubkey, now);
        else await service.requestPublication(pubkey, now);
        await service.flush(now);
      }}
      onExport={async pubkey => {
        const key = await requestFreshAuth();
        if (!key || encryptionKeyRef.current !== key || identityRef.current?.naturalPerson.publicKey !== root) throw new Error('Unlock to copy the bot recovery key.');
        const bot = (await loadBotRegistry(root, key)).bots.find(b => b.publicKey === pubkey && b.removedAt === undefined);
        if (!bot?.privateKey || encryptionKeyRef.current !== key || identityRef.current?.naturalPerson.publicKey !== root) throw new Error('Bot key unavailable');
        const secret = hexToBytes(bot.privateKey);
        try { await navigator.clipboard.writeText(nip19.nsecEncode(secret)); } finally { secret.fill(0); }
      }} />, topBanners);
  }

  if (page === 'settings-security') {
    // Bunker URL for "Pair my phone" — only on the user's NP route
    // (skip when a dependant is active; dependant pairing has its own
    // dedicated flow via PairDependantDevice).
    const bunkerUrl = !activeDependant
      ? buildPhoneBunkerUrl(identity?.naturalPerson?.publicKey, preferences.relayUrl ?? DEFAULT_RELAY_URL)
      : null;
    return renderSettingsPage('settings-security', 'Security & Backup', (
      <SecuritySettings
        identity={identity}
        securityTier={securityTier}
        onSetSecurityTier={setSecurityTier}
        onRequestAuth={requestAuth}
        onRequestFreshAuth={requestFreshAuth}
        blurIdentityNames={blurIdentityNames}
        onSetBlurIdentityNames={setBlurIdentityNames}
        requireNpConfirmation={requireNpConfirmation}
        onSetRequireNpConfirmation={setRequireNpConfirmation}
        preferPersonaForSignIns={preferPersonaForSignIns}
        onSetPreferPersonaForSignIns={setPreferPersonaForSignIns}
        preferredPersonaPubkey={preferredPersonaPubkey}
        onSetPreferredPersonaPubkey={setPreferredPersonaPubkey}
        bunkerServerEnabled={bunkerServerEnabled}
        onSetBunkerServerEnabled={setBunkerServerEnabled}
        bunkerUrl={bunkerUrl}
        onNavigateShamir={() => navigateTo('shamir')}
        // §11.1.7 — after the Heartwood migration this device holds no
        // mnemonic, so both the reveal and the Shamir split have nothing
        // to work with. signingMode is the persistent fact (identity.mnemonic
        // is stale for the rest of the migrating session).
        mnemonicOnSigner={preferences.signingMode === 'bunker'}
        focusSection={pendingSecurityFocus}
        onConsumeFocus={() => setPendingSecurityFocus(null)}
      />
    ));
  }


  if (page === 'settings-profile') {
    return (
      <Layout title="Profile" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <Profile
          identity={identity!}
          onUpdateName={async (name) => { await updateDisplayName(name, encryptionKey!); }}
          onUpdatePhoto={() => navigateTo('photo-capture')}
          ownBadge={ownBadge}
          connectedSiteCount={authorizedSites.length}
          onNavigateConnections={() => navigateTo('connections')}
          onNavigateBadgeEmbed={() => navigateTo('badge-embed')}
          onGoToProfessional={() => navigateTo('settings-professional')}
          onSaveProName={async (name) => {
            if (!identity || !encryptionKey || !effectiveProBackend) return;
            await updateDisplayName('professional-persona', name);
            if (proPersonaPubkey) {
              await publishProKind0(proPersonaPubkey, name, effectiveProBackend);
            }
          }}
        />
      </Layout>
    );
  }

  if (page === 'settings-personas') {
    return (
      <>
      <Layout title="Personas" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        {/* A paired-child install must not be able to name and activate a real
            identity on the kid's own record, so both real-identity props are
            withheld there — same withholding as the ApproveAuth wiring below.
            Absent props leave the Personas row inert. */}
        <Personas
          identity={identity!}
          pairedChildView={isPairedChild}
          onActivateRealIdentity={isPairedChild ? undefined : () => { setActivationReturnTo('settings-personas'); navigateTo('activate-real-identity'); }}
          onOpenRealIdentityAdvanced={isPairedChild ? undefined : () => {
            setPendingPersonaAdvancedTarget({ slotTarget: 'natural-person' });
            navigateTo('persona-advanced');
          }}
          signingMode={preferences.signingMode}
          onManagePersona={isPairedChild ? undefined : (slotTarget) => {
            setPendingPersonaAdvancedTarget({ slotTarget });
            navigateTo('persona-advanced');
          }}
          onOpenPersona={isPairedChild ? undefined : (target) => {
            carousel.exitChildMode();
            carousel.commitPosition(findRowForGuardianKeypair(identity!, target, botInventory), 0);
            navigateTo('home');
          }}
          onSwitchPrimary={async (target) => {
            const key = encryptionKey || await requestAuth();
            if (!key) return;
            await switchPrimary(target, key);
          }}
          onAddPersona={async (displayName) => {
            const key = encryptionKey || await requestAuth();
            if (!key) throw new Error('Authentication required');
            // §11.1.8 D4: in bunker mode the phone has no mnemonic — the
            // device derives `persona-N` from its own tree instead.
            await addPersona(displayName, key, { deviceDerive: extraPersonaDeviceDerive });
          }}
          onUpdateName={async (target, name) => {
            const key = encryptionKey || await requestAuth();
            if (!key) throw new Error('Authentication required');
            await updateDisplayName(target, name);
          }}
          onImportNostrAccount={isPairedChild ? undefined : async (nsec, displayName) => {
            const key = encryptionKey || await requestAuth();
            if (!key) throw new Error('Authentication required');
            return addImportedPersona(nsec, displayName, key);
          }}
          startEditPersona={pendingPersonaFocus}
          onConsumeFocus={() => setPendingPersonaFocus(null)}
        />
      </Layout>
      {/* Add / rename / import all call requestAuth() — with no overlay
          mounted here the prompt had nowhere to render, so the action hung
          forever on a locked app. Same reasoning as approve-auth. */}
      {authOverlay}{nip55Overlay}
      </>
    );
  }

  if (page === 'settings-advanced') {
    return renderSettingsPage('settings-advanced', 'Advanced', (
      <AdvancedSettings
        identity={identity}
        preferences={preferences}
        relays={preferences.relays ?? []}
        onSetRelays={setRelays}
        onSetFallbackBunkerRelays={setFallbackBunkerRelays}
        onConnectSigner={handleConnectSigner}
        onDisconnectSigner={handleDisconnectSigner}
        signingMode={preferences.signingMode}
        bunkerUri={preferences.bunkerUri}
        onNavigateBridge={() => navigateTo('identity-bridge')}
        onNavigateRoster={() => navigateTo('roster')}
        onNavigateDeveloper={() => navigateTo('settings-developer')}
        onOpenMigration={() => navigateTo('migrate-heartwood')}
        heartwoodOperator={preferences.signingMode !== 'paired-child' ? {
          credential: heartwoodOperator.credential
            ? { deviceHex: heartwoodOperator.credential.deviceHex, relays: heartwoodOperator.credential.relays, importedAt: heartwoodOperator.credential.importedAt }
            : null,
          status: heartwoodOperator.status,
          statusError: heartwoodOperator.statusError,
          canPush: heartwoodOperator.canPush,
          canVerdict: heartwoodOperator.canVerdict,
          importLink: async (text, pin) => {
            const r = await heartwoodOperator.importLink(text, pin);
            if ('imported' in r) setPendingOperatorImportText(null);
            return r;
          },
          importPhrase: heartwoodOperator.importPhrase,
          forget: heartwoodOperator.forget,
          push: {
            lastPushAt: policyPush.lastPushAt,
            lastResult: policyPush.lastResult,
            pushing: policyPush.pushing,
            pushNow: policyPush.pushNow,
          },
          initialImportText: pendingOperatorImportText ?? undefined,
        } : undefined}
        onSetDefaultBlossomUrl={async (url) => { await setDefaultBlossomUrl(url); }}
        onResetDefaultBlossomUrl={async () => { await resetDefaultBlossomUrl(); }}
        onSetBlossomConsent={async (consent) => { await setBlossomConsent(consent); }}
      />
    ), topBanners);
  }

  if (page === 'settings-developer') {
    return renderSettingsPage('settings-developer', 'Developer', <DeveloperDiagnostics />);
  }

  if (page === 'edit-public-profile' && identity && pendingPublicProfileTarget) {
    const { target, viewer, depPubkey } = pendingPublicProfileTarget;

    // Phase 2 T28 — EditPublicProfile is now narrowed to:
    //   - 'paired-child': kid's read-only view (§6.6.11)
    //   - 'race-recover': Load-latest / Keep-mine dialog (§5.3)
    // 'self' and 'guardian-of-dep' field editing live on the persona card
    // (SlotProfileFields, T21) and the Publish flow lives on PersonaAdvanced
    // (PublishBlock, T23). The race-recover entry point is rewired in Phase
    // 2F; for now this route is reachable only via paired-child today.

    // Resolve slot config + publication state for the read-only display.
    // For paired-child, the slot is on the kid's own identity (sync rail
    // §5.4 populates it). For race-recover, the caller passes the right
    // depPubkey if applicable (Phase 2F).
    let initialConfig: import('./types').PublicProfileConfig | undefined;
    let initialState: import('./types').PersonaPublicProfile | undefined;
    let fallbackDisplayName = '';
    let dependantDisplayName: string | undefined;

    const configFromSlot = (slot: {
      displayName?: string;
      about?: string;
      pictureUrl?: string;
      pictureBlossomHash?: string;
      bannerUrl?: string;
      bannerBlossomHash?: string;
      nip05?: string;
      lud16?: string;
      website?: string;
    }): import('./types').PublicProfileConfig => ({
      displayName: slot.displayName || '',
      about: slot.about,
      pictureUrl: slot.pictureUrl,
      pictureBlossomHash: slot.pictureBlossomHash,
      bannerUrl: slot.bannerUrl,
      bannerBlossomHash: slot.bannerBlossomHash,
      nip05: slot.nip05,
      lud16: slot.lud16,
      website: slot.website,
    });

    if (depPubkey) {
      const dep = dependants.find(d => d.id === depPubkey);
      if (!dep) {
        // Stale routing state — dep was removed.
        setPendingPublicProfileTarget(null);
        navigateBack();
        return null;
      }
      dependantDisplayName = dep.displayName;
      if (target === 'natural-person') {
        initialConfig = configFromSlot(dep.naturalPerson);
        initialState = dep.naturalPerson.publicProfile;
        fallbackDisplayName = dep.naturalPerson.displayName || dep.displayName;
      } else if (target === 'persona') {
        initialConfig = configFromSlot(dep.persona);
        initialState = dep.persona.publicProfile;
        fallbackDisplayName = dep.persona.displayName || dep.displayName;
      } else {
        const ep = dep.extraPersonas?.find(p => p.publicKey === target);
        initialConfig = ep ? configFromSlot(ep) : undefined;
        initialState = ep?.publicProfile;
        fallbackDisplayName = ep?.displayName || dep.displayName;
      }
    } else {
      if (target === 'natural-person') {
        initialConfig = configFromSlot(identity.naturalPerson);
        initialState = identity.naturalPerson.publicProfile;
        fallbackDisplayName = identity.naturalPerson.displayName || '';
      } else if (target === 'persona') {
        initialConfig = configFromSlot(identity.persona);
        initialState = identity.persona.publicProfile;
        fallbackDisplayName = identity.persona.displayName || '';
      } else if (target === 'professional-persona') {
        initialConfig = identity.professionalPersona ? configFromSlot(identity.professionalPersona) : undefined;
        initialState = identity.professionalPersona?.publicProfile;
        fallbackDisplayName = identity.professionalPersona?.displayName || '';
      } else {
        const ep = identity.extraPersonas?.find(p => p.publicKey === target);
        initialConfig = ep ? configFromSlot(ep) : undefined;
        initialState = ep?.publicProfile;
        fallbackDisplayName = ep?.displayName || '';
      }
    }

    return renderSettingsPage('edit-public-profile', 'Public profile', (
      <EditPublicProfile
        config={initialConfig ?? { displayName: fallbackDisplayName }}
        state={initialState}
        fallbackDisplayName={fallbackDisplayName}
        viewerMode={viewer}
        dependantDisplayName={dependantDisplayName}
        onCancel={() => {
          setPendingPublicProfileTarget(null);
          navigateBack();
        }}
        // TODO race-recover entry point: when PersonaAdvanced's
        // PublishBlock detects a §5.3 race (remote kind-0.created_at >
        // local.lastPublishedAt), it should route here with
        // `viewer: 'race-recover'` and wire onLoadLatest + onKeepMine.
        // Not in scope for T29/T31 — PublishBlock currently surfaces
        // race conflicts as an error string without the explicit dialog.
      />
    ));
  }

  if (page === 'persona-advanced' && identity && pendingPersonaAdvancedTarget) {
    const { slotTarget, depPubkey } = pendingPersonaAdvancedTarget;
    return renderSettingsPage('persona-advanced', 'Advanced', (
      <PersonaAdvanced
        slotTarget={slotTarget}
        depPubkey={depPubkey}
        identity={identity}
        dependants={dependants}
        onBack={() => {
          setPendingPersonaAdvancedTarget(null);
          navigateBack();
        }}
        onPublishProfile={async (_slotKind: PersonaAdvancedSlotKind, _typedNameValue) => {
          // typedNameValue arrives from PersonaAdvanced's §6.5 NP first-time
          // confirm modal — PersonaAdvanced has already gated the publish on
          // its match, so the value's correctness is the modal's invariant,
          // not ours. We treat it as a presence flag (the modal won't call
          // back without it) and forward straight to the shared publisher.
          return await publishPersonaProfile(slotTarget, depPubkey);
        }}
        onDisablePublicProfile={async () => {
          await retractPersonaProfile(slotTarget, depPubkey);
        }}
        onRepublish={async () => {
          // Republish is the already-enabled path: same publisher, no
          // confirm modal (PersonaAdvanced fires this directly). The
          // §5.3.3 content-hash short-circuit means a no-op republish
          // returns ok=true without a relay round-trip.
          return await publishPersonaProfile(slotTarget, depPubkey);
        }}
        onSwitchPrimary={async (target) => {
          const key = encryptionKey || await requestAuth();
          if (!key) throw new Error('Authentication required');
          if (depPubkey) {
            await switchDependantPrimary(depPubkey, target, key);
          } else {
            await switchPrimary(target, key);
          }
        }}
        // `signingMode` is the persistent fact (identity.mnemonic goes stale for
        // the rest of a migrating session): on a bunker install the words live on
        // the signer, and a dep slot never offers the guardian's words at all.
        onShowMnemonic={depPubkey || preferences.signingMode === 'bunker' ? undefined : () => navigateTo('settings-security')}
        mnemonicOnSigner={!depPubkey && preferences.signingMode === 'bunker'}
        onHidePersona={async (pubkey) => {
          // Soft-delete (preserves derivation slot). Distinct from delete.
          // Both branches set `ExtraPersona.hidden = true` — that's the
          // flag `carousel-utils.ts` filters on for the GUARDIAN-side
          // carousel view. Distinct from `hiddenOnPairedDeviceKeys` on the
          // dep record (which filters the PAIRED-CHILD device's view) —
          // the two filters are intentionally separate, see
          // `setDepExtraPersonaHidden` doc.
          if (depPubkey) {
            await setDepExtraPersonaHidden(depPubkey, pubkey, true);
          } else {
            const key = encryptionKey || await requestAuth();
            if (!key) throw new Error('Authentication required');
            await setExtraPersonaHidden(pubkey, true, key);
          }
        }}
        onShowPersona={depPubkey ? undefined : async (pubkey) => {
          const key = encryptionKey || await requestAuth();
          if (!key) throw new Error('Authentication required');
          await setExtraPersonaHidden(pubkey, false, key);
        }}
        onRetractExtraPersonaProfile={async (pubkey) => {
          // Best-effort retract used by HideBlock's §6.10 retract-on-hide
          // checkbox. Swallows errors — caller proceeds with hide either
          // way.
          try {
            await retractPersonaProfile(pubkey, depPubkey);
          } catch { /* §6.10 best-effort */ }
        }}
        onDeletePersona={async (pubkey) => {
          // §9 Q8: 5s race budget for retract-before-purge, then hard-delete.
          // Resolve the extra to check for a published profile we should
          // try to retract first.
          let ep: import('./types').ExtraPersona | undefined;
          if (depPubkey) {
            const dep = dependants.find(d => d.id === depPubkey);
            ep = dep?.extraPersonas?.find(p => p.publicKey === pubkey);
          } else {
            ep = identity.extraPersonas?.find(p => p.publicKey === pubkey);
          }
          if (ep?.publicProfile?.enabled && ep.publicProfile.lastEventId) {
            const targetRelay = ep.publicProfile.lastPublishedRelay || preferences.relayUrl || DEFAULT_RELAY_URL;
            const ownedDelete = !!ep.privateKey;
            // Router-sourced fallback is a SHARED, CACHED route — only a
            // locally-constructed backend (ownedDelete) may be destroy()'d.
            const deleteBackend: DecryptingSigningBackend | null = ownedDelete
              ? new LocalSigningBackend(ep.privateKey)
              : (bunkerRouter?.backendFor(ep.publicKey) ?? null);
            if (deleteBackend) {
              try {
                await Promise.race([
                  retractPublicProfile(ep.publicProfile.lastEventId, deleteBackend, targetRelay, ep.publicProfile.lastPublishedAt),
                  new Promise(resolve => setTimeout(resolve, 5_000)),
                ]);
              } catch { /* best-effort; proceed with delete */ }
              finally { if (ownedDelete) deleteBackend.destroy(); }
            }
          }
          if (depPubkey) {
            await removeDependantExtraPersona(depPubkey, pubkey);
          } else {
            await removeExtraPersona(pubkey);
          }
          // Routing target is gone — pop back to the carousel.
          setPendingPersonaAdvancedTarget(null);
          navigateBack();
        }}
        onShowImportedNsec={undefined /* no in-app reveal UI today; tracked for follow-up */}
        onChangeAutonomyStage={depPubkey ? async (stage) => {
          await updateAutonomyStage(depPubkey, stage);
        } : undefined}
        onChangeActivityVisibility={depPubkey ? async (override) => {
          await updateAuditVisibility(depPubkey, override);
        } : undefined}
        // Petitions only mean something once a Heartwood enforces the
        // compiled ceiling — keyed on the persistent bunker fact (or an
        // operator key already on file, for the stale-prefs window right
        // after the migration wizard commits).
        onChangePetitionOnDeny={depPubkey && (preferences.signingMode === 'bunker' || !!heartwoodOperator.credential) ? async (on) => {
          await updatePetitionOnDeny(depPubkey, on);
        } : undefined}
        onRemoveDependant={depPubkey ? async (contactsChoice) => {
          // Best-effort retract every dep persona's kind-0, then purge the
          // dep record. Pop the routing state since the dep we were
          // viewing is gone.
          const dep = dependants.find(d => d.id === depPubkey);
          if (!dep) return;
          // Contacts first: capture the directory id before the dependant
          // record is purged — `dep.id` is not readable after that. Plan
          // against a FRESH reload, not the `directories` memo — the memo
          // can be `[]` while still loading, or a stale closure even right
          // after an `await reload()` (it's a memo over state, one render
          // behind).
          const directoryId = directoryIdForDependant(dep);
          const reloadResult = await familyContacts.reload();
          // Fail closed: a reload that could not read the log, or one that
          // came back without THIS dependant's directory at all (every ref
          // this hook is given resolves to an entry, so absence means
          // something is wrong, not "nothing there"), must never read as
          // "nothing to strand" — throw so PersonaAdvanced's error banner
          // shows it, and do NOT proceed to `removeDependant`.
          if (!reloadResult.ok) throw new Error(CONTACTS_LOG_UNAVAILABLE_COPY);
          const directory = reloadResult.directories.find(d => d.directoryId === directoryId);
          if (!directory) throw new Error(CONTACTS_LOG_UNAVAILABLE_COPY);
          const plan = planDependantContactRemoval(directoryId, directory.contacts, contactsChoice);
          if (plan.contactIds.length > 0) {
            await familyContacts.applyOps(plan.contactIds.map(contactId => ({
              directoryId, contactId, action: plan.action, value: {},
            })));
            await contactsV2.reload();
          }
          await retractDepProfilesBeforePurge(dep);
          await removeDependant(depPubkey);
          if (activeDependantId === depPubkey) setActiveDependantId(null);
          setPendingPersonaAdvancedTarget(null);
          navigateBack();
        } : undefined}
        contactsLoading={familyContacts.loading}
      />
    ));
  }

  if (page === 'activate-real-identity' && identity && isPairedChild) {
    // Defence in depth. Every entry point already withholds this route on a
    // paired-child install (the real identity belongs to the guardian, and this
    // device holds none of the material to activate it), but the route itself
    // must refuse too — a stale `page` across a signing-mode change would
    // otherwise land the kid in an activation flow that cannot complete.
    return renderSettingsPage('activate-real-identity', 'Your real identity', (
      <div className="fade-in" role="main">
        <div className="card section">
          <div className="section-title">Your real identity</div>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 16 }}>
            This is set up on the phone that looks after your account, not on this one.
          </p>
          <button className="btn btn-ghost" onClick={() => navigateBack()}>Back</button>
        </div>
      </div>
    ));
  }

  if (page === 'activate-real-identity' && identity && pendingDependantActivation && !isPairedChild) {
    const dep = dependants.find(d => d.id === pendingDependantActivation);
    if (dep) {
      return renderSettingsPage('activate-real-identity', 'Real identity', (
        <ActivateRealIdentity
          target={{ kind: 'dependant', depPubkey: dep.id, dependantName: dep.displayName }}
          backupStep="none"
          recoveryWords={[]}
          onActivate={async (legalName) => {
            const key = encryptionKey || await requestAuth();
            if (!key) throw new Error('Authentication required');
            await activateDependantNaturalPerson(dep.id, legalName, key);
          }}
          onMarkBackedUp={async () => { /* dependants have no separate backup — spec §7.7 */ }}
          onDone={() => {
            const to = activationReturnTo;
            setPendingDependantActivation(null);
            setActivationReturnTo(null);
            navigateReplace(to ?? 'settings');
          }}
          onCancel={() => {
            setPendingDependantActivation(null);
            setActivationReturnTo(null);
            navigateBack();
          }}
        />
      ));
    }
  }

  if (page === 'activate-real-identity' && identity) {
    const backupStep = resolveActivationBackupStep({
      hasMnemonic: !!identity.mnemonic,
      backedUp: identity.backedUp === true,
      liteImported: identity.liteImported === true,
    });
    let words: string[] = [];
    if (backupStep !== 'none' && identity.mnemonic) {
      try {
        words = toRecoveryWords(identity.mnemonic).split(' ');
      } catch {
        words = [];
      }
    }
    return renderSettingsPage('activate-real-identity', 'Your real identity', (
      <ActivateRealIdentity
        target={{ kind: 'owner' }}
        backupStep={words.length === 0 ? 'none' : backupStep}
        recoveryWords={words}
        onActivate={activateNaturalPerson}
        onMarkBackedUp={handleMarkBackedUp}
        onDone={() => {
          const target = activationReturnTo;
          setActivationReturnTo(null);
          if (target) navigateReplace(target);
          else navigateReplace('home');
        }}
        onCancel={() => { setActivationReturnTo(null); navigateBack(); }}
      />
    ));
  }

  if (page === 'manage-carousel' && identity) {
    return renderSettingsPage('manage-carousel', 'Manage Carousel', (
      <ManageCarousel
        identity={identity}
        dependants={dependants}
        onSetExtraPersonaHidden={setExtraPersonaHidden}
        onReorderExtras={reorderExtraPersonas}
        onReorderDependants={reorderDependants}
      />
    ));
  }

  if ((page === 'settings-professional' || page === 'pro-onboarding') && identity && !npActive) {
    return renderRealIdentityGate(
      'A professional anchor is tied to a verified real name, so the Professional surface needs your real identity.',
      page,
    );
  }

  // Heartwood guard — Pro mode requires local mnemonic (§4.5.10)
  if ((page === 'settings-professional' || page === 'pro-onboarding') && isProModeBlocked) {
    return renderSettingsPage(page, 'Professional mode',
      <div className="p-4 space-y-4">
        <p className="text-base text-zinc-700 dark:text-zinc-300">{isProModeBlocked}</p>
      </div>
    );
  }

  if (page === 'settings-professional' && identity) {
    return (
      <Layout title="Professional role" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <Professional
          anchor={proAnchor}
          isLoading={proAnchorLoading}
          hasPendingSelfCert={hasPendingSelfCert && !!proPersonaPubkey}
          onSetupPro={async () => {
            if (identity && encryptionKey) {
              const pp = await deriveAndStoreProPersona(identity, encryptionKey);
              setProPersonaPubkey(pp.publicKey);
              setProBackend(new LocalSigningBackend(pp.privateKey));
            }
            navigateTo('pro-onboarding');
          }}
          onGoToDashboard={() => navigateReplace('pro-dashboard')}
          onGoToSubRoleDashboard={() => navigateReplace('sub-role-pro-dashboard')}
          onBack={() => navigateBack()}
        />
      </Layout>
    );
  }

  if (page === 'sub-role-pro-dashboard' && proPersonaPubkey) {
    return (
      <Layout title="Professional role" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <SubRoleProDashboard
          claimedFirm={selfCertClaimedFirm}
          claimedFirmKind={selfCertClaimedFirmKind}
          claimedRole={selfCertClaimedRole}
          professionKind={selfCertProfessionKind}
          pendingCredentialCount={pendingSelfCertCredentials.length}
          proPersonaPubkey={proPersonaPubkey}
          isChainConfirmed={isChainConfirmedSubRole}
          onIssueSelfCert={() => navigateTo('self-cert-issue')}
          onAttest={() => navigateTo('pro-attest')}
          onBack={() => navigateBack()}
        />
      </Layout>
    );
  }

  if (page === 'self-cert-issue' && effectiveProBackend && proPersonaPubkey) {
    return (
      <Layout title="Issue credential" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <SelfCertIssue
          professionKind={selfCertProfessionKind}
          prefilledFirm={selfCertClaimedFirm || undefined}
          prefilledFirmKind={selfCertClaimedFirmKind || undefined}
          prefilledRole={selfCertClaimedRole || undefined}
          proBackend={effectiveProBackend}
          proPersonaPubkey={proPersonaPubkey}
          requestAuth={requestAuth}
          onComplete={() => navigateReplace('sub-role-pro-dashboard')}
          onSave={addCredential}
          onBack={() => navigateBack()}
        />
      </Layout>
    );
  }

  // Confirmed-path pro attest (Phase 7, Task 16)
  if (page === 'pro-attest' && effectiveProBackend && proPersonaPubkey) {
    const professionKind =
      confirmedSelfCertClaimedFirmKind === 'URN' ? 'school' :
      confirmedSelfCertClaimedFirmKind === 'CQC-ProviderID' ? 'gp-practice' :
      confirmedSelfCertClaimedFirmKind === 'SRA-FirmNumber' ? 'solicitor-firm' :
      selfCertProfessionKind;
    return (
      <ProAttest
        professionKind={professionKind}
        prefilledFirm={confirmedSelfCertClaimedFirm || undefined}
        prefilledFirmKind={confirmedSelfCertClaimedFirmKind || undefined}
        prefilledRole={confirmedSelfCertClaimedRole || undefined}
        proBackend={effectiveProBackend}
        proPersonaPubkey={proPersonaPubkey}
        requestFreshAuth={requestFreshAuth}
        onComplete={() => navigateReplace('sub-role-pro-dashboard')}
        onSave={addCredential}
        onBack={() => navigateBack()}
      />
    );
  }

  if (page === 'pro-onboarding' && identity && (effectiveProBackend ?? activeBackend)) {
    return (
      <Layout title="Set up Professional role" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <ProOnboarding
          leadPubkeyHex={proPersonaPubkey ?? ''}
          backend={effectiveProBackend ?? activeBackend!}
          proAnchorHook={{ publish: proAnchorPublish }}
          onComplete={() => navigateReplace('pro-dashboard')}
          onBack={() => navigateBack()}
        />
      </Layout>
    );
  }

  if (page === 'pro-dashboard' && proAnchor) {
    return (
      <Layout title="Professional dashboard" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <ProDashboard
          anchor={proAnchor}
          backend={effectiveProBackend ?? activeBackend}
          requestAuth={requestAuth}
          requestFreshAuth={requestFreshAuth}
          onAddStaff={() => navigateTo('lead-add-staff')}
          onManageDelegates={() => navigateTo('lead-manage-delegates')}
          onBack={() => navigateBack()}
          onRoleAnchorRemoved={() => navigateReplace('settings-professional')}
        />
      </Layout>
    );
  }

  // Lead Add Staff page (Phase 7, Task 17)
  // Fix: fetch the current kind-30202 roster from relay before rendering so that
  // buildRosterAppendEvent receives the existing members — otherwise the append
  // would publish a fresh event with only the new pubkey, silently dropping prior staff.
  if (page === 'lead-add-staff' && proAnchor && effectiveProBackend) {
    const anchorContext = {
      registry: proAnchor.registry,
      identifier: proAnchor.identifier,
      professionKind: proAnchor.professionKind,
      entityName: proAnchor.entityName,
      canonicalDomain: proAnchor.canonicalDomain,
      jurisdiction: proAnchor.jurisdiction,
      leadPubkey: proPersonaPubkey ?? proAnchor.pubkey,
    };
    const dTagValue = `${proAnchor.registry}:${proAnchor.identifier}`;
    // Fetch current roster from relay if not yet loaded for this session.
    // null = not yet fetched; [] = fetched (empty); populated array = existing members.
    // This ensures buildRosterAppendEvent receives the full existing roster so the
    // new kind-30202 event preserves all previously-added staff.
    if (leadAddStaffRoster === null && !leadAddStaffRosterLoading && proPersonaPubkey) {
      void (async () => {
        setLeadAddStaffRosterLoading(true);
        try {
          const events = await fetchEvents([{
            kinds: [PRO_ROSTER],
            authors: [proPersonaPubkey],
            '#d': [dTagValue],
            limit: 1,
          }]);
          // Verify the roster was actually signed by the lead — a hostile relay
          // could substitute member/delegate tags, causing the lead to re-publish
          // an attacker-shaped roster under their own sig. Audit-3 catch.
          const raw = events[0] as unknown as { pubkey: string; sig: string; id: string } | undefined;
          const rosterEvent = verifiedAuthoredEvent(raw, proPersonaPubkey);
          if (rosterEvent) {
            const tags = (rosterEvent as unknown as { tags: string[][] }).tags;
            const members: RosterMember[] = tags
              .filter(t => t[0] === 'p' && typeof t[1] === 'string')
              .map(t => ({ pubkey: t[1], role: t[2] ?? '', scope: t[3] }));
            setLeadAddStaffRoster(members);
          } else {
            // No prior roster event — first-time add, empty is correct.
            setLeadAddStaffRoster([]);
          }
        } catch {
          // Relay unavailable — proceed with empty roster (first-time add is safe;
          // subsequent adds may lose prior members but this is better than a crash).
          setLeadAddStaffRoster([]);
        } finally {
          setLeadAddStaffRosterLoading(false);
        }
      })();
    }
    if (leadAddStaffRoster === null || leadAddStaffRosterLoading) {
      return (
        <Layout title="Add staff" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
          <div style={{ padding: 24, textAlign: 'center' }}>
            <p style={{ color: 'var(--text-secondary)', marginTop: 48 }}>Loading current roster…</p>
          </div>
        </Layout>
      );
    }
    return (
      <Layout title="Add staff" showBack onBack={() => { setLeadAddStaffRoster(null); navigateBack(); }} {...guardianLayoutProps}>
        <LeadAddStaff
          anchorContext={anchorContext}
          currentRosterMembers={leadAddStaffRoster}
          proBackend={effectiveProBackend}
          requestAuth={requestAuth}
          requestFreshAuth={requestFreshAuth}
          onComplete={() => {
            setLeadAddStaffRoster(null);
            navigateReplace('pro-dashboard');
          }}
          onBack={() => {
            setLeadAddStaffRoster(null);
            navigateBack();
          }}
        />
      </Layout>
    );
  }
  // Lead Manage Delegates page (Phase 5 — multi-lead + delegates)
  // Fetch current roster from relay before rendering so that buildRosterUpdate
  // receives the full existing members + delegates — prevents destructive replace.
  if (page === 'lead-manage-delegates' && proAnchor && effectiveProBackend) {
    const anchorContext = {
      registry: proAnchor.registry,
      identifier: proAnchor.identifier,
      professionKind: proAnchor.professionKind,
      entityName: proAnchor.entityName,
      canonicalDomain: proAnchor.canonicalDomain,
      jurisdiction: proAnchor.jurisdiction,
      leadPubkey: proPersonaPubkey ?? proAnchor.pubkey,
    };
    const dTagValue = `${proAnchor.registry}:${proAnchor.identifier}`;
    // Fetch current roster if not yet loaded for this page visit.
    if (manageDelegatesRoster === null && !manageDelegatesLoading && proPersonaPubkey) {
      void (async () => {
        setManageDelegatesLoading(true);
        try {
          const events = await fetchEvents([{
            kinds: [PRO_ROSTER],
            authors: [proPersonaPubkey],
            '#d': [dTagValue],
            limit: 1,
          }]);
          // Verify the roster was actually signed by the lead — audit-3 sibling
          // to the staff-add fetch above.
          const raw = events[0] as unknown as { pubkey: string; sig: string; id: string } | undefined;
          const rosterEvent = verifiedAuthoredEvent(raw, proPersonaPubkey);
          if (rosterEvent) {
            const tags = (rosterEvent as unknown as { tags: string[][] }).tags;
            const members: RosterMember[] = tags
              .filter(t => t[0] === 'p' && typeof t[1] === 'string')
              .map(t => ({ pubkey: t[1], role: t[2] ?? '', scope: t[3] }));
            const delegates: string[] = tags
              .filter(t => t[0] === 'delegate' && typeof t[1] === 'string')
              .map(t => t[1]);
            setManageDelegatesRoster({ members, delegates });
          } else {
            setManageDelegatesRoster({ members: [], delegates: [] });
          }
        } catch {
          setManageDelegatesRoster({ members: [], delegates: [] });
        } finally {
          setManageDelegatesLoading(false);
        }
      })();
    }
    if (manageDelegatesRoster === null || manageDelegatesLoading) {
      return (
        <Layout title="Manage delegates" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
          <div style={{ padding: 24, textAlign: 'center' }}>
            <p style={{ color: 'var(--text-secondary)', marginTop: 48 }}>Loading current roster…</p>
          </div>
        </Layout>
      );
    }
    return (
      <Layout title="Manage delegates" showBack onBack={() => { setManageDelegatesRoster(null); navigateBack(); }} {...guardianLayoutProps}>
        <LeadManageDelegates
          currentDelegates={manageDelegatesRoster.delegates}
          currentMembers={manageDelegatesRoster.members}
          anchorCtx={anchorContext}
          proBackend={effectiveProBackend}
          onComplete={() => {
            setManageDelegatesRoster(null);
            navigateReplace('pro-dashboard');
          }}
          onBack={() => {
            setManageDelegatesRoster(null);
            navigateBack();
          }}
          requestAuth={requestAuth}
          requestFreshAuth={requestFreshAuth}
        />
      </Layout>
    );
  }

  if (page === 'pro-dashboard' && !proAnchor && !proAnchorLoading) {
    // Anchor gone (revoked or relay miss) — fall back to gateway
    return (
      <Layout title="Professional role" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <Professional
          anchor={null}
          isLoading={false}
          onSetupPro={() => navigateReplace('pro-onboarding')}
          onGoToDashboard={() => {}}
          onBack={() => navigateBack()}
        />
      </Layout>
    );
  }

  // Contact detail (v2). Every record — including one with a matching legacy
  // `contacts`/`ken` row — routes through this one page; `detailSections`
  // decides what renders, and a legacy `ken` match adds a `Key control` row
  // that opens the untouched `KenDetail` page.
  if (page === 'contact-detail' && selectedContactId) {
    const record = contactsV2.effective.find(c => c.contactId === selectedContactId);
    if (!record) { navigateReplace('contacts'); return null; }
    const rights = resolveActorRights(record, {
      actorRole: contactsScope.actorRole,
      actorPubkey: contactsActorPubkey,
    }, contactsActiveGuardianPubkeys);
    const recordPubkeys = new Set(record.identities.map(i => i.pubkey.toLowerCase()));
    const legacyContact = members.find(m => recordPubkeys.has(m.pubkey.toLowerCase()));
    const legacyMatch = {
      hasSharedSecret: !!legacyContact?.sharedSecret,
      hasKenEntry: kens.some(k => recordPubkeys.has(k.pubkey.toLowerCase())),
    };
    return (
      <Layout title={record.displayName} showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <ContactDetail
          contact={record}
          lists={contactsIdentityLists}
          onReviewAppList={(grantId, accept) => contactsV2.reviewAppList(record.contactId, grantId, accept)}
          onLinkList={(key) => contactsV2.linkList(record.contactId, key)}
          onUnlinkList={async (key) => { await contactsV2.unlinkList(record.contactId, key); navigateReplace('contacts'); }}
          identity={identity}
          rights={rights}
          sections={detailSections(record, rights, legacyMatch)}
          legacy={legacyMatch}
          legacyContact={legacyContact}
          actorPubkey={contactsActorPubkey}
          guardianName={activeDependant ? (identity?.naturalPerson.displayName || null) : null}
          wordCount={wordCount}
          onRename={(displayName) => contactsV2.renameContact(record.contactId, displayName)}
          onSetTier={(tier) => contactsV2.setTier(record.contactId, tier)}
          onAddRole={(roles) => contactsV2.setRoles(record.contactId, roles)}
          onRemoveRole={(roles) => contactsV2.setRoles(record.contactId, roles)}
          onAddMethod={async (value) => { await contactsV2.addContactMethod(record.contactId, value); }}
          onMethodSharingChange={(itemId, grantable) => contactsV2.updateContactMethod(record.contactId, { itemId, sharingPolicy: grantable ? 'grantable' : 'private' })}
          onRemoveItem={(itemId) => contactsV2.removeItem(record.contactId, itemId)}
          checkOwnerIdentityPubkey={contactsListIdentity === 'all' ? undefined : contactsWriteIdentity}
          onRecordOrigin={contactsListIdentity === 'all' ? undefined : origin => contactsV2.recordOrigin(record.contactId, origin)}
          onRemoveOrigin={id => contactsV2.removeOrigin(record.contactId, id)}
          onUpdateCheck={contactsListIdentity === 'all' ? undefined : check => contactsV2.updateCheck(record.contactId, check)}
          onRecordCheck={contactsListIdentity === 'all' ? undefined : check => contactsV2.recordCheck(record.contactId, check)}
          onRemoveCheck={id => contactsV2.removeCheck(record.contactId, id)}
          onSetNote={(note) => contactsV2.setNote(record.contactId, note)}
          onBlock={async (reason) => {
            // Block and unblock bump the SAFETY token as well as the ordinary
            // change token: `useContactProjections` publishes a safety change
            // at once, skipping both the jitter and the hash-dedupe. Bumped
            // only after the mutation has actually landed.
            await contactsV2.block(record.contactId, { scope: { kind: 'contact' }, ...(reason ? { reason } : {}) });
            bumpContactsSafety(`block:${record.contactId}`);
          }}
          onUnblock={async () => {
            // M5: only a block this actor actually lifted is a safety change.
            // With nothing to lift, an immediate dedupe-bypassing publish
            // would go out for a directory that did not change.
            const lifted = ownBlocks(record, contactsActorPubkey);
            for (const b of lifted) {
              await contactsV2.unblock(record.contactId, b.operationId);
            }
            if (lifted.length > 0) bumpContactsSafety(`unblock:${record.contactId}`);
          }}
          onRemove={async () => { await contactsV2.removeContact(record.contactId); navigateReplace('contacts'); }}
          onOpenKenDetail={(pubkey) => { handleSelectKen(pubkey); }}
        />
      </Layout>
    );
  }

  // Add member
  if (page === 'add') {
    return (
      <Layout title="Add Family Member" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <AddMember identity={identity} onAddMember={addMember} onDone={handleAddDone} wordCount={wordCount} onNostrConnect={handleNostrConnect} signingMode={preferences.signingMode} />
      </Layout>
    );
  }

  // D6: paired-child branch of the contact-invite intake — ask the
  // guardian to connect instead of connecting directly.
  if (page === 'child-contact-ask' && isPairedChild && pendingContactInvite) {
    const invite = parseContactInviteLink(pendingContactInvite, Math.floor(Date.now() / 1000));
    const done = () => { setPendingContactInvite(undefined); navigateReplace('contacts'); };
    return (
      <Layout title="Ask to connect" showBack onBack={done} {...guardianLayoutProps}>
        {invite
          ? <ChildContactAsk invite={invite}
              personaLabel={childAskPersona?.label ?? null}
              guardianName={cachedGuardianName ?? null}
              onAsk={() => askGuardianToConnect(invite)}
              onBack={done} />
          : <p role="alert">This invite is invalid or has expired.</p>}
      </Layout>
    );
  }

  // Contacts list
  if (page === 'contact-invites' && contactsScope.directoryId && !isPairedChild) {
    return <Layout title="Contact invites" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
      <ContactInvites service={inviteService} identityPubkey={contactsWriteIdentity}
        identityName={contactsIdentityLists.find(i => i.ownerIdentityPubkey === contactsWriteIdentity)?.label ?? 'this identity'}
        relays={syncRelays.write.filter(url => url.startsWith('wss:'))} version={contactsV2Version}
        initialInvite={pendingContactInvite}
        onApproveContact={activeDependant && childSettingsMap.get(activeDependant.id)?.contactPolicy === 'approved' ? async peer => {
          if (!encryptionKey || !identity || isPairedChild) throw new Error('Unlock the guardian identity first.');
          const guardian = identity.naturalPerson.publicKey;
          const dep = (await loadFreshDependants(encryptionKey)).find(dep => dep.id === activeDependant.id && dep.guardianPubkey === guardian);
          if (!dep) throw new Error('This dependant is no longer managed here.');
          if (!await contactPeerAllowed(`dependant:${dep.id}`, encryptionKey, peer)) throw new Error('This contact is blocked.');
          if (inviteSession.current.key !== encryptionKey || inviteSession.current.owner !== guardian) throw new Error('Unlock the guardian identity first.');
          const settings = await approveChildContact(dep.id, guardian, peer);
          setChildSettingsMap(old => new Map(old).set(dep.id, settings));
        } : undefined}
        onBack={() => { setPendingContactInvite(undefined); navigateReplace('contacts'); }}
        onAddContact={async exchange => {
          const own = exchange.role === 'requester' ? exchange.request.from : exchange.request.to;
          if (own !== contactsWriteIdentity) throw new Error('Select the identity used for this exchange.');
          const id = await inviteService.materialiseContact(contactExchangeKey(exchange.request));
          await contactsV2.reload();
          setSelectedContactId(id); navigateTo('contact-detail');
        }} />
    </Layout>;
  }

  if (page === 'contacts' && !encryptionKey) {
    return <>
      <Layout title="Contacts" {...guardianLayoutProps}>
        <p>Unlock to view your contacts.</p>
        <button className="btn btn-primary" onClick={() => { void requestAuth(); }}>Unlock contacts</button>
      </Layout>
      {authOverlay}
    </>;
  }

  if (page === 'contacts') {
    return (
      <Layout title="Contacts" {...guardianLayoutProps}>
        {isPairedChild && <p role="status" className="field-hint">
          {!pairedContactPolicy ? 'Waiting for your guardian’s current contact policy.'
            : pairedContactPolicy.conflicted ? 'Your guardian needs to resolve a contact policy conflict.'
            : pairedContactPolicy.policy === 'kin-only' ? 'Your guardian allows contacts in your close circle.'
            : pairedContactPolicy.policy === 'approved' ? 'New contacts need your guardian’s approval.'
            : 'Your guardian allows contact requests. Blocked contacts are still excluded.'}
        </p>}
        {!isPairedChild && pendingGuardianChildRequests.pendingCount > 0 && <p role="status" className="field-hint">
          {pendingGuardianChildRequests.pendingCount} paired-child contact request{pendingGuardianChildRequests.pendingCount === 1 ? '' : 's'} waiting for review.
        </p>}
        {!isPairedChild && <PairedChildRequestReview requests={pendingGuardianChildRequests.pending} stuck={pendingGuardianChildRequests.stuck}
          history={pendingGuardianChildRequests.history}
          keyMaterial={encryptionKey!} now={() => Math.floor(Date.now() / 1000)} current={guardianChildReviewCurrent} mayConnect={guardianChildMayConnect}
          childName={child => dependants.find(dep => dep.id === child)?.displayName ?? 'your child'}
          onExecute={guardianChildExecute} onAbandon={guardianChildAbandon} onReply={guardianChildReply} onCancel={item => guardianChildCancel(item)}
          onChanged={() => { bumpContactsV2(); pendingGuardianChildRequests.reload(); }} />}
        {isPairedChild && <ChildContactDirectory view={pairedContactDirectory}
          lists={contactsIdentityLists} selectedList={contactsListIdentity} onSelectList={setContactsIdentityChoice} />}
        {/* D4: replaces the old single "your guardian replied" line — each
            of the 20 most recent requests shows its own distinct status. */}
        {isPairedChild && childContactHistory.length > 0 && <section aria-label="Your contact requests" className="stack">
          <h2>Your requests</h2>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {childContactHistory.map(item => <li key={item.requestId} className="row field-hint">
              {item.caption ? sanitizeDisplayName(item.caption, 100) : 'Contact exchange request'} — {CHILD_ASK_HISTORY_LABEL[item.status]}
            </li>)}
          </ul>
        </section>}
        {isPairedChild && <h2>Contacts saved on this device</h2>}
        <ContactsRolodex
          initialSearch={contactCardSearch}
          contacts={contactsListIdentity === 'all' ? contactsV2.effective : contactsV2.effective.filter(c => contactBelongsToList(c, contactsListIdentity))}
          lists={contactsIdentityLists}
          pendingLinks={contactsV2.records.reduce((n, r) => n + (r.appIntroductions?.filter(i => i.status === 'pending').length ?? 0), 0)}
          selectedList={contactsListIdentity}
          onSelectList={setContactsIdentityChoice}
          loading={contactsV2.loading}
          actorPubkey={contactsActorPubkey}
          guardianName={activeDependant ? (identity?.naturalPerson.displayName || null) : null}
          subjectName={contactsScope.subjectName}
          relayUrl={preferences.relayUrl ?? DEFAULT_RELAY_URL}
          encryptionKey={encryptionKey}
          onSelectContact={(contactId) => { setSelectedContactId(contactId); navigateTo('contact-detail'); }}
          onNewContact={() => navigateTo('contact-new')}
          onInvites={contactsScope.directoryId && !isPairedChild ? () => navigateTo('contact-invites') : undefined}
          onAddKen={() => navigateTo('ken-add')}
          onManageFamily={contactsScope.canManageFamily ? handleOpenFamilyContacts : undefined}
        />
      </Layout>
    );
  }

  if (page === 'contact-new') {
    return (
      <Layout title="New contact" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <ContactNew
          subjectName={contactsIdentityLists.find(l => l.ownerIdentityPubkey === contactsWriteIdentity)?.label ?? contactsScope.subjectName}
          onCreate={async (contact, methods) => {
            if (!contactsWriteIdentity) throw new Error('Choose an identity for this contact.');
            const contactId = await contactsV2.addContact({ ...contact, ownerIdentityPubkey: contactsWriteIdentity });
            for (const m of methods) await contactsV2.addContactMethod(contactId, m);
          }}
          onDone={() => navigateReplace('contacts')}
        />
      </Layout>
    );
  }

  if (page === 'get-verified' && identity && !activeDependant && !npActive) {
    return renderRealIdentityGate(
      'Getting verified attaches your legal name to this Signet, so it needs your real identity.',
      'get-verified',
    );
  }

  if (page === 'get-verified' && identity && activeDependant && !isDependantNaturalPersonActive(activeDependant)) {
    return renderDependantRealIdentityGate(
      dependantGateReason('get-verified', activeDependant.displayName),
      'get-verified',
      activeDependant.id,
    );
  }

  // Get Verified
  if (page === 'get-verified') {
    return (
      <Layout title="Get Verified" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <GetVerified
          identity={identity}
          onMarkBackedUp={handleMarkBackedUp}
          relayUrl={preferences.relayUrl}
          encryptionKey={encryptionKey}
          // Hide the optional public-relay publish button in dependant
          // (child) context — a child's pubkey → tier mapping must not
          // be placed on a public relay (UK GDPR / AADC).
          allowPublish={!activeDependant}
          onRegisterSavedInjector={
            (import.meta as any).env?.DEV
              ? (fn: (eventJsons: string[]) => void) => { getVerifiedSavedInjectorRef.current = fn; }
              : undefined
          }
        />
      </Layout>
    );
  }

  if (page === 'my-documents' && identity && !npActive) {
    return renderRealIdentityGate(
      'Your identity documents belong to your real identity, so it needs to be set up first.',
      'my-documents',
    );
  }

  // My Documents
  if (page === 'my-documents') {
    return (
      <Layout title="My Documents" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <MyDocuments documents={documents} onAddDocument={() => {}} onSelectDocument={() => {}} />
      </Layout>
    );
  }

  // Verify Someone
  if (page === 'verify-someone') {
    return (
      <Layout title="Verify Someone" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <VerifySomeone identity={identity} signingMode={preferences.signingMode} />
      </Layout>
    );
  }

  // Shamir Backup
  if (page === 'shamir') {
    return (
      <Layout title="Shamir Backup" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <ShamirBackup identity={identity} onBack={() => navigateBack()} />
      </Layout>
    );
  }

  if (page === 'identity-bridge' && identity && !npActive) {
    return renderRealIdentityGate(
      'The identity bridge links your real-world identity to this Signet, so it needs your real identity.',
      'identity-bridge',
    );
  }

  // Identity Bridge
  if (page === 'identity-bridge') {
    return (
      <Layout title="Identity Bridge" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <IdentityBridge identity={identity} onBack={() => navigateBack()} />
      </Layout>
    );
  }

  // Web Verify — scan or pick a QR from a website
  if (page === 'web-verify') {
    return (
      <Layout title="Scan QR Code" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <WebVerify
          onContactInvite={!isPairedChild && !activeDependantId ? invite => setPendingContactInvite(JSON.stringify(invite)) : undefined}
          onVerifyRequest={(request) => {
            setPendingVerifyRequest(request);
            navigateReplace('approve-verification');
          }}
          onAuthRequest={(request) => {
            // No carousel-row scan-time context here — the user is on the
            // dedicated WebVerify page. Clear any stale snapshot so the full
            // ApproveAuth page falls through to the policy default.
            setPendingAuthSelection(null);
            setPendingAuthRequest(request);
            navigateReplace('approve-auth');
          }}
          onLoginRequest={(request) => {
            setPendingAuthSelection(null);
            setPendingAuthRequest(request);
            navigateReplace('approve-auth');
          }}
          onNostrConnect={handleNostrConnect}
          onBack={() => navigateBack()}
        />
      </Layout>
    );
  }

  // Approve Verification
  if (page === 'approve-verification' && pendingVerifyRequest) {
    const personaCred = pickCredential(credentials, pendingVerifyRequest, Math.floor(Date.now() / 1000));
    return (
      <>
        <Layout title="Verify Age" showBack onBack={handleDenyVerification} {...guardianLayoutProps}>
          <ApproveVerification
            request={pendingVerifyRequest}
            credential={personaCred}
            onApprove={handleApproveVerification}
            onDeny={handleDenyVerification}
            onNavigateGetVerified={() => { setPendingVerifyRequest(null); navigateReplace('get-verified'); }}
          />
        </Layout>
        {/* See approve-auth: the re-unlock prompt must be mountable after an auto-lock. */}
        {authOverlay}{nip55Overlay}
      </>
    );
  }

  // Relay Auth Acknowledgement — shown after relay-mode approve or deny
  if (page === 'relay-auth-ack' && relayAuthAckState) {
    const clearAck = () => {
      setRelayAuthAckState(null);
      navigateReplace('home');
    };

    if (relayAuthAckState.status === 'failed') {
      return (
        <Layout title="Sign In" {...guardianLayoutProps}>
          <RelayAuthAck
            state="failed"
            relayHost={relayAuthAckState.relayHost}
            onRetry={async () => { await relayAuthAckState.retry(); }}
            onCancel={clearAck}
          />
        </Layout>
      );
    }

    return (
      <Layout title="Sign In" {...guardianLayoutProps}>
        <RelayAuthAck
          state={relayAuthAckState.status}
          siteName={relayAuthAckState.siteName}
          postUrl={relayAuthAckState.status === 'approved' ? relayAuthAckState.postUrl : undefined}
          onClose={clearAck}
        />
      </Layout>
    );
  }

  // Approve Auth (signet-auth-request or signet-login-request)
  if (page === 'approve-auth' && pendingAuthRequest && identity) {
    // Look up any per-origin policy for this request's origin.
    const originPolicyForRequest = (() => {
      try {
        const key = new URL(pendingAuthRequest.origin).origin;
        return originPolicies.find(p => p.origin === key) ?? null;
      } catch {
        return null;
      }
    })();
    // Offer identities with a local unlock path or an available external route.
    // Device-held slots (bunker mode) stay LISTED while the per-persona router
    // is down — it is torn down on lock and only returns once the unlock,
    // reconnect and capabilities probe have run — and are marked waiting
    // instead. Only a signer that has answered "cannot route personas" drops
    // them (a generic bunker is NP-only).
    const { listed: availableGuardianPubkeys, waiting: waitingGuardianPubkeys } = approvalGuardianPubkeys(identity, {
      signingMode: preferences.signingMode,
      unlocked: !!encryptionKey,
      routerReady: !!bunkerRouter && signerStatus === 'connected',
      routerUnsupported: routerProbeState === 'unsupported',
      routeWaitLapsed,
      externalPubkey: npBunkerBackend?.activePublicKeyHex ?? nip07Backend?.activePublicKeyHex,
    });
    const canSwitchGuardianPersona = availableGuardianPubkeys.length > 0;
    // Gate on the ACTING slot's key, not the NP's: a persona-first dependant
    // signs as their persona, so an NP-keyed test would drop them from the
    // picker after a key strip that left the persona signable (and vice versa).
    const availableDependants = dependants.filter(d =>
      !d.encrypted && isValidHexKey(resolveDependantCardSlot(d).slot.privateKey));
    const approveAuthRequestKey = authRequestKey(pendingAuthRequest);
    // Default selection comes from the row the user was viewing when the
    // request arrived. For QR scans we use the snapshot taken in
    // `handleCarouselQRScanned` so a later rows-rebuild can't drift it.
    // For URL-auth (?auth=1 handler) there is no carousel context and the
    // helper falls back to identity.primaryKeypair inside ApproveAuth.
    const currentRow = carousel.rows[carousel.row];
    const carouselSelection = pendingAuthSelection
      ?? (currentRow ? resolveSigningSelection(currentRow) : null);
    const approveAuthProps = {
      request: pendingAuthRequest,
      hasCredentialForSelection: (selection: AuthSelection | null) => {
        if (pendingAuthRequest.type !== 'signet-login-request') return false;
        const signingPubkey = resolveSelectedPubkey(selection, identity, dependants);
        if (!signingPubkey) return false;
        return !!pickCredentialForSubject(
          credentials,
          pendingAuthRequest,
          signingPubkey,
          Math.floor(Date.now() / 1000),
        );
      },
      identity,
      canSwitchGuardianPersona,
      availableGuardianPubkeys,
      dependants: availableDependants.length > 0 ? availableDependants : undefined,
      defaultSelection: carouselSelection ?? undefined,
      consumerHint,
      requireNpConfirmation,
      preferPersonaForSignIns,
      preferredPersonaPubkey,
      originMemory: originPolicyForRequest,
      onAddPersona: async (displayName: string) => {
        const key = encryptionKey || await requestAuth();
        if (!key) throw new Error('Authentication required');
        return addPersona(displayName, key, { deviceDerive: extraPersonaDeviceDerive });
      },
      onApprove: handleApproveAuthGuarded,
      onDeny: handleDenyAuth,
      initialError: pickerInitialError ?? undefined,
      isPairedChild,
      // A paired-child install cannot activate the owner's real identity.
      onActivateRealIdentity: preferences.signingMode === 'paired-child' ? undefined : () => {
        setActivationReturnTo('approve-auth');
        navigateTo('activate-real-identity');
      },
    };

    return (
      <>
        <Layout title={approveAuthTitle(pendingAuthRequest)} showBack onBack={handleDenyAuth}>
          {signerBanner}
          {/* Keyed by request: a new sign-in arriving while this page is up
              must get a fresh screen, never inherit the last one's
              "Signing…" state or error. */}
          <ApproveAuth
            key={approveAuthRequestKey}
            {...approveAuthProps}
            externallyApproving={authApprovalInFlightKey === approveAuthRequestKey}
            userChoice={authPickerChoice?.key === approveAuthRequestKey ? { selection: authPickerChoice.selection } : undefined}
            onUserChoice={(selection) => setAuthPickerChoice({ key: approveAuthRequestKey, selection })}
            waitingGuardianPubkeys={waitingGuardianPubkeys}
          />
        </Layout>
        {/* authOverlay must render here too — when the app auto-locks while this
            screen is open, the re-unlock prompt (requestAuth → showAuthPrompt)
            has to mount somewhere, or the lock strands the user (the internal issue tracker). */}
        {authOverlay}{nip55Overlay}
      </>
    );
  }

  if (page === 'approve-add-dependant' && identity && !npActive) {
    return renderRealIdentityGate(
      'A site asked you to add a dependant. You are the guardian on record, so this needs your real identity.',
      'approve-add-dependant',
    );
  }

  // Approve third-party Add Dependant
  if (page === 'approve-add-dependant' && pendingAddDependantRequest && identity) {
    const props = {
      request: pendingAddDependantRequest,
      canAutoPair: bunkerServerEnabled,
      onApprove: handleApproveAddDependant,
      onCancel: handleDenyAddDependant,
    };
    return (
      <>
        <Layout title="Add Dependant" showBack onBack={handleDenyAddDependant} {...guardianLayoutProps}>
          <ApproveAddDependant {...props} />
        </Layout>
        {/* See approve-auth: the re-unlock prompt must be mountable after an auto-lock. */}
        {authOverlay}{nip55Overlay}
      </>
    );
  }

  // Approve Connect (NIP-46)
  if (page === 'approve-connect' && pendingConnectRequest && identity) {
    // Same listing as the sign-in picker: device-held slots stay listed (and
    // waiting) while the per-persona router is down after a lock.
    const { listed: availableGuardianPubkeys, waiting: waitingGuardianPubkeys } = approvalGuardianPubkeys(identity, {
      signingMode: preferences.signingMode,
      unlocked: !!encryptionKey,
      routerReady: !!bunkerRouter && signerStatus === 'connected',
      routerUnsupported: routerProbeState === 'unsupported',
      routeWaitLapsed,
      externalPubkey: npBunkerBackend?.activePublicKeyHex ?? nip07Backend?.activePublicKeyHex,
    });
    const connectRequestKey = requestObjectKey(pendingConnectRequest);
    const canSwitchGuardianPersona = availableGuardianPubkeys.length > 0;
    // Gate on the ACTING slot's key, not the NP's: a persona-first dependant
    // signs as their persona, so an NP-keyed test would drop them from the
    // picker after a key strip that left the persona signable (and vice versa).
    const availableDependants = dependants.filter(d =>
      !d.encrypted && isValidHexKey(resolveDependantCardSlot(d).slot.privateKey));
    return (
      <>
      <Layout title="Connect" showBack onBack={handleConnectDone}>
        {signerBanner}
        <ApproveConnect
          key={connectRequestKey}
          request={pendingConnectRequest}
          identity={identity}
          canSwitchGuardianPersona={canSwitchGuardianPersona}
          availableGuardianPubkeys={availableGuardianPubkeys}
          dependants={availableDependants.length > 0 ? availableDependants : undefined}
          defaultSelection={pendingConnectSelection ?? undefined}
          requireNpConfirmation={requireNpConfirmation}
          preferPersonaForSignIns={preferPersonaForSignIns}
          preferredPersonaPubkey={preferredPersonaPubkey}
          onApprove={handleApproveConnect}
          onDeny={handleConnectDone}
          userChoice={connectPickerChoice?.key === connectRequestKey ? { selection: connectPickerChoice.selection } : undefined}
          onUserChoice={(selection) => setConnectPickerChoice({ key: connectRequestKey, selection })}
          waitingGuardianPubkeys={waitingGuardianPubkeys}
        />
      </Layout>
      {authOverlay}{nip55Overlay}
      {bunkerApprovalOverlay}
      {handoffPickerOverlay}
      </>
    );
  }

  // Approve Companion Grant (companion data rail pairing — see
  // companion-data-rail-plan Task 10). `pendingPairingRequest` is set by the
  // scan (handleCarouselQRScanned), the ?pair=1 web-carrier URL, and the
  // native signet-grant:// scheme (appUrlOpen) — see Task 12.
  if (page === 'approve-companion-grant' && pendingPairingRequest && identity) {
    const bunkerMode = !identity.mnemonic;
    const personas: Array<{ pubkey: string; label: string }> = [
      { pubkey: identity.naturalPerson.publicKey, label: identity.naturalPerson.displayName || 'Natural Person' },
      ...(identity.persona.publicKey
        ? [{ pubkey: identity.persona.publicKey, label: identity.persona.displayName || 'Persona' }]
        : []),
      // Skip hidden extras — same soft-delete semantics as ApproveConnect/ApproveAuth.
      ...(identity.extraPersonas ?? [])
        .filter(ep => !ep.hidden)
        .map(ep => ({ pubkey: ep.publicKey, label: ep.displayName || 'Persona' })),
    ];
    return (
      <>
        <Layout title="Connect companion app" showBack onBack={handleDenyCompanionGrant}>
          <ApproveCompanionGrant
            request={pendingPairingRequest}
            personas={personas}
            bunkerMode={bunkerMode}
            onApprove={handleApproveCompanionGrant}
            onDeny={handleDenyCompanionGrant}
          />
        </Layout>
        {/* See approve-auth: the re-unlock prompt must be mountable after an auto-lock. */}
        {authOverlay}{nip55Overlay}
      </>
    );
  }

  // Approve a contacts v2 grant (Phase E). `pendingContactsGrantV2` is only
  // ever set from the SDK parser — the QR route and the `?pair=1` carrier —
  // and never on a paired-child install (R-8).
  if (page === 'contacts-grant-approve' && pendingContactsGrantV2 && identity && !isPairedChild) {
    return (
      <>
        <Layout title={CONTACTS_GRANT_APPROVE_TITLE} showBack onBack={handleDenyContactsGrantV2}>
          <ContactsGrantApprove
            request={pendingContactsGrantV2}
            directories={contactsGrantDirectoryOptions}
            onApprove={handleApproveContactsGrantV2}
            onDeny={handleDenyContactsGrantV2}
          />
        </Layout>
        {/* See approve-auth: the re-unlock prompt must be mountable after an auto-lock. */}
        {authOverlay}{nip55Overlay}
      </>
    );
  }

  // Pairing verification-code check (SDK B1/F1). Set only by
  // `handleApproveContactsGrantV2` once the ack has landed — never on a
  // paired-child install (R-8), matching the approve screen above.
  // Back/leave is wired the same as "Keep it": the grant stands, nothing is
  // revoked silently.
  // Finding 2: gated on `encryptionKey` too — the disconnect action needs an
  // unlocked app, so a locked app falls through to the normal unlock flow
  // instead, and this render picks the page back up once unlocked (`page`
  // is untouched by locking, and `contactsGrantCodeCheck`'s mismatch count
  // is preserved by finding 1's fix regardless).
  if (page === 'contacts-grant-code' && contactsGrantCodeCheck && identity && encryptionKey && !isPairedChild) {
    return (
      <>
        <Layout title={CONTACTS_GRANT_CODE_TITLE} showBack onBack={handleContactsGrantCodeDone}>
          <ContactsGrantCode
            check={contactsGrantCodeCheck}
            onMismatch={handleContactsGrantCodeMismatch}
            onMatch={handleContactsGrantCodeMatch}
            onRevoke={revokeContactsGrantForCodeCheck}
            onDone={handleContactsGrantCodeDone}
          />
        </Layout>
        {authOverlay}{nip55Overlay}
      </>
    );
  }

  // Credential Detail
  if (page === 'credential-detail' && selectedCredential) {
    return (
      <Layout title="Credential" showBack onBack={() => { setSelectedCredential(null); navigateBack(); }} {...guardianLayoutProps}>
        <CredentialDetail credential={selectedCredential} userPubkey={activePubkey} tier={ownBadge?.tier ?? null} onBack={() => { setSelectedCredential(null); navigateBack(); }} />
      </Layout>
    );
  }

  // Vouch Someone
  if (page === 'vouch-someone' && activeBackend) {
    return (
      <Layout title="Vouch for Someone" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <VouchSomeone activeBackend={activeBackend} onBack={() => navigateBack()} />
      </Layout>
    );
  }

  if (page === 'add-dependant' && identity && !npActive) {
    return renderRealIdentityGate(
      'You are the guardian on record for anyone you add, so family needs your real identity.',
      'add-dependant',
    );
  }

  if (page === 'add-dependant') {
    return (
      <>
      <Layout title="Add Dependant" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <AddDependant
          onCreateDependant={async (name, dob) => {
            const dep = await addDependant(name, dob, { deviceDerive: dependantDeviceDerive });
            return dep.id;
          }}
          onSwitchToDependant={(depId) => { setActiveDependantId(depId); navigateReplace('home'); }}
          onPairDevice={(depId) => { setActiveDependantId(depId); navigateTo('pair-dependant-device'); }}
          onTurnOnBunker={() => { setPendingSecurityFocus('bunker'); navigateTo('settings-security'); }}
          bunkerServerEnabled={bunkerServerEnabled}
          onBack={() => navigateBack()}
        />
      </Layout>
      {authOverlay}{nip55Overlay}
          {handoffPickerOverlay}
      </>
    );
  }

  // Gated only while the list is empty: a user who already has dependants (e.g.
  // from a cross-device sync) must never be locked out of managing them.
  if (page === 'family-list' && identity && !npActive && dependants.length === 0) {
    return renderRealIdentityGate(
      'You are the guardian on record for anyone you add, so family needs your real identity.',
      'family-list',
    );
  }

  if (page === 'family-contacts') {
    if (!contactsScope.canManageFamily || !familyContactsUnlocked) { navigateReplace('family-list'); return null; }
    return (
      // M2: no guardianLayoutProps — like family-list, this is an owner-scope
      // cross-family surface (canManageFamily implies no activeDependant), so
      // spreading it would risk a stale "Viewing as {dep}" banner.
      <Layout title={FAMILY_CONTACTS_PAGE_TITLE} showBack onBack={() => { setFamilyContactsUnlocked(false); navigateBack(); }}>
        <FamilyContacts
          identityListsByDirectory={Object.fromEntries(familyDirectoryRefs.map(ref => [ref.directoryId,
            contactIdentityLists(identity, ref.isOwner ? null : dependants.find(dep => directoryIdForDependant(dep) === ref.directoryId) ?? null),
          ]))}
          rows={familyManagerRows}
          directories={familyContacts.directories}
          actorPubkey={contactsActorPubkey}
          guardianPubkey={contactsActorPubkey}
          guardianName={identity?.naturalPerson.displayName || null}
          loading={familyContacts.loading}
          error={familyContacts.error}
          onApply={async (reqs) => {
            await familyContacts.applyOps(reqs);
            await contactsV2.reload();
            // B/I5: the family manager is precisely where a guardian blocks
            // someone in a CHILD's directory, which is the case the immediate
            // publish path exists for (spec §7.9) — but only `ContactDetail`
            // was bumping the safety token, so a block applied here waited out
            // the 6–91 s jitter and could be absorbed by the hash dedupe.
            if (reqs.some((r) => r.action === 'block' || r.action === 'unblock')) {
              bumpContactsSafety(`family-block:${Date.now()}`);
            }
          }}
          onBack={() => { setFamilyContactsUnlocked(false); navigateBack(); }}
        />
      </Layout>
    );
  }

  if (page === 'family-list') {
    // family-list is an owner-scope list of ALL dependants — don't spread
    // guardianLayoutProps because it would render the "Viewing as {dep}"
    // banner when activeDependant is non-null (e.g. user back-navigates
    // here from a dep's settings page). The page itself is unrelated to
    // any one dep; banner scope would be misleading.
    return (
      <>
      <Layout title="Family" showBack onBack={() => navigateBack()}>
        <FamilyList
          dependants={dependants}
          onSelect={(depId) => {
            setActiveDependantId(depId);
            navigateTo('settings');
          }}
          onAddDependant={() => navigateTo('add-dependant')}
          onAddKen={() => navigateTo('ken-add')}
          onManageContacts={contactsScope.canManageFamily ? handleOpenFamilyContacts : undefined}
        />
      </Layout>
      {authOverlay}{nip55Overlay}
          {handoffPickerOverlay}
      </>
    );
  }

  if (page === 'ken-add' && identity) {
    // ownerPubkey for ken-add follows the primary keypair — same key that
    // useKens and the Rolodex use, so persona-primary users' kens show up.
    const kenOwner = contactsWriteIdentity || getActivePubkey(identity);
    return (
      <>
      <Layout title="Add a Contact" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <KenAdd
          ownerPubkeyHex={kenOwner}
          onAddKen={async (entry) => {
            await contactsV2.recogniseContact(entry.pubkey, entry.displayName || 'Unnamed', contactsWriteIdentity,
              entry.provenance.locator === 'qr' ? 'qr' : entry.provenance.source === 'nip05' ? 'nip05' : 'npub');
          }}
          onDone={() => navigateBack()}
          onBack={() => navigateBack()}
          relayUrl={preferences.relayUrl ?? DEFAULT_RELAY_URL}
          encryptionKey={encryptionKey}
          onSaveContactAvatar={async (pubkey, shareKey) => {
            if (!encryptionKey) return;
            await saveContactAvatar({ pubkey, shareKey, addedAt: Math.floor(Date.now() / 1000) }, encryptionKey);
          }}
        />
      </Layout>
      {authOverlay}{nip55Overlay}
      {handoffPickerOverlay}
      </>
    );
  }

  if (page === 'ken-detail' && identity && selectedKenPubkey) {
    // Lowercase both sides — `legacy.hasKenEntry` (contacts-v2-detail.ts, via
    // the contact-detail branch above) lowercases before comparing, so a
    // mixed-case legacy `ken` row must resolve here the same way or the
    // "Key control" row it offered would bounce back to `family-list`.
    const selectedKenPubkeyLower = selectedKenPubkey.toLowerCase();
    const kenEntry = kens.find(k => k.pubkey.toLowerCase() === selectedKenPubkeyLower);
    if (!kenEntry) { navigateReplace('family-list'); return null; }
    return (
      <>
      <Layout title={kenEntry.displayName ?? 'Ken detail'} showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <KenDetail
          entry={kenEntry}
          onAddKen={addKenEntry}
          onRemoveKen={removeKenEntry}
          onBack={() => navigateBack()}
          relayUrl={preferences.relayUrl ?? DEFAULT_RELAY_URL}
          encryptionKey={encryptionKey}
        />
      </Layout>
      {authOverlay}{nip55Overlay}
      {handoffPickerOverlay}
      </>
    );
  }

  if (page === 'import-dependant') {
    return (
      <>
      <Layout title="Import Identity" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <ImportDependant
          onImportDependant={async ({ displayName, dateOfBirth, publicKey, mnemonic }) => {
            const dep = await importDependant(publicKey, displayName, dateOfBirth, mnemonic);
            setActiveDependantId(dep.id);
          }}
          onSwitchToDependant={() => navigateReplace('home')}
          onBack={() => navigateBack()}
        />
      </Layout>
      {authOverlay}{nip55Overlay}
          {handoffPickerOverlay}
      </>
    );
  }

  // Transition Ceremony — independence ceremony for a dependant
  if (page === 'transition-ceremony' && activeDependant) {
    return (
      <Layout title="Independence Ceremony" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <TransitionCeremony
          dependant={activeDependant}
          contactsGate={resolveIndependenceGate({
            dependantName: activeDependant?.displayName ?? 'them',
            contacts: activeDependant
              ? (familyContacts.directories.find(d => d.directoryId === directoryIdForDependant(activeDependant))?.contacts ?? [])
              : [],
          })}
          contactsLoading={familyContacts.loading}
          onResolveGate={async () => {
            // Fresh re-check at the moment of confirm — the ceremony is a
            // one-way door, so `contactsGate` above (a render-time memo,
            // possibly stale right after page entry) is not enough on its
            // own. `reload()` returns the freshly-loaded directories
            // synchronously rather than the one-render-behind `directories`
            // memo — same pattern as `onRemoveDependant` below.
            //
            // Fail closed: a reload that could not read the log, or one
            // that came back without THIS dependant's directory at all
            // (every ref this hook is given resolves to an entry, so
            // absence means something is wrong, not "nothing there"), must
            // never read as "nothing to strand" — block the ceremony
            // instead of silently allowing it.
            const reloadResult = await familyContacts.reload();
            const directory = reloadResult.ok
              ? reloadResult.directories.find(d => d.directoryId === directoryIdForDependant(activeDependant))
              : undefined;
            if (!reloadResult.ok || !directory) {
              return { allowed: false, reason: CONTACTS_LOG_UNAVAILABLE_COPY };
            }
            return resolveIndependenceGate({
              dependantName: activeDependant.displayName,
              contacts: directory.contacts,
            });
          }}
          onComplete={async (opts) => {
            // Record decisions — actual credential supersession happens at a verifier's office.
            // Key rotation (migration event) is published inside TransitionCeremony before calling here.
            //
            // When the guardian relinquishes, purge all bunker material
            // for this dependant:
            //   - derived signing keypair (on guardian phone)
            //   - per-dependant endpoint keypair (lives on the identity row)
            //   - RememberedGrant records
            // All three are bundled in `removeDependant` which calls
            // deleteGrantsForDependant + deleteDependant in order.
            //
            // Emit the final ceremony-complete audit record BEFORE purging
            // so the last log-of-record is safely on the wire before we
            // tear down the grants table. A failed audit does not block
            // the purge — the purge is the user-requested action.
            if (!opts.removeGuardian) return;
            const depId = activeDependant.id;
            const relayUrl = preferences.relayUrl ?? DEFAULT_RELAY_URL;
            const guardianPubkey = naturalPersonServingBackend?.activePublicKeyHex;
            if (naturalPersonServingBackend && guardianPubkey) {
              await publishAuditEvent(
                { dependantPubkey: depId, outcome: 'ceremony-complete' },
                guardianPubkey,
                naturalPersonServingBackend,
                relayUrl,
              ).catch(() => { /* non-fatal */ });
            }
            try {
              // Retract any active dep kind-0s BEFORE the record is
              // purged — same one-way-door reasoning as handleRemove-
              // Dependant: once removeDependant runs the signing keys
              // are gone with the record. Best-effort, fire-and-forget
              // semantics inside retractDepProfilesBeforePurge.
              await retractDepProfilesBeforePurge(activeDependant);
              await removeDependant(depId);
            } catch {
              // Surface via the ceremony's error state — the onComplete
              // caller in TransitionCeremony catches and displays.
              throw new Error('Could not complete cleanup. Some dependant data may remain on this device.');
            }
          }}
          onBack={() => navigateBack()}
        />
      </Layout>
    );
  }

  // Pair a device — guardian-side QR for phone-as-family-bunker
  if (page === 'pair-dependant-device' && activeDependant) {
    return (
      <Layout title={`Pair ${activeDependant.displayName}'s device`} showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        {/* authOverlay must render here — the page's mount effect calls
         requestAuth(), which sets showAuthPrompt when the app is locked.
         Without the overlay the prompt is invisible and the awaited promise
         never resolves, freezing the page on "Setting up…". */}
        {authOverlay}{nip55Overlay}
        <PairDependantDevice
          dependant={activeDependant}
          relayUrl={preferences.relayUrl ?? DEFAULT_RELAY_URL}
          fallbackRelayUrls={preferences.fallbackBunkerRelays}
          // Reflect ONLY the user's configured intent. Don't conjoin with
          // `!!encryptionKey` — that conflates "Bunker is off" (a settings
          // state) with "app is locked" (an auth state), making the guard
          // falsely read "Bunker is off" right after a successful toggle if
          // the key is transiently null. The page's mount effect already
          // calls requestAuth() and bails via onBack if no key.
          bunkerServerEnabled={bunkerServerEnabled}
          ensureDependantBunkerEndpoint={async (pubkey) => {
            const key = encryptionKey || await requestAuth();
            if (!key) throw new Error('Authentication required');
            return ensureDependantBunkerEndpoint(pubkey, key);
          }}
          clearDependantBunkerEndpoint={async (pubkey) => {
            const key = encryptionKey || await requestAuth();
            if (!key) throw new Error('Authentication required');
            return clearDependantBunkerEndpoint(pubkey, key);
          }}
          saveDependantPairingSecret={async (pubkey, secret) => {
            const key = encryptionKey || await requestAuth();
            if (!key) throw new Error('Authentication required');
            return saveDependantPairingSecret(pubkey, secret, key);
          }}
          onOpenSecuritySettings={() => { setPendingSecurityFocus('bunker'); navigateTo('settings-security'); }}
          requestAuth={requestAuth}
          onBack={() => navigateBack()}
        />
      </Layout>
    );
  }

  // Pair a trusted app as this dependant — guardian-side QR for the
  // per-dependant app-bunker endpoint. Distinct
  // from device pairing — pairings live on `appBunkerEndpoint.pairings`,
  // capped at TRUSTED_APP_PAIRING_CAP, and don't evict the child's own
  // device pairing.
  if (page === 'pair-dependant-app' && activeDependant) {
    return (
      <Layout title={`Pair an app as ${activeDependant.displayName}`} showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        {/* See pair-dependant-device above — requestAuth() needs the overlay. */}
        {authOverlay}{nip55Overlay}
        <PairDependantApp
          dependant={activeDependant}
          relayUrl={preferences.relayUrl ?? DEFAULT_RELAY_URL}
          fallbackRelayUrls={preferences.fallbackBunkerRelays}
          // See PairDependantDevice render above — don't conjoin with
          // !!encryptionKey; the page's mount effect handles the locked case.
          bunkerServerEnabled={bunkerServerEnabled}
          ensureAppBunkerEndpoint={async (pubkey) => {
            const key = encryptionKey || await requestAuth();
            if (!key) throw new Error('Authentication required');
            const ep = await dbEnsureAppBunkerEndpoint(pubkey, key);
            await reloadDependants();
            return ep;
          }}
          setAppBunkerPairingSecret={async (pubkey, secret) => {
            const key = encryptionKey || await requestAuth();
            if (!key) throw new Error('Authentication required');
            await dbSetAppBunkerPairingSecret(pubkey, secret, key);
            await reloadDependants();
          }}
          listAppBunkerPairings={async (pubkey) => {
            const key = encryptionKey || await requestAuth();
            if (!key) throw new Error('Authentication required');
            return dbListAppBunkerPairings(pubkey, key);
          }}
          removeAppBunkerPairing={async (pubkey, clientPubkey) => {
            const key = encryptionKey || await requestAuth();
            if (!key) throw new Error('Authentication required');
            await dbRemoveAppBunkerPairing(pubkey, clientPubkey, key);
            await reloadDependants();
          }}
          onOpenSecuritySettings={() => { setPendingSecurityFocus('bunker'); navigateTo('settings-security'); }}
          requestAuth={requestAuth}
          onBack={() => navigateBack()}
        />
      </Layout>
    );
  }

  // Migrate family to Heartwood — full-screen ceremony page, no Layout
  // wrapper (family-bunker migration §11.1.3). Guarded on identity +
  // encryptionKey; the effect above (`signingPages`) already re-prompts
  // auth on arrival if locked, so this branch only needs the interim
  // "Unlocking..." state while that prompt is up.
  if (page === 'migrate-heartwood') {
    if (!identity || !encryptionKey) {
      return (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--text-secondary)' }}>
            Unlocking...
          </div>
          {authOverlay}{nip55Overlay}
          {bunkerApprovalOverlay}
          {handoffPickerOverlay}
        </>
      );
    }
    return (
      <MigrateToHeartwood
        identity={identity}
        dependants={dependants}
        relayUrl={preferences.relayUrl}
        alreadyBunker={!identity.mnemonic && !!bunkerBackend}
        onConnect={handleMigrationConnect}
        requestFn={handleMigrationRequestFn}
        onFinalize={handleMigrationFinalize}
        onAbort={handleMigrationAbort}
        onDone={() => navigateReplace('home')}
        onCancel={() => navigateBack()}
        operatorImport={{
          imported: !!heartwoodOperator.credential,
          onImportLink: heartwoodOperator.importLink,
          onImportPhrase: heartwoodOperator.importPhrase,
        }}
      />
    );
  }

  // Activity — guardian-side audit log per dependant (v1).
  // Rendered as a separate route so the underlying useAuditLog hook only fires
  // when the page is actually open (avoids relay traffic on every Settings visit).
  if (page === 'activity' && activeDependant) {
    return (
      <Layout
        title={`${activeDependant.displayName}'s activity`}
        showBack
        onBack={() => navigateBack()}
        {...guardianLayoutProps}
      >
        {authOverlay}{nip55Overlay}
        {bunkerApprovalOverlay}
        {handoffPickerOverlay}
        {topBanners}
        <GuardianActivityRoute
          dependant={activeDependant}
          guardianPubkey={identity?.naturalPerson.publicKey ?? ''}
          guardianBackend={guardianAuditBackend}
          relayUrl={preferences.relayUrl ?? DEFAULT_RELAY_URL}
        />
      </Layout>
    );
  }

  // Activity — paired-child-side audit surface (v2).
  // Renders only on devices in `paired-child` signing mode, where the
  // guardian's app has chosen to surface the dep's own audit log via
  // the dual-address gift-wrap (see `audit-visibility.ts`).
  //
  // Identity in this mode is a stub record (`SignetIdentity` with empty
  // private keys — see `handlePairChild`). The dep's NIP-46 client
  // keypair lives on the `PairedChildRecord` row, loaded into
  // `pairedChildClientKeypair` on unlock.
  if (page === 'activity' && preferences.signingMode === 'paired-child' && pairedChildClientKeypair && identity) {
    // Minimal DependantIdentity shape for the child surface — the
    // ChildActivityRoute only reads `id` and `displayName`. Cast
    // through unknown so we don't have to populate every field of
    // the full type just to render a header.
    const depForChild = {
      id: identity.id,
      displayName: identity.naturalPerson.displayName || 'You',
    } as unknown as import('./types').DependantIdentity;
    return (
      <Layout
        title="Your activity"
        showBack
        onBack={() => navigateBack()}
      >
        {authOverlay}{nip55Overlay}
        {bunkerApprovalOverlay}
        {topBanners}
        <ChildActivityRoute
          dependant={depForChild}
          childClientPubkey={pairedChildClientKeypair.publicKey}
          childClientPrivkey={pairedChildClientKeypair.privateKey}
          guardianPubkey={pairedChildClientKeypair.guardianPubkey}
          relayUrl={preferences.relayUrl ?? DEFAULT_RELAY_URL}
        />
      </Layout>
    );
  }

  // Paired-child re-pair. Lets a kid whose
  // guardian replaced their phone (or otherwise revoked the endpoint)
  // scan a fresh pairing QR without wiping their app. Updates the
  // existing PairedChildRecord in place; PIN, audit cache, persona-
  // inventory revision cache, etc. all survive. Routed in via
  // SettingsMenu when signingMode === 'paired-child'.
  if (page === 'paired-child-repair' && preferences.signingMode === 'paired-child' && identity) {
    return (
      <Layout title="Re-pair" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        {authOverlay}{nip55Overlay}
        <PairChildOnboarding
          expectedDependantPubkey={identity.id}
          onConfirm={async (parsed, rawUri) => {
            await handleRepairChild(parsed, rawUri);
            // Back to home — the bunker-setup effect re-runs from the
            // bumped counter and reconnects via the new endpoint.
            navigateReplace('home');
          }}
          onCancel={() => navigateBack()}
        />
      </Layout>
    );
  }

  // Paired-child switcher. Lets the shared-device user flip the
  // active pairing between the children already paired to this device.
  if (page === 'paired-child-switcher') {
    return (
      <Layout title="Who's using this device?" showBack onBack={() => navigateBack()} {...guardianLayoutProps}>
        <PairedChildSwitcher
          metas={pairedChildMetas}
          activePubkey={preferences.activeAccountId}
          onSelect={async (dependantPubkey) => {
            if (dependantPubkey === preferences.activeAccountId) return;
            // Tear down the current bunker + signer state before switching —
            // prevents a WebSocket leak and stale activePublicKeyHex reaching
            // the next sign flow under the new identity.
            if (bunkerBackend) {
              bunkerBackend.destroy();
              setBunkerBackend(null);
            }
            setSignerStatus(null);
            await savePreferences({ ...(await getPreferences()), activeAccountId: dependantPubkey });
            // Full reload — keeps the identity / useIdentity / useEffect
            // graph coherent without surgical in-place state swaps.
            window.location.reload();
          }}
          onBack={() => navigateBack()}
        />
      </Layout>
    );
  }

  // ─── Contact-share avatar: ENABLE + always-current republish (Task 13) ───
  // Distinct from the encrypted in-app avatar above. The contact avatar is
  // encrypted with a STABLE per-slot key (`contactAvatarKey`) so the pointer
  // can be reshared/refetched across devices; the pointer is a kind-0-shaped
  // event signed by the persona's OWN key (not the guardian's), and the blob
  // re-uploads on every avatar change to stay current. `requireExisting`
  // gates the change-time path so a plain avatar edit never auto-enables
  // sharing — only the explicit carousel "share" action does.
  const pushContactAvatar = async (opts: {
    target: string;
    depPubkey?: string;
    plaintext?: Uint8Array;
    requireExisting: boolean;
  }): Promise<string | null> => {
    const key = encryptionKey || await requestAuth();
    if (!key) throw new Error('Authentication required');

    // Resolve the decrypted slot (privateKey + private-avatar fields).
    let slot: { publicKey: string; privateKey: string; avatarHash?: string; avatarBlossomUrl?: string; avatarKey?: string; contactAvatarKey?: string; contactAvatarHash?: string; contactAvatarBlossomUrl?: string; contactAvatarUpdatedAt?: number } | undefined;
    if (opts.depPubkey) {
      // Read the dep FRESH from IDB — the in-memory `dependants` array is the
      // pre-change snapshot when this runs right after a same-handler avatar
      // change (e.g. onSetDepPersonaAvatar → setDependantPersonaAvatar →
      // pushContactAvatar). Using the stale slot here would re-share the old
      // avatar bytes. loadFreshDependants re-decrypts via getDependants and
      // mirrors the user-side loadIdentityDecrypted path below. See C1.
      const all = await loadFreshDependants(key);
      const dep = all.find(d => d.id === opts.depPubkey);
      if (!dep) return null;
      slot = opts.target === 'natural-person' ? dep.naturalPerson
        : opts.target === 'persona' ? dep.persona
        : dep.extraPersonas?.find(e => e.publicKey === opts.target);
    } else {
      if (!identity) return null;
      const decrypted = await loadIdentityDecrypted(identity.id, key);
      if (!decrypted) return null;
      slot = opts.target === 'natural-person' ? decrypted.naturalPerson
        : opts.target === 'persona' ? decrypted.persona
        : decrypted.extraPersonas?.find(e => e.publicKey === opts.target);
    }
    if (!slot) return null;
    // Need a PRIVATE avatar to share.
    if (!(slot.avatarHash && slot.avatarBlossomUrl && slot.avatarKey)) return null;
    const ownedPublish = !!slot.privateKey;
    // Router-sourced fallback is a SHARED, CACHED route — only a locally-
    // constructed backend (ownedPublish) may be destroy()'d below.
    const routedPublish = ownedPublish ? null : (bunkerRouter?.backendFor(slot.publicKey) ?? null);
    if (!ownedPublish && !routedPublish) return null;

    let contactKey = slot.contactAvatarKey;
    if (!contactKey) {
      if (opts.requireExisting) return null; // change-time: don't auto-enable
      contactKey = generateContactAvatarKey();
    }

    const backendForBlossom = npBunkerBackend ?? nip07Backend ?? backends?.naturalPerson;
    if (!backendForBlossom) throw new Error('Sign in before sharing an avatar.');
    const blossomUrl = preferences.defaultBlossomUrl ?? DEFAULT_BLOSSOM_URL;
    if (!blossomUrl) throw new Error('Set a Blossom server in Advanced Settings first.');
    if (!blossomConsent) throw new Error('Enable Blossom uploads in Advanced Settings first.');

    // Plaintext: supplied on avatar change, else fetch + decrypt the current avatar.
    let plaintext = opts.plaintext;
    if (!plaintext) {
      const blob = await fetchAvatar({ hash: slot.avatarHash, blossomUrl: slot.avatarBlossomUrl, keyHex: slot.avatarKey });
      plaintext = new Uint8Array(await blob.arrayBuffer());
    }

    // M3: surface re-publish failures instead of swallowing them. An upload OR
    // publish failure at CHANGE-time (requireExisting) leaves contacts seeing
    // the OLD avatar, so we flag the slot stale; a successful (re-)share clears
    // it. At ENABLE-time nothing was shared yet, so an upload throw propagates
    // untouched (QRCard surfaces it) without persisting a stale flag.
    let meta;
    try {
      meta = await uploadContactAvatar(plaintext, contactKey, blossomUrl, backendForBlossom, blossomConsent);
    } catch (err) {
      if (opts.requireExisting) {
        // Re-publish of an already-shared avatar failed to upload. Keep the
        // last-known-good pointer in place but mark it stale so the card nudges
        // a re-share; the change-time caller's catch then no-ops gracefully.
        const staleFields = {
          contactAvatarKey: contactKey,
          contactAvatarHash: slot.contactAvatarHash ?? '',
          contactAvatarBlossomUrl: slot.contactAvatarBlossomUrl ?? '',
          contactAvatarUpdatedAt: slot.contactAvatarUpdatedAt ?? 0,
          contactAvatarStale: true,
        };
        if (opts.depPubkey) await setDependantPersonaContactAvatar(opts.depPubkey, opts.target, staleFields);
        else await setPersonaContactAvatar(opts.target, staleFields);
      }
      throw err;
    }

    // Publish the pointer signed by the persona's own key. A `false` return is
    // a relay reject — record it as stale rather than discarding it.
    const slotBackend: DecryptingSigningBackend = ownedPublish ? new LocalSigningBackend(slot.privateKey) : routedPublish!;
    let publishOk: boolean;
    try {
      publishOk = await publishContactAvatarPointer({ hash: meta.hash, blossomUrl: meta.blossomUrl }, slotBackend, preferences.relayUrl ?? DEFAULT_RELAY_URL);
    } finally {
      if (ownedPublish) slotBackend.destroy();
    }

    const fields = {
      contactAvatarKey: contactKey,
      contactAvatarHash: meta.hash,
      contactAvatarBlossomUrl: meta.blossomUrl,
      contactAvatarUpdatedAt: meta.updatedAt,
      contactAvatarStale: !publishOk,
    };
    if (opts.depPubkey) await setDependantPersonaContactAvatar(opts.depPubkey, opts.target, fields);
    else await setPersonaContactAvatar(opts.target, fields);

    return contactKey;
  };

  const handleEnableContactAvatarShare = (target: string, depPubkey?: string): Promise<string | null> =>
    pushContactAvatar({ target, depPubkey, requireExisting: false });

  // ─── Contact-share avatar: STOP sharing (G1 coarse revocation) ───
  // Clears the stable per-slot key + pointer metadata LOCALLY first (so the
  // revocation can't be blocked by an unreachable relay), then best-effort
  // retracts the published pointer via kind-5 + tombstone. Re-enabling later
  // mints a fresh key (generateContactAvatarKey in pushContactAvatar), so a
  // recipient who cached the old key can't follow the new pointer. Recipients
  // who already fetched the blob keep it — no clawback, by design.
  const handleStopContactAvatarShare = async (target: string, depPubkey?: string): Promise<void> => {
    const key = encryptionKey || await requestAuth();
    if (!key) throw new Error('Authentication required');

    // Resolve the slot's privateKey the same fresh-read way pushContactAvatar
    // does (dep: loadFreshDependants; user: loadIdentityDecrypted).
    let slot: { publicKey: string; privateKey: string } | undefined;
    if (depPubkey) {
      const all = await loadFreshDependants(key);
      const dep = all.find(d => d.id === depPubkey);
      if (!dep) return;
      slot = target === 'natural-person' ? dep.naturalPerson
        : target === 'persona' ? dep.persona
        : dep.extraPersonas?.find(e => e.publicKey === target);
    } else {
      if (!identity) return;
      const decrypted = await loadIdentityDecrypted(identity.id, key);
      if (!decrypted) return;
      slot = target === 'natural-person' ? decrypted.naturalPerson
        : target === 'persona' ? decrypted.persona
        : decrypted.extraPersonas?.find(e => e.publicKey === target);
    }
    if (!slot) return;

    // Clear FIRST — local revocation must not be blockable by relay state
    // (or by the absence of a local/routed signing key).
    if (depPubkey) await clearDependantPersonaContactAvatar(depPubkey, target);
    else await clearPersonaContactAvatar(target);

    // Best-effort retract of the published pointer. Router-sourced fallback
    // is a SHARED, CACHED route — only a locally-constructed backend
    // (ownedStop) may be destroy()'d below.
    const ownedStop = !!slot.privateKey;
    const stopBackend: DecryptingSigningBackend | null = ownedStop
      ? new LocalSigningBackend(slot.privateKey)
      : (bunkerRouter?.backendFor(slot.publicKey) ?? null);
    if (stopBackend) {
      try {
        await retractContactAvatarPointer(stopBackend, preferences.relayUrl ?? DEFAULT_RELAY_URL);
      } finally {
        if (ownedStop) stopBackend.destroy();
      }
    }
  };

  // Home (default) — card-swipe wallet carousel
  return (
    <>
      {activeDependant && (
        <GuardianBanner
          dependantName={activeDependant.displayName}
          actingAs={carousel.childMode}
          onSwitchBack={carousel.childMode
            ? () => { handleExitChildMode(); }
            : () => { setActiveDependantId(null); }}
          onOpenSwitcher={dependants.length > 1 ? () => setShowHandoffPicker(true) : undefined}
        />
      )}
      {showRepairBanner && (
        <RepairBanner
          onReview={() => {
            clearRecentRestore();
            setShowRepairBanner(false);
            navigateTo('home');
          }}
          onDismiss={() => {
            clearRecentRestore();
            setShowRepairBanner(false);
          }}
        />
      )}
      {rateLimitAlert && !showRepairBanner && (
        <RateLimitBanner
          dependantName={rateLimitAlert.name}
          onReview={() => {
            setRateLimitAlert(null);
            if (rateLimitAutoDismissRef.current) {
              clearTimeout(rateLimitAutoDismissRef.current);
              rateLimitAutoDismissRef.current = null;
            }
            navigateTo('home');
          }}
          onDismiss={() => {
            setRateLimitAlert(null);
            if (rateLimitAutoDismissRef.current) {
              clearTimeout(rateLimitAutoDismissRef.current);
              rateLimitAutoDismissRef.current = null;
            }
          }}
        />
      )}
      {showBackupNudge && (
        <BackupCard
          onBackup={() => { navigateTo('settings-security'); }}
          onDismiss={() => { void snoozeBackupNudge(Date.now() + BACKUP_NUDGE_SNOOZE_MS); }}
        />
      )}
      {!apkPromoDismissed && shouldPromoteAndroidApp() && !showBackupNudge && (
        <AndroidAppPromo
          onGetApp={openAndroidApp}
          onSnooze={() => { snoozeApkPromo(); setApkPromoDismissed(true); }}
        />
      )}
      {contactsScope.directoryId === 'owner' && !carousel.activeIdentity.isDependant && !isPairedChild
        && contactsV2.records.filter(c => contactBelongsToList(c, carousel.activeIdentity.publicKey) && uncheckedAppConnection(c, carousel.activeIdentity.publicKey)).slice(0, 3).map(contact => {
          const notice = uncheckedAppConnection(contact, carousel.activeIdentity.publicKey);
          return notice ? <div className="card section" role="status" key={contact.contactId}>
            <p>{contact.displayName}: added via {notice.appName}, not checked.</p>
            <button className="btn btn-secondary" onClick={() => { setContactsIdentityChoice(carousel.activeIdentity.publicKey);
              setSelectedContactId(contact.contactId); navigateTo('contact-detail'); }}>Review app connection</button>
            {notice.canUndo && <button className="btn btn-ghost" onClick={() => { void contactsV2.removeContact(contact.contactId).catch(() => {}); }}>Undo app connection</button>}
          </div> : null;
        })}
      <Carousel
        renderInviteCard={(_row, resolved, publicCard) => !resolved.isDependant && !isPairedChild && resolved.publicKey
          ? <ContactInviteQRCard key={resolved.publicKey} service={ownerInviteService} identityPubkey={resolved.publicKey}
            name={resolved.displayName} relays={syncRelays.write.filter(url => url.startsWith('wss:'))} version={contactsV2Version} publicCard={publicCard}
            onManage={() => { setActiveDependantId(null); setContactsIdentityChoice(resolved.publicKey); navigateTo('contact-invites'); }} />
          : publicCard}
        renderBotCard={(row, col) => <BotCarouselCard key={row.bot.publicKey} bot={row.bot} col={col}
          onSignIn={async (selection, request, valid) => {
            const key = encryptionKey, root = identity.naturalPerson.publicKey, mode = preferences.signingMode;
            const current = () => valid() && !!key && botSession.current.key === key && botSession.current.owner === root
              && botSession.current.mode === mode && mode !== 'paired-child';
            if (!key || mode === 'paired-child' || !current() || selection.botPubkey !== row.bot.publicKey) throw new Error('Unlock to sign in as this bot.');
            await approveBotAuth({ selection, request, isCurrent: current,
              signer: selected => createBotSigningBackend({ identityId: identity.id, ownerRoot: root, botPubkey: selected.botPubkey,
                encryptionKey: key, mode: mode ?? 'local', isCurrent: current,
                routed: target => mode === 'nip07' ? nip07Backend?.activePublicKeyHex === target ? nip07Backend : null
                  : resolveSlotBunkerBackend(bunkerBackend, bunkerRouter, target) }) });
          }}
          onOpen={contacts => { setPendingBotContacts(contacts ? row.bot.publicKey : undefined); setActiveDependantId(null); navigateTo('bots'); }}
          onHide={async () => {
            if (!encryptionKey) throw new Error('Unlock first');
            const root = identity.naturalPerson.publicKey;
            await updateBotRegistry(root, encryptionKey, value => {
              if (identityRef.current?.naturalPerson.publicKey !== root || encryptionKeyRef.current !== encryptionKey) throw new Error('Bot session changed');
              return { ...value, bots: value.bots.map(bot => bot.publicKey === row.bot.publicKey ? { ...bot, hidden: true, updatedAt: Math.floor(Date.now() / 1000) } : bot) };
            });
            setBotsVersion(v => v + 1); setBotsChangeVersion(v => v + 1);
          }} />}
        renderContactsCard={(_row, resolved) => <ContactsCard key={(resolved.dependantId ?? 'owner') + ':' + resolved.publicKey}
          name={resolved.displayName} available={!resolved.isDependant && (contactsScope.directoryId === 'owner' || isPairedChild) && !contactsV2.loading}
          contacts={!resolved.isDependant && (contactsScope.directoryId === 'owner' || isPairedChild)
            ? contactsV2.effective.filter(contact => contactBelongsToList(contact, resolved.publicKey)) : []}
          onOpen={async (action, query) => {
            const owner = identity.naturalPerson.publicKey;
            const key = await requestAuth({ purpose: 'manage-family-contacts' });
            if (!key || identityRef.current?.naturalPerson.publicKey !== owner) return;
            setActiveDependantId(resolved.isDependant ? resolved.dependantId ?? null : null);
            setContactsIdentityChoice(resolved.publicKey || null);
            setContactCardSearch(query);
            navigateTo(action === 'new' ? 'contact-new' : 'contacts');
          }} />}
        row={carousel.row}
        col={carousel.col}
        rows={carousel.rows}
        activeIdentity={carousel.activeIdentity}
        animating={carousel.animating}
        onCommit={carousel.commitPosition}
        onAnimatingChange={carousel.setAnimating}
        swipeLocked={!!pendingAuthRequest}
        badge={ownBadge ? {
          tier: ownBadge.tier,
          score: ownBadge.score ?? 0,
          vouchCount: ownBadge.vouchCount ?? 0,
          iqBreakdown: ownBadge.iqBreakdown,
        } : null}
        onNavigateDeepPage={(p, opts) => {
          if (opts?.focusPersona) setPendingPersonaFocus(opts.focusPersona);
          // Must precede navigateTo — destination routes (e.g. 'settings',
          // 'transition-ceremony') read activeDependant synchronously on
          // render; React batches both state updates into the same flush.
          if (opts?.dependantId) setActiveDependantId(opts.dependantId);
          if (opts?.slotTarget) {
            setPendingPersonaAdvancedTarget({
              slotTarget: opts.slotTarget,
              depPubkey: opts.dependantId,
            });
          }
          navigateTo(p as Page);
        }}
        onQRScanned={handleCarouselQRScanned}
        onEnterChildMode={handleEnterChildMode}
        onExitChildMode={handleExitChildMode}
        childMode={carousel.childMode}
        childDependant={carousel.childDependant}
        onAddPersona={async (displayName) => {
          // Fresh-auth gate so a child who's shoulder-surfed the PIN can't
          // mint new personas on the guardian's identity. Same pattern as
          // IdentitySettings' Add Persona flow. See the authorisation matrix.
          const key = await requestFreshAuth();
          if (!key) throw new Error('Authentication required');
          // Route the new persona to the currently-viewed identity. In child
          // mode the carousel is showing a dependant — the persona must land
          // on the dependant's record (derived from the guardian's mnemonic
          // under the dependant's derivation path), not on the guardian's
          // own identity. Matches the GuardianSettings "Add persona to
          // dependant" path.
          if (carousel.childMode && activeDependant) {
            await addDependantPersona(activeDependant.id, displayName, key, { deviceDerive: extraPersonaDeviceDerive });
          } else {
            await addPersona(displayName, key, { deviceDerive: extraPersonaDeviceDerive });
          }
        }}
        onAddDependant={() => navigateTo('add-dependant')}
        childDormant={preferences.signingMode === 'paired-child' && childIsDormant}
        childSignerKind={preferences.signingMode === 'paired-child' && bunkerRouter ? 'heartwood' : 'guardian-phone'}
        cachedGuardianName={cachedGuardianName}
        dependantById={Object.fromEntries(dependants.map(d => [d.id, d]))}
        proAnchorActive={!!proAnchor}
        onProPillTap={() => navigateTo('pro-dashboard')}
        recentSignInAck={recentSignInAck}
        signingMode={preferences.signingMode}
        dependantsCount={dependants.length}
        isPairedChild={isPairedChild}
        blurIdentityNames={blurIdentityNames}
        onRenameActive={async (target, name) => {
          // `target` is the slot of the row that was edited (Carousel resolves
          // it via `resolveRenameTarget`), NOT `identity.primaryKeypair` — on a
          // persona-primary install those differ, and naming a nameless real
          // identity from its own card used to rename the persona instead.
          await updateDisplayName(target, name);
        }}
        defaultBlossomUrl={preferences.defaultBlossomUrl ?? DEFAULT_BLOSSOM_URL}
        blossomConsent={blossomConsent}
        // ─── Inline SlotProfileFields handlers — mirror Personas.tsx /
        // GuardianSettings.tsx wiring so the carousel SettingsCard can host
        // the kind-0 editor + name editor inline. Phase 3 of the persona-
        // card-as-source-of-truth refactor. ───
        onSavePersonaConfig={async (target, config) => {
          if (!identity) return;
          let currentState: import('./types').PersonaPublicProfile | undefined;
          if (target === 'natural-person') currentState = identity.naturalPerson.publicProfile;
          else if (target === 'persona') currentState = identity.persona.publicProfile;
          else if (target === 'professional-persona') currentState = identity.professionalPersona?.publicProfile;
          else currentState = identity.extraPersonas?.find(p => p.publicKey === target)?.publicProfile;
          await setPersonaPublicProfile(target, config, currentState);
        }}
        onRepublishProfile={async (target) => {
          const result = await publishPersonaProfile(target, undefined);
          if (!result.ok) throw new Error(result.message || 'Republish failed.');
        }}
        onUploadPersonaPicture={async (file, kind) => {
          const blossomUrl = preferences.defaultBlossomUrl ?? DEFAULT_BLOSSOM_URL;
          if (!blossomUrl) throw new Error('Set a Blossom server in Advanced Settings first.');
          if (!blossomConsent) throw new Error('Enable Blossom uploads in Advanced Settings first.');
          const MAX_RAW_BYTES = 20 * 1024 * 1024;
          if (file.size > MAX_RAW_BYTES) {
            throw new Error('That photo is too large. Pick one under 20 MB.');
          }
          const uploadBackend = npBunkerBackend ?? nip07Backend ?? backends?.naturalPerson;
          if (!uploadBackend) throw new Error('Sign in before uploading a photo.');
          // Re-encode via canvas to strip EXIF (GPS, device serial, capture
          // timestamp, etc.) before publishing the URL on a public Nostr
          // kind-0. `downscaleAvatar` is the same primitive used by the
          // encrypted-avatar path; here we just pass a larger max edge.
          const maxEdge = kind === 'banner' ? PUBLIC_BANNER_MAX_EDGE_PX : PUBLIC_PICTURE_MAX_EDGE_PX;
          const reencoded = await downscaleAvatar(file, maxEdge);
          const hash = await uploadToBlossom(reencoded, blossomUrl, uploadBackend, blossomConsent);
          const url = `${blossomUrl.replace(/\/+$/, '')}/${hash}`;
          return { url, sha256: hash };
        }}
        onUpdateOwnPersonaName={async (target, name) => {
          const key = encryptionKey || await requestAuth();
          if (!key) throw new Error('Authentication required');
          await updateDisplayName(target, name);
        }}
        onSaveDepPersonaConfig={async (depPubkey, target, config) => {
          const dep = dependants.find(d => d.id === depPubkey);
          if (!dep) return;
          let currentState: import('./types').PersonaPublicProfile | undefined;
          if (target === 'natural-person') currentState = dep.naturalPerson.publicProfile;
          else if (target === 'persona') currentState = dep.persona.publicProfile;
          else currentState = dep.extraPersonas?.find(p => p.publicKey === target)?.publicProfile;
          await setDependantPersonaPublicProfile(depPubkey, target, config, currentState);
        }}
        onRepublishDepProfile={async (depPubkey, target) => {
          const result = await publishPersonaProfile(target, depPubkey);
          if (!result.ok) throw new Error(result.message || 'Republish failed.');
        }}
        onUploadDepPersonaPicture={async (_depPubkey, file, kind) => {
          // Same NP-backend signs the Blossom NIP-98 auth event regardless
          // of which dep slot the picture is FOR — the dep's signing
          // material isn't on this device. Mirrors GuardianSettings.tsx.
          const blossomUrl = preferences.defaultBlossomUrl ?? DEFAULT_BLOSSOM_URL;
          if (!blossomUrl) throw new Error('Set a Blossom server in Advanced Settings first.');
          if (!blossomConsent) throw new Error('Enable Blossom uploads in Advanced Settings first.');
          const MAX_RAW_BYTES = 20 * 1024 * 1024;
          if (file.size > MAX_RAW_BYTES) {
            throw new Error('That photo is too large. Pick one under 20 MB.');
          }
          const uploadBackend = npBunkerBackend ?? nip07Backend ?? backends?.naturalPerson;
          if (!uploadBackend) throw new Error('Sign in before uploading a photo.');
          // Re-encode to strip EXIF — see `onUploadPersonaPicture` above.
          // Particularly important for dep public pictures: a guardian
          // uploading a phone photo of their child would otherwise leak
          // home GPS coordinates onto the public Nostr relay.
          const maxEdge = kind === 'banner' ? PUBLIC_BANNER_MAX_EDGE_PX : PUBLIC_PICTURE_MAX_EDGE_PX;
          const reencoded = await downscaleAvatar(file, maxEdge);
          const hash = await uploadToBlossom(reencoded, blossomUrl, uploadBackend, blossomConsent);
          const url = `${blossomUrl.replace(/\/+$/, '')}/${hash}`;
          return { url, sha256: hash };
        }}
        onUpdateDepName={async (depPubkey, name) => {
          const key = encryptionKey || await requestAuth();
          if (!key) throw new Error('Authentication required');
          await updateDependantName(depPubkey, name);
        }}
        onUpdateDepPersonaName={async (depPubkey, target, name) => {
          const key = encryptionKey || await requestAuth();
          if (!key) throw new Error('Authentication required');
          await updateDependantPersonaName(depPubkey, target, name, key);
        }}
        // ─── Encrypted in-app avatar handlers — lifted from Personas.tsx /
        // GuardianSettings.tsx so the carousel SettingsCard hosts the
        // Set/Change/Remove flow inline. Same downscale → encrypt → Blossom
        // upload pipeline as before; only the host surface changed.
        // Suppressed on the paired-child surface: the kid's local writes
        // get overwritten by the next persona-inventory sync from the
        // guardian, and the Blossom NIP-98 auth event would
        // pop an unsolicited sign request to the guardian's bunker.
        onSetPersonaAvatar={isPairedChild ? undefined : async (target, file) => {
          const key = encryptionKey || await requestAuth();
          if (!key) throw new Error('Authentication required');
          const MAX_RAW_BYTES = 20 * 1024 * 1024;
          if (file.size > MAX_RAW_BYTES) {
            throw new Error('That photo is too large. Pick one under 20 MB.');
          }
          const npBackend = npBunkerBackend ?? nip07Backend ?? backends?.naturalPerson;
          if (!npBackend) throw new Error('Sign in before uploading a photo.');
          const blossomUrl = preferences.defaultBlossomUrl ?? DEFAULT_BLOSSOM_URL;
          if (!blossomUrl) {
            throw new Error('Set a Blossom server in Advanced Settings before uploading photos.');
          }
          if (!blossomConsent) {
            throw new Error('Enable Blossom uploads in Advanced Settings first.');
          }
          const downscaled = await downscaleAvatar(file);
          const metadata = await uploadAvatar(downscaled, blossomUrl, npBackend, blossomConsent);
          await setPersonaAvatar(target, metadata);
          // Keep the contact-share avatar current (only if sharing was already enabled).
          try {
            await pushContactAvatar({ target, plaintext: new Uint8Array(await downscaled.arrayBuffer()), requireExisting: true });
          } catch { /* best-effort — never block the primary avatar set */ }
        }}
        onClearPersonaAvatar={isPairedChild ? undefined : async (target) => {
          const key = encryptionKey || await requestAuth();
          if (!key) throw new Error('Authentication required');
          await clearPersonaAvatar(target);
        }}
        // Device-local NIP-05 check result — persisted straight to IDB, no
        // auth prompt (mirrors the read-only nature of the check itself;
        // the identity is already unlocked to be viewing this card at all).
        onNip05Checked={async (target, result, checkedAt) => {
          await setSlotNip05Check(target, { result, checkedAt });
        }}
        onSetDepPersonaAvatar={async (depPubkey, target, file) => {
          const key = encryptionKey || await requestAuth();
          if (!key) throw new Error('Authentication required');
          const MAX_RAW_BYTES = 20 * 1024 * 1024;
          if (file.size > MAX_RAW_BYTES) {
            throw new Error('That photo is too large. Pick one under 20 MB.');
          }
          // Same NP-backend precedence as user-own avatar upload. The dep
          // doesn't have signing material on this device — the guardian's
          // NP key authorises the Blossom PUT.
          const npBackend = npBunkerBackend ?? nip07Backend ?? backends?.naturalPerson;
          if (!npBackend) throw new Error('Sign in before uploading a photo.');
          const blossomUrl = preferences.defaultBlossomUrl ?? DEFAULT_BLOSSOM_URL;
          if (!blossomUrl) {
            throw new Error('Set a Blossom server in Advanced Settings before uploading photos.');
          }
          if (!blossomConsent) {
            throw new Error('Enable Blossom uploads in Advanced Settings first.');
          }
          const downscaled = await downscaleAvatar(file);
          const metadata = await uploadAvatar(downscaled, blossomUrl, npBackend, blossomConsent);
          await setDependantPersonaAvatar(depPubkey, target, metadata);
          // Keep the contact-share avatar current (only if sharing was already enabled).
          try {
            await pushContactAvatar({ target, depPubkey, plaintext: new Uint8Array(await downscaled.arrayBuffer()), requireExisting: true });
          } catch { /* best-effort */ }
        }}
        onClearDepPersonaAvatar={async (depPubkey, target) => {
          const key = encryptionKey || await requestAuth();
          if (!key) throw new Error('Authentication required');
          await clearDependantPersonaAvatar(depPubkey, target);
        }}
        onDepNip05Checked={async (depPubkey, target, result, checkedAt) => {
          await setDependantSlotNip05Check(depPubkey, target, { result, checkedAt });
        }}
        // Contact-share avatar ENABLE. Gated on the paired-child surface for
        // the same reasons as the in-app avatar handlers above (local writes
        // get clobbered by the next persona-inventory sync; Blossom NIP-98
        // auth would pop an unsolicited sign request to the guardian's bunker).
        onEnableContactAvatarShare={isPairedChild ? undefined : handleEnableContactAvatarShare}
        // Contact-share avatar STOP (G1 coarse revocation). Gated on the
        // paired-child surface for the same reasons as enable above.
        onStopContactAvatarShare={isPairedChild ? undefined : handleStopContactAvatarShare}
      >
        {pendingAuthRequest && page === 'home' && identity && (() => {
          // Display from the scan-time selection snapshot, not the live carousel
          // row — they can diverge if any state update rebuilds `carousel.rows`
          // or resets `carousel.row` between scan and overlay render. Falling
          // back to `carousel.activeIdentity` keeps the overlay sensible for
          // requests that arrived without a scan-time selection (e.g. URL auth
          // before the post-unlock navigation kicks in).
          const overlayIdentity = pendingAuthSelection
            ? (resolveAuthSelectionIdentity(pendingAuthSelection, identity, dependants)
              ?? carousel.activeIdentity)
            : carousel.activeIdentity;
          return (
            <ApprovalOverlay
              request={pendingAuthRequest}
              // Fall back to the hostname (bidi/control-safe via safeOrigin), not
              // the raw consumer-supplied origin — a QR-scanned auth request sets
              // no urlAuthSiteName, so the unsanitised origin would otherwise be
              // rendered verbatim in the approval prompt (UI spoofing). Security
              // audit 2026-06-15.
              siteName={urlAuthSiteName || safeOrigin(pendingAuthRequest.origin)}
              activeIdentity={overlayIdentity}
              consumerHint={consumerHint}
              requireNpConfirmation={requireNpConfirmation}
              onOpenFullPicker={() => navigateTo('approve-auth')}
              onApprove={handleApproveFromCarousel}
              onDeny={handleDenyAuth}
              isPairedChild={isPairedChild}
            />
          );
        })()}
      </Carousel>
      {authOverlay}{nip55Overlay}
          {handoffPickerOverlay}
    </>
  );
  };

  return (
    <>
      <AppShell
        page={page}
        isDependantContext={!!activeDependant || preferences.signingMode === 'paired-child'}
        bunkerPanelOpen={bunkerPanelOpen}
        onNavigate={(target) => {
          void (async () => {
            if (target === 'contacts') setContactCardSearch('');
            if (target === 'contacts' && page === 'home' && !isPairedChild) {
              const current = carousel.activeIdentity;
              if (current.isDependant) {
                const key = await requestAuth({ purpose: 'manage-family-contacts' });
                if (!key) return;
                setActiveDependantId(current.dependantId ?? null);
              } else setActiveDependantId(null);
              setContactsIdentityChoice(current.publicKey || null);
            }
            navigateTo(target);
          })();
        }}
        onBunker={() => setBunkerPanelOpen(true)}
      >
        {renderPage()}
      </AppShell>
      {bunkerPanelOpen && !isBarHiddenPage(page) && (
        <BunkerPanel
          onClose={() => setBunkerPanelOpen(false)}
          bunkerAllowed={bunkerServerEnabled}
          onGoToSecurity={() => { setBunkerPanelOpen(false); navigateTo('settings-security'); }}
          stayAwakeUntil={stayAwakeUntil}
          onArmStayAwake={armStayAwake}
          onCloseStayAwake={closeStayAwake}
          wakeLockSupported={isWakeLockSupported()}
          pendingApprovals={bunkerPendingApprovals}
          onApproveOnce={bunkerApproveOnce}
          onApproveAlways={bunkerApproveAlways}
          onDeny={bunkerDeny}
          dependantNameFor={(depId) => (depId ? dependants.find((d) => d.id === depId)?.displayName : undefined)}
          hasDependants={hasDependantRoutes}
          serveStatus={bunkerServeStatus}
          locked={!encryptionKey}
          onRequestUnlockWithPendingArm={handleBunkerPendingArm}
          isNative={isNativeApp()}
          backgroundServing={backgroundServing}
          onSetBackgroundServing={handleSetBackgroundServing}
          escalationNotices={escalations.notices}
          onDismissEscalation={escalations.dismiss}
          resolveEscalationIdentityName={resolveEscalationIdentityName}
          onEscalationVerdict={handleEscalationVerdict}
          verdictAvailability={verdictAvailability}
        />
      )}
    </>
  );
}
