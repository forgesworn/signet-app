import { buildBotOwnership, buildBotOwnershipRevocation, readBotOwnership, botOwnershipRenewalDue } from 'signet-protocol/experimental';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import { loadBotRegistry, updateBotRegistry, type BotRecord, type BotOwnershipState } from './bot-registry';
/** All signing uses the linked persona. Creation and first publication are
 * explicit UI actions; only renewal of an existing claim may run unattended. */
export class BotOwnershipService {
  constructor(private options: {
    root: string; encryptionKey: string; isCurrent(): boolean; onChanged(): void;
    sign(owner: string, event: UnsignedEvent): Promise<NostrEvent>;
    publish(event: NostrEvent): Promise<boolean>;
  }) {}
  private current() { if (!this.options.isCurrent()) throw new Error('Bot ownership session changed'); }
  private async bot(pubkey: string) {
    this.current();
    const bot = (await loadBotRegistry(this.options.root, this.options.encryptionKey)).bots.find(b => b.publicKey === pubkey && b.removedAt === undefined);
    this.current();
    if (!bot) throw new Error('Bot is unavailable');
    return bot;
  }
  private async update(bot: BotRecord, change: (state: BotOwnershipState | undefined) => BotOwnershipState, checkAttempt = false) {
    this.current();
    await updateBotRegistry(this.options.root, this.options.encryptionKey, value => {
      this.current();
      const current = value.bots.find(b => b.publicKey === bot.publicKey && b.removedAt === undefined);
      if (!current || current.ownerPersona !== bot.ownerPersona || current.ownership?.event.id !== bot.ownership?.event.id
        || (checkAttempt && current.ownership?.lastAttemptAt !== bot.ownership?.lastAttemptAt)) throw new Error('Bot ownership changed; try again');
      return { ...value, bots: value.bots.map(b => b.publicKey === bot.publicKey ? { ...b, ownership: change(b.ownership) } : b) };
    });
    this.options.onChanged();
  }
  async create(pubkey: string, now: number, days = 30) {
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('Choose one to ninety days');
    const bot = await this.bot(pubkey);
    await this.issue(bot, now, days, false);
  }
  private async issue(bot: BotRecord, now: number, days: number, revoked: boolean) {
    const issued = Math.max(now, (bot.ownership?.event.created_at ?? -1) + 1);
    if (issued > now + 300) throw new Error('Bot ownership clock is ahead; try later');
    const template = revoked ? buildBotOwnershipRevocation({ ownerPubkey: bot.ownerPersona, botPubkey: bot.publicKey, now: issued })
      : buildBotOwnership({ ownerPubkey: bot.ownerPersona, botPubkey: bot.publicKey, label: bot.label, now: issued, expiresAt: issued + days * 86400 });
    this.current();
    const event = await this.options.sign(bot.ownerPersona, template);
    this.current();
    const verified = await readBotOwnership(event, { ownerPubkey: bot.ownerPersona, botPubkey: bot.publicKey, now });
    if (verified.status === 'invalid' || event.created_at !== issued || event.content !== template.content
      || JSON.stringify(event.tags) !== JSON.stringify(template.tags)) throw new Error('Signer returned a different ownership event');
    await this.update(bot, old => ({ event, publishRequested: old?.publishRequested ?? false, lastAttemptAt: now }));
  }
  async requestPublication(pubkey: string, now: number) {
    const bot = await this.bot(pubkey);
    if (!bot.ownership || (await readBotOwnership(bot.ownership.event, { ownerPubkey: bot.ownerPersona, botPubkey: pubkey, now })).status === 'invalid') throw new Error('Create a valid ownership link first');
    await this.update(bot, state => ({ ...state!, publishRequested: true }));
  }
  async revoke(pubkey: string, now: number) { await this.issue(await this.bot(pubkey), now, 30, true); }
  async renew(pubkey: string, now: number) {
    const bot = await this.bot(pubkey), state = bot.ownership;
    if (!state) return;
    const result = await readBotOwnership(state.event, { ownerPubkey: bot.ownerPersona, botPubkey: pubkey, now });
    if (!botOwnershipRenewalDue(result, now, state.lastAttemptAt)) return;
    // Persist the daily retry throttle before asking hardware to sign.
    await this.update(bot, old => ({ ...old!, lastAttemptAt: now }), true);
    const lifetime = Number(state.event.tags.find(t => t[0] === 'valid_to')?.[1]) - state.event.created_at;
    const days = Math.min(90, Math.max(1, Math.floor(lifetime / 86400)));
    await this.issue(await this.bot(pubkey), now, days, false);
  }
  async flush(now: number) {
    const state = await loadBotRegistry(this.options.root, this.options.encryptionKey);
    for (const row of state.bots) {
      this.current();
      // Removal never creates a new disclosure. Existing publication is kept
      // in the registry for audit; revoke before removing a public link.
      if (row.removedAt !== undefined) continue;
      const bot = await this.bot(row.publicKey), claim = bot.ownership;
      if (!claim?.publishRequested || claim.publishedEventId === claim.event.id) continue;
      const result = await readBotOwnership(claim.event, { ownerPubkey: bot.ownerPersona, botPubkey: bot.publicKey, now });
      if (result.status !== 'valid' && result.status !== 'revoked') continue;
      this.current();
      if (await this.options.publish(claim.event)) {
        await this.update(bot, current => ({ ...current!, publishedEventId: claim.event.id }));
      }
    }
  }
}
