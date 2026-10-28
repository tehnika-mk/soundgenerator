/**
 * Metronome reference data: the traditional Italian tempo terms and the
 * subdivision grid. Kept in one place so the page table and the live readout
 * can never disagree.
 */

export type TempoTerm = {
  min: number;
  max: number;
  name: string;
  detail: string;
};

/** Italian tempo terms mapped to BPM ranges (the ranges commonly used in practice). */
export const TEMPO_TERMS: TempoTerm[] = [
  { min: 20, max: 24, name: 'Larghissimo', detail: 'Extremely slow' },
  { min: 25, max: 45, name: 'Grave', detail: 'Slow and solemn' },
  { min: 46, max: 59, name: 'Largo', detail: 'Broad, very slow' },
  { min: 60, max: 65, name: 'Larghetto', detail: 'Slightly faster than largo' },
  { min: 66, max: 75, name: 'Adagio', detail: 'Slow, at ease' },
  { min: 76, max: 107, name: 'Andante', detail: 'Walking pace' },
  { min: 108, max: 119, name: 'Moderato', detail: 'Moderate' },
  { min: 120, max: 155, name: 'Allegro', detail: 'Fast and bright' },
  { min: 156, max: 175, name: 'Vivace', detail: 'Lively and fast' },
  { min: 176, max: 199, name: 'Presto', detail: 'Very fast' },
  { min: 200, max: 300, name: 'Prestissimo', detail: 'As fast as possible' },
];

export function tempoTerm(bpm: number): TempoTerm {
  const term = TEMPO_TERMS.find((t) => bpm >= t.min && bpm <= t.max);
  return term ?? TEMPO_TERMS[TEMPO_TERMS.length - 1];
}

export type Subdivision = {
  id: 'quarter' | 'eighth' | 'triplet' | 'sixteenth';
  label: string;
  /** Clicks per beat. */
  perBeat: number;
  /** Pitch of the off-beat clicks, in Hz. */
  pitch: number;
};

export const SUBDIVISIONS: Subdivision[] = [
  { id: 'quarter', label: 'Quarter', perBeat: 1, pitch: 0 },
  { id: 'eighth', label: 'Eighth', perBeat: 2, pitch: 880 },
  { id: 'triplet', label: 'Triplet', perBeat: 3, pitch: 780 },
  { id: 'sixteenth', label: 'Sixteenth', perBeat: 4, pitch: 660 },
];

export function subdivisionById(id: string): Subdivision {
  return SUBDIVISIONS.find((s) => s.id === id) ?? SUBDIVISIONS[0];
}
