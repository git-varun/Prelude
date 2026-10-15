import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode, type MutableRefObject } from "react";

// State of the patient screens' document pane (README "State"): collapsed by default, nothing persisted.
interface Selection {
  paneDocId: string | null;
  selectedFactId: string | null;
  /** A fact was clicked that has no document: the pane says so in plain words. */
  noDocument: boolean;
}

export interface PaneApi extends Selection {
  paneOpen: boolean;
  /** Bumped on every open, so the pane can move focus again when it is already open. */
  openSeq: number;
  /** What had focus when the pane opened; focus goes back there on close. */
  opener: MutableRefObject<HTMLElement | null>;
  openAtFact: (factId: string, documentId: string | null) => void;
  openDocument: (documentId: string) => void;
  /** Opens the pane on its tree, leaving the current selection alone. */
  openList: () => void;
  close: () => void;
}

const PaneContext = createContext<PaneApi | null>(null);

/** null outside a patient screen (extraction review, full-page source): callers fall back to their old link. */
export function usePane(): PaneApi | null {
  return useContext(PaneContext);
}

export function PaneProvider({ children }: { children: ReactNode }) {
  const [paneOpen, setPaneOpen] = useState(false);
  const [openSeq, setOpenSeq] = useState(0);
  const [selection, setSelection] = useState<Selection>({ paneDocId: null, selectedFactId: null, noDocument: false });
  const opener = useRef<HTMLElement | null>(null);

  const reveal = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !active.closest(".doc-pane")) opener.current = active;
    setPaneOpen(true);
    setOpenSeq((n) => n + 1);
  }, []);

  const api = useMemo<PaneApi>(
    () => ({
      paneOpen,
      openSeq,
      opener,
      ...selection,
      openAtFact: (factId, documentId) => {
        setSelection({ paneDocId: documentId, selectedFactId: factId, noDocument: documentId === null });
        reveal();
      },
      openDocument: (documentId) => {
        setSelection({ paneDocId: documentId, selectedFactId: null, noDocument: false });
        // Picking from the tree (pane already open) must not steal focus back to the header.
        if (!paneOpen) reveal();
      },
      openList: reveal,
      close: () => setPaneOpen(false),
    }),
    [paneOpen, openSeq, selection, reveal],
  );

  return <PaneContext.Provider value={api}>{children}</PaneContext.Provider>;
}
