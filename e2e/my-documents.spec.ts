/**
 * Playwright tests for the MyDocuments page beyond the empty-state case.
 *
 * The empty-state test already lives in harness-pages.spec.ts and is not
 * duplicated here.
 *
 * onAddDocument and onSelectDocument are both no-ops in App.tsx (the page
 * renders as a read-only list). Documents are therefore seeded through the
 * DEV harness's `seedIdentityDocument`, which writes through the app's
 * encrypted `saveDocument` (documents are encrypted at rest, so a raw
 * IndexedDB put of plaintext fields is unreadable), then the app is reloaded
 * and unlocked so that useDocuments re-loads from the store.
 *
 * My Documents belongs to the real identity, which starts dormant: the route
 * shows the activation gate until the real identity is activated.
 */

import { test, expect } from '@playwright/test';
import { activateRealIdentity, createIdentityAndUnlock, clearDatabase, navigateViaHarness, unlockAfterReload } from './fixtures';

type SeedDocument = {
  id: string;
  /** Omit for the real identity's own pubkey (what the page lists). */
  ownerPubkey?: string;
  country: string;
  documentType: string;
  fullName: string;
  dateOfBirth: string;
  documentNumber: string;
};

// ---------------------------------------------------------------------------
// Helper: write one or more documents through the app's encrypted writer, then
// reload and unlock so useDocuments picks them up.
// ---------------------------------------------------------------------------
async function injectDocuments(page: import('@playwright/test').Page, docs: SeedDocument[]) {
  for (const doc of docs) {
    await page.evaluate((record) => (window as any).__TEST__.seedIdentityDocument(record), doc);
  }
  await page.reload();
  await unlockAfterReload(page);
  await page.locator('.carousel-viewport, div[role="main"]').first().waitFor({ state: 'visible', timeout: 60_000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test.describe('MyDocuments — with documents present', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
    await navigateViaHarness(page, 'my-documents');
    await activateRealIdentity(page);
  });

  test('displays a single passport in the list', async ({ page }) => {
    await injectDocuments(page, [
      {
        id: 'doc-pp-001',
        country: 'GB',
        documentType: 'passport',
        fullName: 'Alice Example',
        dateOfBirth: '1990-01-15',
        documentNumber: 'GB123456789',
      },
    ]);

    // Navigate away then back so useDocuments re-runs
    await navigateViaHarness(page, 'home');
    await navigateViaHarness(page, 'my-documents');

    // Section heading present
    await expect(page.getByRole('heading', { name: 'My Documents' })).toBeVisible();

    // Document type label
    await expect(page.getByText('Passport')).toBeVisible();

    // Owner name
    await expect(page.getByText('Alice Example')).toBeVisible();

    // Document number is masked — only last 4 digits visible
    await expect(page.getByText('•••• 6789')).toBeVisible();

    // Country code
    await expect(page.getByText('GB')).toBeVisible();

    // Icon abbreviation
    await expect(page.getByText('PP')).toBeVisible();
  });

  test('displays the correct icon abbreviations for each document type', async ({ page }) => {
    await injectDocuments(page, [
      {
        id: 'doc-pp-002',
        country: 'GB',
        documentType: 'passport',
        fullName: 'Bob Smith',
        dateOfBirth: '1985-06-01',
        documentNumber: 'GB000000001',
      },
      {
        id: 'doc-dl-001',
        country: 'GB',
        documentType: 'driving_licence',
        fullName: 'Bob Smith',
        dateOfBirth: '1985-06-01',
        documentNumber: 'SMITH85060199999',
      },
      {
        id: 'doc-id-001',
        country: 'DE',
        documentType: 'national_id',
        fullName: 'Bob Schmidt',
        dateOfBirth: '1985-06-01',
        documentNumber: 'DE123456',
      },
      {
        id: 'doc-bc-001',
        country: 'GB',
        documentType: 'birth_certificate',
        fullName: 'Baby Jones',
        dateOfBirth: '2010-03-22',
        documentNumber: 'BC000001',
      },
    ]);

    await navigateViaHarness(page, 'home');
    await navigateViaHarness(page, 'my-documents');

    await expect(page.getByText('PP')).toBeVisible();
    await expect(page.getByText('DL')).toBeVisible();
    await expect(page.getByRole('button', { name: /ID National ID Bob Schmidt/ })).toBeVisible();
    await expect(page.getByText('BC')).toBeVisible();
  });

  test('displays the correct human-readable label for each document type', async ({ page }) => {
    await injectDocuments(page, [
      {
        id: 'doc-label-pp',
        country: 'GB',
        documentType: 'passport',
        fullName: 'Carol Test',
        dateOfBirth: '1992-07-10',
        documentNumber: 'PP99887766',
      },
      {
        id: 'doc-label-dl',
        country: 'GB',
        documentType: 'driving_licence',
        fullName: 'Carol Test',
        dateOfBirth: '1992-07-10',
        documentNumber: 'CAROL921001234',
      },
    ]);

    await navigateViaHarness(page, 'home');
    await navigateViaHarness(page, 'my-documents');

    await expect(page.getByText('Passport')).toBeVisible();
    await expect(page.getByText('Driving Licence')).toBeVisible();
  });

  test('masks document number showing only last 4 digits', async ({ page }) => {
    await injectDocuments(page, [
      {
        id: 'doc-mask-001',
        country: 'FR',
        documentType: 'national_id',
        fullName: 'Denis Dupont',
        dateOfBirth: '1980-11-23',
        documentNumber: 'ABCDEF1234',
      },
    ]);

    await navigateViaHarness(page, 'home');
    await navigateViaHarness(page, 'my-documents');

    // Full number should not appear verbatim
    await expect(page.getByText('ABCDEF1234')).not.toBeVisible();

    // Masked form should appear
    await expect(page.getByText('•••• 1234')).toBeVisible();
  });

  test('short document number (4 chars or fewer) is shown unmasked', async ({ page }) => {
    await injectDocuments(page, [
      {
        id: 'doc-short-001',
        country: 'US',
        documentType: 'national_id',
        fullName: 'Eve Short',
        dateOfBirth: '1995-04-05',
        documentNumber: 'A123',
      },
    ]);

    await navigateViaHarness(page, 'home');
    await navigateViaHarness(page, 'my-documents');

    // Number is 4 chars, should not be masked
    await expect(page.getByText('A123')).toBeVisible();
  });

  test('multiple documents are all rendered in the list', async ({ page }) => {
    await injectDocuments(page, [
      {
        id: 'doc-multi-1',
        country: 'GB',
        documentType: 'passport',
        fullName: 'Frank Alpha',
        dateOfBirth: '1978-03-14',
        documentNumber: 'PASS001001',
      },
      {
        id: 'doc-multi-2',
        country: 'IE',
        documentType: 'driving_licence',
        fullName: 'Frank Alpha',
        dateOfBirth: '1978-03-14',
        documentNumber: 'DL00200200',
      },
    ]);

    await navigateViaHarness(page, 'home');
    await navigateViaHarness(page, 'my-documents');

    // Both entries should be in the list
    await expect(page.getByText('Passport')).toBeVisible();
    await expect(page.getByText('Driving Licence')).toBeVisible();
    await expect(page.getByText('GB')).toBeVisible();
    await expect(page.getByText('IE')).toBeVisible();

    // "Add another document" secondary button should appear (replaces empty-state CTA)
    await expect(page.getByRole('button', { name: 'Add another document' })).toBeVisible();
  });

  test('"Add another document" button is present in non-empty state', async ({ page }) => {
    await injectDocuments(page, [
      {
        id: 'doc-add-btn-001',
        country: 'AU',
        documentType: 'passport',
        fullName: 'Grace Hopper',
        dateOfBirth: '1906-12-09',
        documentNumber: 'AU0000001',
      },
    ]);

    await navigateViaHarness(page, 'home');
    await navigateViaHarness(page, 'my-documents');

    await expect(page.getByRole('button', { name: 'Add another document' })).toBeVisible();

    // The primary empty-state CTA ("Add a document") should not appear here
    await expect(page.getByRole('button', { name: 'Add a document' })).not.toBeVisible();
  });

  test('documents from a different owner pubkey are not shown', async ({ page }) => {
    await injectDocuments(page, [
      // Correct owner
      {
        id: 'doc-owner-match',
        country: 'GB',
        documentType: 'passport',
        fullName: 'Correct Owner',
        dateOfBirth: '2000-01-01',
        documentNumber: 'CORRECT0001',
      },
      // Wrong owner (different pubkey)
      {
        id: 'doc-owner-other',
        ownerPubkey: 'a'.repeat(64),
        country: 'US',
        documentType: 'national_id',
        fullName: 'Other Person',
        dateOfBirth: '1999-12-31',
        documentNumber: 'OTHER00001',
      },
    ]);

    await navigateViaHarness(page, 'home');
    await navigateViaHarness(page, 'my-documents');

    // Only the matching owner's document should appear
    await expect(page.getByText('Correct Owner')).toBeVisible();
    await expect(page.getByText('Other Person')).not.toBeVisible();
  });
});
