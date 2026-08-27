import { createContext, useContext, useEffect, useState, useCallback } from "react";

const ThemeContext = createContext(null);
// Bumped to -v2 so browsers that stored "light" under the old key (back when
// the default followed the OS) start fresh on the dark default instead.
const STORAGE_KEY = "outpla-theme-v2";

function getInitialTheme() {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  // Dark is the product default. We deliberately do NOT follow the OS
  // preference — a light-mode machine shouldn't silently flip the brand.
  // Once the person uses the toggle their choice is stored and always wins.
  return "dark";
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
};
