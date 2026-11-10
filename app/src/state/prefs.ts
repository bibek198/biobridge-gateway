import { useEffect, useState } from "react";

// Per-browser UI preferences (theme, collapsed sidebar). Storage may be unavailable; the UI must work anyway.

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode or blocked storage: keep the in-memory value */
  }
}

export type Theme = "light" | "dark";

export function usePref<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const v = read(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  });
  return [
    value,
    (v: T) => {
      write(key, v);
      setValue(v);
    },
  ];
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = usePref<Theme>("biobridge.theme", "light", ["light", "dark"]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return [theme, setTheme];
}
