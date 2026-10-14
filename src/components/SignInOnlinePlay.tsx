import type { SignInAppPermission } from '../lib/sign-in-app-permission';
import { APP_PERMISSION_COPY } from '../lib/app-permission-copy';

export function SignInOnlinePlay({ request, appName, personaName, enabled, onChange, disabled }: {
  request: SignInAppPermission; appName: string; personaName: string;
  enabled: boolean; onChange(value: boolean): void; disabled: boolean;
}) {
  const until = new Date(request.validUntil * 1000).toLocaleDateString();
  return <section className="card section" data-testid="sign-in-online-play">
    <h3 style={{ marginBottom: 12 }}>Online play</h3>
    <p style={{ marginBottom: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
      {APP_PERMISSION_COPY.allowsAdult(appName, personaName, until)}
    </p>
    <p style={{ fontSize: '.85rem', marginBottom: 12 }}><strong>{APP_PERMISSION_COPY.appSaysLabel}</strong> {request.reason}</p>
    <label style={{ display: 'flex', gap: 12, alignItems: 'center', minHeight: 44 }}>
      <input type="checkbox" checked={enabled} onChange={e => onChange(e.target.checked)} disabled={disabled} />
      Enable online play for this app
    </label>
  </section>;
}
