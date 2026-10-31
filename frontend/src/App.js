import { useState, useEffect, useRef, createContext, useContext, useCallback } from "react";
import { createSocket } from "@/lib/socket";
import "@/App.css";
import "@/index.css";
import { useScrollReveal } from "@/hooks/useScrollReveal";
import { BrowserRouter, Routes, Route, useNavigate, useLocation, Link } from "react-router-dom";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import axios from "axios";

axios.defaults.withCredentials = true;
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { ThemeProvider, useTheme } from "@/context/ThemeContext";
import AppShell from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";

// Pages
import Landing from "@/pages/Landing";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import Lobby from "@/pages/Lobby";
import Game from "@/pages/Game";
import Profile from "@/pages/Profile";
import Leaderboard from "@/pages/Leaderboard";
import AdminPanel from "@/pages/AdminPanel";
import Wallet from "@/pages/Wallet";
import AuthCallback from "@/pages/AuthCallback";
import Tournaments from "@/pages/Tournaments";
import ChallengeQueue from "@/pages/ChallengeQueue";
import PlayComputer from "@/pages/PlayComputer";
import Messages from "@/pages/Messages";
import News from "@/pages/News";
import Live from "@/pages/Live";
import Puzzles from "@/pages/Puzzles";
import ImportPGN from "@/pages/ImportPGN";
import Study from "@/pages/Study";
import StudyDetail from "@/pages/StudyDetail";
import BoardEditor from "@/pages/BoardEditor";
import ChessClock from "@/pages/ChessClock";
import Terms from "@/pages/Terms";
import Privacy from "@/pages/Privacy";
import DatabaseInfo from "@/pages/Database";
import Support from "@/pages/Support";
import PushManager from "@/components/PushManager";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || window.location.origin;
export const API = `${BACKEND_URL}/api`;

// Auth Context
const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(localStorage.getItem("token"));
  const [incomingChallenge, setIncomingChallenge] = useState(null);
  const [pendingChallengeCount, setPendingChallengeCount] = useState(0);
  const [watchableMatchCount, setWatchableMatchCount] = useState(0);
  const [puzzleProgress, setPuzzleProgress] = useState(null);
  const socketRef = useRef(null);

  const refreshPendingChallenges = useCallback(async () => {
    if (!token) return;
    try {
      const response = await axios.get(`${API}/challenges/pending`, {
        headers: { Authorization: `Bearer ${token}` },
        withCredentials: true,
      });
      setPendingChallengeCount(response.data.challenges?.length || 0);
    } catch (error) {
      console.error("Failed to fetch pending challenges", error);
    }
  }, [token]);

  const refreshWatchableMatches = useCallback(async () => {
    if (!token) return;
    try {
      const response = await axios.get(`${API}/games/watchable-count`, {
        headers: { Authorization: `Bearer ${token}` },
        withCredentials: true,
      });
      setWatchableMatchCount(response.data.count ?? 0);
    } catch (error) {
      console.error("Failed to fetch watchable match count", error);
    }
  }, [token]);

  const refreshPuzzleProgress = useCallback(async () => {
    if (!token) return;
    try {
      const response = await axios.get(`${API}/puzzles/progress`, {
        headers: { Authorization: `Bearer ${token}` },
        withCredentials: true,
      });
      setPuzzleProgress(response.data);
    } catch (error) {
      console.error("Failed to fetch puzzle progress", error);
    }
  }, [token]);

  const refreshUser = useCallback(async () => {
    // Re-fetches the current user (rating, wallet, games_played, etc.) without
    // touching the global `loading` flag, so it's safe to call from any page
    // (e.g. Lobby, after returning from a finished game) without flashing the
    // ProtectedRoute spinner.
    if (!token) return;
    try {
      const response = await axios.get(`${API}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
        withCredentials: true,
      });
      setUser(response.data);
    } catch (error) {
      console.error("Failed to refresh user", error);
    }
  }, [token]);

  const checkAuth = useCallback(async () => {
    // CRITICAL: If returning from OAuth callback, skip the /me check.
    const hasOAuthSession = window.location.search?.includes("session_id=") || window.location.hash?.includes("session_id=");
    if (hasOAuthSession) {
      setLoading(false);
      return;
    }

    const storedToken = localStorage.getItem("token");
    try {
      const config = { withCredentials: true };
      if (storedToken) {
        config.headers = { Authorization: `Bearer ${storedToken}` };
      }
      const response = await axios.get(`${API}/auth/me`, config);
      setUser(response.data);
      setToken(storedToken || null);
    } catch (error) {
      localStorage.removeItem("token");
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (user && token) {
      refreshPendingChallenges();
      refreshWatchableMatches();
      refreshPuzzleProgress();
    }
  }, [user, token, refreshPendingChallenges, refreshWatchableMatches, refreshPuzzleProgress]);

  // Silently keep the user's stored IANA timezone in sync with the
  // browser's - used server-side to localize daily-reset features like
  // puzzle retry/skip budgets (Phase 4b) to the user's actual midnight
  // instead of UTC. Fire-and-forget: never blocks the UI, never surfaces
  // an error, and only writes when it's actually stale so it's not a
  // network call on every load.
  useEffect(() => {
    if (!user || !token) return;
    let detected;
    try {
      detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (error) {
      return;
    }
    if (!detected || detected === user.timezone) return;
    axios
      .put(
        `${API}/users/${user.user_id}/settings`,
        { timezone: detected },
        { headers: { Authorization: `Bearer ${token}` }, withCredentials: true }
      )
      .then(() => setUser((prev) => (prev ? { ...prev, timezone: detected } : prev)))
      .catch((error) => console.warn("Failed to sync timezone", error));
  }, [user, token]);

  const navigate = useNavigate();

  const acceptIncomingChallenge = async () => {
    if (!incomingChallenge) {
      return;
    }
    try {
      await axios.post(
        `${API}/challenges/${incomingChallenge.challenge_id}/accept`,
        {},
        { headers: { Authorization: `Bearer ${token}` }, withCredentials: true }
      );
      toast.success("Challenge accepted! Redirecting to game...");
      if (incomingChallenge.game_id) {
        navigate(`/game/${incomingChallenge.game_id}`);
      }
    } catch (error) {
      toast.error(error.response?.data?.detail || "Failed to accept challenge");
    } finally {
      setIncomingChallenge(null);
      setPendingChallengeCount((count) => Math.max(0, count - 1));
      refreshPendingChallenges();
    }
  };

  const rejectIncomingChallenge = async () => {
    if (!incomingChallenge) {
      return;
    }
    try {
      await axios.post(
        `${API}/challenges/${incomingChallenge.challenge_id}/reject`,
        {},
        { headers: { Authorization: `Bearer ${token}` }, withCredentials: true }
      );
      toast(`Challenge rejected`, { duration: 5000 });
    } catch (error) {
      toast.error(error.response?.data?.detail || "Failed to reject challenge");
    } finally {
      setIncomingChallenge(null);
      setPendingChallengeCount((count) => Math.max(0, count - 1));
      refreshPendingChallenges();
    }
  };

  // Socket: create global socket when authenticated
  useEffect(() => {
    const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || window.location.origin;
    if (user && token) {
      try {
        socketRef.current = createSocket(BACKEND_URL, token);

        socketRef.current.on("connect", () => {
          try {
            socketRef.current.emit("join_user_room", { user_id: user.user_id });
            console.log("Socket connected and joined user room", user.user_id);
            if (user?.is_admin) {
              socketRef.current.emit("join_admin_room", {});
            }
          } catch (e) {
            console.error("Socket join_user_room error", e);
          }
        });

        socketRef.current.on("direct_message", (msg) => {
          // Broadcast to the app via a CustomEvent so pages can listen
          try {
            window.dispatchEvent(new CustomEvent("direct_message", { detail: msg }));
          } catch (e) {
            console.error("Failed to dispatch direct_message event", e);
          }
        });

        socketRef.current.on("challenge_received", (msg) => {
          try {
            window.dispatchEvent(new CustomEvent("challenge_received", { detail: msg }));
          } catch (e) {
            console.error("Failed to dispatch challenge_received event", e);
          }
          setIncomingChallenge(msg);
          setPendingChallengeCount((count) => count + 1);
          refreshPendingChallenges();
          toast(`${msg.from_username || "Opponent"} sent you a challenge`, { duration: 7000 });
        });

        socketRef.current.on("watchable_count_update", (msg) => {
          setWatchableMatchCount(msg.count ?? 0);
        });

        socketRef.current.on("challenge_accepted", (msg) => {
          toast.success(`${msg.to_username || "Your opponent"} accepted your challenge!`, { duration: 7000 });
          if (msg.game_id) {
            navigate(`/game/${msg.game_id}`);
          }
        });

        socketRef.current.on("challenge_rejected", (msg) => {
          toast.error(`${msg.to_username || "Your opponent"} rejected your challenge.`, { duration: 7000 });
        });

        socketRef.current.on("tournament_match_assigned", (msg) => {
          try {
            window.dispatchEvent(new CustomEvent("tournament_match_assigned", { detail: msg }));
          } catch (e) {
            console.error("Failed to dispatch tournament_match_assigned event", e);
          }
          toast.success(`Tournament match assigned: ${msg.game_id}`, { duration: 7000 });
        });

        socketRef.current.on("admin_alert", (msg) => {
          try {
            window.dispatchEvent(new CustomEvent("admin_alert", { detail: msg }));
          } catch (e) {
            console.error("Failed to dispatch admin_alert event", e);
          }
          if (user?.is_admin) {
            toast.error(`Admin alert: ${msg.message}`, { duration: 10000 });
          }
        });

        socketRef.current.on("tournament_updated", (msg) => {
          try {
            window.dispatchEvent(new CustomEvent("tournament_updated", { detail: msg }));
          } catch (e) {
            console.error("Failed to dispatch tournament_updated event", e);
          }
        });

        socketRef.current.on("tournament_started", (msg) => {
          try {
            window.dispatchEvent(new CustomEvent("tournament_started", { detail: msg }));
          } catch (e) {
            console.error("Failed to dispatch tournament_started event", e);
          }
          toast.success(`Tournament started: ${msg.name}`, { duration: 7000 });
        });

        socketRef.current.on("tournament_ended", (msg) => {
          try {
            window.dispatchEvent(new CustomEvent("tournament_ended", { detail: msg }));
          } catch (e) {
            console.error("Failed to dispatch tournament_ended event", e);
          }
          toast.success(`Tournament ended: ${msg.name}`, { duration: 7000 });
        });

        socketRef.current.connect();
      } catch (e) {
        console.error("Failed to create socket", e);
      }
    }

    return () => {
      try {
        if (socketRef.current) {
          socketRef.current.disconnect();
          socketRef.current = null;
        }
      } catch (e) {
        // ignore
      }
    };
    // Depend on the specific fields this effect actually reads, not the
    // whole `user` object. refreshUser() (polled every 5s from Lobby and
    // elsewhere) calls setUser() with a brand-new object each time, even
    // when nothing meaningful changed - depending on `user` by reference
    // was tearing the socket down and recreating it on every poll cycle,
    // which is what produced the repeated "Socket connected and joined
    // user room" logs and the interleaved polling-transport 400s.
  }, [user?.user_id, user?.is_admin, token]);

  const login = async (email, password) => {
    const response = await axios.post(
      `${API}/auth/login`,
      { email, password },
      { withCredentials: true }
    );
    const { access_token, user: userData } = response.data;
    localStorage.setItem("token", access_token);
    setToken(access_token);
    setUser(userData);
    return userData;
  };

  const register = async (username, email, password) => {
    const response = await axios.post(
      `${API}/auth/register`,
      { name: username, email, password },
      { withCredentials: true }
    );
    const { access_token, user: userData } = response.data;
    localStorage.setItem("token", access_token);
    setToken(access_token);
    setUser(userData);
    return userData;
  };

  const logout = async () => {
    try {
      await axios.post(`${API}/auth/logout`, {}, { withCredentials: true });
    } catch (e) {
      // Ignore
    }
    localStorage.removeItem("token");
    setToken(null);
    setUser(null);
  };

  const updateUser = (userData, tokenValue) => {
    setUser(userData);
    if (tokenValue) {
      setToken(tokenValue);
    }
  };

  return (
    <AuthContext.Provider
      value={{ user, token, loading, login, register, logout, updateUser, checkAuth, refreshUser, pendingChallengeCount, refreshPendingChallenges, watchableMatchCount, refreshWatchableMatches, puzzleProgress, refreshPuzzleProgress }}
    >
      {children}
      <Dialog open={!!incomingChallenge} onOpenChange={(open) => !open && setIncomingChallenge(null)}>
        <DialogContent className="max-w-md bg-surface-1 border border-hair p-6">
          <DialogHeader>
            <DialogTitle className="font-heading text-xl">Challenge Request</DialogTitle>
          </DialogHeader>
          {incomingChallenge && (
            <div className="space-y-4 pt-2 text-ink">
              <p>
                <span className="font-semibold">{incomingChallenge.from_username || "Opponent"}</span> has challenged you to a game.
              </p>
              <p className="text-sm text-ink-secondary">{incomingChallenge.message || "No message provided."}</p>
              <div className="rounded-xl bg-surface-2 border border-hair p-3">
                <p className="text-xs uppercase tracking-[0.18em] text-ink-secondary mb-2">Game details</p>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="font-semibold">Game ID</div>
                  <div className="text-right text-ink-secondary">{incomingChallenge.game_id}</div>
                  <div className="font-semibold">From</div>
                  <div className="text-right text-ink-secondary">{incomingChallenge.from_username}</div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter className="gap-2 mt-4">
            <Button size="sm" variant="ghost" onClick={rejectIncomingChallenge}>
              Reject
            </Button>
            <Button size="sm" onClick={acceptIncomingChallenge}>
              Accept
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AuthContext.Provider>
  );
};

// Protected Route
const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!loading && !user) {
      navigate("/login", { state: { from: location.pathname } });
    }
  }, [user, loading, navigate, location]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--surface-0)" }}>
        <div
          className="w-10 h-10 rounded-full animate-spin"
          style={{ border: "3px solid var(--hairline)", borderTopColor: "var(--brand)" }}
        />
      </div>
    );
  }

  return user ? children : null;
};

// Paths rendered outside the AppShell (no sidebar/topbar). Everything else
// falls under the AppShell branch below and shares one persistent shell
// instance — see AnimatedOutlet in AppShell.jsx for how navigation *within*
// the shell (lobby -> puzzles, etc.) gets its own, more local transition
// without remounting the sidebar/topbar on every click.
const STANDALONE_PATHS = ["/", "/login", "/register", "/callback"];
const SHELL_TRANSITION_KEY = "app-shell";

// Fade-through + subtle scale, per the design spec: exit is quick (~180ms)
// so the outgoing page gets out of the way fast, enter is a touch slower
// (~220ms) so the incoming page settles rather than snapping in. Each side
// carries its own transition rather than one shared duration.
const PAGE_ENTER = { opacity: 1, scale: 1, transition: { duration: 0.22, ease: "easeOut" } };
const PAGE_EXIT = { opacity: 0, scale: 0.98, transition: { duration: 0.18, ease: "easeIn" } };
const PAGE_INITIAL = { opacity: 0, scale: 0.98 };

// App Router
function AppRouter() {
  const location = useLocation();
  useScrollReveal();

  const hasOAuthSession = location.search?.includes("session_id=") || location.hash?.includes("session_id=");
  if (hasOAuthSession) {
    return <AuthCallback />;
  }

  // Only the boundary between standalone pages and the shell (or between
  // two different standalone pages) should replay this outer transition.
  // Navigating between pages that already live inside the shell keeps this
  // key constant, so AnimatePresence leaves the shell mounted and the inner
  // AnimatedOutlet handles that transition instead — no double-fade, no
  // needless remount of the sidebar/topbar.
  const transitionKey = STANDALONE_PATHS.includes(location.pathname)
    ? location.pathname
    : SHELL_TRANSITION_KEY;

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={transitionKey}
        initial={PAGE_INITIAL}
        animate={PAGE_ENTER}
        exit={PAGE_EXIT}
      >
        <Routes location={location}>
      {/* Public / unauthenticated pages — no sidebar shell */}
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/callback" element={<AuthCallback />} />

      {/* Everything below shares the sidebar + topbar shell (see AppShell).
          Individual pages keep their own ProtectedRoute wrapping so public
          pages like /leaderboard still render for logged-out visitors. */}
      <Route element={<AppShell />}>
        <Route
          path="/lobby"
          element={
            <ProtectedRoute>
              <Lobby />
            </ProtectedRoute>
          }
        />
        <Route
          path="/game/:gameId"
          element={
            <ProtectedRoute>
              <Game />
            </ProtectedRoute>
          }
        />
        <Route
          path="/profile"
          element={
            <ProtectedRoute>
              <Profile />
            </ProtectedRoute>
          }
        />
        <Route
          path="/profile/:userId"
          element={
            <ProtectedRoute>
              <Profile />
            </ProtectedRoute>
          }
        />
        <Route path="/leaderboard" element={<Leaderboard />} />
        <Route
          path="/wallet"
          element={
            <ProtectedRoute>
              <Wallet />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin"
          element={
            <ProtectedRoute>
              <AdminPanel />
            </ProtectedRoute>
          }
        />
        <Route
          path="/tournaments"
          element={
            <ProtectedRoute>
              <Tournaments />
            </ProtectedRoute>
          }
        />
        <Route
          path="/messages"
          element={
            <ProtectedRoute>
              <Messages />
            </ProtectedRoute>
          }
        />
        <Route
          path="/challenge-queue"
          element={
            <ProtectedRoute>
              <ChallengeQueue />
            </ProtectedRoute>
          }
        />
        <Route path="/news" element={<News />} />
        <Route path="/live" element={<Live />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/database" element={<DatabaseInfo />} />
        <Route path="/support" element={<Support />} />
        <Route
          path="/puzzles"
          element={
            <ProtectedRoute>
              <Puzzles />
            </ProtectedRoute>
          }
        />
        <Route
          path="/study"
          element={
            <ProtectedRoute>
              <Study />
            </ProtectedRoute>
          }
        />
        <Route
          path="/study/:id"
          element={
            <ProtectedRoute>
              <StudyDetail />
            </ProtectedRoute>
          }
        />
        <Route
          path="/import-pgn"
          element={
            <ProtectedRoute>
              <ImportPGN />
            </ProtectedRoute>
          }
        />
        <Route
          path="/board-editor"
          element={
            <ProtectedRoute>
              <BoardEditor />
            </ProtectedRoute>
          }
        />
        <Route
          path="/chess-clock"
          element={
            <ProtectedRoute>
              <ChessClock />
            </ProtectedRoute>
          }
        />
        <Route path="/play-computer" element={<PlayComputer />} />
      </Route>
        </Routes>
      </motion.div>
    </AnimatePresence>
  );
}

// Toaster styling reacts to the theme so toasts don't stay dark-only.
// Split out so it can call useTheme() inside the ThemeProvider below.
function ThemedToaster() {
  const { theme } = useTheme();
  return (
    <Toaster
      position="top-right"
      toastOptions={{
        style: {
          background: "var(--surface-1)",
          border: "1px solid var(--hairline)",
          color: "var(--text-primary)",
        },
      }}
      theme={theme}
    />
  );
}

function App() {
  return (
    <div className="App min-h-screen">
      <BrowserRouter>
        <MotionConfig reducedMotion="user">
          <ThemeProvider>
            <AuthProvider>
              <AppRouter />
              <PushManager />
              <ThemedToaster />
            </AuthProvider>
          </ThemeProvider>
        </MotionConfig>
      </BrowserRouter>
    </div>
  );
}

export default App;
