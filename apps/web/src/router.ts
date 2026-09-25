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
