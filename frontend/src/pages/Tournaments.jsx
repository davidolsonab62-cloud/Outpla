import { useState, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import io from "socket.io-client";
import BackButton from "@/components/layout/BackButton";
import {
  Trophy,
  Users,
  Clock,
  Coins,
  Zap,
  Timer,
  Target,
  Calendar,
  BarChart3,
  Share2,
  Link2,
  MessageCircle,
  Plus,
  Lock,
} from "lucide-react";
import { SkeletonPanel } from "@/components/ui/skeletons";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || window.location.origin;

const PRIVATE_TOURNAMENT_TIME_CONTROLS = ["3+2", "5+0", "10+0", "15+10", "30+0"];


function CountdownTimer({ targetTime, expiredText = "Starting..." }) {
  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    const calculateTimeLeft = () => {
      const now = new Date();
      const target = new Date(targetTime);
      const diff = target - now;

      if (diff <= 0) {
        setTimeLeft(expiredText);
        return;
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      if (hours > 0) {
        setTimeLeft(`${hours}h ${minutes}m ${seconds}s`);
      } else if (minutes > 0) {
        setTimeLeft(`${minutes}m ${seconds}s`);
      } else {
        setTimeLeft(`${seconds}s`);
      }
    };

    calculateTimeLeft();
    const interval = setInterval(calculateTimeLeft, 1000);
    return () => clearInterval(interval);
  }, [targetTime, expiredText]);

  return <span className="font-mono">{timeLeft}</span>;
}

export default function Tournaments() {
  const { user, token, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tournaments, setTournaments] = useState([]);
  const [myTournaments, setMyTournaments] = useState([]);
  const [activeTab, setActiveTab] = useState("all");
  const [loading, setLoading] = useState(true);
  const [selectedTournament, setSelectedTournament] = useState(null);
  const [leaderboardTournament, setLeaderboardTournament] = useState(null);
  const [joining, setJoining] = useState(false);
  const [leavingId, setLeavingId] = useState(null);

  // Phase 4c: create-your-own private tournament, gated behind credits.
  const [createPrivateOpen, setCreatePrivateOpen] = useState(false);
  const [creatingPrivate, setCreatingPrivate] = useState(false);
  // Phase 5: show cost before the user commits.
  const [privateTournamentCost, setPrivateTournamentCost] = useState(null);

  useEffect(() => {
    if (!token) return;
    axios
      .get(`${API}/credits/feature-costs/private_tournament_create`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => setPrivateTournamentCost(response.data.cost))
      .catch(() => {});
  }, [token]);
  const [privateName, setPrivateName] = useState("");
  const [privateTimeControl, setPrivateTimeControl] = useState("5+0");
  const [privateMinPlayers, setPrivateMinPlayers] = useState("2");
  const [privateMaxPlayers, setPrivateMaxPlayers] = useState("16");
  const [privateDuration, setPrivateDuration] = useState("60");

  useEffect(() => {
    fetchTournaments();
    const interval = setInterval(fetchTournaments, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!token) {
      setMyTournaments([]);
      return;
    }
    fetchMyTournaments();
    const interval = setInterval(fetchMyTournaments, 10000);
    return () => clearInterval(interval);
  }, [token]);

  // Live match-assignment redirect: the instant the backend pairs this
  // player into a new arena match, jump them straight to the board - no
  // waiting on the next 10s poll and no manual "play" click.
  const socketRef = useRef(null);

  useEffect(() => {
    if (!token || !user?.user_id) return;

    socketRef.current = io(BACKEND_URL, {
      transports: ["polling", "websocket"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
      path: "/socket.io",
      autoConnect: false,
    });

    socketRef.current.on("connect", () => {
      socketRef.current.emit("join_user_room", { user_id: user.user_id });
    });

    socketRef.current.on("reconnect", () => {
      socketRef.current.emit("join_user_room", { user_id: user.user_id });
    });

    socketRef.current.on("tournament_match_assigned", (data) => {
      toast.success("Match found - taking you to the board!", { duration: 2000 });
      navigate(`/game/${data.game_id}`);
    });

    // Keep both lists fresh the instant pairings/leaderboard change,
    // instead of waiting on the next poll tick.
    socketRef.current.on("tournament_updated", () => {
      fetchTournaments();
      if (token) fetchMyTournaments();
    });
    socketRef.current.on("tournament_started", () => {
      fetchTournaments();
      if (token) fetchMyTournaments();
    });
    socketRef.current.on("tournament_ended", () => {
      fetchTournaments();
      if (token) fetchMyTournaments();
    });

    socketRef.current.connect();

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, [token, user?.user_id, navigate]);

  const fetchTournaments = async () => {
    try {
      const response = await axios.get(`${API}/tournaments`);
      setTournaments(response.data);
    } catch (error) {
      console.error("Failed to fetch tournaments:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchMyTournaments = async () => {
    try {
      const response = await axios.get(`${API}/tournaments/mine`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setMyTournaments(response.data);
    } catch (error) {
      console.error("Failed to fetch my tournaments:", error);
    }
  };

  // Supports being sent straight to a tournament's leaderboard - e.g. the
  // match/board page navigating to `/tournaments?leaderboard=<tournament_id>`
  // the moment a tournament game ends, instead of players having to find
  // and open it themselves.
  useEffect(() => {
    const targetId = searchParams.get("leaderboard");
    if (!targetId) return;
    const pool = [...myTournaments, ...tournaments];
    const target = pool.find((t) => t.tournament_id === targetId);
    if (target) {
      setLeaderboardTournament(target);
      setActiveTab("mine");
      const next = new URLSearchParams(searchParams);
      next.delete("leaderboard");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, tournaments, myTournaments, setSearchParams]);

  const handleTabChange = (tab) => {
    if (tab === "mine" && !token) {
      toast.error("Log in to see the tournaments you've joined");
      return;
    }
    setActiveTab(tab);
  };

  const displayedTournaments = activeTab === "mine" ? myTournaments : tournaments;
  const sortedLeaderboard = (tournament) =>
    [...(tournament?.leaderboard || [])].sort((a, b) => (b.score || 0) - (a.score || 0));

  const handleJoin = async (tournamentId) => {
    setJoining(true);
    try {
      await axios.post(
        `${API}/tournaments/${tournamentId}/join`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      toast.success("Successfully joined tournament!");
      fetchTournaments();
      if (token) fetchMyTournaments();
      setSelectedTournament(null);
    } catch (error) {
      toast.error(error.response?.data?.detail || "Failed to join tournament");
    } finally {
      setJoining(false);
    }
  };

  const handleLeave = async (tournamentId) => {
    setLeavingId(tournamentId);
    try {
      const response = await axios.post(
        `${API}/tournaments/${tournamentId}/leave`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      toast.success(response.data?.message || "You've left the tournament");
      fetchTournaments();
      if (token) fetchMyTournaments();
      setSelectedTournament(null);
    } catch (error) {
      toast.error(error.response?.data?.detail || "Failed to leave tournament");
    } finally {
      setLeavingId(null);
    }
  };

  // Phase 4c: any logged-in user can create their own private tournament,
  // gated behind credits (see server.py's /tournaments/private). Success
  // shows the invite link/code so the creator can share it, and refreshUser()
  // so the header credits balance updates immediately after the spend.
  const handleCreatePrivateTournament = async () => {
    if (!privateName.trim()) {
      toast.error("Give your tournament a name");
      return;
    }
    setCreatingPrivate(true);
    try {
      const response = await axios.post(
        `${API}/tournaments/private`,
        {
          name: privateName.trim(),
          time_control: privateTimeControl,
          min_players: parseInt(privateMinPlayers, 10) || 2,
          max_players: parseInt(privateMaxPlayers, 10) || 16,
          tournament_type: "arena",
          duration_minutes: parseInt(privateDuration, 10) || 60,
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      toast.success(`"${response.data.name}" created — invite code: ${response.data.invite_code}`);
      refreshUser();
      setCreatePrivateOpen(false);
      setPrivateName("");
      fetchTournaments();
      if (token) fetchMyTournaments();
      setActiveTab("mine");
    } catch (error) {
      console.error("Create private tournament error", error);
      const detail = error?.response?.data?.detail;
      if (error?.response?.status === 402 && detail?.error === "insufficient_credits") {
        toast.error(`Not enough credits — creating a private tournament costs ${detail.cost} credits (you have ${detail.credits_balance}).`, {
          action: { label: "Buy credits", onClick: () => navigate("/wallet") },
        });
        return;
      }
      toast.error(typeof detail === "string" ? detail : "Failed to create tournament");
    } finally {
      setCreatingPrivate(false);
    }
  };

  const getTypeIcon = (type) => {
    switch (type) {
      case "arena":
        return <Zap className="w-5 h-5 text-warn" />;
      case "swiss":
        return <Target className="w-5 h-5 text-info" />;
      default:
        return <Trophy className="w-5 h-5 text-brand" />;
    }
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case "upcoming":
        return <Badge className="bg-brand-dim text-brand border-brand">Upcoming</Badge>;
      case "active":
        return <Badge className="bg-success-dim text-success border-success animate-pulse">Live</Badge>;
      case "completed":
        return <Badge className="bg-surface-2 text-ink-secondary border-hair">Completed</Badge>;
      default:
        return null;
    }
  };

  const isAlreadyJoined = (tournament) => {
    return tournament.players?.some(p => p.user_id === user?.user_id);
  };

  const buildShareText = (tournament) => {
    const ranked = sortedLeaderboard(tournament);
    const medals = ["🥇", "🥈", "🥉"];
    const podium = ranked
      .slice(0, 3)
      .map((p, i) => `${medals[i]} ${p.username} — ${p.score} pt${p.score === 1 ? "" : "s"}`)
      .join("\n");

    const myIndex = ranked.findIndex(p => p.user_id === user?.user_id);
    const myLine = myIndex >= 0
      ? `\n\nMy result: #${myIndex + 1} place, ${ranked[myIndex].score} pt${ranked[myIndex].score === 1 ? "" : "s"} 🎉`
      : "";

    return `🏆 ${tournament.name} just wrapped up on Outpla!\n\n${podium}${myLine}\n\nPlay at ${window.location.origin}/tournaments`;
  };

  const shareToWhatsApp = (tournament) => {
    const text = buildShareText(tournament);
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
  };

  const shareToX = (tournament) => {
    const text = buildShareText(tournament);
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
  };

  const shareGeneric = async (tournament) => {
    const text = buildShareText(tournament);
    if (navigator.share) {
      try {
        await navigator.share({ title: tournament.name, text });
      } catch (error) {
        // User cancelled the share sheet - nothing to do
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Result copied - paste it anywhere!");
    } catch (error) {
      toast.error("Couldn't copy result");
    }
  };

  return (
    <div>
      <div className="max-w-6xl mx-auto">
        <div className="mb-2">
          <BackButton />
        </div>
        <div className="sc-reveal-stagger text-center mb-8">
          <h1
            className="sc-reveal-item text-3xl font-bold mb-2"
            style={{ fontFamily: "'Space Grotesk', sans-serif" }}
            data-testid="tournaments-title"
          >
            <span style={{ color: "var(--brand)" }}>Tournaments</span>
          </h1>
          <p className="sc-reveal-item" style={{ color: "var(--text-secondary)" }}>Compete for prizes in 24/7 tournaments</p>
        </div>

        <div className="flex flex-wrap justify-center gap-3 mb-6">
          <Button
            onClick={() => handleTabChange("all")}
            className={`uppercase tracking-wider font-bold ${
              activeTab === "all"
                ? "bg-brand text-brand-on hover:bg-brand-hover"
                : "bg-transparent border border-hair text-ink-secondary hover:bg-surface-2"
            }`}
            data-testid="all-tournaments-tab"
          >
            All Tournaments
          </Button>
          <Button
            onClick={() => handleTabChange("mine")}
            className={`uppercase tracking-wider font-bold flex items-center gap-2 ${
              activeTab === "mine"
                ? "bg-brand text-brand-on hover:bg-brand-hover"
                : "bg-transparent border border-hair text-ink-secondary hover:bg-surface-2"
            }`}
            data-testid="my-tournaments-tab"
          >
            My Tournaments
            {token && (
              <Badge className="bg-surface-1 text-ink border-hair">{myTournaments.length}</Badge>
            )}
          </Button>
          {token && (
            <Dialog open={createPrivateOpen} onOpenChange={setCreatePrivateOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="outline"
                  className="uppercase tracking-wider font-bold bg-transparent border border-hair text-ink-secondary hover:bg-surface-2 flex items-center gap-2"
                  data-testid="create-private-tournament-btn"
                >
                  <Plus className="w-4 h-4" />
                  Create private
                </Button>
              </DialogTrigger>
              <DialogContent
                className="max-w-md"
                style={{ background: "var(--surface-1)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
              >
                <DialogHeader>
                  <DialogTitle style={{ fontFamily: "'Space Grotesk', sans-serif" }} className="flex items-center gap-2">
                    <Lock className="w-4 h-4 text-brand" />
                    Create private tournament
                  </DialogTitle>
                </DialogHeader>
                <div className="space-y-4 pt-2">
                  <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                    Costs credits to create. You'll get an invite code to share — friends join with it, no one else sees it in the public list.
                  </p>
                  <div className="space-y-2">
                    <Label style={{ color: "var(--text-secondary)" }}>Name</Label>
                    <Input
                      value={privateName}
                      onChange={(e) => setPrivateName(e.target.value)}
                      placeholder="Friday Night Blitz"
                      style={{ background: "var(--surface-2)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
                      data-testid="private-tournament-name-input"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label style={{ color: "var(--text-secondary)" }}>Time control</Label>
                    <Select value={privateTimeControl} onValueChange={setPrivateTimeControl}>
                      <SelectTrigger
                        style={{ background: "var(--surface-2)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
                        data-testid="private-tournament-time-control-select"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent style={{ background: "var(--surface-1)", borderColor: "var(--hairline)" }}>
                        {PRIVATE_TOURNAMENT_TIME_CONTROLS.map((tc) => (
                          <SelectItem key={tc} value={tc}>{tc}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label style={{ color: "var(--text-secondary)" }}>Min players</Label>
                      <Input
                        type="number"
                        min="2"
                        value={privateMinPlayers}
                        onChange={(e) => setPrivateMinPlayers(e.target.value)}
                        className="font-mono"
                        style={{ background: "var(--surface-2)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label style={{ color: "var(--text-secondary)" }}>Max players</Label>
                      <Input
                        type="number"
                        min="2"
                        value={privateMaxPlayers}
                        onChange={(e) => setPrivateMaxPlayers(e.target.value)}
                        className="font-mono"
                        style={{ background: "var(--surface-2)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label style={{ color: "var(--text-secondary)" }}>Duration (minutes)</Label>
                    <Input
                      type="number"
                      min="1"
                      value={privateDuration}
                      onChange={(e) => setPrivateDuration(e.target.value)}
                      className="font-mono"
                      style={{ background: "var(--surface-2)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
                    />
                  </div>
                  <Button
                    onClick={handleCreatePrivateTournament}
                    disabled={creatingPrivate}
                    className="w-full bg-brand text-brand-on hover:bg-brand-hover font-bold uppercase tracking-wider"
                    data-testid="confirm-create-private-tournament-btn"
                  >
                    {creatingPrivate ? (
                      <span className="flex items-center gap-2 justify-center">
                        <div className="w-4 h-4 spinner" />
                        Creating...
                      </span>
                    ) : (
                      `Create tournament${privateTournamentCost != null ? ` (${privateTournamentCost} cr)` : ""}`
                    )}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>

        {loading ? (
          <SkeletonPanel rows={4} title={false} />
        ) : displayedTournaments.length === 0 ? (
          <div
            className="rounded-2xl p-12 text-center"
            style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
          >
            <Trophy className="w-14 h-14 mx-auto mb-4" style={{ color: "var(--text-muted)" }} />
            <h3 className="text-lg font-semibold mb-2">
              {activeTab === "mine" ? "No tournaments joined yet" : "No tournaments available"}
            </h3>
            <p style={{ color: "var(--text-secondary)" }}>
              {activeTab === "mine"
                ? "Join a tournament below to see it here."
                : "Check back soon for upcoming tournaments."}
            </p>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 gap-6">
            {displayedTournaments.map((tournament) => (
              <div
                key={tournament.tournament_id}
                className="bg-surface-1 border border-hair rounded-sm overflow-hidden card-hover"
                data-testid={`tournament-card-${tournament.tournament_id}`}
              >
                {/* Header */}
                <div className="bg-gradient-to-r from-[#7C5CFC]/10 to-transparent p-4 border-b border-hair">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {getTypeIcon(tournament.tournament_type)}
                      <div>
                        <h3 className="text-ink font-semibold text-lg">{tournament.name}</h3>
                        <p className="text-ink-secondary text-sm capitalize">{tournament.tournament_type} Tournament</p>
                      </div>
                    </div>
                    {getStatusBadge(tournament.status)}
                  </div>
                </div>

                {/* Body */}
                <div className="p-4 space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-surface-2 p-3 rounded-sm">
                      <p className="text-ink-secondary text-xs mb-1 flex items-center gap-1">
                        <Clock className="w-3 h-3" /> Time Control
                      </p>
                      <p className="text-ink font-mono font-bold">{tournament.time_control}</p>
                    </div>
                    <div className="bg-surface-2 p-3 rounded-sm">
                      <p className="text-ink-secondary text-xs mb-1 flex items-center gap-1">
                        <Coins className="w-3 h-3" /> Entry Fee
                      </p>
                      <p className="text-brand font-mono font-bold">
                        {tournament.entry_fee} {tournament.entry_currency}
                      </p>
                    </div>
                    <div className="bg-surface-2 p-3 rounded-sm">
                      <p className="text-ink-secondary text-xs mb-1 flex items-center gap-1">
                        <Users className="w-3 h-3" /> Players
                      </p>
                      <p className="text-ink font-mono">
                        <span className="text-success">{tournament.current_players}</span>
                        <span className="text-ink-muted">/{tournament.max_players}</span>
                      </p>
                    </div>
                    <div className="bg-surface-2 p-3 rounded-sm">
                      <p className="text-ink-secondary text-xs mb-1 flex items-center gap-1">
                        <Trophy className="w-3 h-3" /> Prize Pool
                      </p>
                      <p className="text-success font-mono font-bold">
                        {tournament.prize_pool.toFixed(2)} {tournament.entry_currency}
                      </p>
                    </div>
                  </div>

                  {/* Countdown / Status */}
                  {tournament.status === "upcoming" && (
                    <div className="bg-brand-dim border border-brand p-3 rounded-sm text-center">
                      <p className="text-ink-secondary text-xs mb-1">Starts in</p>
                      <p className="text-brand text-xl font-bold">
                        <CountdownTimer targetTime={tournament.start_time} />
                      </p>
                    </div>
                  )}

                  {tournament.status === "active" && (
                    <div className="bg-success-dim border border-success p-3 rounded-sm text-center">
                      <p className="text-success font-bold animate-pulse mb-1">Tournament in Progress!</p>
                      {tournament.end_time && (
                        <p className="text-ink-secondary text-xs">
                          Ends in{" "}
                          <span className="text-success">
                            <CountdownTimer targetTime={tournament.end_time} expiredText="Wrapping up..." />
                          </span>
                        </p>
                      )}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-3">
                    <Button
                      onClick={() => setSelectedTournament(tournament)}
                      variant="outline"
                      className="flex-1 bg-transparent border-hair text-ink hover:bg-surface-2"
                      data-testid={`view-tournament-btn-${tournament.tournament_id}`}
                    >
                      View Details
                    </Button>
                    {tournament.status === "upcoming" && !isAlreadyJoined(tournament) && (
                      <Button
                        onClick={() => handleJoin(tournament.tournament_id)}
                        className="flex-1 bg-brand text-brand-on hover:bg-brand-hover font-bold uppercase tracking-wider btn-scale"
                        data-testid={`join-tournament-btn-${tournament.tournament_id}`}
                      >
                        Join
                      </Button>
                    )}
                    {isAlreadyJoined(tournament) && tournament.status !== "completed" && (
                      <Button
                        onClick={() => handleLeave(tournament.tournament_id)}
                        disabled={leavingId === tournament.tournament_id}
                        variant="outline"
                        className="flex-1 border-red-400/40 text-red-400 hover:bg-red-500/10 bg-transparent"
                        data-testid={`leave-tournament-btn-${tournament.tournament_id}`}
                      >
                        {leavingId === tournament.tournament_id ? (
                          <span className="flex items-center gap-2">
                            <div className="w-4 h-4 spinner" />
                            Leaving...
                          </span>
                        ) : (
                          "Leave"
                        )}
                      </Button>
                    )}
                    {isAlreadyJoined(tournament) && tournament.status === "completed" && (
                      <Button
                        disabled
                        className="flex-1 bg-success-dim text-success border border-success"
                      >
                        Joined
                      </Button>
                    )}
                  </div>

                  {(tournament.leaderboard?.length > 0 || tournament.status !== "upcoming") && (
                    <button
                      onClick={() => setLeaderboardTournament(tournament)}
                      className="w-full flex items-center justify-center gap-2 text-ink-secondary hover:text-ink text-sm py-1"
                      data-testid={`leaderboard-btn-${tournament.tournament_id}`}
                    >
                      <BarChart3 className="w-4 h-4" /> Leaderboard
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>


      {/* Tournament Details Dialog */}
      <Dialog open={!!selectedTournament} onOpenChange={() => setSelectedTournament(null)}>
        <DialogContent className="bg-surface-1 border-hair text-ink max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display font-bold text-xl flex items-center gap-2">
              {selectedTournament && getTypeIcon(selectedTournament.tournament_type)}
              {selectedTournament?.name}
            </DialogTitle>
          </DialogHeader>

          {selectedTournament && (
            <div className="space-y-4 pt-2">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-surface-2 p-4 rounded-sm">
                  <p className="text-ink-secondary text-sm mb-1">Time Control</p>
                  <p className="text-ink font-mono text-lg">{selectedTournament.time_control}</p>
                </div>
                <div className="bg-surface-2 p-4 rounded-sm">
                  <p className="text-ink-secondary text-sm mb-1">
                    {selectedTournament.status === "active" ? "Time Remaining" : "Duration"}
                  </p>
                  <p className="text-ink font-mono text-lg">
                    {selectedTournament.status === "active" && selectedTournament.end_time ? (
                      <CountdownTimer targetTime={selectedTournament.end_time} expiredText="Wrapping up..." />
                    ) : (
                      `${selectedTournament.duration_minutes} min`
                    )}
                  </p>
                </div>
                <div className="bg-surface-2 p-4 rounded-sm">
                  <p className="text-ink-secondary text-sm mb-1">Entry Fee</p>
                  <p className="text-brand font-mono text-lg font-bold">
                    {selectedTournament.entry_fee} {selectedTournament.entry_currency}
                  </p>
                </div>
                <div className="bg-surface-2 p-4 rounded-sm">
                  <p className="text-ink-secondary text-sm mb-1">Prize Pool</p>
                  <p className="text-success font-mono text-lg font-bold">
                    {selectedTournament.prize_pool.toFixed(2)} {selectedTournament.entry_currency}
                  </p>
                </div>
              </div>

              <div className="bg-surface-2 p-4 rounded-sm">
                <p className="text-ink-secondary text-sm mb-2">Prize Distribution</p>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-warn">🥇 1st Place</span>
                    <span className="font-mono">50% of pool</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#C0C0C0]">🥈 2nd Place</span>
                    <span className="font-mono">30% of pool</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#CD7F32]">🥉 3rd Place</span>
                    <span className="font-mono">20% of pool</span>
                  </div>
                </div>
              </div>

              <div className="bg-surface-2 p-4 rounded-sm">
                <div className="flex justify-between items-center mb-2">
                  <p className="text-ink-secondary text-sm">Players</p>
                  <span className="text-ink-muted text-sm">
                    {selectedTournament.current_players}/{selectedTournament.max_players}
                  </span>
                </div>
                <div className="w-full bg-surface-1 rounded-full h-2">
                  <div
                    className="bg-brand h-2 rounded-full transition-all"
                    style={{
                      width: `${(selectedTournament.current_players / selectedTournament.max_players) * 100}%`,
                    }}
                  />
                </div>
              </div>

              {selectedTournament.status === "upcoming" && !isAlreadyJoined(selectedTournament) && (
                <Button
                  onClick={() => handleJoin(selectedTournament.tournament_id)}
                  disabled={joining}
                  className="w-full bg-brand text-brand-on hover:bg-brand-hover font-bold uppercase tracking-wider btn-scale"
                >
                  {joining ? (
                    <span className="flex items-center gap-2">
                      <div className="w-4 h-4 spinner" />
                      Joining...
                    </span>
                  ) : (
                    `Join Tournament (${selectedTournament.entry_fee} ${selectedTournament.entry_currency})`
                  )}
                </Button>
              )}

              {isAlreadyJoined(selectedTournament) && (
                <div className="bg-success-dim border border-success p-3 rounded-sm text-center space-y-2">
                  <p className="text-success">You're registered for this tournament!</p>
                  {selectedTournament.status !== "completed" && (
                    <Button
                      onClick={() => handleLeave(selectedTournament.tournament_id)}
                      disabled={leavingId === selectedTournament.tournament_id}
                      variant="outline"
                      className="w-full border-red-400/40 text-red-400 hover:bg-red-500/10 bg-transparent"
                    >
                      {leavingId === selectedTournament.tournament_id ? (
                        <span className="flex items-center gap-2 justify-center">
                          <div className="w-4 h-4 spinner" />
                          Leaving...
                        </span>
                      ) : selectedTournament.status === "upcoming" ? (
                        "Leave Tournament (refund entry fee)"
                      ) : (
                        "Leave Tournament"
                      )}
                    </Button>
                  )}
                </div>
              )}

              <button
                onClick={() => {
                  setLeaderboardTournament(selectedTournament);
                  setSelectedTournament(null);
                }}
                className="w-full flex items-center justify-center gap-2 text-ink-secondary hover:text-ink text-sm py-1"
              >
                <BarChart3 className="w-4 h-4" /> View Leaderboard
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Leaderboard Dialog */}
      <Dialog open={!!leaderboardTournament} onOpenChange={() => setLeaderboardTournament(null)}>
        <DialogContent className="bg-surface-1 border-hair text-ink max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display font-bold text-xl flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-brand" />
              Leaderboard — {leaderboardTournament?.name}
            </DialogTitle>
          </DialogHeader>

          {leaderboardTournament && (
            <div className="space-y-4 pt-2">
              {sortedLeaderboard(leaderboardTournament).length === 0 ? (
                <p className="text-ink-secondary text-sm text-center py-6">
                  No results yet — check back once matches start.
                </p>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {sortedLeaderboard(leaderboardTournament).map((entry, index) => {
                    const isMe = entry.user_id === user?.user_id;
                    const medal = ["🥇", "🥈", "🥉"][index];
                    return (
                      <div
                        key={entry.user_id}
                        className={`flex items-center justify-between p-3 rounded-sm border ${
                          isMe ? "bg-brand-dim border-brand" : "bg-surface-2 border-hair"
                        }`}
                        data-testid={`leaderboard-row-${entry.user_id}`}
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-lg w-6 text-center">{medal || index + 1}</span>
                          <div>
                            <p className="text-ink font-semibold">
                              {entry.username}
                              {isMe && <span className="text-brand"> (You)</span>}
                            </p>
                            <p className="text-ink-secondary text-xs">
                              {entry.games_played || 0} game{entry.games_played === 1 ? "" : "s"} played
                            </p>
                            <p className="text-ink-secondary text-xs font-mono">
                              <span className="text-success">{entry.wins || 0}W</span>
                              {" - "}
                              <span className="text-danger" style={{ color: "#f87171" }}>{entry.losses || 0}L</span>
                              {" - "}
                              <span className="text-ink-muted">{entry.draws || 0}D</span>
                            </p>
                          </div>
                        </div>
                        <span className="text-ink font-mono font-bold text-lg">{entry.score}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {leaderboardTournament.status === "completed" && (
                <div className="bg-surface-2 p-4 rounded-sm space-y-3">
                  <p className="text-ink-secondary text-sm">Share your result</p>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => shareToWhatsApp(leaderboardTournament)}
                      className="flex-1 bg-[#25D366] text-black hover:opacity-90 font-semibold flex items-center justify-center gap-2"
                    >
                      <MessageCircle className="w-4 h-4" /> WhatsApp
                    </Button>
                    <Button
                      onClick={() => shareToX(leaderboardTournament)}
                      variant="outline"
                      className="flex-1 bg-transparent border-hair text-ink hover:bg-surface-1 flex items-center justify-center gap-2"
                    >
                      <Share2 className="w-4 h-4" /> X
                    </Button>
                    <Button
                      onClick={() => shareGeneric(leaderboardTournament)}
                      variant="outline"
                      className="flex-1 bg-transparent border-hair text-ink hover:bg-surface-1 flex items-center justify-center gap-2"
                    >
                      <Link2 className="w-4 h-4" /> {navigator.share ? "More" : "Copy"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
