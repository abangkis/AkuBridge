export type EvidenceOwner = "primary" | "quote" | "other" | "unknown";

export interface CardCandidate<Root = Element> {
  /** A reference scoped to one sample. It does not establish a native post ID. */
  readonly ref: string;
  readonly root: Root;
  readonly visible: boolean;
}

export interface CardEvidence {
  readonly ref: string;
  readonly visible: boolean;
  readonly layout: string | null;
  readonly probeFailed?: boolean;
  readonly identityClaims: readonly {
    readonly key: string;
    readonly locator?: string;
    readonly owner: EvidenceOwner;
    readonly provenance: string;
  }[];
  readonly fields: readonly {
    readonly name: string;
    readonly owner: EvidenceOwner;
    readonly availability: "present" | "absent" | "unknown";
    readonly identityKey?: string;
  }[];
}

/** Browser adapter port. Pass CardEvidence to assessDOM with the source policy. */
export interface CardDOMAdapter<DiscoveryContext, EvidenceContext, Root = Element> {
  discoverCandidates(context: DiscoveryContext): { readonly candidates: readonly Root[] };
  readCardEvidence(card: CardCandidate<Root>, context: EvidenceContext): CardEvidence;
}
