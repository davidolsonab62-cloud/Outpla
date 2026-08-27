import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";
import { useAuth, API } from "@/App";
import { resolveBoardPrefs } from "@/utils/boardPrefs";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { toast } from "sonner";
import { RotateCcw, Lock } from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";

// Basic in-house opening explorer, sourced from Outpla's own completed
// games (there's no external opening database in this codebase). The first
// few moves of a line are always free; going deeper costs credits - see
// OPENING_EXPLORER_FREE_PLY on the backend, mirrored here for the UI hint.
const FREE_PLY_HINT = 6;

export default function OpeningExplorer() {
  const { user, token } = useAuth();
  const { boardSquareColors, theme: boardThemeName, color: boardColorName } = resolveBoardPrefs(user);
  const navigate = useNavigate();

  const [chess, setChess] = useState(() => new Chess());
  const [position, setPosition] = useState("start");
  const [uciMoves, setUciMoves] = useState([]);
  const [sanMoves, setSanMoves] = useState([]);
  const [explorer, setExplorer] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [boardWidth, setBoardWidth] = useState(420);
  const boardWrapperRef = useRef(null);
  // Phase 5: numeric cost for looking beyond FREE_PLY_HINT, fetched once
  // so it can be shown ahead of the charge (both as an ambient hint right
  // at the boundary, and in the insufficient_credits panel below) rather
  // than only appearing after a 402.
  const [deepCost, setDeepCost] = useState(null);

  useEffect(() => {
    if (!token) return;
    axios
      .get(`${API}/credits/feature-costs/opening_explorer_deep`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => setDeepCost(response.data.cost))
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    const node = boardWrapperRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setBoardWidth(Math.max(220, Math.floor(entry.contentRect.width)));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const authHeaders = token
    ? { headers: { Authorization: `Bearer ${token}` }, withCredentials: true }
    : { withCredentials: true };

  const queryExplorer = useCallback(
    async (moves) => {
      setLoading(true);
      setError(null);
      try {
        const response = await axios.get(`${API}/opening-explorer`, {
          ...authHeaders,
          params: { moves: moves.join(",") },
        });
        setExplorer(response.data);
      } catch (err) {
        const detail = err?.response?.data?.detail;
        if (err?.response?.status === 402 && detail?.error === "insufficient_credits") {
          toast.error(`Not enough credits — looking this deep costs ${detail.cost} credits (you have ${detail.credits_balance}).`, {
            action: { label: "Buy credits", onClick: () => navigate("/wallet") },
          });
          setError("insufficient_credits");
        } else {
          const message = detail?.detail || detail || err?.message || "Couldn't load opening data.";
          setError(message);
          toast.error(typeof message === "string" ? message : "Couldn't load opening data.");
        }
        setExplorer(null);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token]
  );

  // Load the free root-position stats on mount.
  useEffect(() => {
    queryExplorer([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const playUciMove = useCallback(
    (uciMove) => {
      const trialChess = new Chess(chess.fen());
      const from = uciMove.slice(0, 2);
      const to = uciMove.slice(2, 4);
      const promotion = uciMove.length > 4 ? uciMove.slice(4) : undefined;
      const move = trialChess.move({ from, to, promotion });
      if (!move) return;

      const nextUciMoves = [...uciMoves, uciMove];
      setChess(trialChess);
      setPosition(trialChess.fen());
      setUciMoves(nextUciMoves);
      setSanMoves((prev) => [...prev, move.san]);
      queryExplorer(nextUciMoves);
    },
    [chess, uciMoves, queryExplorer]
  );

  const handlePieceDrop = useCallback(
    ({ sourceSquare, targetSquare }) => {
      if (loading) return false;
      const trialChess = new Chess(chess.fen());
      const move = trialChess.move({ from: sourceSquare, to: targetSquare, promotion: "q" });
      if (!move) return false;

      const nextUciMoves = [...uciMoves, `${sourceSquare}${targetSquare}${move.promotion || ""}`];
      setChess(trialChess);
      setPosition(trialChess.fen());
      setUciMoves(nextUciMoves);
      setSanMoves((prev) => [...prev, move.san]);
      queryExplorer(nextUciMoves);
      return true;
    },
    [chess, uciMoves, loading, queryExplorer]
  );

  const handleReset = useCallback(() => {
    const fresh = new Chess();
    setChess(fresh);
    setPosition("start");
    setUciMoves([]);
    setSanMoves([]);
    queryExplorer([]);
  }, [queryExplorer]);

  const handleBack = useCallback(() => {
    if (uciMoves.length === 0) return;
    const nextUciMoves = uciMoves.slice(0, -1);
    const fresh = new Chess();
    nextUciMoves.forEach((uci) => {
      fresh.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
    });
    setChess(fresh);
    setPosition(fresh.fen());
    setUciMoves(nextUciMoves);
    setSanMoves((prev) => prev.slice(0, -1));
    queryExplorer(nextUciMoves);
  }, [uciMoves, queryExplorer]);

  const isDeep = (explorer?.ply ?? 0) > FREE_PLY_HINT;

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        title="Opening Explorer"
        subtitle="See what Outpla players actually play from this position - drag a piece or click a move below."
      />

      <div className="flex flex-col lg:flex-row gap-6">
        <div ref={boardWrapperRef} className="mx-auto w-full max-w-[480px] rounded-3xl border border-hair bg-surface-1 p-4 box-border">
          <Chessboard
            key={`${boardThemeName}-${boardColorName}`}
            options={{
              id: "OpeningExplorerBoard",
              position,
              boardWidth,
              arePiecesDraggable: !loading,
              darkSquareStyle: { backgroundColor: boardSquareColors.dark },
              lightSquareStyle: { backgroundColor: boardSquareColors.light },
              boardStyle: { borderRadius: "18px" },
              onPieceDrop: handlePieceDrop,
            }}
          />

          <div className="flex items-center justify-between gap-2 mt-4">
            <p className="text-sm text-ink-secondary font-mono truncate">
              {sanMoves.length > 0 ? sanMoves.join(" ") : "Starting position"}
            </p>
            <div className="flex gap-2 shrink-0">
              <Button size="sm" variant="outline" onClick={handleBack} disabled={uciMoves.length === 0 || loading}>
                Back
              </Button>
              <Button size="sm" variant="outline" onClick={handleReset} disabled={loading}>
                <RotateCcw className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 bg-surface-1 border border-hair rounded-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-ink font-semibold text-sm">
              Next moves {explorer ? `(${explorer.total_games} games)` : ""}
            </h3>
            {isDeep && (
              <span className="text-xs text-ink-secondary flex items-center gap-1">
                <Lock className="w-3 h-3" /> Deep lookup
              </span>
            )}
          </div>

          {/* Phase 5: ambient warning right at the free/paid boundary -
              visible before the next move crosses it, not just after. */}
          {!isDeep && !loading && (explorer?.ply ?? 0) === FREE_PLY_HINT && deepCost != null && (
            <p className="text-xs text-ink-secondary mb-3">
              The next move here goes beyond the free {FREE_PLY_HINT / 2}-move lookup — costs {deepCost} credits.
            </p>
          )}

          {loading ? (
            <div className="text-ink-secondary text-sm">Loading opening data...</div>
          ) : error === "insufficient_credits" ? (
            <div className="space-y-3">
              <div className="bg-brand-dim border border-brand rounded-sm p-3">
                <p className="text-sm text-ink font-semibold">Go deeper into this line</p>
                <p className="text-xs text-ink-secondary mt-1">
                  The first {FREE_PLY_HINT / 2} moves are free to explore.
                  {deepCost != null ? ` Going deeper costs ${deepCost} credits.` : " Spend credits to keep going deeper."}
                </p>
              </div>
              <Button size="sm" className="w-full bg-brand text-brand-on hover:bg-brand-hover" onClick={() => navigate("/wallet")}>
                Buy credits
              </Button>
              <Button size="sm" variant="outline" className="w-full" onClick={handleBack}>
                Go back a move
              </Button>
            </div>
          ) : error ? (
            <div className="text-sm text-danger">{error}</div>
          ) : explorer && explorer.next_moves.length > 0 ? (
            <div className="space-y-2">
              {explorer.next_moves.map((item) => (
                <button
                  key={item.move}
                  type="button"
                  onClick={() => playUciMove(item.move)}
                  className="w-full flex items-center justify-between gap-3 rounded-sm bg-surface-2 hover:bg-surface-3 p-3 text-left transition"
                >
                  <span className="font-mono text-sm text-ink font-semibold">{item.move}</span>
                  <span className="text-xs text-ink-secondary">{item.games} games</span>
                  <div className="flex h-2 w-32 overflow-hidden rounded-full">
                    <div className="bg-success" style={{ width: `${item.white_win_pct}%` }} title={`White wins ${item.white_win_pct}%`} />
                    <div className="bg-ink-muted" style={{ width: `${item.draw_pct}%` }} title={`Draws ${item.draw_pct}%`} />
                    <div className="bg-danger" style={{ width: `${item.black_win_pct}%` }} title={`Black wins ${item.black_win_pct}%`} />
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="text-ink-secondary text-sm">
              No Outpla games found from this position yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
