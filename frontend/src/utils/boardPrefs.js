// Shared by every page that renders a <Chessboard> (Game, PlayComputer,
// BoardEditor, Puzzles, Study, Live, etc). Keeping this in one place means
// a board theme/color saved on Profile applies everywhere instead of only
// wherever someone remembered to copy-paste the lookup.

// Maps the "Board color" choice saved on the Profile page to actual square
// colors. "default" falls back to the existing CSS variables so a user who
// never touches the setting sees exactly the same board as before.
export const BOARD_COLOR_PALETTES = {
  default: { dark: "var(--sq-dark)", light: "var(--sq-light)" },
  blue: { dark: "#4a6fa5", light: "#dbe6f3" },
  green: { dark: "#6f9b5c", light: "#eaf3e3" },
  purple: { dark: "#7d5ba6", light: "#e8ddf3" },
  brown: { dark: "#8b5e34", light: "#e8d9c3" },
};

// Maps the "Board theme" choice to the board's chrome (corners/shadow).
export const BOARD_THEME_STYLES = {
  classic: { borderRadius: "12px", boxShadow: "var(--shadow-md)" },
  wood: { borderRadius: "6px", boxShadow: "0 8px 24px rgba(101, 67, 33, 0.35)" },
  glass: { borderRadius: "18px", boxShadow: "0 8px 32px rgba(120, 180, 255, 0.25)" },
  modern: { borderRadius: "0px", boxShadow: "0 4px 16px rgba(0, 0, 0, 0.4)" },
};

// Resolves a user object's saved board preference into the palette/theme
// objects above, with safe fallbacks to "default"/"classic" for users who
// never set a preference (or a spectated opponent whose object shape differs).
export function resolveBoardPrefs(user) {
  const boardPrefs = user?.board_preferences || user?.challenge_preferences?.board_preferences || {};
  const boardSquareColors = BOARD_COLOR_PALETTES[boardPrefs.color] || BOARD_COLOR_PALETTES.default;
  const boardThemeStyle = BOARD_THEME_STYLES[boardPrefs.theme] || BOARD_THEME_STYLES.classic;
  return {
    theme: boardPrefs.theme || "classic",
    color: boardPrefs.color || "default",
    boardSquareColors,
    boardThemeStyle,
  };
}
