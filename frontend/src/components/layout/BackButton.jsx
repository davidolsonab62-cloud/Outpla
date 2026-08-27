import { useNavigate, useLocation } from "react-router-dom";
import { navigateBack } from "@/utils/navigation";

/**
 * Single source of truth for back navigation. Renders nothing on /lobby
 * (the app's home route — no back control needed there). Icon-only,
 * styled consistently with other icon buttons in the app.
 */
export default function BackButton({ className = "" }) {
  const navigate = useNavigate();
  const location = useLocation();

  if (location.pathname === "/lobby") return null;

  return (
    <button
      onClick={() => navigateBack(navigate, "/lobby")}
      aria-label="Go back"
      title="Back"
      className={`flex h-9 w-9 items-center justify-center rounded-lg sc-icon-btn ${className}`}
      style={{ color: "var(--text-secondary)" }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="19" y1="12" x2="5" y2="12" />
        <polyline points="12 19 5 12 12 5" />
      </svg>
    </button>
  );
}
