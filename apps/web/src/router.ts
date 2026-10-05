import { useEffect, useState } from "react";

// Deliberately minimal hash router — M1 has four screens total; a routing
// library is unwarranted until the screen count actually grows (M4+).
export function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || "/login");

  useEffect(() => {
    const onChange = () => setHash(window.location.hash.slice(1) || "/login");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return hash;
}

export function navigate(path: string) {
  window.location.hash = path;
}

export function matchPatientUpload(path: string): string | null {
  const m = path.match(/^\/patients\/([^/]+)\/upload$/);
  return m ? m[1]! : null;
}

export function matchDocumentReview(path: string): string | null {
  const m = path.match(/^\/documents\/([^/]+)\/review$/);
  return m ? m[1]! : null;
}

export function matchPatientSnapshot(path: string): string | null {
  const m = path.match(/^\/patients\/([^/]+)\/snapshot$/);
  return m ? m[1]! : null;
}

// Hash routes carry their query string too (everything after '#' is one string), so the
// ?fact= param is parsed out here rather than relying on window.location.search.
export function matchDocumentSource(path: string): { documentId: string; factId: string } | null {
  const [pathname, query] = path.split("?");
  const m = pathname!.match(/^\/documents\/([^/]+)\/source$/);
  if (!m) return null;
  const factId = new URLSearchParams(query ?? "").get("fact");
  if (!factId) return null;
  return { documentId: m[1]!, factId };
}
