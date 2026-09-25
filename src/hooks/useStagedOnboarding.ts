import { useState } from 'react';
import { parseRestoreInput, RESTORE_ERROR_COPY } from '../lib/recovery-words';

export type StagedOnboardingStage =
  | 'choice'
  | 'returning'
  | 'first-ever'
  | 'enter-phrase'
  | 'first-ever-name';

interface Options {
  onCreate: (displayName: string, primaryKeypair: 'natural-person' | 'persona', isChild: boolean) => Promise<void>;
  onImport: (mnemonic: string, displayName: string, primaryKeypair: 'natural-person' | 'persona', isChild: boolean) => Promise<void>;
}

export function useStagedOnboarding({ onCreate, onImport }: Options) {
  const [stage, setStage] = useState<StagedOnboardingStage>('choice');
  const [phrase, setPhrase] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Explicit user choice, never sniffed from the word count: the default box
  // takes ForgeSworn recovery words, the toggle takes a pre-envelope 12-word
  // BIP-39 backup.
  const [legacyMode, setLegacyMode] = useState(false);

  const goBack = () => {
    setError(null);
    setStage('choice');
  };

  // Combined handler (mirrors goBack's error-clearing pattern): flipping modes
  // must not leave a stale error from the other mode's validation on screen.
  const toggleLegacyMode = () => {
    setError(null);
    setLegacyMode(v => !v);
  };

  const handleImportSubmit = async () => {
    setError(null);
    const parsed = parseRestoreInput(phrase, legacyMode ? 'legacy-bip39' : 'recovery-words');
    if (!parsed.ok) {
      setError(
        parsed.reason === 'legacy-invalid'
          ? 'That phrase doesn\u2019t look right — check the spelling and word order.'
          : RESTORE_ERROR_COPY[parsed.reason],
      );
      return;
    }
    const mnemonic = parsed.mnemonic;
    const name = displayName.trim();
    if (!name) {
      setError('Please give this identity a display name.');
      return;
    }
    setBusy(true);
    try {
      await onImport(mnemonic, name, 'natural-person', false);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : 'Could not restore that Signet — please try again.');
    }
  };

  const handleCreateSubmit = async () => {
    setError(null);
    const name = displayName.trim();
    if (!name) {
      setError('Please give your Signet a display name.');
      return;
    }
    setBusy(true);
    try {
      await onCreate(name, 'natural-person', false);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : 'Could not create your Signet — please try again.');
    }
  };

  return {
    stage, setStage,
    phrase, setPhrase,
    displayName, setDisplayName,
    acknowledged, setAcknowledged,
    legacyMode,
    toggleLegacyMode,
    busy,
    error,
    goBack,
    handleImportSubmit,
    handleCreateSubmit,
  };
}
