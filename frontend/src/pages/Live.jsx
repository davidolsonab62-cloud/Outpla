import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { API, useAuth } from "@/App";
import axios from "axios";
import io from "socket.io-client";
import { toast } from "sonner";
import { Clock, ChevronRight, ShieldOff, RefreshCw } from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";

export default function Live() {
  const { user, token } = useAuth();
  const navigate = useNavigate();
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const socketRef = useRef(null);

  const fetchLiveGames = async () => {
    setLoading(true);
    try {
      const requestConfig = {
        withCredentials: true,
      };
      if (token) {
        requestConfig.headers = { Authorization: `Bearer ${token}` };
      }
      const response = await axios.get(`${API}/games?status=active`, requestConfig);
      setGames(response.data || []);
    } catch (error) {
      console.error("Failed to load live games", error);
      toast.error("Unable to load live matches");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    fetchLiveGames();

    const backendUrl = process.env.REACT_APP_BACKEND_URL || window.location.origin;
    socketRef.current = io(backendUrl, {
      transports: ["polling", "websocket"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      path: "/socket.io",
      autoConnect: false,
    });

    socketRef.current.on("connect", () => {
      console.log("Live socket connected", socketRef.current.id);
      socketRef.current.emit("join_user_room", { user_id: user?.user_id });
    });

    socketRef.current.on("game_created", () => {
      fetchLiveGames();
    });

    socketRef.current.on("game_started", () => {
      fetchLiveGames();
    });

    socketRef.current.on("player_joined", () => {
      fetchLiveGames();
    });

    socketRef.current.connect();

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, [token, user?.user_id]);

  const handleWatch = (gameId) => {
    navigate(`/game/${gameId}`);
  };

  return (
    <div className="min-h-screen p-6 bg-surface-1">
      <div className="max-w-5xl mx-auto">
        <PageHeader title="Watch Live Matches" subtitle="Spectate active public games and join the commentary flow.">
          <Button size="sm" variant="outline" onClick={fetchLiveGames} className="font-semibold">
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
        </PageHeader>

        {loading ? (
          <div className="rounded-3xl border border-hair bg-surface-2 p-8 text-center text-ink-secondary">Loading live games…</div>
        ) : games.length === 0 ? (
          <div className="rounded-3xl border border-hair bg-surface-2 p-10 text-center text-ink-secondary">
            <ShieldOff className="w-10 h-10 mx-auto mb-4" />
            <p className="text-lg font-semibold">No live games found.</p>
            <p className="text-sm mt-2">Check back soon or create a match in the lobby to watch live action.</p>
          </div>
        ) : (
          <div className="grid gap-4">
            {games.map((game) => {
              const isPlayer =
                game.white_player?.user_id === user?.user_id ||
                game.black_player?.user_id === user?.user_id;
              const allowSpectators =
                game.white_player?.allow_spectators !== false &&
                game.black_player?.allow_spectators !== false;
              const actionText = isPlayer ? "View game" : allowSpectators ? "Spectate" : "View details";

              return (
                <div
                  key={game.game_id}
                  className="rounded-3xl border border-hair bg-surface-1 p-5 shadow-sm"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <span className="text-sm font-semibold text-ink">Game ID:</span>
                        <span className="text-sm text-ink-secondary">{game.game_id}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <Badge className="bg-success-dim text-success border-success">Live</Badge>
                        <span className="text-sm text-ink-secondary">{game.time_control}</span>
                        <span className="text-sm text-ink-secondary">{game.game_type || "Rapid"}</span>
                        <span className="text-sm text-ink-secondary">Chat: {game.white_player?.allow_chat_broadcast !== false && game.black_player?.allow_chat_broadcast !== false ? "On" : "Off"}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleWatch(game.game_id)}
                        disabled={!isPlayer && !allowSpectators}
                      >
                        {actionText} <ChevronRight className="w-4 h-4 ml-1" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-3 mt-5 text-sm text-ink-secondary">
                    <div className="rounded-2xl border border-hair bg-surface-2 p-4">
                      <div className="flex items-center gap-3">
                        <Avatar className="h-10 w-10">
                          {game.white_player?.picture ? (
                            <AvatarImage src={game.white_player.picture} alt={game.white_player.username} />
                          ) : (
                            <AvatarFallback>{(game.white_player?.username || "?")[0]?.toUpperCase() || "?"}</AvatarFallback>
                          )}
                        </Avatar>
                        <div>
                          <p className="font-semibold text-ink">White</p>
                          <p>{game.white_player?.username || "Unknown"}</p>
                          <p className="mt-1">{game.white_player?.rating ?? 1200} ELO</p>
                        </div>
                      </div>
                    </div>
                    <div className="rounded-2xl border border-hair bg-surface-2 p-4">
                      <div className="flex items-center gap-3">
                        <Avatar className="h-10 w-10">
                          {game.black_player?.picture ? (
                            <AvatarImage src={game.black_player.picture} alt={game.black_player.username} />
                          ) : (
                            <AvatarFallback>{(game.black_player?.username || "?")[0]?.toUpperCase() || "?"}</AvatarFallback>
                          )}
                        </Avatar>
                        <div>
                          <p className="font-semibold text-ink">Black</p>
                          <p>{game.black_player?.username || "Waiting"}</p>
                          <p className="mt-1">{game.black_player?.rating ?? 1200} ELO</p>
                        </div>
                      </div>
                    </div>
                    <div className="rounded-2xl border border-hair bg-surface-2 p-4">
                      <p className="font-semibold text-ink">Stake</p>
                      <p>{game.stake_amount > 0 ? `${game.stake_amount} ${game.stake_currency}` : "Free play"}</p>
                      <p className="mt-3 text-ink-secondary">Spectator chat: {game.white_player?.allow_chat_broadcast !== false && game.black_player?.allow_chat_broadcast !== false ? "Enabled" : "Disabled"}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
