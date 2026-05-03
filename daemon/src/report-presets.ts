/**
 * Built-in audience presets for report generation. Each preset bundles a
 * human-readable name, a one-line description for the UI dropdown, and the
 * `system_prompt` that frames the LLM's output for that audience.
 *
 * Free-text audience override: when the caller passes a non-empty
 * `audience_freetext`, `resolveSystemPrompt` ignores the preset and returns the
 * generic override prompt. The override always wins.
 */
export interface ReportPreset {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
}

export const PRESETS: ReportPreset[] = [
  {
    id: 'executive',
    name: 'Executive',
    description: 'Senior leader, outcomes-first',
    system_prompt:
      "You write a weekly executive summary for a busy senior leader. Lead with outcomes and risks, not activity. Use 5-7 tight bullets. Quantify when possible. Skip implementation detail unless it explains a risk. End with one line of 'what's next'.",
  },
  {
    id: 'business_partner',
    name: 'Business partner',
    description: 'Partner needing commitments + asks',
    system_prompt:
      "You write an update for a business partner who cares about commitments and timelines. Focus on shipped/in-flight commitments and any blockers needing their action. Use plain language. Call out asks explicitly under a final 'Asks' bullet block.",
  },
  {
    id: 'engineer_peer',
    name: 'Engineer peer',
    description: 'Adjacent engineer learning the method',
    system_prompt:
      'You write a peer technical update for engineers on adjacent teams. Include the methodology — what was tried, why a particular path was chosen, what was learned. Cross-pollination matters more than completeness; surface the two or three sharpest lessons.',
  },
  {
    id: 'sponsor',
    name: 'Sponsor / investor',
    description: 'Investor wanting traction signals',
    system_prompt:
      'You write a status update for an investor or program sponsor. Lead with traction signals, deliverables landed, and risks/asks. Keep tone confident and crisp. No engineering jargon unless it materially explains a risk.',
  },
];

const FREETEXT_TEMPLATE = (freetext: string): string =>
  `You write an update for: ${freetext}. Adapt the structure and tone to suit. Be concrete and avoid filler.`;

/**
 * Pick the system prompt for a generation. Free-text override (when non-empty)
 * always wins over the preset. Returns null when neither is provided so the
 * caller can decide whether to fail validation or fall back to a default.
 */
export function resolveSystemPrompt(opts: {
  preset_id?: string | null;
  freetext?: string | null;
}): string | null {
  if (opts.freetext && opts.freetext.trim().length > 0) {
    return FREETEXT_TEMPLATE(opts.freetext.trim());
  }
  if (opts.preset_id) {
    const found = PRESETS.find((p) => p.id === opts.preset_id);
    if (found) return found.system_prompt;
  }
  return null;
}

export function getPreset(id: string): ReportPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}
