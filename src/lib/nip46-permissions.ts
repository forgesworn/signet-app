/** Requested NIP-46 permissions constrain a connection; they are never consent
 * to sign a particular statement. An absent list preserves legacy behaviour. */
export function parseNip46Permissions(raw: string): string[] | null {
  if (!raw || raw.length > 1024) return null;
  const tokens = raw.split(',');
  if (tokens.length > 32) return null;
  const methods = ['get_public_key', 'sign_event', 'nip04_encrypt', 'nip04_decrypt', 'nip44_encrypt', 'nip44_decrypt'];
  if (tokens.some(t => {
    const [method, kind, ...extra] = t.split(':');
    if (!methods.includes(method) || extra.length) return true;
    if (kind === undefined) return false;
    return method !== 'sign_event' || !/^(0|[1-9]\d{0,4})$/.test(kind) || Number(kind) > 65535;
  })) return null;
  return [...new Set(tokens)];
}

export function nip46PermissionAllows(permissions: string[] | undefined, method: string, kind?: number): boolean {
  if (permissions === undefined) return true;
  // Corrupted persisted scopes fail closed.
  if (!Array.isArray(permissions) || !permissions.length || permissions.some(p => typeof p !== 'string')
    || !parseNip46Permissions(permissions.join(','))) return false;
  if (['connect', 'ping', 'logout', 'switch_relays', 'get_public_key'].includes(method)) return true;
  if (method === 'sign_event' && (!Number.isInteger(kind) || kind! < 0 || kind! > 65535)) return false;
  return permissions.includes(method) || (method === 'sign_event' && permissions.includes(`sign_event:${kind}`));
}
