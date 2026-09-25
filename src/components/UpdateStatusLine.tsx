import { ANDROID_APP_URL } from '../lib/android-promo';
import { useAppUpdate } from '../hooks/useAppUpdate';

/**
 * One line reporting "is this build current?" APK: compares the installed
 * versionCode with the published manifest (checked itself, via
 * `useAppUpdate()`, only while this component is mounted — i.e. only while a
 * Settings About block is on screen). Web: reflects the service worker's
 * "new build waiting" flag, passed in by the caller. Every wording here is
 * one the evidence supports — "couldn't check" is not "out of date".
 *
 * `webUpdateReady` left `undefined` means the caller didn't opt into a web
 * status line at all (e.g. a secondary About block) — renders nothing on
 * the web. Native rendering is unaffected either way.
 */
export function UpdateStatusLine({ webUpdateReady, onApplyWebUpdate }: {
  webUpdateReady?: boolean;
  onApplyWebUpdate?: () => void;
}) {
  const appUpdate = useAppUpdate();
  const linkStyle = { color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' } as const;
  const kind = appUpdate.kind;

  if (kind === 'not-native') {
    if (webUpdateReady === undefined) return null;
    if (!webUpdateReady) return <div>You're on the latest version</div>;
    return (
      <div>
        A new version is ready —{' '}
        <span role="button" style={linkStyle} onClick={onApplyWebUpdate}>Update</span>
      </div>
    );
  }
  if (kind === 'checking') return <div>Checking for updates…</div>;
  if (kind === 'unreadable' || kind === 'unknown') return <div>Couldn't check for updates</div>;
  if (kind === 'current') return <div>You're on the latest version</div>;
  if (appUpdate.kind !== 'behind') return null;
  return (
    <div>
      v{appUpdate.latest.versionName} is available —{' '}
      <span
        role="button"
        style={linkStyle}
        onClick={() => window.open(ANDROID_APP_URL, '_blank', 'noopener')}
      >
        Get it
      </span>
    </div>
  );
}
