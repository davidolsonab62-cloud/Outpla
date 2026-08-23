import React, { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import io from "socket.io-client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useAuth, API } from "@/App";
import { toast } from "sonner";
import axios from "axios";
import {
  Plus,
  Users,
  Clock,
  ChevronRight,
  Zap,
  Timer,
  RefreshCw,
  Calendar,
  Share2,
  Copy,
  Check,
  Play,
  Radio,
  Rocket,
} from "lucide-react";
import { SkeletonStatsRow, SkeletonPanel } from "@/components/ui/skeletons";
import PageHeader from "@/components/layout/PageHeader";
import PlayMenuDialog from "@/components/play/PlayMenuDialog";
import StreamMenuDialog from "@/components/play/StreamMenuDialog";

const TIME_CONTROLS = [
  { value: "1+0", label: "1 min", type: "bullet" },
  { value: "3+0", label: "3 min", type: "blitz" },
  { value: "5+0", label: "5 min", type: "blitz" },
  { value: "10+0", label: "10 min", type: "rapid" },
  { value: "15+10", label: "15+10", type: "rapid" },
  { value: "30+0", label: "30 min", type: "classical" },
];

const CURRENCIES = [
  { value: "USDT", symbol: "$", tone: "success" },
  { value: "BTC", symbol: "\u20BF", tone: "warn" },
  { value: "ETH", symbol: "\u039E", tone: "brand" },
];

const TONE_VAR = { success: "var(--green)", warn: "var(--orange)", brand: "var(--brand)" };

const formatCountdown = (seconds) => {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

export default function Lobby() {
  const { user, token, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [playDialogOpen, setPlayDialogOpen] = useState(false);
  const [streamDialogOpen, setStreamDialogOpen] = useState(false);
  const [joiningGame, setJoiningGame] = useState(null);
  const [boostingGame, setBoostingGame] = useState(null);
  const [currentGameId, setCurrentGameId] = useState(null);
  const [currentGameExpiry, setCurrentGameExpiry] = useState(null);
  const [expiryCountdown, setExpiryCountdown] = useState(0);
  const [savedComputerMatch, setSavedComputerMatch] = useState(null);
  const [computerMatchCountdown, setComputerMatchCountdown] = useState(0);
  // Phase 5: show the boost cost before the user commits, not just after
  // a 402 (see the insufficient_credits handling in boostGame below).
  const [boostCost, setBoostCost] = useState(null);

  useEffect(() => {
    if (!token) return;
    axios
      .get(`${API}/credits/feature-costs/featured_game`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => setBoostCost(response.data.cost))
      .catch(() => {});
  }, [token]);


  // Create game form
  const [timeControl, setTimeControl] = useState("10+0");
  const [stakeAmount, setStakeAmount] = useState("0");
  const [stakeCurrency, setStakeCurrency] = useState("USDT");
  const [gameType] = useState("rapid");
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const socketRef = useRef(null);
  const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || window.location.origin;

  const clearComputerMatch = useCallback(() => {
    localStorage.removeItem("currentComputerMatch");
    setSavedComputerMatch(null);
    setComputerMatchCountdown(0);
  }, []);

  const loadSavedComputerMatch = useCallback(() => {
    const raw = localStorage.getItem("currentComputerMatch");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.expiresAt && parsed.expiresAt > Date.now()) {
        setSavedComputerMatch(parsed);
        setComputerMatchCountdown(Math.max(0, Math.floor((parsed.expiresAt - Date.now()) / 1000)));
      } else {
        clearComputerMatch();
      }
    } catch {
      clearComputerMatch();
    }
  }, [clearComputerMatch]);


  const handleResumeComputerMatch = () => {
    navigate("/play-computer");
  };

  const fetchGames = useCallback(async () => {
    try {
      // Include waiting and active games so ongoing matches are visible for reconnection
      const response = await axios.get(`${API}/games?status=waiting,active`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      setGames(response.data);
    } catch (error) {
      console.error("Failed to fetch games:", error);
      toast.error("Couldn't refresh games list");
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Check for active game on mount
  useEffect(() => {
    const savedGameId = localStorage.getItem("currentGameId");
    const savedExpiry = parseInt(localStorage.getItem("currentGameExpiry") || "0", 10);
    if (savedGameId) {
      setCurrentGameId(savedGameId);
    }
    if (savedExpiry && savedExpiry > Date.now()) {
      setCurrentGameExpiry(savedExpiry);
      setExpiryCountdown(Math.max(0, Math.ceil((savedExpiry - Date.now()) / 1000)));
    } else {
      // cleanup stale expiry
      localStorage.removeItem("currentGameExpiry");
    }
    loadSavedComputerMatch();
  }, [loadSavedComputerMatch]);

  useEffect(() => {
    if (!savedComputerMatch) return;
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.floor((savedComputerMatch.expiresAt - Date.now()) / 1000));
      if (remaining <= 0) {
        clearComputerMatch();
      } else {
        setComputerMatchCountdown(remaining);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [savedComputerMatch, clearComputerMatch]);

  // Countdown for resume-able created game (60s window)
  useEffect(() => {
    if (!currentGameExpiry) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((currentGameExpiry - Date.now()) / 1000));
      setExpiryCountdown(remaining);
      if (remaining <= 0) {
        // expired: clear saved game id so lobby no longer treats it as resumable
        localStorage.removeItem("currentGameId");
        localStorage.removeItem("currentGameExpiry");
        setCurrentGameId(null);
        setCurrentGameExpiry(null);
        fetchGames();
      }
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [currentGameExpiry, fetchGames]);

  // Socket.IO auto-refresh when games update
  useEffect(() => {
    socketRef.current = io(BACKEND_URL, {
      transports: ["polling", "websocket"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      path: "/socket.io",
      autoConnect: false,
    });

    socketRef.current.on("game_started", (data) => {
      navigate(`/game/${data.game_id}`);
    });

    socketRef.current.on("player_joined", () => {
      fetchGames();
    });

    socketRef.current.on("game_created", () => {
      fetchGames();
    });

    socketRef.current.connect();

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, [navigate, BACKEND_URL, fetchGames]);

  useEffect(() => {
    fetchGames();
    refreshUser();
    const interval = setInterval(() => {
      fetchGames();
      refreshUser();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchGames, refreshUser]);

  const refreshGames = async () => {
    setRefreshing(true);
    try {
      await fetchGames();
    } finally {
      setTimeout(() => setRefreshing(false), 150);
    }
  };

  const handleGamesClick = () => {
    if (currentGameId) {
      navigate(`/game/${currentGameId}`);
    } else {
      refreshGames();
    }
  };

  const shareMatchLink = async (gameId, label = "Match") => {
    const shareUrl = `${window.location.origin}/game/${gameId}`;
    try {
      if (navigator.share) {
        await navigator.share({
          title: `${label} invite`,
          text: `Join my ${label.toLowerCase()} on StakeChess:`,
          url: shareUrl,
        });
        toast.success("Invite shared");
        return;
      }

      await navigator.clipboard.writeText(shareUrl);
      toast.success("Match link copied to clipboard");
    } catch (error) {
      if (error?.name === "AbortError") return;
      try {
        await navigator.clipboard.writeText(shareUrl);
        toast.success("Match link copied to clipboard");
      } catch {
        toast.error("Unable to copy match link");
      }
    }
  };

  const createGame = async () => {
    setCreating(true);
    try {
      const payload = {
        time_control: timeControl,
        stake_amount: parseFloat(stakeAmount) || 0,
        stake_currency: stakeCurrency,
        game_type: gameType,
      };
      const res = await axios.post(`${API}/games`, payload, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const game = res.data;
      localStorage.setItem("currentGameId", game.game_id);
      // give the creator a 60s window to return to lobby and resume the match
      const expiry = Date.now() + 60 * 1000;
      localStorage.setItem("currentGameExpiry", String(expiry));
      setCurrentGameExpiry(expiry);
      setExpiryCountdown(60);
      setCurrentGameId(game.game_id);
      setCreateDialogOpen(false);
      try {
        await navigator.clipboard.writeText(`${window.location.origin}/game/${game.game_id}`);
        toast.success("Game created and invite link copied");
      } catch {
        toast.success("Game created. Share this game link: " + `${window.location.origin}/game/${game.game_id}`);
      }
      navigate(`/game/${game.game_id}`);
    } catch (error) {
      console.error("Create game error", error);
      toast.error(error.response?.data?.detail || "Failed to create game");
    } finally {
      setCreating(false);
    }
  };

  const joinGame = async (gameId) => {
    setJoiningGame(gameId);
    try {
      await axios.post(`${API}/games/${gameId}/join`, {}, { headers: { Authorization: `Bearer ${token}` } });
      localStorage.setItem("currentGameId", gameId);
      setCurrentGameId(gameId);
      navigate(`/game/${gameId}`);
      toast.success("Joined game");
    } catch (error) {
      console.error("Join game error", error);
      toast.error(error.response?.data?.detail || "Failed to join game");
    } finally {
      setJoiningGame(null);
    }
  };

  // Phase 4c: pay credits to feature an open game at the top of the lobby.
  // Only the game's own creator can boost it, and only while it's still
  // waiting for an opponent - fetchGames()/refreshUser() afterwards so both
  // the "Featured" badge and the header credits balance update immediately.
  const boostGame = async (gameId) => {
    setBoostingGame(gameId);
    try {
      await axios.post(`${API}/games/${gameId}/boost`, {}, { headers: { Authorization: `Bearer ${token}` } });
      toast.success("Game boosted to the top of the lobby");
      fetchGames();
      refreshUser();
    } catch (error) {
      console.error("Boost game error", error);
      const detail = error?.response?.data?.detail;
      if (error?.response?.status === 402 && detail?.error === "insufficient_credits") {
        toast.error(`Not enough credits — boosting costs ${detail.cost} credits (you have ${detail.credits_balance}).`, {
          action: { label: "Buy credits", onClick: () => navigate("/wallet") },
        });
      } else {
        toast.error(detail || "Failed to boost game");
      }
    } finally {
      setBoostingGame(null);
    }
  };

  const isGameFeaturedNow = (game) =>
    Boolean(game.featured && game.featured_until && new Date(game.featured_until) > new Date());

  const getGameTypeIcon = (type) => {
    switch (type) {
      case "bullet":
        return <Zap className="w-4 h-4" style={{ color: "var(--orange)" }} />;
      case "blitz":
        return <Timer className="w-4 h-4" style={{ color: "var(--orange)" }} />;
      case "rapid":
      default:
        return <Clock className="w-4 h-4" style={{ color: "var(--blue)" }} />;
    }
  };

  const winRate = user?.games_played > 0 ? ((user?.wins / user?.games_played) * 100).toFixed(0) : 0;

  return (
    <div className="sc-page max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-6">
        <PageHeader title="Game lobby" subtitle="Find an opponent or create a new game" testId="lobby-title" />

        <div className="flex gap-2.5 flex-wrap">
          <Button
            variant="outline"
            onClick={() => setStreamDialogOpen(true)}
            className="border font-semibold"
            style={{ background: "var(--surface-1)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
            data-testid="stream-btn"
          >
            <Radio className="w-4 h-4 mr-2" />
            Stream
          </Button>
          <StreamMenuDialog
            open={streamDialogOpen}
            onOpenChange={setStreamDialogOpen}
            gameId={currentGameId}
          />
          <Button
            className="font-semibold"
            style={{ background: "var(--brand)", color: "var(--on-brand)" }}
            onClick={() => setPlayDialogOpen(true)}
            data-testid="play-btn"
          >
            <Play className="w-4 h-4 mr-2" />
            Play
          </Button>
          <PlayMenuDialog
            open={playDialogOpen}
            onOpenChange={setPlayDialogOpen}
            timeControl={timeControl}
            gameType={gameType}
          />
          <Button
            variant="outline"
            onClick={() => navigate("/tournaments")}
            className="border font-semibold"
            style={{ background: "var(--surface-1)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
            data-testid="tournaments-btn"
          >
            <Calendar className="w-4 h-4 mr-2" />
            Tournaments
          </Button>
          <Button
            onClick={refreshGames}
            variant="outline"
            disabled={refreshing}
            className="border font-semibold"
            style={{ background: "var(--surface-1)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
            data-testid="refresh-games-btn"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button
                className="font-semibold"
                style={{ background: "var(--brand)", color: "var(--on-brand)" }}
                data-testid="create-game-btn"
              >
                <Plus className="w-4 h-4 mr-2" />
                Create game
              </Button>
            </DialogTrigger>
            <DialogContent
              className="max-w-md"
              style={{ background: "var(--surface-1)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
            >
              <DialogHeader>
                <DialogTitle style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Create new game</DialogTitle>
              </DialogHeader>
              <div className="space-y-6 pt-4">
                <div className="space-y-2">
                  <Label style={{ color: "var(--text-secondary)" }}>Time control</Label>
                  <Select value={timeControl} onValueChange={setTimeControl}>
                    <SelectTrigger
                      style={{ background: "var(--surface-2)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
                      data-testid="time-control-select"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent style={{ background: "var(--surface-1)", borderColor: "var(--hairline)" }}>
                      {TIME_CONTROLS.map((tc) => (
                        <SelectItem key={tc.value} value={tc.value}>
                          <span className="flex items-center gap-2">
                            {getGameTypeIcon(tc.type)}
                            {tc.label}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label style={{ color: "var(--text-secondary)" }}>Stake amount</Label>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={stakeAmount}
                      onChange={(e) => setStakeAmount(e.target.value)}
                      placeholder="0"
                      className="font-mono"
                      style={{ background: "var(--surface-2)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
                      data-testid="stake-amount-input"
                    />
                    <Select value={stakeCurrency} onValueChange={setStakeCurrency}>
                      <SelectTrigger
                        className="w-28"
                        style={{ background: "var(--surface-2)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
                        data-testid="stake-currency-select"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent style={{ background: "var(--surface-1)", borderColor: "var(--hairline)" }}>
                        {CURRENCIES.map((c) => (
                          <SelectItem key={c.value} value={c.value}>
                            <span style={{ color: TONE_VAR[c.tone] }}>{c.value}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                    Balance: {user?.wallet_balance?.[stakeCurrency]?.toFixed(4) || 0} {stakeCurrency}
                  </p>
                </div>

                {parseFloat(stakeAmount) > 0 && (
                  <div className="p-4 rounded-lg" style={{ background: "var(--surface-2)", border: "1px solid var(--hairline)" }}>
                    <p className="text-sm mb-2" style={{ color: "var(--text-secondary)" }}>Pot breakdown</p>
                    <div className="space-y-1 font-mono text-sm">
                      <div className="flex justify-between">
                        <span style={{ color: "var(--text-secondary)" }}>Your stake</span>
                        <span>{parseFloat(stakeAmount).toFixed(2)} {stakeCurrency}</span>
                      </div>
                      <div className="flex justify-between">
                        <span style={{ color: "var(--text-secondary)" }}>Total pot</span>
                        <span>{(parseFloat(stakeAmount) * 2).toFixed(2)} {stakeCurrency}</span>
                      </div>
                      <div className="flex justify-between">
                        <span style={{ color: "var(--text-secondary)" }}>Winner receives</span>
                        <span style={{ color: "var(--green)" }}>
                          {(parseFloat(stakeAmount) * 2 * 0.98).toFixed(2)} {stakeCurrency}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span style={{ color: "var(--text-secondary)" }}>Arbiter fee (2%)</span>
                        <span style={{ color: "var(--text-muted)" }}>
                          {(parseFloat(stakeAmount) * 2 * 0.02).toFixed(2)} {stakeCurrency}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                <Button
                  onClick={createGame}
                  disabled={creating}
                  className="w-full font-semibold"
                  style={{ background: "var(--brand)", color: "var(--on-brand)" }}
                  data-testid="confirm-create-game-btn"
                >
                  {creating ? "Creating\u2026" : "Create game"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {currentGameId && expiryCountdown > 0 && (
        <div className="mb-4 rounded-lg border border-hair bg-yellow-50 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <p className="font-semibold">You have a pending game</p>
            <p className="text-sm text-ink-secondary">Resume your created match before the timer expires.</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="font-mono text-lg">{formatCountdown(expiryCountdown)}</div>
            <Button onClick={() => navigate(`/game/${currentGameId}`)} size="sm">
              Resume
            </Button>
          </div>
        </div>
      )}

      {/* Saved computer match */}
      {savedComputerMatch && (
        <div className="rounded-2xl p-5 mb-6" style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}>
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold mb-1" style={{ color: "var(--brand)" }}>Saved computer match</p>
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                Resume your practice game before the 30-second reconnect window closes.
              </p>
            </div>
            <span className="font-mono text-sm" style={{ color: "var(--brand)" }}>{computerMatchCountdown}s left</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button onClick={handleResumeComputerMatch} style={{ background: "var(--brand)", color: "var(--on-brand)" }}>
              Resume practice
            </Button>
            <Button
              variant="outline"
              onClick={clearComputerMatch}
              style={{ borderColor: "var(--hairline)", color: "var(--text-primary)" }}
            >
              Discard
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <React.Fragment key="loading">
          <div className="mb-6">
            <SkeletonStatsRow count={4} />
          </div>
          <SkeletonPanel rows={4} />
        </React.Fragment>
      ) : (
        <React.Fragment key="loaded">
          {/* Stats row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 mb-6">
            <div className="rounded-2xl p-[18px]" style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}>
              <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>Rating</p>
              <p className="text-2xl font-bold mt-2 font-mono" style={{ color: "var(--brand)", fontFamily: "'Space Grotesk', sans-serif" }}>
                {user?.rating || 1200}
              </p>
            </div>
            <div
              onClick={handleGamesClick}
              className="rounded-2xl p-[18px]"
              style={{
                background: "var(--surface-1)",
                border: currentGameId ? "1px solid var(--brand)" : "1px solid var(--hairline)",
                cursor: currentGameId ? "pointer" : "default",
              }}
            >
              <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>Games</p>
              <p className="text-2xl font-bold mt-2" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{user?.games_played || 0}</p>
              {currentGameId && <p className="text-xs mt-2" style={{ color: "var(--brand)" }}>Return to ongoing match</p>}
            </div>
            <div className="rounded-2xl p-[18px]" style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}>
              <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>Win rate</p>
              <p className="text-2xl font-bold mt-2" style={{ color: "var(--green)", fontFamily: "'Space Grotesk', sans-serif" }}>{winRate}%</p>
            </div>
            <div className="rounded-2xl p-[18px]" style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}>
              <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>Balance</p>
              <p className="text-2xl font-bold mt-2" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                ${user?.wallet_balance?.USDT?.toFixed(2) || "0.00"}
              </p>
            </div>
          </div>

          {/* Available games */}
          <div className="rounded-2xl overflow-hidden" style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}>
            <div className="flex items-center justify-between px-5 pt-[18px] pb-3.5">
              <h2 className="text-[16px] font-bold" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Available games</h2>
              <button
                onClick={() => (currentGameId ? navigate(`/game/${currentGameId}`) : fetchGames())}
                className="text-xs font-semibold"
                style={{ color: currentGameId ? "var(--brand)" : "var(--text-secondary)" }}
                data-testid="available-games-count"
              >
                {games.length} games
              </button>
            </div>

            {games.length === 0 ? (
              <div className="px-5 pb-10 pt-4 text-center" style={{ borderTop: "1px solid var(--hairline)" }}>
                <Users className="w-10 h-10 mx-auto mb-4" style={{ color: "var(--text-muted)" }} />
                <h3 className="text-[15px] font-semibold mb-1">No games available</h3>
                <p className="text-sm mb-5" style={{ color: "var(--text-secondary)" }}>
                  Be the first to create a game and wait for challengers.
                </p>
                <Button onClick={() => setCreateDialogOpen(true)} style={{ background: "var(--brand)", color: "var(--on-brand)" }}>
                  Create game
                </Button>
              </div>
            ) : (
              games.map((game) => {
                const isPlayer =
                  game.white_player?.user_id === user?.user_id || game.black_player?.user_id === user?.user_id;
                const isWaiting = game.status === "waiting";
                const isActive = game.status === "active";
                const canJoin = isWaiting && game.white_player?.user_id !== user?.user_id;
                const canRejoin = isActive && isPlayer;
                const isSpectator = isActive && !isPlayer;
                const currencyTone = CURRENCIES.find((c) => c.value === game.stake_currency)?.tone || "brand";

                return (
                  <div
                    key={game.game_id}
                    className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 px-5 py-4"
                    style={{ borderTop: "1px solid var(--hairline)" }}
                    data-testid={`game-card-${game.game_id}`}
                  >
                    <div className="flex items-center gap-4">
                      <div
                        className="w-10 h-10 rounded-[9px] flex items-center justify-center shrink-0"
                        style={{ background: "var(--surface-2)", border: "1px solid var(--hairline)" }}
                      >
                        {getGameTypeIcon(game.game_type)}
                      </div>
                      <div className="grid gap-2">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-9 w-9">
                            {game.white_player?.picture ? (
                              <AvatarImage src={game.white_player.picture} alt={game.white_player.username} />
                            ) : (
                              <AvatarFallback>{(game.white_player?.username || "?")[0]?.toUpperCase() || "?"}</AvatarFallback>
                            )}
                          </Avatar>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-[14px]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                                {game.white_player?.username || "Unknown"}
                              </span>
                              <span className="text-sm font-mono" style={{ color: "var(--text-muted)" }}>
                                ({game.white_player?.rating || 1200})
                              </span>
                            </div>
                            <div className="text-xs" style={{ color: "var(--text-secondary)" }}>White</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <Avatar className="h-9 w-9">
                            {game.black_player?.picture ? (
                              <AvatarImage src={game.black_player.picture} alt={game.black_player.username} />
                            ) : (
                              <AvatarFallback>{(game.black_player?.username || "?")[0]?.toUpperCase() || "?"}</AvatarFallback>
                            )}
                          </Avatar>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-[14px]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                                {game.black_player?.username || "Waiting"}
                              </span>
                              <span className="text-sm font-mono" style={{ color: "var(--text-muted)" }}>
                                ({game.black_player?.rating || 1200})
                              </span>
                            </div>
                            <div className="text-xs" style={{ color: "var(--text-secondary)" }}>Black</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 text-sm mt-0.5" style={{ color: "var(--text-secondary)" }}>
                          <Clock className="w-3 h-3" />
                          {game.time_control}
                          <span>&middot;</span>
                          <span className="capitalize">{game.game_type}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
                      {game.stake_amount > 0 ? (
                        <div className="px-3.5 py-2 rounded-lg" style={{ background: "var(--surface-2)", border: "1px solid var(--hairline)" }}>
                          <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>Stake</p>
                          <p className="font-mono font-bold text-sm" style={{ color: TONE_VAR[currencyTone] }}>
                            {game.stake_amount} {game.stake_currency}
                          </p>
                        </div>
                      ) : (
                        <div className="px-3.5 py-2 rounded-lg" style={{ background: "var(--surface-2)" }}>
                          <p className="text-sm" style={{ color: "var(--text-muted)" }}>Free play</p>
                        </div>
                      )}

                      <div className="flex items-center gap-2 flex-wrap">
                        {isGameFeaturedNow(game) ? (
                          <div
                            className="px-3.5 py-2 rounded-lg flex items-center gap-1.5"
                            style={{ background: "var(--brand-dim, rgba(212,175,55,0.12))", border: "1px solid var(--brand, #D4AF37)" }}
                            title="Featured at the top of the lobby"
                          >
                            <Rocket className="w-3.5 h-3.5" style={{ color: "var(--brand, #D4AF37)" }} />
                            <span className="text-xs font-semibold" style={{ color: "var(--brand, #D4AF37)" }}>Featured</span>
                          </div>
                        ) : (
                          isWaiting &&
                          game.white_player?.user_id === user?.user_id && (
                            <Button
                              variant="outline"
                              onClick={() => boostGame(game.game_id)}
                              disabled={boostingGame === game.game_id}
                              className="font-semibold"
                              style={{ borderColor: "var(--hairline)", color: "var(--text-primary)" }}
                              title={boostCost != null ? `Feature this game at the top of the lobby — ${boostCost} credits` : "Feature this game at the top of the lobby"}
                              data-testid={`boost-game-btn-${game.game_id}`}
                            >
                              <Rocket className="w-4 h-4 mr-1" />
                              {boostingGame === game.game_id
                                ? "\u2026"
                                : `Boost${boostCost != null ? ` (${boostCost} cr)` : ""}`}
                            </Button>
                          )
                        )}
                        <Button
                          variant="outline"
                          onClick={() => shareMatchLink(game.game_id, "Match")}
                          className="font-semibold"
                          style={{ borderColor: "var(--hairline)", color: "var(--text-primary)" }}
                          title="Copy match link"
                        >
                          <Share2 className="w-4 h-4 mr-1" />
                          Share
                        </Button>
                        <Button
                          onClick={() => joinGame(game.game_id)}
                          disabled={joiningGame === game.game_id || (!canJoin && !canRejoin)}
                          className="font-semibold px-5"
                          style={{ background: "var(--brand)", color: "var(--on-brand)" }}
                          data-testid={`join-game-btn-${game.game_id}`}
                        >
                          {joiningGame === game.game_id ? (
                            "\u2026"
                          ) : canRejoin ? (
                            "Rejoin"
                          ) : isSpectator ? (
                            "In progress"
                          ) : isWaiting ? (
                            <>
                              Join <ChevronRight className="w-4 h-4 ml-1" />
                            </>
                          ) : (
                            "Unavailable"
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </React.Fragment>
      )}
    </div>
  );
}
