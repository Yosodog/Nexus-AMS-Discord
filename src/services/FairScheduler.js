/**
 * Deficit round-robin over connection ids. The scheduler contains no tenant
 * data and never owns the remote queue; it only decides which connection gets
 * the next claim opportunity.
 */
export class FairScheduler {
  constructor({ quantum = 1, maxDeficit = 32, clock = Date.now } = {}) {
    this.quantum = Math.max(1, Number(quantum) || 1);
    this.maxDeficit = Math.max(this.quantum, Number(maxDeficit) || 32);
    this.clock = clock;
    this.entries = new Map();
    this.cursor = 0;
  }

  register(connectionId, { weight = 1 } = {}) {
    const id = `${connectionId ?? ''}`.trim().toLowerCase();
    if (!id) throw new TypeError('Fair scheduler requires a connection id.');
    const normalizedWeight = Math.max(1, Math.min(16, Number(weight) || 1));
    const existing = this.entries.get(id);
    this.entries.set(id, {
      weight: normalizedWeight,
      deficit: existing?.deficit ?? 0,
      lastSelectedAt: existing?.lastSelectedAt ?? null,
    });
    return id;
  }

  unregister(connectionId) {
    const id = `${connectionId ?? ''}`.trim().toLowerCase();
    return this.entries.delete(id);
  }

  reset() {
    this.entries.clear();
    this.cursor = 0;
  }

  /** Returns the next eligible id and charges one claim opportunity. */
  next(availableConnectionIds = []) {
    const available = [...new Set(availableConnectionIds.map((id) => `${id}`.trim().toLowerCase()))]
      .filter((id) => id && this.entries.has(id));
    if (available.length === 0) return null;

    const ordered = [...this.entries.keys()];
    if (ordered.length === 0) return null;
    const start = this.cursor % ordered.length;

    for (let pass = 0; pass < 2; pass += 1) {
      for (let offset = 0; offset < ordered.length; offset += 1) {
        const index = (start + offset) % ordered.length;
        const id = ordered[index];
        const entry = this.entries.get(id);
        if (pass === 0) {
          entry.deficit = Math.min(this.maxDeficit, entry.deficit + this.quantum * entry.weight);
        }
        if (!available.includes(id) || entry.deficit < 1) continue;
        entry.deficit -= 1;
        entry.lastSelectedAt = this.clock();
        this.cursor = (index + 1) % ordered.length;
        return id;
      }
    }

    // A connection can become available after the first pass; give the first
    // available connection one bounded opportunity rather than spinning.
    const fallback = available[0];
    const entry = this.entries.get(fallback);
    entry.deficit = Math.max(0, entry.deficit - 1);
    entry.lastSelectedAt = this.clock();
    this.cursor = (ordered.indexOf(fallback) + 1) % ordered.length;
    return fallback;
  }

  snapshot() {
    return [...this.entries.entries()].map(([connectionId, entry]) => ({
      connection_id: connectionId,
      weight: entry.weight,
      deficit: entry.deficit,
      last_selected_at: entry.lastSelectedAt,
    }));
  }
}

export class ConnectionRoundRobin extends FairScheduler {}
