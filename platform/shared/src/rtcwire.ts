// ============================================================================
// P2P SIGNALING WIRE (docs/PLATFORM.md §12.6 P1→P2) — the opaque payload
// shapes two peers exchange THROUGH the platform's rtc_signal relay. The
// server is content-blind: these types exist only so both SDK sides agree.
// ============================================================================
/** Candidate init shape relayed verbatim (addIceCandidate needs mid/line). */
export interface CandInit {
  readonly candidate: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
  readonly usernameFragment?: string | null;
}

/** SDP/ICE envelope carried inside {t:'rtc_signal', data}. */
export type RtcSignalPayload =
  | { readonly v: 1; readonly kind: 'offer'; readonly sdp: string }
  | { readonly v: 1; readonly kind: 'answer'; readonly sdp: string }
  | { readonly v: 1; readonly kind: 'ice'; readonly cand: CandInit };

export function isRtcSignalPayload(v: unknown): v is RtcSignalPayload {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  if (p.v !== 1) return false;
  if (p.kind === 'offer' || p.kind === 'answer') return typeof p.sdp === 'string' && p.sdp.length > 0;
  if (p.kind === 'ice') {
    if (typeof p.cand !== 'object' || p.cand === null) return false;
    return typeof (p.cand as CandInit).candidate === 'string' && (p.cand as CandInit).candidate.length > 0;
  }
  return false;
}
