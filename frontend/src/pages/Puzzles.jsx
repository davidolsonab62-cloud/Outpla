import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";
import { useAuth, API } from "@/App";
import { resolveBoardPrefs } from "@/utils/boardPrefs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import axios from "axios";
import { toast } from "sonner";
import { RefreshCw, Lightbulb, Sparkles } from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";

export default function Puzzles() {
  const { user, token, loading: authLoading } = useAuth();
  const { boardSquareColors, theme: boardThemeName, color: boardColorName } = resolveBoardPrefs(user);
  const navigate = useNavigate();
  const [puzzle, setPuzzle] = useState(null);
  const [progress, setProgress] = useState(null);
  const [packs, setPacks] = useState(null);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(true);
  const [solving, setSolving] = useState(false);
  const [hintsVisible, setHintsVisible] = useState(0);
  const [boardWidth, setBoardWidth] = useState(520);
  // Measures the actual rendered width of the board's wrapper (rather than
  // guessing from window.innerWidth) so the board always fits its container
  // exactly, including on narrow phones where sidebar/page/card padding
  // eats into the available space.
  const boardWrapperRef = useRef(null);
  const [statusMessage, setStatusMessage] = useState(null);
  const [chess, setChess] = useState(() => new Chess());
  const [position, setPosition] = useState("start");
  // The last position the server has confirmed as correct - a wrong guess
  // reverts here, not all the way back to the puzzle's starting FEN, since
  // a puzzle can be several correct plies deep when a wrong guess happens.
  const [confirmedFen, setConfirmedFen] = useState(null);
  const [puzzleSolved, setPuzzleSolved] = useState(false);
  // True for the brief window while the opponent's scripted reply is being
  // played out on the board, so the player can't drag a piece mid-animation.
  const [opponentThinking, setOpponentThinking] = useState(false);
  const isAuthenticated = Boolean(token || user);
  const authHeaders = token
    ? { headers: { Authorization: `Bearer ${token}` }, withCredentials: true }
    : { withCredentials: true };

  const puzzleTitle = puzzle?.title || (puzzle?.puzzle_id ? `Puzzle ${puzzle.puzzle_id}` : "Loading next puzzle");
  const puzzleDescription = puzzle?.description || puzzle?.objective || "This puzzle's goal will appear once the position loads.";
  const puzzleSideToMove = puzzle?.side_to_move || "White";

  // Tracks the wrapper's own content width via ResizeObserver, so the board
  // is sized to what's actually available (accounting for page padding,
  // card padding, and the sidebar) instead of a rough viewport estimate.
  useEffect(() => {
    const node = boardWrapperRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.max(200, Math.floor(entry.contentRect.width));
      setBoardWidth(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const fetchProgress = useCallback(async () => {
    const headers = token
      ? { headers: { Authorization: `Bearer ${token}` }, withCredentials: true }
      : { withCredentials: true };

    try {
      const response = await axios.get(`${API}/puzzles/progress`, headers);
      setProgress(response.data);
    } catch (error) {
      console.error("Failed to fetch puzzle progress", error);
    }
  }, [token]);

  const fetchPacks = useCallback(async () => {
    const headers = token
      ? { headers: { Authorization: `Bearer ${token}` }, withCredentials: true }
      : { withCredentials: true };
    try {
      const response = await axios.get(`${API}/puzzles/packs`, headers);
      setPacks(response.data.packs || []);
    } catch (error) {
      console.error("Failed to fetch puzzle packs", error);
    }
  }, [token]);

  // Phase 5: ambient "X free skips/retries left today" - fetched
  // read-only so the price is visible before the user runs out, not only
  // after a 402. Refreshed alongside packs/progress since a skip or a
  // wrong guess both change it.
  const [budgetStatus, setBudgetStatus] = useState(null);
  const fetchBudgetStatus = useCallback(async () => {
    if (!token) return;
    try {
      const response = await axios.get(`${API}/puzzles/budget-status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setBudgetStatus(response.data);
    } catch (error) {
      console.error("Failed to fetch puzzle budget status", error);
    }
  }, [token]);

  const fetchPuzzle = useCallback(async (difficultyOverride) => {
    const headers = token
      ? { headers: { Authorization: `Bearer ${token}` }, withCredentials: true }
      : { withCredentials: true };

    setLoading(true);
    setStatusMessage(null);
    setAnswer("");
    setHintsVisible(0);
    setPuzzle(null);
    setPuzzleSolved(false);
    setOpponentThinking(false);

    try {
      // /puzzles/next both hands back the puzzle to display AND opens a
      // fresh server-side solving session (attempt_id) that the board's
      // moves get checked against, one ply at a time. Requesting a new
      // puzzle while the last one is unsolved counts as a skip server-side
      // (Phase 4b) - free up to a daily limit, then charged in credits.
      // Picking a difficulty above the one you've naturally earned is a
      // "pack" unlock, also charged in credits (see /puzzles/packs).
      const params = {};
      if (difficultyOverride) params.difficulty = difficultyOverride;
      const response = await axios.get(`${API}/puzzles/next`, { ...headers, params });
      const newChess = new Chess(response.data.fen);
      setChess(newChess);
      setPosition(newChess.fen());
      setConfirmedFen(newChess.fen());
      setPuzzle(response.data);
      setStatusMessage(null);
      fetchPacks();
      fetchBudgetStatus();
    } catch (error) {
      console.error("Failed to load next puzzle", error);
      const detail = error?.response?.data?.detail;
      if (error?.response?.status === 402 && detail?.error === "insufficient_credits") {
        const label = detail.feature_key === "puzzle_pack" ? "unlocking this puzzle pack" : "skipping this puzzle";
        toast.error(`Not enough credits — ${label} costs ${detail.cost} credits (you have ${detail.credits_balance}).`, {
          action: { label: "Buy credits", onClick: () => navigate("/wallet") },
        });
        setStatusMessage("Not enough credits for that. Your current puzzle is still active.");
        setLoading(false);
        return;
      }
      setPuzzle(null);
      setStatusMessage(
        detail || "Unable to load a puzzle right now. Try again later."
      );
    } finally {
      setLoading(false);
    }
  }, [token, navigate, fetchPacks, fetchBudgetStatus]);



  useEffect(() => {
    if (!authLoading) {
      if (isAuthenticated) {
        fetchProgress();
        fetchPuzzle();
        fetchPacks();
        fetchBudgetStatus();
      } else {
        setLoading(false);
        setPuzzle(null);
        setProgress(null);
        setStatusMessage("Please log in to load puzzles.");
      }
    }
  }, [authLoading, isAuthenticated, fetchProgress, fetchPuzzle, fetchPacks, fetchBudgetStatus]);

  // Shared by drag-and-drop and the typed-move box: apply a move to a copy
  // of the current position using chess.js's own legal-move generator.
  // Returns null for anything illegal (including moves that are fine in
  // general chess but not legal in THIS position) so an illegal move never
  // reaches the server and never gets shown on the board.
  const applyLocalMove = (moveInput) => {
    const trialChess = new Chess(chess.fen());
    let move = null;
    try {
      move = trialChess.move(moveInput);
    } catch (err) {
      move = null;
    }
    return move ? { move, trialChess } : null;
  };

  // Checks one ply against the puzzle's next expected move, then handles
  // whatever the server says: wrong (revert to the last confirmed
  // position), right-but-more-to-go (auto-play the opponent's one scripted
  // reply and wait for the next player move), or right-and-done (award
  // credit, then load the next puzzle).
  const submitPly = async (san, trialChess) => {
    setSolving(true);
    try {
      const response = await axios.post(
        `${API}/puzzles/attempts/${puzzle.attempt_id}/move`,
        { move: san },
        authHeaders
      );

      if (!response.data.correct) {
        toast.error(response.data.message || "Incorrect move.");
        setStatusMessage(response.data.message || "Incorrect. Try again.");
        const revertChess = new Chess(confirmedFen);
        setChess(revertChess);
        setPosition(revertChess.fen());
        fetchBudgetStatus();
        return;
      }
      let latestFen = trialChess.fen();
      setConfirmedFen(latestFen);

      if (response.data.opponent_move) {
        // Reveal the opponent's forced reply on the board itself, not just
        // in text, so the sequence actually plays out like a real puzzle.
        setOpponentThinking(true);
        await new Promise((resolve) => setTimeout(resolve, 450));
        const afterOpponent = new Chess(latestFen);
        afterOpponent.move(response.data.opponent_move);
        latestFen = afterOpponent.fen();
        setChess(afterOpponent);
        setPosition(latestFen);
        setConfirmedFen(latestFen);
        setOpponentThinking(false);
      }

      if (response.data.puzzle_complete) {
        toast.success(response.data.message || "Solved!");
        setStatusMessage(response.data.message || "Puzzle solved!");
        setPuzzleSolved(true);
        await fetchProgress();
        // Let the finished position sit on screen for a beat before the
        // next puzzle replaces it.
        setTimeout(() => fetchPuzzle(), 900);
      } else {
        setStatusMessage(response.data.message || "Correct! Find the next move.");
      }
    } catch (error) {
      console.error("Puzzle move failed", error);
      const detail = error?.response?.data?.detail;
      if (error?.response?.status === 402 && detail?.error === "insufficient_credits") {
        // Out of free daily retries (Phase 4b) and can't afford another -
        // don't reset the board, just let them stop and think instead of
        // burning another guess.
        toast.error(`Out of free retries for today — another guess costs ${detail.cost} credits (you have ${detail.credits_balance}).`, {
          action: { label: "Buy credits", onClick: () => navigate("/wallet") },
        });
        setStatusMessage("Out of free retries for today. Buy credits to keep guessing, or come back tomorrow.");
        return;
      }
      toast.error(
        detail?.detail || detail || error.response?.data?.message || "Failed to submit move."
      );
      setStatusMessage("Failed to submit your move. Please try again.");
      const revertChess = new Chess(confirmedFen);
      setChess(revertChess);
      setPosition(revertChess.fen());
    } finally {
      setSolving(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!puzzle || !answer.trim() || solving || puzzleSolved || opponentThinking) {
      return;
    }
    const result = applyLocalMove(answer.trim());
    if (!result) {
      toast.error("That's not a legal move in this position.");
      setStatusMessage("That's not a legal move in this position.");
      return;
    }
    const { move, trialChess } = result;
    setChess(trialChess);
    setPosition(trialChess.fen());
    setAnswer("");
    await submitPly(move.san, trialChess);
  };

  const renderHints = () => {
    if (!puzzle?.hints?.length) {
      return <p style={{ color: "var(--text-secondary)" }}>No hints available for this puzzle.</p>;
    }

    return puzzle.hints.slice(0, hintsVisible).map((hint, index) => (
      <div
        key={index}
        className="rounded-sm border border-hair bg-surface-2 p-3 text-sm" style={{ color: "var(--text-primary)" }}
      >
        <span className="font-semibold">Hint {index + 1}:</span> {hint}
      </div>
    ));
  };

  if (!authLoading && !isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6" style={{ background: "var(--surface-0)" }}>
        <div className="max-w-xl w-full rounded-3xl border border-hair bg-surface-1 p-10 text-center shadow-sm">
          <h1 className="font-heading text-3xl mb-4" style={{ color: "var(--text-primary)" }}>Puzzle Training</h1>
          <p className="mb-6" style={{ color: "var(--text-secondary)" }}>
            Login to access tactical chess puzzles, solve positions, and earn rating.
          </p>
          <Button
            onClick={() => navigate("/login")}
            className="bg-[#D4AF37] text-black hover:bg-[#F4C430]"
          >
            Sign in to start
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: "var(--surface-0)", color: "var(--text-primary)" }}>
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between mb-6">
          <div>
            <PageHeader
              title="Puzzle Training"
              subtitle="Solve tactical positions, earn rating, and progress through harder puzzles."
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-sm border border-hair bg-surface-1 p-4">
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Solved</p>
              <p className="text-2xl font-semibold text-[#D4AF37]">{progress?.solved_count ?? 0}</p>
            </div>
            <div className="rounded-sm border border-hair bg-surface-1 p-4">
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Rating Earned</p>
              <p className="text-2xl font-semibold text-[#00FF94]">{progress?.earned_rating ?? 0}</p>
            </div>
            <div className="rounded-sm border border-hair bg-surface-1 p-4">
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Current Tier</p>
              <p className="text-2xl font-semibold text-[#80CBFF]">{progress?.current_difficulty ?? 1}</p>
            </div>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.28fr_0.72fr]">
          <section className="rounded-3xl border border-hair bg-surface-1 p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full bg-surface-2 px-3 py-1 text-xs uppercase tracking-[0.22em]" style={{ color: "var(--text-primary)" }}>
                  {puzzle ? `Difficulty ${puzzle.difficulty}` : "Loading puzzle..."}
                </div>
                <h2 className="font-heading text-2xl mt-4" style={{ color: "var(--text-primary)" }}>
                  {puzzleTitle}
                </h2>
                {puzzle?.puzzle_id && (
                  <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>ID: {puzzle.puzzle_id}</p>
                )}
                <div className="mt-4 rounded-3xl border border-hair bg-surface-2 p-4 text-sm" style={{ color: "var(--text-primary)" }}>
                  {puzzle ? (
                    <div className="space-y-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                          <p className="text-xs uppercase tracking-[0.18em]" style={{ color: "var(--text-secondary)" }}>Side to move</p>
                          <p className="font-semibold" style={{ color: "var(--text-primary)" }}>{puzzleSideToMove}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs uppercase tracking-[0.18em]" style={{ color: "var(--text-secondary)" }}>Reward</p>
                          <p className="text-[#00FF94] font-semibold">+{puzzle.reward ?? "—"}</p>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs uppercase tracking-[0.18em]" style={{ color: "var(--text-secondary)" }}>Objective</p>
                        <p style={{ color: "var(--text-primary)" }}>{puzzle.objective || "Solve the puzzle to reveal the best tactical move."}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em]" style={{ color: "var(--text-secondary)" }}>Description</p>
                        <p style={{ color: "var(--text-primary)" }}>{puzzleDescription}</p>
                      </div>
                    </div>
                  ) : (
                    <p>{loading ? "Loading a tactical puzzle from the library…" : "Puzzle not loaded yet. Click New Puzzle to start."}</p>
                  )}
                </div>
              </div>
              {puzzle?.reward != null && (
                <div className="rounded-full bg-surface-2 px-4 py-2 text-sm" style={{ color: "var(--text-primary)" }}>
                  Reward: <span className="font-semibold text-[#00FF94]">+{puzzle.reward}</span>
                </div>
              )}
            </div>

            <div className="mt-6 flex flex-col gap-4 lg:flex-row lg:items-start">
              <div ref={boardWrapperRef} className="mx-auto w-full max-w-[560px] rounded-3xl border border-hair bg-surface-1 p-4 box-border">
                {puzzle ? (
                  <Chessboard
                    key={`${boardThemeName}-${boardColorName}`}
                    options={{
                      id: "PuzzleBoard",
                      position: position,
                      boardWidth: boardWidth,
                      arePiecesDraggable: !loading && !solving && !puzzleSolved && !opponentThinking,
                      boardOrientation: puzzle.side_to_move === "Black" ? "black" : "white",
                      darkSquareStyle: { backgroundColor: boardSquareColors.dark },
                      lightSquareStyle: { backgroundColor: boardSquareColors.light },
                      boardStyle: { borderRadius: "18px" },
                      onPieceDrop: ({ sourceSquare, targetSquare }) => {
                        if (solving || puzzleSolved || opponentThinking) return false;
                        // Legality is checked locally first (chess.js rejects
                        // anything that isn't a legal move in this exact
                        // position) - only a genuinely legal move ever gets
                        // shown on the board or sent to the server.
                        const result = applyLocalMove({ from: sourceSquare, to: targetSquare, promotion: "q" });
                        if (!result) return false;
                        const { move, trialChess } = result;
                        setChess(trialChess);
                        setPosition(trialChess.fen());
                        setAnswer("");
                        setStatusMessage(`Checking ${move.san}…`);
                        submitPly(move.san, trialChess);
                        return true;
                      }
                    }}
                  />
                ) : (
                  <div className="min-h-[560px] flex items-center justify-center" style={{ color: "var(--text-secondary)" }}>
                    {loading ? "Loading puzzle…" : "No puzzle loaded. Press New Puzzle."}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-hair bg-surface-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm uppercase tracking-[0.14em]" style={{ color: "var(--text-secondary)" }}>Coaching</p>
                    <p className="mt-2 text-sm" style={{ color: "var(--text-primary)" }}>{puzzle?.coaching || "A short coaching tip will appear once the puzzle loads."}</p>
                  </div>
                  <Lightbulb className="w-5 h-5 text-[#F7C948]" />
                </div>
              </div>
              <div className="rounded-2xl border border-hair bg-surface-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm uppercase tracking-[0.14em]" style={{ color: "var(--text-secondary)" }}>Hints</p>
                    <p className="mt-2 text-sm" style={{ color: "var(--text-primary)" }}>Reveal one hint at a time to guide your solution.</p>
                  </div>
                  <Sparkles className="w-5 h-5 text-[#7E8CFF]" />
                </div>
                <div className="mt-4 space-y-3">{renderHints()}</div>
                <Button
                  onClick={() => setHintsVisible((count) => Math.min((puzzle?.hints?.length || 0), count + 1))}
                  disabled={!puzzle?.hints?.length || hintsVisible >= (puzzle?.hints?.length || 0)}
                  className="mt-4 w-full bg-[#D4AF37] text-black hover:bg-[#F4C430]"
                >
                  {hintsVisible >= (puzzle?.hints?.length || 0) ? "No more hints" : "Show another hint"}
                </Button>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <div className="grid gap-4 sm:grid-cols-[1.6fr_0.9fr]">
                <div>
                  <Label style={{ color: "var(--text-secondary)" }}>Your move</Label>
                  <Input
                    value={answer}
                    onChange={(event) => setAnswer(event.target.value)}
                    placeholder="Drag a piece on the board, or type a move e.g. Nxe5"
                    className="bg-surface-2 border-hair text-text-primary"
                  />
                </div>
                <div className="flex items-end gap-2">
                  <Button
                    type="submit"
                    disabled={!answer.trim() || solving || loading || puzzleSolved || opponentThinking}
                    className="w-full bg-[#00FF94] text-black hover:bg-[#00FF94]/90"
                  >
                    {solving ? "Checking..." : "Submit move"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={fetchPuzzle}
                    disabled={loading}
                    className="w-full border-hair hover:bg-surface-2"
                  >
                    <RefreshCw className="w-4 h-4 mr-2" />
                    New Puzzle
                  </Button>
                </div>
              </div>

              {statusMessage && (
                <div className="rounded-2xl border border-hair bg-surface-2 p-4 text-sm" style={{ color: "var(--text-primary)" }}>
                  {statusMessage}
                </div>
              )}

              {/* Phase 5: ambient free-budget status - visible before the
                  user runs out, not just after a 402. */}
              {budgetStatus && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: "var(--text-secondary)" }}>
                  <span>
                    {budgetStatus.skips.remaining_free > 0
                      ? `${budgetStatus.skips.remaining_free} free skips left today`
                      : `Out of free skips today — next one costs ${budgetStatus.skips.cost ?? "?"} credits`}
                  </span>
                  <span>
                    {budgetStatus.retries.remaining_free > 0
                      ? `${budgetStatus.retries.remaining_free} free wrong guesses left today`
                      : `Out of free retries today — the next wrong guess costs ${budgetStatus.retries.cost ?? "?"} credits`}
                  </span>
                </div>
              )}
            </form>
          </section>

          <aside className="space-y-4">
            <div className="rounded-3xl border border-hair bg-surface-1 p-6">
              <h3 className="font-heading text-xl mb-3" style={{ color: "var(--text-primary)" }}>Progress</h3>
              <div className="space-y-3 text-sm" style={{ color: "var(--text-secondary)" }}>
                <div className="flex items-center justify-between gap-2">
                  <span>Current difficulty</span>
                  <Badge className="bg-[#00B4F7]/15 text-[#8ED1FF] border-[#8ED1FF]/20">{progress?.current_difficulty ?? 1}</Badge>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>Puzzles solved</span>
                  <span className="font-semibold" style={{ color: "var(--text-primary)" }}>{progress?.solved_count ?? 0}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>Rating earned</span>
                  <span className="font-semibold text-[#00FF94]">{progress?.earned_rating ?? 0}</span>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-hair bg-surface-1 p-6">
              <div className="flex items-center justify-between gap-3 mb-3">
                <h3 className="font-heading text-xl" style={{ color: "var(--text-primary)" }}>Puzzle Packs</h3>
              </div>
              <p className="text-sm mb-3" style={{ color: "var(--text-secondary)" }}>
                Jump straight to a harder tier instead of grinding up to it. Tiers you've already earned are always free.
              </p>
              {packs?.length ? (
                <div className="grid grid-cols-5 gap-2">
                  {packs.map((pack) => (
                    <button
                      key={pack.difficulty}
                      type="button"
                      onClick={() => fetchPuzzle(pack.difficulty)}
                      disabled={loading}
                      title={pack.earned ? "Earned" : pack.unlocked ? "Unlocked" : `${pack.cost ?? "?"} credits to unlock`}
                      className={`rounded-lg border p-2 text-center text-sm font-semibold transition ${
                        puzzle?.difficulty === pack.difficulty
                          ? "border-[#D4AF37] bg-[#D4AF37]/10 text-[#D4AF37]"
                          : pack.earned || pack.unlocked
                          ? "border-hair bg-surface-2 hover:bg-surface-3"
                          : "border-hair bg-surface-2 text-text-secondary hover:bg-surface-3"
                      }`}
                    >
                      {pack.difficulty}
                      {!pack.earned && !pack.unlocked && (
                        <div className="text-[10px] font-normal mt-0.5">{pack.cost ?? "—"}c</div>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Loading packs...</p>
              )}
            </div>

            <div className="rounded-3xl border border-hair bg-surface-1 p-6">
              <div className="flex items-center justify-between gap-3 mb-4">
                <h3 className="font-heading text-xl" style={{ color: "var(--text-primary)" }}>Recent Solves</h3>
                <span className="rounded-full bg-surface-2 px-2 py-1 text-xs" style={{ color: "var(--text-secondary)" }}>Last 10</span>
              </div>
              {progress?.recent_solved?.length ? (
                <div className="space-y-3">
                  {progress.recent_solved.slice(-10).reverse().map((entry) => (
                    <div key={entry.puzzle_id + entry.solved_at} className="rounded-2xl border border-hair bg-surface-2 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{entry.title}</p>
                          <p className="text-xs" style={{ color: "var(--text-secondary)" }}>Difficulty {entry.difficulty}</p>
                        </div>
                        <Badge className="bg-[#00FF94]/10 text-[#00FF94] border-[#00FF94]/20">
                          +{entry.reward}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Solve your first puzzle to begin tracking progress.</p>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
