import { useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { toast } from "sonner";
import { useAuth, API } from "@/App";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Cpu, Users, Search } from "lucide-react";

/**
 * Shared "Play" dialog: lets the user pick Play computer (-> /play-computer)
 * or Play active users (rating-matched via POST /api/matchmaking/find).
 * Used from both the sidebar nav and the Lobby page's Play button so the
 * matchmaking call and its UI live in exactly one place.
 *
 * `open`/`onOpenChange` are controlled by the caller (it decides how the
 * dialog gets triggered - a sidebar row, a header button, etc).
 * `timeControl`/`gameType` default to a sensible rapid game since callers
 * like the sidebar have no game-creation form of their own to read from.
 */
export default function PlayMenuDialog({ open, onOpenChange, timeControl = "10+0", gameType = "rapid" }) {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [findingMatch, setFindingMatch] = useState(false);

  const handlePlayComputer = () => {
    onOpenChange(false);
    navigate("/play-computer");
  };

  // Asks the backend to either drop us into someone else's compatible open
  // match, or open a new one for us to wait in - either way we land on
  // /game/:id, same as creating or joining a game manually. Rating
  // compatibility is enforced server-side using the same challenge_preferences
  // saved on the Profile page.
  const handlePlayActiveUsers = async () => {
    setFindingMatch(true);
    try {
      const res = await axios.post(
        `${API}/matchmaking/find`,
        { time_control: timeControl, game_type: gameType },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const game = res.data;
      onOpenChange(false);
      if (game.status === "active") {
        toast.success("Opponent found! Starting match…");
      } else {
        toast("Searching for an opponent — you'll be matched automatically.", { duration: 5000 });
      }
      navigate(`/game/${game.game_id}`);
    } catch (error) {
      console.error("Matchmaking error", error);
      toast.error(error.response?.data?.detail || "Unable to find a match right now");
    } finally {
      setFindingMatch(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        style={{ background: "var(--surface-1)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
      >
        <DialogHeader>
          <DialogTitle style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Play</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <button
            type="button"
            onClick={handlePlayComputer}
            className="w-full flex items-center gap-4 rounded-2xl p-4 text-left transition-colors"
            style={{ background: "var(--surface-2)", border: "1px solid var(--hairline)" }}
            data-testid="play-computer-btn"
          >
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
            >
              <Cpu className="w-5 h-5" style={{ color: "var(--blue)" }} />
            </div>
            <div>
              <p className="font-semibold text-[15px]">Play computer</p>
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                Practice against Stockfish at your chosen difficulty.
              </p>
            </div>
          </button>

          <button
            type="button"
            onClick={handlePlayActiveUsers}
            disabled={findingMatch}
            className="w-full flex items-center gap-4 rounded-2xl p-4 text-left transition-colors disabled:opacity-60"
            style={{ background: "var(--surface-2)", border: "1px solid var(--hairline)" }}
            data-testid="play-active-users-btn"
          >
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
            >
              {findingMatch ? (
                <Search className="w-5 h-5 animate-pulse" style={{ color: "var(--brand)" }} />
              ) : (
                <Users className="w-5 h-5" style={{ color: "var(--brand)" }} />
              )}
            </div>
            <div>
              <p className="font-semibold text-[15px]">{findingMatch ? "Searching…" : "Play active users"}</p>
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                Matched with another player using your rating range from Profile.
              </p>
            </div>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
