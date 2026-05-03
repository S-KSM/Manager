/**
 * In-memory store for LLM-generated activity headlines, one per workstream.
 *
 * A headline is a single-sentence, present-tense summary of what the agent is
 * currently doing — generated from the recent event log by the Headliner
 * background ticker. The HTTP layer reads this in `serializeWorkstream` and
 * surfaces it as `activity_headline` so the macOS client can show a
 * human-readable "Currently:" line that beats the raw `latest_activity`
 * heuristic ("Editing /foo/bar.ts").
 *
 * Not persisted: on daemon restart the store is empty and the ticker
 * regenerates headlines on its next pass. Cheaper than a SQLite column for v1.
 */
export interface Headline {
  text: string;
  generatedAt: string;
  /** Snapshot of `events.length` at generation time — used to skip regen when no new events arrived. */
  lastEventCount: number;
}

export class HeadlineStore {
  private readonly map = new Map<string, Headline>();

  get(workstreamId: string): Headline | undefined {
    return this.map.get(workstreamId);
  }

  set(workstreamId: string, headline: Headline): void {
    this.map.set(workstreamId, headline);
  }

  delete(workstreamId: string): void {
    this.map.delete(workstreamId);
  }

  clear(): void {
    this.map.clear();
  }
}
