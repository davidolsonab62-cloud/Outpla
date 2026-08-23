import { useState, useEffect, useRef } from "react";
import { useLocation, useOutlet, Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Wallet, Coins } from "lucide-react";
import Sidebar from "@/components/layout/Sidebar";
import { useTheme } from "@/context/ThemeContext";
import { useAuth } from "@/App";

const STORAGE_KEY = "stakechess-sidebar-collapsed";

// Matches Tailwind's `lg` breakpoint used for the sidebar's fixed/static
// switch — the drawer (and its swipe gestures) only apply below this.
const LG_BREAKPOINT_QUERY = "(min-width: 1024px)";
// How close to the left edge a touch has to start to count as "opening the
// drawer" rather than an ordinary tap/scroll/swipe elsewhere on the page.
const EDGE_ZONE_PX = 24;
const OPEN_LOCK_PX = 10;
const OPEN_DOMINANCE_RATIO = 1.2;
const OPEN_THRESHOLD_PX = 60;

// Same fade-through + subtle scale as the top-level route transition in
// App.js (kept in sync with those values), applied here for navigation
// *within* the shell — lobby -> puzzles, etc. — so the sidebar/topbar stay
// mounted and only the content area transitions.
const PAGE_ENTER = { opacity: 1, scale: 1, transition: { duration: 0.22, ease: "easeOut" } };
const PAGE_EXIT = { opacity: 0, scale: 0.98, transition: { duration: 0.18, ease: "easeIn" } };
const PAGE_INITIAL = { opacity: 0, scale: 0.98 };

/**
 * Renders the current nested route's element (in place of a plain
 * <Outlet />) wrapped in a fade-through/scale transition keyed by the
 * pathname, so switching between shell pages animates without remounting
 * AppShell itself. `useOutlet()` gives the already-resolved element for the
 * current match, same as <Outlet /> would render, just accessible for
 * wrapping.
 */
function AnimatedOutlet() {
  const location = useLocation();
  const element = useOutlet();

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        initial={PAGE_INITIAL}
        animate={PAGE_ENTER}
        exit={PAGE_EXIT}
      >
        {element}
      </motion.div>
    </AnimatePresence>
  );
}

/**
 * Shared shell for authenticated pages: collapsible sidebar + content area.
 * A slim bar sits at the top-left of the content column on every
 * breakpoint, holding the dark mode toggle. On mobile it also holds the
 * menu icon to open the sidebar drawer (hidden on lg, since the sidebar is
 * a static rail there instead). Closing the drawer happens via the X
 * inside it (see Sidebar.jsx), not from this bar.
 *
 * Back navigation lives per-page via <PageHeader>
 * (components/layout/PageHeader.jsx) directly beside each page's title.
 */
export default function AppShell() {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const location = useLocation();
  const { user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, String(collapsed));
  }, [collapsed]);

  // Close the mobile drawer automatically whenever the route changes, so it
  // never lingers open after tapping a link or navigating back/forward.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  // Edge-swipe-to-open: the drawer itself is off-canvas while closed, so it
  // can't receive the touch that opens it — that has to be listened for on
  // the page instead. Scoped to a slim strip at the left edge and to a
  // rightward, horizontally-dominant drag, so it never fires from an
  // ordinary tap or vertical scroll anywhere else on the page. Desktop
  // (lg+) uses a static sidebar with no drawer, so this stays off there.
  const isDesktopRef = useRef(
    typeof window !== "undefined" ? window.matchMedia(LG_BREAKPOINT_QUERY).matches : false
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(LG_BREAKPOINT_QUERY);
    const onChange = () => {
      isDesktopRef.current = mq.matches;
    };
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const drag = { active: false, locked: false, opening: false, startX: 0, startY: 0 };

    const onTouchStart = (e) => {
      if (isDesktopRef.current || mobileNavOpen) return;
      const t = e.touches[0];
      if (t.clientX > EDGE_ZONE_PX) return;
      drag.active = true;
      drag.locked = false;
      drag.opening = false;
      drag.startX = t.clientX;
      drag.startY = t.clientY;
    };

    const onTouchMove = (e) => {
      if (!drag.active) return;
      const t = e.touches[0];
      const dx = t.clientX - drag.startX;
      const dy = t.clientY - drag.startY;

      if (!drag.locked) {
        if (Math.abs(dx) < OPEN_LOCK_PX && Math.abs(dy) < OPEN_LOCK_PX) return;
        drag.locked = true;
        // Only a rightward, horizontally-dominant drag counts as "open the
        // drawer" — anything else (leftward, vertical) is left completely
        // alone so page scrolling near the edge is never disturbed.
        drag.opening = dx > 0 && Math.abs(dx) > Math.abs(dy) * OPEN_DOMINANCE_RATIO;
      }
      if (!drag.opening) return;

      e.preventDefault();
      if (dx > OPEN_THRESHOLD_PX) {
        setMobileNavOpen(true);
        drag.active = false;
        drag.opening = false;
      }
    };

    const onTouchEnd = () => {
      drag.active = false;
      drag.opening = false;
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [mobileNavOpen]);

  return (
    <div className="flex min-h-screen" style={{ background: "var(--surface-0)", color: "var(--text-primary)" }}>
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <div
          className="flex items-center gap-1 px-2 sticky top-0 z-30"
          style={{ height: 52, borderBottom: "1px solid var(--hairline)", background: "var(--surface-0)" }}
        >
          <button
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open menu"
            title="Menu"
            className="lg:hidden flex h-9 w-9 items-center justify-center rounded-lg sc-icon-btn"
            style={{ color: "var(--text-secondary)" }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>

          <div className="flex-1" />

          {user && (
            <Link
              to="/wallet"
              className="flex items-center gap-2 sm:gap-3 rounded-lg px-2 sm:px-2.5 py-1.5 no-underline mr-1 sc-nav-row"
              style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
              title={`${(user.wallet_balance?.USDT ?? 0).toFixed(2)} USDT · ${(user.credits_balance ?? 0).toLocaleString()} credits`}
            >
              <span className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--text-secondary)" }}>
                <Wallet className="w-3.5 h-3.5 shrink-0" />
                {(user.wallet_balance?.USDT ?? 0).toFixed(2)}
                <span className="hidden sm:inline">&nbsp;USDT</span>
              </span>
              <span className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: "var(--brand)" }}>
                <Coins className="w-3.5 h-3.5 shrink-0" />
                {(user.credits_balance ?? 0).toLocaleString()}
                <span className="hidden sm:inline">&nbsp;cr</span>
              </span>
            </Link>
          )}

          <button
            onClick={toggleTheme}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            title={isDark ? "Light mode" : "Dark mode"}
            className="flex h-9 w-9 items-center justify-center rounded-lg sc-icon-btn"
            style={{ color: "var(--text-secondary)" }}
          >
            {isDark ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
              </svg>
            )}
          </button>
        </div>

        <main className="flex-1 min-w-0 px-5 py-6 md:px-8 md:py-7">
          <AnimatedOutlet />
        </main>
      </div>
    </div>
  );
}
