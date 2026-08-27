import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { API, useAuth } from "@/App";
import axios from "axios";
import { toast } from "sonner";
import { Trophy, Medal, Target, Crown, MessageCircle, ShieldCheck, X } from "lucide-react";
import { SkeletonPanel } from "@/components/ui/skeletons";
import BackButton from "@/components/layout/BackButton";

export default function Leaderboard() {
  const { user, token, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState("rating");
  const [conversationOpen, setConversationOpen] = useState(false);
  const [convPartner, setConvPartner] = useState(null);
  const [convMessages, setConvMessages] = useState([]);
  const [convInput, setConvInput] = useState("");
  // Phase 5: ambient free-daily-challenge-invite status, so the price
  // (once free ones run out) is visible before it's spent, not just
  // after a 402 from the per-row challenge button below.
  const [inviteStatus, setInviteStatus] = useState(null);

  // Listen for incoming direct messages globally
  useEffect(() => {
    const handler = (e) => {
      const msg = e.detail;
      // If conversation modal open and partner matches sender or recipient, append
      if (conversationOpen && convPartner) {
        const otherId = convPartner.user_id;
        if (msg.from_user_id === otherId || msg.to_user_id === otherId) {
          setConvMessages((prev) => [...prev, msg]);
        }
      }
    };

    const challengeHandler = (e) => {
      const challenge = e.detail;
      toast(`${challenge.from_username || "Opponent"} challenged you to a game!`, {
        duration: 7000,
      });
    };

    window.addEventListener("direct_message", handler);
    window.addEventListener("challenge_received", challengeHandler);
    return () => {
      window.removeEventListener("direct_message", handler);
      window.removeEventListener("challenge_received", challengeHandler);
    };
  }, [conversationOpen, convPartner]);

  useEffect(() => {
    fetchLeaderboard();
  }, [sortBy]);

  useEffect(() => {
    if (!token) return;
    axios
      .get(`${API}/challenges/invite-status`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => setInviteStatus(response.data))
      .catch(() => {});
  }, [token]);

  const fetchLeaderboard = async () => {
    setLoading(true);
    try {
      const response = await axios.get(`${API}/leaderboard?sort_by=${sortBy}`);
      setPlayers(response.data);
    } catch (error) {
      console.error("Failed to fetch leaderboard:", error);
    } finally {
      setLoading(false);
    }
  };

  const getRankIcon = (rank) => {
    switch (rank) {
      case 1:
        return <Crown className="w-6 h-6 text-warn" />;
      case 2:
        return <Medal className="w-6 h-6 text-[#C0C0C0]" />;
      case 3:
        return <Medal className="w-6 h-6 text-[#CD7F32]" />;
      default:
        return (
          <span className="text-ink-muted font-mono text-lg w-6 text-center">
            {rank}
          </span>
        );
    }
  };

  return (
    <div>
      <div className="max-w-4xl mx-auto">
        <div className="mb-2">
          <BackButton />
        </div>
        <div className="sc-reveal-stagger text-center mb-8">
          <h1
            className="sc-reveal-item text-3xl font-bold mb-2"
            style={{ fontFamily: "'Space Grotesk', sans-serif" }}
            data-testid="leaderboard-title"
          >
            <span style={{ color: "var(--brand)" }}>Leaderboard</span>
          </h1>
          <p className="sc-reveal-item" style={{ color: "var(--text-secondary)" }}>The best players on Outpla</p>
          {inviteStatus && (
            <p className="sc-reveal-item text-xs mt-2" style={{ color: "var(--text-secondary)" }}>
              {inviteStatus.remaining_free > 0
                ? `${inviteStatus.remaining_free} free challenge invites left today`
                : `Out of free challenge invites today — the next one costs ${inviteStatus.cost ?? "?"} credits`}
            </p>
          )}
        </div>

        <Tabs
          defaultValue="rating"
          value={sortBy}
          onValueChange={setSortBy}
          className="mb-8"
        >
          <TabsList className="bg-surface-1 border border-hair w-full grid grid-cols-3">
            <TabsTrigger
              value="rating"
              className="data-[state=active]:bg-brand data-[state=active]:text-brand-on"
              data-testid="tab-rating"
            >
              <Trophy className="w-4 h-4 mr-2" />
              Rating
            </TabsTrigger>
            <TabsTrigger
              value="wins"
              className="data-[state=active]:bg-brand data-[state=active]:text-brand-on"
              data-testid="tab-wins"
            >
              <Target className="w-4 h-4 mr-2" />
              Wins
            </TabsTrigger>
            <TabsTrigger
              value="games"
              className="data-[state=active]:bg-brand data-[state=active]:text-brand-on"
              data-testid="tab-games"
            >
              <Medal className="w-4 h-4 mr-2" />
              Games
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {loading ? (
          <SkeletonPanel rows={6} title={false} />
        ) : (
          <div className="overflow-x-auto rounded-sm border border-hair bg-surface-1">
            <table className="min-w-[640px] w-full border-collapse text-sm">
              <thead className="bg-surface-2 text-ink-secondary text-xs uppercase tracking-[0.16em]">
                <tr>
                  <th className="px-3 py-3 text-left">#</th>
                  <th className="px-3 py-3 text-left">Player</th>
                  <th className="px-3 py-3 text-center">Rating</th>
                  <th className="px-3 py-3 text-center">W/L/D</th>
                  <th className="px-3 py-3 text-center">Games</th>
                  <th className="px-3 py-3 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hair">
                {players.map((player, index) => {
                  const rank = index + 1;
                  const isCurrentUser = player.user_id === user?.user_id;
                  const rowBorderClass =
                    rank === 1
                      ? "border-l-4 border-warn"
                      : rank === 2
                      ? "border-l-4 border-[#C0C0C0]"
                      : rank === 3
                      ? "border-l-4 border-[#CD7F32]"
                      : "border-l border-transparent";

                  return (
                    <tr
                      key={player.user_id}
                      className={`group transition-colors hover:bg-surface-2 ${isCurrentUser ? "bg-brand-dim" : ""} ${rowBorderClass}`}
                      data-testid={`leaderboard-row-${rank}`}
                    >
                      <td className="px-3 py-3 align-middle text-left text-ink-secondary">
                        {getRankIcon(rank)}
                      </td>
                      <td className="px-3 py-3 align-middle">
                        <Link
                          to={user ? `/profile/${player.user_id}` : "#"}
                          className="flex items-center gap-3"
                        >
                          <Avatar className="h-10 w-10 rounded-sm">
                            {player.picture ? (
                              <AvatarImage src={player.picture} alt={player.username} />
                            ) : (
                              <AvatarFallback>
                                {player.username?.charAt(0)?.toUpperCase() || "?"}
                              </AvatarFallback>
                            )}
                          </Avatar>
                          <div>
                            <p className="text-ink group-hover:text-brand transition-colors">
                              {player.username}
                              {isCurrentUser && (
                                <span className="text-brand text-xs ml-2">(You)</span>
                              )}
                            </p>
                          </div>
                        </Link>
                      </td>
                      <td className="px-4 py-4 align-middle text-center">
                        <span
                          className={`font-mono font-bold ${
                            rank === 1
                              ? "text-warn"
                              : rank === 2
                              ? "text-[#C0C0C0]"
                              : rank === 3
                              ? "text-[#CD7F32]"
                              : "text-ink"
                          }`}
                        >
                          {player.rating}
                        </span>
                      </td>
                      <td className="px-4 py-4 align-middle text-center font-mono text-sm">
                        <span className="text-success">{player.wins}</span>
                        <span className="text-ink-muted">/</span>
                        <span className="text-danger">{player.losses}</span>
                        <span className="text-ink-muted">/</span>
                        <span className="text-ink-secondary">{player.draws}</span>
                      </td>
                      <td className="px-3 py-3 align-middle text-center text-ink-secondary font-mono">
                        {player.games_played}
                      </td>
                      <td className="px-3 py-3 align-middle text-center">
                        <div className="inline-flex items-center justify-center gap-2">
                          <Button
                            size="icon"
                            variant="outline"
                            aria-label="Send challenge"
                            onClick={async () => {
                              try {
                                const res = await axios.post(`${API}/games`, {
                                  time_control: "5+0",
                                  stake_amount: 0,
                                  stake_currency: "USDT",
                                  game_type: "blitz",
                                  is_private: true
                                }, { headers: { Authorization: `Bearer ${token}` } });

                                const gameId = res.data.game_id;
                                const challengeRes = await axios.post(`${API}/challenges`, { target_user_id: player.user_id, game_id: gameId }, { headers: { Authorization: `Bearer ${token}` } });
                                // Phase 4c: past the free daily challenge limit, sending
                                // this one spent credits - let the sender know why.
                                if (challengeRes.data?.credits_charged) {
                                  toast.success('Challenge sent (used a paid invite - out of free ones for today)');
                                  refreshUser();
                                } else {
                                  toast.success('Challenge sent');
                                }
                                axios
                                  .get(`${API}/challenges/invite-status`, { headers: { Authorization: `Bearer ${token}` } })
                                  .then((response) => setInviteStatus(response.data))
                                  .catch(() => {});
                              } catch (e) {
                                console.error('Failed to send challenge', e);
                                const detail = e?.response?.data?.detail;
                                if (e?.response?.status === 402 && detail?.error === 'insufficient_credits') {
                                  toast.error(`Not enough credits — an extra challenge invite costs ${detail.cost} credits (you have ${detail.credits_balance}).`, {
                                    action: { label: 'Buy credits', onClick: () => navigate('/wallet') },
                                  });
                                  return;
                                }
                                toast.error('Failed to send challenge');
                              }
                            }}
                          >
                            <ShieldCheck className="w-4 h-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Send message"
                            onClick={async () => {
                              setConvPartner(player);
                              setConversationOpen(true);
                              try {
                                const r = await axios.get(`${API}/conversations/${player.user_id}`, { headers: { Authorization: `Bearer ${token}` } });
                                setConvMessages(r.data.messages || []);
                              } catch (e) {
                                console.error('Failed to load conversation', e);
                                setConvMessages([]);
                              }
                            }}
                          >
                            <MessageCircle className="w-4 h-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {players.length === 0 && (
              <div className="p-12 text-center">
                <Trophy className="w-12 h-12 text-ink-muted mx-auto mb-4" />
                <p className="text-ink-secondary">No players yet</p>
              </div>
            )}
          </div>
        )}
        {/* Conversation modal */}
        {conversationOpen && convPartner && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
            <div className="bg-surface-1 p-4 rounded-sm w-full max-w-xl">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-ink">Conversation with {convPartner.username}</h3>
                <Button size="sm" variant="ghost" onClick={() => setConversationOpen(false)}>Close</Button>
              </div>
              <div className="h-64 overflow-y-auto bg-surface-1 p-3 mb-3">
                {convMessages.map((m, i) => (
                  <div key={i} className={`mb-2 ${m.from_user_id === convPartner.user_id ? 'text-ink' : 'text-ink-secondary'}`}>
                    <div className="text-xs text-ink-secondary">{m.timestamp}</div>
                    <div className="text-sm">{m.message}</div>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input className="flex-1 p-2 bg-surface-2 text-ink rounded-sm" value={convInput} onChange={(e) => setConvInput(e.target.value)} />
                <Button
                  onClick={async () => {
                    if (!convInput) return;
                    try {
                      await axios.post(`${API}/messages`, { to_user_id: convPartner.user_id, message: convInput }, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
                      setConvMessages(prev => [...prev, { from_user_id: user.user_id, to_user_id: convPartner.user_id, message: convInput, timestamp: new Date().toISOString() }]);
                      setConvInput("");
                    } catch (e) {
                      console.error('Failed to send DM', e);
                      alert('Failed to send message');
                    }
                  }}
                >Send</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
