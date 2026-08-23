import { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion, useReducedMotion, MotionConfig } from "framer-motion";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/App";
import { useTheme } from "@/context/ThemeContext";
import {
  Zap,
  Bot,
  Puzzle,
  Trophy,
  ChevronRight,
  Menu,
  X,
  Play,
  Sun,
  Moon,
} from "lucide-react";

/* Nav stays minimal: Dashboard, News, and the auth action.
   Leaderboard / Wallet / Profile / Admin live in the app shell, not here. */
const LOGO_URL = "/stakechess-logo.png";

/* ---------------------------------------------------------------
   Note: this page previously rendered a WebGL chess scene here
   (HeroBoard3D — three.js/@react-three/fiber, a lazy-loaded glTF
   model, WebGL/low-end-device detection, an HDRI environment, the
   works). That's been pulled back out in favor of the static hero
   image below; the HeroBoard3D component file itself hasn't been
   deleted from the codebase, just unhooked from this page, in case
   it's wanted again later. See src/components/hero/HeroBoard3D.jsx.
   --------------------------------------------------------------- */

/* Shared button spring — used everywhere a Button/icon-button gets
   hover/tap physics instead of the flatter CSS transition. */
const BUTTON_SPRING = { type: "spring", stiffness: 500, damping: 30 };

const MotionButton = motion(Button);


const NAV_LINKS = [
  { to: "/lobby", label: "Dashboard", requiresAuth: true },
  { to: "/news", label: "News" },
];

const STATS = [
  { value: "12,456", label: "Players online", dot: "var(--green)" },
  { value: "$152.48K", label: "Prize pool" },
  { value: "84,331", label: "Games today" },
  { value: "$8,420", label: "Total wagered" },
  { value: "842", label: "Live matches", dot: "var(--red)" },
];

/* ---------------------------------------------------------------
   Hero art.

   This is the rendered 3D chess scene (raytraced lighting, depth of
   field, the glowing ring under the king). It's a real image rather
   than CSS/SVG because that look can't be faithfully reproduced with
   vector shapes — served as WebP (~45KB) from /public. Restored from
   an earlier version of this page in place of the animated CSS board
   / WebGL HeroBoard3D that briefly replaced it.

   (An animated MP4 version of both themes was built and wired in
   here for a while — /hero-chess-dark.mp4 and /hero-chess-light.mp4,
   both watermark-cleaned PixVerse V6 generations of pieces sliding
   with a purple light trail. Pulled back out in favor of the plain
   stills below; the video assets and the <video>/poster wiring
   aren't deleted from the codebase, just unhooked from this
   component, in case they're wanted again later.)
   --------------------------------------------------------------- */
function HeroBoard() {
  const { theme } = useTheme();
  // Same rendered chess scene, two versions: /hero-chess.webp for dark
  // mode (baked-in dark background + glow, with a large empty canvas
  // margin the old sizing below was tuned to bleed off-panel) and
  // /hero-chess-light.webp for light mode (transparent background,
  // tightly cropped to the actual pieces/board with almost no margin).
  // The light asset can't reuse the dark asset's full oversized/shifted
  // sizing - blowing a tightly-cropped image up too far or shifting it
  // too far right pushes the king and board edge past the panel's
  // overflow-hidden bounds, cropping it on both desktop and mobile.
  // Re-check both breakpoints if either ratio changes again.
  const isLight = theme === "light";
  const heroSrc = isLight ? "/hero-chess-light.webp" : "/hero-chess.webp";

  return (
    <div className={isLight ? "relative w-full md:-ml-16 lg:-ml-24" : "relative w-full"}>
      {/* glow bleeding out past the image edges, so it melts into the panel */}
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[125%] h-[125%]"
        style={{
          background:
            "radial-gradient(ellipse at 55% 60%, rgba(124,92,252,.38), rgba(124,92,252,.10) 45%, transparent 70%)",
        }}
      />
      <img
        key={heroSrc}
        src={heroSrc}
        alt="Chess king spotlit on a board, surrounded by other pieces"
        className={
          isLight
            ? "relative h-auto select-none w-[116%] max-w-none -mr-[3%]"
            : "relative h-auto select-none w-[118%] max-w-none -mr-[8%] md:-mt-6"
        }
        draggable="false"
        style={{
          /* feather the edges so the render blends into the hero panel
             instead of sitting in an obvious rectangle */
          maskImage:
            "radial-gradient(ellipse 78% 82% at 52% 52%, #000 58%, transparent 96%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 78% 82% at 52% 52%, #000 58%, transparent 96%)",
        }}
      />
    </div>
  );
}

function PlayTile({ icon: Icon, title, subtitle, tint, onClick }) {
  const prefersReducedMotion = useReducedMotion();

  return (
    <motion.button
      onClick={onClick}
      className="sc-reveal-item text-left rounded-2xl p-5 w-full"
      style={{
        /* subtle colour wash per tile, like the reference */
        background: `linear-gradient(150deg, ${tint.bg} 0%, var(--surface-1) 62%)`,
        border: "1px solid var(--hairline)",
      }}
      whileHover={
        prefersReducedMotion
          ? undefined
          : { y: -4, borderColor: "var(--brand)", boxShadow: "var(--shadow-md)" }
      }
      whileTap={prefersReducedMotion ? undefined : { scale: 0.975, y: -1 }}
      transition={{ type: "spring", stiffness: 400, damping: 28 }}
    >
      <motion.div
        className="w-10 h-10 rounded-xl flex items-center justify-center mb-3"
        style={{ background: tint.bg, color: tint.fg }}
        whileHover={prefersReducedMotion ? undefined : { scale: 1.08, rotate: -6 }}
        transition={{ type: "spring", stiffness: 400, damping: 20 }}
      >
        <Icon className="w-5 h-5" />
      </motion.div>
      <div className="font-display font-bold text-[15px]">{title}</div>
      <div className="text-[12px] mt-0.5" style={{ color: "var(--text-secondary)" }}>
        {subtitle}
      </div>
    </motion.button>
  );
}

export default function Landing() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isDark = theme === "dark";

  // Nav hides on scroll-down, reveals on scroll-up — tracks the last
  // scroll position and compares each tick.
  const [navHidden, setNavHidden] = useState(false);
  const lastScrollY = useRef(0);

  useEffect(() => {
    lastScrollY.current = window.scrollY;

    const handleScroll = () => {
      const currentY = window.scrollY;
      const delta = currentY - lastScrollY.current;

      // Ignore tiny jitters (e.g. rubber-band bounce on mobile) and stay
      // visible right at the top of the page regardless of direction.
      if (Math.abs(delta) > 4) {
        if (currentY <= 8) {
          setNavHidden(false);
        } else if (delta > 0) {
          // scrolling down
          setNavHidden(true);
        } else {
          // scrolling up
          setNavHidden(false);
        }
        lastScrollY.current = currentY;
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const go = (path) => {
    setMobileMenuOpen(false);
    navigate(path);
  };

  const visibleNavLinks = NAV_LINKS.filter((l) => !l.requiresAuth || user);

  return (
    <MotionConfig reducedMotion="user">
    <div className="min-h-screen" style={{ background: "var(--surface-0)", color: "var(--text-primary)" }}>
      {/* ---------------- Nav ---------------- */}
      <header
        className="sticky top-0 z-50 backdrop-blur"
        style={{
          borderBottom: "1px solid var(--hairline)",
          background: "color-mix(in srgb, var(--surface-0) 88%, transparent)",
          transform: navHidden ? "translateY(-100%)" : "translateY(0)",
          transition: "transform 220ms ease",
        }}
      >
        <div className="max-w-6xl mx-auto px-5 md:px-8 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 no-underline" style={{ color: "var(--text-primary)" }}>
            <img
              src={LOGO_URL}
              alt="StakeChess logo"
              className="h-10 w-auto object-contain"
              loading="lazy"
            />
          </Link>

          <nav className="hidden md:flex items-center gap-1">
            {visibleNavLinks.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className="sc-nav-row rounded-lg px-3.5 py-2 text-[14px] font-medium no-underline"
                style={{ color: "var(--text-secondary)" }}
              >
                {l.label}
              </Link>
            ))}

            <motion.button
              onClick={toggleTheme}
              aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
              title={isDark ? "Light mode" : "Dark mode"}
              className="sc-icon-btn ml-1 flex h-9 w-9 items-center justify-center rounded-lg"
              style={{ color: "var(--text-secondary)" }}
              whileHover={{ scale: 1.08, rotate: isDark ? -14 : 14 }}
              whileTap={{ scale: 0.9 }}
              transition={BUTTON_SPRING}
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </motion.button>

            {user ? (
              <MotionButton
                onClick={logout}
                variant="outline"
                className="ml-2 font-semibold"
                style={{ borderColor: "var(--hairline)", color: "var(--text-primary)", background: "transparent" }}
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.96 }}
                transition={BUTTON_SPRING}
              >
                Logout
              </MotionButton>
            ) : (
              <MotionButton
                onClick={() => go("/login")}
                className="ml-2 font-semibold"
                style={{ background: "var(--brand)", color: "var(--on-brand)" }}
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.96 }}
                transition={BUTTON_SPRING}
              >
                Login
              </MotionButton>
            )}
          </nav>

          <motion.button
            className="md:hidden sc-icon-btn h-9 w-9 rounded-lg flex items-center justify-center"
            onClick={() => setMobileMenuOpen((o) => !o)}
            aria-label="Menu"
            style={{ color: "var(--text-secondary)" }}
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.9 }}
            transition={BUTTON_SPRING}
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </motion.button>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden px-5 pb-4 flex flex-col gap-1" style={{ borderTop: "1px solid var(--hairline)" }}>
            {visibleNavLinks.map((l) => (
              <button
                key={l.to}
                onClick={() => go(l.to)}
                className="sc-nav-row text-left rounded-lg px-3 py-2.5 text-[14px] font-medium"
                style={{ color: "var(--text-secondary)", background: "transparent" }}
              >
                {l.label}
              </button>
            ))}
            <button
              onClick={toggleTheme}
              className="sc-nav-row text-left rounded-lg px-3 py-2.5 text-[14px] font-medium"
              style={{ color: "var(--text-secondary)", background: "transparent" }}
            >
              {isDark ? "Light mode" : "Dark mode"}
            </button>
            {user ? (
              <MotionButton
                onClick={logout}
                variant="outline"
                className="mt-2"
                style={{ borderColor: "var(--hairline)", color: "var(--text-primary)" }}
                whileTap={{ scale: 0.96 }}
                transition={BUTTON_SPRING}
              >
                Logout
              </MotionButton>
            ) : (
              <MotionButton
                onClick={() => go("/login")}
                className="mt-2"
                style={{ background: "var(--brand)", color: "var(--on-brand)" }}
                whileTap={{ scale: 0.96 }}
                transition={BUTTON_SPRING}
              >
                Login
              </MotionButton>
            )}
          </div>
        )}
      </header>

      {/* ---------------- Hero card ---------------- */}
      <section className="max-w-6xl mx-auto px-5 md:px-8 pt-7 md:pt-10">
        <div
          className="sc-page sc-hero sc-reveal-stagger relative overflow-hidden rounded-3xl"
          style={{
            background: isDark
              ? "linear-gradient(150deg, #171233 0%, #0E0B20 55%, #14102B 100%)"
              : "linear-gradient(150deg, #FFFFFF 0%, #F7F7FF 55%, #F0F0FF 100%)",
            border: isDark ? "1px solid rgba(140,110,255,.18)" : "1px solid rgba(148, 156, 255, 0.25)",
          }}
        >
          {/* ambient glows */}
          <div
            className="pointer-events-none absolute -top-40 right-[-10%] w-[560px] h-[560px] rounded-full"
            style={{ background: "radial-gradient(circle, rgba(124,92,252,.30), transparent 66%)" }}
          />
          <div
            className="pointer-events-none absolute -bottom-48 -left-32 w-[460px] h-[460px] rounded-full"
            style={{ background: "radial-gradient(circle, rgba(60,203,127,.14), transparent 70%)" }}
          />

          <div className={`relative grid md:grid-cols-[1.02fr,1fr] items-center pl-6 md:pl-12 pt-10 md:pt-14 pr-6 md:pr-0 ${isDark ? "gap-8" : "gap-6 md:gap-2"}`}>
            <div className="pb-2">
              <div className="sc-reveal-item mb-6 flex items-center gap-3 flex-wrap">
                <img
                  src={LOGO_URL}
                  alt="StakeChess branding"
                  className="h-16 w-auto object-contain"
                  loading="lazy"
                />
              </div>
              
              <h1 className="sc-reveal-item font-display font-bold text-[42px] md:text-[58px] leading-[1.02] tracking-tight">
                <span style={{ color: isDark ? "white" : "black" }}>STAKE.</span>{" "}
                <span style={{ color: "var(--brand)" }}>PLAY.</span>{" "}
                <span style={{ color: "var(--green)" }}>WIN.</span>
              </h1>

              <div className="sc-reveal-item">
                <p className="sc-hero-sub mt-3 text-[13px] md:text-[14px] tracking-wider font-medium" style={{ color: "var(--text-secondary)", letterSpacing: "0.15em" }}>
                  STAKE • PLAY • WIN
                </p>

                <p className="sc-hero-sub mt-5 text-[15px] md:text-[16px] leading-relaxed max-w-[440px]">
                  The premier real-time chess platform where skill meets stakes. Challenge opponents,
                  wager crypto, and prove you're the grandmaster.
                </p>
              </div>

              <div className="sc-reveal-item mt-7 flex flex-wrap gap-3">
                <MotionButton
                  onClick={() => go(user ? "/lobby" : "/login")}
                  className="font-semibold px-6 h-12 rounded-xl text-[13.5px] tracking-wide"
                  style={{ background: "var(--brand)", color: "var(--on-brand)" }}
                  whileHover={{ y: -3, boxShadow: "0 12px 24px -8px rgba(124,92,252,.55)" }}
                  whileTap={{ scale: 0.96, y: -1 }}
                  transition={BUTTON_SPRING}
                >
                  {user ? "ENTER LOBBY" : "START PLAYING"}
                  <ChevronRight className="w-4 h-4 ml-1.5" />
                </MotionButton>
                <MotionButton
                  onClick={() => go("/live")}
                  variant="outline"
                  className="sc-hero-ghost font-semibold px-6 h-12 rounded-xl text-[13.5px] tracking-wide"
                  whileHover={{ y: -3 }}
                  whileTap={{ scale: 0.96, y: -1 }}
                  transition={BUTTON_SPRING}
                >
                  <Play className="w-4 h-4 mr-1.5" />
                  WATCH LIVE
                </MotionButton>
              </div>

              {/* social proof */}
              <div className="mt-7 flex items-center gap-3">
                <div className="flex -space-x-2">
                  {["M", "S", "D", "K"].map((initial, i) => (
                    <span
                      key={initial}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold"
                      style={{
                        background: [
                          "var(--brand-dim)",
                          "var(--green-dim)",
                          "var(--orange-dim)",
                          "var(--blue-dim)",
                        ][i],
                        color: ["var(--brand)", "var(--green)", "var(--orange)", "var(--blue)"][i],
                        border: "2px solid rgba(255,255,255,.16)",
                      }}
                    >
                      {initial}
                    </span>
                  ))}
                </div>
                <p className="sc-hero-trust text-[13px]">
                  <strong>25,000+</strong> players trust StakeChess
                </p>
              </div>
            </div>

            <HeroBoard />
          </div>

          {/* Stats bar — inside the hero panel, as in the reference */}
          <div className="relative mx-6 md:mx-12 mb-8 md:mb-10 mt-2">
            <div
              className="rounded-2xl grid grid-cols-2 md:grid-cols-5 overflow-hidden"
              style={{
                background: "rgba(255,255,255,.035)",
                border: "1px solid rgba(150,120,255,.16)",
              }}
            >
              {STATS.map((s, i) => (
                <div
                  key={s.label}
                  className="px-5 py-4 text-center"
                  style={{
                    borderLeft: i === 0 ? "none" : "1px solid rgba(150,120,255,.14)",
                    borderTop: i >= 2 ? "1px solid rgba(150,120,255,.14)" : "none",
                  }}
                >
                  <div
                    className="font-display font-bold text-[20px] md:text-[23px]"
                    style={{ color: isDark ? "#F4F2FF" : "#0B0B0F" }}
                  >
                    {s.value}
                  </div>
                  <div className="flex items-center gap-1.5 justify-center mt-0.5">
                    <span className="text-[11.5px]" style={{ color: isDark ? "#A9A2C9" : "#1F2937" }}>
                      {s.label}
                    </span>
                    {s.dot && <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.dot }} />}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>


      {/* ---------------- Play your way ---------------- */}
      <section className="sc-reveal-stagger max-w-6xl mx-auto px-5 md:px-8 pt-9 pb-16">
        <h2
          className="sc-reveal-item text-[12px] font-semibold uppercase tracking-[0.14em] mb-4"
          style={{ color: "var(--text-secondary)" }}
        >
          Play your way
        </h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <PlayTile
            icon={Zap}
            title="Play online"
            subtitle="Find real opponents"
            tint={{ bg: "var(--brand-dim)", fg: "var(--brand)" }}
            onClick={() => go(user ? "/lobby" : "/login")}
          />
          <PlayTile
            icon={Bot}
            title="Play AI"
            subtitle="Practice with bots"
            tint={{ bg: "var(--blue-dim)", fg: "var(--blue)" }}
            onClick={() => go("/play-computer")}
          />
          <PlayTile
            icon={Puzzle}
            title="Daily puzzle"
            subtitle="Solve and earn rating"
            tint={{ bg: "var(--green-dim)", fg: "var(--green)" }}
            onClick={() => go(user ? "/puzzles" : "/login")}
          />
          <PlayTile
            icon={Trophy}
            title="Tournaments"
            subtitle="Compete and win big"
            tint={{ bg: "var(--orange-dim)", fg: "var(--orange)" }}
            onClick={() => go("/tournaments")}
          />
        </div>
      </section>

      <footer style={{ borderTop: "1px solid var(--hairline)" }}>
        <div
          className="max-w-6xl mx-auto px-5 md:px-8 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-[12px]"
          style={{ color: "var(--text-secondary)" }}
        >
          <span>StakeChess — stake. play. win.</span>
          <div className="flex gap-5">
            <Link to="/news" className="no-underline" style={{ color: "var(--text-secondary)" }}>News</Link>
            <Link to="/live" className="no-underline" style={{ color: "var(--text-secondary)" }}>Watch</Link>
          </div>
        </div>
      </footer>
    </div>
    </MotionConfig>
  );
}
