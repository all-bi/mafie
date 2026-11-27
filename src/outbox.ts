import { DurableObject } from 'cloudflare:workers';
import { sendJobs, type PushEnv, type PushJob } from './push';

/** Zpráv na jedno spuštění alarmu (~0,8 ms CPU na zprávu, limit 10 ms). */
const CHUNK = 6;
const KEY_PREFIX = 'job:';

/**
 * Fronta upozornění jedné hry. Hromadné zprávy (např. začátek hry pro 50 hráčů)
 * se nevejdou do CPU limitu jednoho požadavku, proto je Durable Object uloží
 * a rozešle po dávkách. Každé spuštění alarmu je samostatná událost s vlastním
 * limitem CPU. Používá úložiště SQLite, které je dostupné na free plánu.
 */
export class PushOutbox extends DurableObject<PushEnv> {
  async enqueue(jobs: PushJob[]): Promise<void> {
    let seq = (await this.ctx.storage.get<number>('seq')) ?? 0;
    for (let start = 0; start < jobs.length; start += 100) {
      const entries: Record<string, unknown> = {};
      for (const job of jobs.slice(start, start + 100)) {
        entries[`${KEY_PREFIX}${String(seq++).padStart(12, '0')}`] = job;
      }
      entries.seq = seq;
      await this.ctx.storage.put(entries);
    }
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const batch = await this.ctx.storage.list<PushJob>({ prefix: KEY_PREFIX, limit: CHUNK });
    if (batch.size) {
      // Nejdřív smazat, ať se při opakování alarmu zprávy neposílají dvakrát.
      await this.ctx.storage.delete([...batch.keys()]);
      await sendJobs(this.env, [...batch.values()]);
    }
    const more = await this.ctx.storage.list({ prefix: KEY_PREFIX, limit: 1 });
    if (more.size) await this.ctx.storage.setAlarm(Date.now() + 50);
  }
}
