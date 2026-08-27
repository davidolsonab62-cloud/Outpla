import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { API, useAuth } from "@/App";
import axios from "axios";
import { toast } from "sonner";
import { ShieldCheck, X, Clock, User } from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";

export default function ChallengeQueue() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [challenges, setChallenges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeChallenge, setActiveChallenge] = useState(null);

  useEffect(() => {
    fetchChallenges();
  }, []);

  const fetchChallenges = async () => {
    setLoading(true);
    try {
      const response = await axios.get(`${API}/challenges/pending`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setChallenges(response.data.challenges || []);
    } catch (error) {
      console.error("Failed to load pending challenges", error);
      toast.error("Unable to load challenge requests");
    } finally {
      setLoading(false);
    }
  };

  const acceptChallenge = async (challenge) => {
    try {
      await axios.post(`${API}/challenges/${challenge.challenge_id}/accept`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      toast.success("Challenge accepted");
      setChallenges((prev) => prev.filter((item) => item.challenge_id !== challenge.challenge_id));
      if (challenge.game_id) {
        navigate(`/game/${challenge.game_id}`);
      }
    } catch (error) {
      console.error("Accept challenge failed", error);
      toast.error(error.response?.data?.detail || "Unable to accept challenge");
    }
  };

  const rejectChallenge = async (challenge) => {
    try {
      await axios.post(`${API}/challenges/${challenge.challenge_id}/reject`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      toast.success("Challenge rejected");
      setChallenges((prev) => prev.filter((item) => item.challenge_id !== challenge.challenge_id));
    } catch (error) {
      console.error("Reject challenge failed", error);
      toast.error(error.response?.data?.detail || "Unable to reject challenge");
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader title="Challenge Queue" subtitle="Accept or reject pending match requests from other players.">
        <Button size="sm" variant="outline" onClick={fetchChallenges}>
          Refresh
        </Button>
      </PageHeader>

      <div className="rounded-2xl border border-hair bg-surface-1 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-ink-secondary">Loading challenges…</div>
        ) : challenges.length === 0 ? (
          <div className="p-12 text-center text-ink-secondary">You have no pending challenge requests.</div>
        ) : (
          <div className="divide-y divide-hair">
            {challenges.map((challenge) => (
              <div key={challenge.challenge_id} className="p-4 md:p-5 flex flex-col md:flex-row md:items-center gap-4 md:gap-6">
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-2 text-ink">
                    <ShieldCheck className="w-4 h-4" />
                    <span className="font-semibold">{challenge.from_username || challenge.from_user_id}</span>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 text-sm text-ink-secondary">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.2em] mb-1">Game ID</div>
                      <div>{challenge.game_id || "N/A"}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.2em] mb-1">Message</div>
                      <div>{challenge.message || "No message provided."}</div>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 items-center">
                  <Button size="icon" variant="outline" onClick={() => rejectChallenge(challenge)}>
                    <X className="w-4 h-4" />
                  </Button>
                  <Button size="icon" onClick={() => acceptChallenge(challenge)}>
                    <ShieldCheck className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
