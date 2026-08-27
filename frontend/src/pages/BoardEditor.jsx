import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Chessboard, defaultPieces } from "react-chessboard";
import { Chess } from "chess.js";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useAuth, API } from "@/App";
import { resolveBoardPrefs } from "@/utils/boardPrefs";
import { toast } from "sonner";
import axios from "axios";
import { Copy, RotateCcw, Zap, Layers } from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";

const INITIAL_FEN = new Chess().fen();
const PIECE_PALETTE = [
  { label: "White King", value: "wK" },
  { label: "White Queen", value: "wQ" },
  { label: "White Rook", value: "wR" },
  { label: "White Bishop", value: "wB" },
  { label: "White Knight", value: "wN" },
  { label: "White Pawn", value: "wP" },
  { label: "Black King", value: "bK" },
  { label: "Black Queen", value: "bQ" },
  { label: "Black Rook", value: "bR" },
  { label: "Black Bishop", value: "bB" },
  { label: "Black Knight", value: "bN" },
  { label: "Black Pawn", value: "bP" },
];

const SQUARES = [
  "a8","b8","c8","d8","e8","f8","g8","h8",
  "a7","b7","c7","d7","e7","f7","g7","h7",
  "a6","b6","c6","d6","e6","f6","g6","h6",
  "a5","b5","c5","d5","e5","f5","g5","h5",
  "a4","b4","c4","d4","e4","f4","g4","h4",
  "a3","b3","c3","d3","e3","f3","g3","h3",
  "a2","b2","c2","d2","e2","f2","g2","h2",
  "a1","b1","c1","d1","e1","f1","g1","h1",
];

function buildChess() {
  return new Chess();
}

// Swaps the active-color field of a FEN string (the "w"/"b" after the
// piece placement) without touching piece placement, castling rights, etc.
function withTurn(fen, color) {
  const parts = fen.split(" ");
  parts[1] = color;
  return parts.join(" ");
}

function countPiecesFromFen(fen) {
  const chess = new Chess();
  try {
    if (fen === "start") {
      chess.reset();
    } else {
      chess.load(fen);
    }
  } catch (error) {
    return {};
  }

  const counts = {};
  SQUARES.forEach((square) => {
    const piece = chess.get(square);
    if (piece) {
      const code = `${piece.color}${piece.type.toUpperCase()}`;
      counts[code] = (counts[code] || 0) + 1;
    }
  });
  return counts;
}

export default function BoardEditor() {
  const { user, token } = useAuth();
  const navigate = useNavigate();
  const { boardSquareColors, theme: boardThemeName, color: boardColorName } = resolveBoardPrefs(user);
  const chessRef = useRef(buildChess());
  const boardWrapperRef = useRef(null);
  const [boardPosition, setBoardPosition] = useState(INITIAL_FEN);
  const [originalPosition, setOriginalPosition] = useState(INITIAL_FEN);
  const [moveHistory, setMoveHistory] = useState([]);
  const [fenInput, setFenInput] = useState("");
  const removedCounts = useMemo(() => {
    const original = countPiecesFromFen(originalPosition);
    const current = countPiecesFromFen(boardPosition);
    const counts = {};

    PIECE_PALETTE.forEach((piece) => {
      const originalCount = original[piece.value] || 0;
      const currentCount = current[piece.value] || 0;
      counts[piece.value] = Math.max(0, originalCount - currentCount);
    });

    return counts;
  }, [originalPosition, boardPosition]);
  const [selectedPiece, setSelectedPiece] = useState(null);
  const [selectedSquare, setSelectedSquare] = useState(null);
  const [possibleMoves, setPossibleMoves] = useState([]);
  const [hoveredPiece, setHoveredPiece] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState(null);
  const [analysisHistory, setAnalysisHistory] = useState([]);
  // Free-then-paid allowance info from the last /board/analyze response -
  // this is Board Editor's own 5-free-then-30-credit allowance, separate
  // from the match Game Review's allowance.
  const [freeUsesRemaining, setFreeUsesRemaining] = useState(null);
  const [analysisCost, setAnalysisCost] = useState(null);
  const [activeHistoryId, setActiveHistoryId] = useState(null);
  const [boardOrientation, setBoardOrientation] = useState("white");

  const loadBoard = useCallback((fen, keepOriginal = false) => {
    const chess = buildChess();
    try {
      if (fen === "start") {
        chess.reset();
      } else {
        chess.load(fen);
      }
    } catch (error) {
      return false;
    }
    chessRef.current = chess;
    setBoardPosition(chess.fen());
    if (!keepOriginal) {
      setOriginalPosition(chess.fen());
    }
    setSelectedPiece(null);
    setSelectedSquare(null);
    setPossibleMoves([]);
    setAnalysis(null);
    setMoveHistory([]);
    return true;
  }, []);

  const handleFlipBoard = useCallback(() => {
    setBoardOrientation((prev) => {
      const next = prev === "white" ? "black" : "white";
      const turnColor = next === "white" ? "w" : "b";
      const newFen = withTurn(chessRef.current.fen(), turnColor);
      try {
        const chess = buildChess();
        chess.load(newFen, { skipValidation: true });
        chessRef.current = chess;
        setBoardPosition(newFen);
        // Position (side to move) changed, so any prior analysis is stale.
        setAnalysis(null);
      } catch (error) {
        // Leave the position untouched if the FEN somehow can't be parsed.
      }
      return next;
    });
  }, []);

  const updateCurrentBoard = useCallback((chess) => {
    chessRef.current = chess;
    setBoardPosition(chess.fen());
    setSelectedSquare(null);
    setPossibleMoves([]);
    setAnalysis(null);
  }, []);

  // With options.allowDragOffBoard set, react-chessboard (dnd-kit under
  // the hood) calls onPieceDrop with targetSquare: null whenever a piece is
  // released outside the board's droppable squares — including over the
  // piece palette below. No extra window-level listeners are needed.
  const handlePieceDrop = useCallback(({ sourceSquare, targetSquare }) => {
    if (!sourceSquare) {
      return false;
    }

    const chess = new Chess(chessRef.current.fen());
    const piece = chess.get(sourceSquare);
    if (!piece) {
      return false;
    }

    if (targetSquare == null) {
      chess.remove(sourceSquare);
      updateCurrentBoard(chess);
      return true;
    }

    if (targetSquare === sourceSquare) {
      return true;
    }

    // Placement, not a chess move: relocate freely regardless of turn or
    // legality. chess.put() overwrites whatever was on targetSquare.
    chess.remove(sourceSquare);
    const placed = chess.put(piece, targetSquare);
    if (!placed) {
      return false;
    }
    updateCurrentBoard(chess);
    return true;
  }, [updateCurrentBoard]);

  const placePiece = useCallback(
    (pieceCode, square) => {
      if (!pieceCode || !square) return;
      const chess = new Chess(chessRef.current.fen());
      const color = pieceCode[0] === "w" ? "w" : "b";
      const type = pieceCode[1].toLowerCase();
      chess.put({ type, color }, square);
      updateCurrentBoard(chess);
      setSelectedPiece(null);
      setSelectedSquare(null);
    },
    [updateCurrentBoard]
  );

  const handlePaletteClick = useCallback(
    (pieceCode) => {
      if (selectedSquare) {
        placePiece(pieceCode, selectedSquare);
        return;
      }
      setSelectedPiece(pieceCode);
    },
    [selectedSquare, placePiece]
  );

  const getSquareFromPointer = useCallback((event) => {
    const board = boardWrapperRef.current?.querySelector(".Chessboard");
    if (!board) return null;
    const rect = board.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    const fileIndex = Math.floor((x / rect.width) * 8);
    const rankIndex = Math.floor((y / rect.height) * 8);
    const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const ranks = ["8", "7", "6", "5", "4", "3", "2", "1"];
    const square = `${files[fileIndex]}${ranks[rankIndex]}`;
    return square;
  }, []);

  const handleBoardDrop = useCallback(
    (event) => {
      event.preventDefault();
      const pieceCode = event.dataTransfer?.getData("text/plain");
      const square = getSquareFromPointer(event);
      if (pieceCode && square) {
        placePiece(pieceCode, square);
      }
    },
    [getSquareFromPointer, placePiece]
  );

  const handlePaletteDrop = useCallback(
    (event, pieceCode) => {
      event.preventDefault();
      const draggedPiece = event.dataTransfer?.getData("text/plain");
      const sourceSquare = event.dataTransfer?.getData("text/square");

      if (sourceSquare && draggedPiece === pieceCode) {
        const chess = new Chess(chessRef.current.fen());
        chess.remove(sourceSquare);
        updateCurrentBoard(chess);
        return;
      }

      if (draggedPiece) {
        setSelectedPiece(draggedPiece);
        if (selectedSquare) {
          placePiece(draggedPiece, selectedSquare);
        }
        return;
      }

      handlePaletteClick(pieceCode);
    },
    [handlePaletteClick, selectedSquare, placePiece, updateCurrentBoard]
  );

  const handlePaletteHover = useCallback((pieceCode) => {
    setHoveredPiece(pieceCode);
  }, []);

  const handlePaletteLeave = useCallback(() => {
    setHoveredPiece(null);
  }, []);

  const handlePaletteDragStart = useCallback((event, pieceCode) => {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData("text/plain", pieceCode);
    event.dataTransfer.effectAllowed = "copy";
  }, []);

  const handleSquareClick = useCallback(
    ({ piece: clickedPiece, square }) => {
      if (selectedPiece) {
        placePiece(selectedPiece, square);
        return;
      }

      const chess = new Chess(chessRef.current.fen());

      if (selectedSquare) {
        if (square === selectedSquare) {
          setSelectedSquare(null);
          setPossibleMoves([]);
          return;
        }

        // Placement, not a chess move: relocate freely regardless of turn
        // or legality. chess.put() overwrites whatever was on the target.
        const piece = chess.get(selectedSquare);
        if (piece) {
          chess.remove(selectedSquare);
          chess.put(piece, square);
          updateCurrentBoard(chess);
        }
        setSelectedSquare(null);
        setPossibleMoves([]);
        return;
      }

      if (clickedPiece) {
        setSelectedSquare(square);
        // No legal-move highlighting: any square is a valid destination
        // for a free placement.
        setPossibleMoves([]);
      }
    },
    [selectedPiece, selectedSquare, updateCurrentBoard]
  );

  const handleSquareRightClick = useCallback(({ square }) => {
    if (selectedPiece) {
      setSelectedPiece(null);
      return;
    }

    const chess = new Chess(chessRef.current.fen());
    chess.remove(square);
    updateCurrentBoard(chess);
  }, [updateCurrentBoard]);

  const handleResetBoard = useCallback(() => loadBoard("start"), [loadBoard]);
  const handleClearBoard = useCallback(() => {
    const chess = buildChess();
    chess.clear();
    updateCurrentBoard(chess);
    setMoveHistory([]);
  }, [updateCurrentBoard]);

  const handleSetFen = useCallback(() => {
    if (!fenInput.trim()) {
      toast.error("Enter a FEN string to load.");
      return;
    }
    const chess = new Chess();
    try {
      if (fenInput.trim() === "start") {
        chess.reset();
      } else {
        chess.load(fenInput.trim());
      }
    } catch (error) {
      toast.error("Invalid FEN. Please check the format and try again.");
      return;
    }
    chessRef.current = chess;
    setBoardPosition(chess.fen());
    setOriginalPosition(chess.fen());
    setSelectedPiece(null);
    setSelectedSquare(null);
    setPossibleMoves([]);
    setAnalysis(null);
    setMoveHistory([]);
    setFenInput("");
  }, [fenInput]);

  const handleCopyFen = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(boardPosition);
      toast.success("Current FEN copied to clipboard");
    } catch (error) {
      toast.error("Could not copy FEN. Try again manually.");
    }
  }, [boardPosition]);

  const analysisAbortRef = useRef(null);
  const analysisCancelledRef = useRef(false);

  const handleAnalyzePosition = useCallback(async () => {
    const fen = chessRef.current.fen();
    if (!fen) {
      return;
    }
    if (!token) {
      toast.error("Log in to analyze positions with Stockfish.");
      return;
    }

    analysisAbortRef.current?.abort();
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    analysisCancelledRef.current = false;

    setAnalysisLoading(true);
    setAnalysisError(null);

    try {
      // Deep Stockfish analysis of this custom position - Board Editor's
      // own 5-free-then-30-credit allowance (feature key "board_analysis").
      // Always deep depth; there's no separate quick/shallow tier.
      //
      // This kicks the search off in the background on the server and
      // polls for the result instead of waiting on one long request - a
      // genuinely deep search can take a while (especially on a shared
      // CPU), and no single HTTP request should be held open that long.
      const kickoff = await axios.post(
        `${API}/board/analyze`,
        {
          fen,
          multi_pv: 3,
        },
        { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }
      );
      const jobId = kickoff.data.job_id;

      let data = null;
      while (!analysisCancelledRef.current) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (analysisCancelledRef.current) break;
        // eslint-disable-next-line no-await-in-loop
        const poll = await axios.get(`${API}/board/analyze/${jobId}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (poll.data.status === "done") {
          data = poll.data;
          break;
        }
        // status "pending" - keep polling
      }
      if (analysisCancelledRef.current || !data) {
        return;
      }

      setAnalysis(data);
      setFreeUsesRemaining(data.free_uses_remaining ?? null);
      setAnalysisCost(data.cost ?? null);
      if (data.paid) {
        toast.success(`Deep analysis complete — ${data.cost} credits spent.`);
      }
      const entryId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setAnalysisHistory((prev) => [
        { id: entryId, fen, analysis: data, analyzedAt: Date.now() },
        ...prev,
      ].slice(0, 25));
      setActiveHistoryId(entryId);
    } catch (error) {
      if (axios.isCancel(error) || error.code === "ERR_CANCELED" || error.name === "CanceledError") {
        return;
      }
      const detail = error?.response?.data?.detail;
      if (error?.response?.status === 402 && detail?.error === "insufficient_credits") {
        toast.error(`Not enough credits — deep analysis costs ${detail.cost} credits (you have ${detail.credits_balance}).`, {
          action: { label: "Buy credits", onClick: () => navigate("/wallet") },
        });
        setAnalysisError("insufficient_credits");
      } else {
        const message = detail?.detail || detail || error?.message || "Failed to analyze position.";
        setAnalysisError(message);
      }
      setAnalysis(null);
    } finally {
      if (analysisAbortRef.current === controller) {
        analysisAbortRef.current = null;
        setAnalysisLoading(false);
      }
    }
  }, [token, navigate]);

  const handleStopAnalysis = useCallback(() => {
    analysisCancelledRef.current = true;
    analysisAbortRef.current?.abort();
    analysisAbortRef.current = null;
    setAnalysisLoading(false);
  }, []);

  const handleSelectHistoryEntry = useCallback(
    (entry) => {
      const loaded = loadBoard(entry.fen, true);
      if (!loaded) {
        toast.error("Could not restore that position.");
        return;
      }
      setAnalysis(entry.analysis);
      setAnalysisError(null);
      setActiveHistoryId(entry.id);
    },
    [loadBoard]
  );

  const handleClearHistory = useCallback(() => {
    setAnalysisHistory([]);
    setActiveHistoryId(null);
  }, []);

  useEffect(() => {
    return () => {
      analysisAbortRef.current?.abort();
    };
  }, []);

  const squareStyles = useMemo(() => {
    const styles = {};
    if (selectedSquare) {
      styles[selectedSquare] = { backgroundColor: "rgba(16, 185, 129, 0.25)" };
    }
    possibleMoves.forEach((square) => {
      styles[square] = { backgroundColor: "rgba(59, 130, 246, 0.2)" };
    });
    return styles;
  }, [selectedSquare, possibleMoves]);

  return (
    <div className="sc-page max-w-6xl mx-auto">
      <div className="flex flex-col gap-4 mb-6">
        <PageHeader title="Board editor" subtitle="Rearrange pieces, create a custom position, and analyze it with Stockfish." />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={handleResetBoard} className="font-semibold">
            Reset board
          </Button>
          <Button variant="outline" onClick={handleClearBoard} className="font-semibold">
            Clear board
          </Button>
          <Button variant="outline" onClick={handleFlipBoard} className="font-semibold">
            <RotateCcw className="w-4 h-4 mr-2" /> Flip board
          </Button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(320px,420px)_1fr]">
        <div
          ref={boardWrapperRef}
          className="rounded-2xl border border-hair bg-surface-1 p-4 shadow-sm"
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleBoardDrop}
        >
          <div className="mb-4 flex items-center justify-between gap-2">
            <div>
              <p className="text-sm text-text-secondary uppercase tracking-[0.2em]">Board editor</p>
              <h2 className="text-lg font-semibold">Drag, drop, or click to move</h2>
            </div>
            <div className="text-xs text-text-secondary">
              Orientation: {boardOrientation === "white" ? "White" : "Black"}
            </div>
          </div>
          <div
            className="mb-4 mx-auto"
            style={{
              touchAction: "none",
              width: "100%",
              maxWidth: 520,
              minWidth: 0,
              aspectRatio: "1 / 1",
            }}
          >
            <Chessboard
              key={`${boardThemeName}-${boardColorName}`}
              options={{
                id: "BoardEditorChessboard",
                position: boardPosition,
                boardOrientation,
                pieces: defaultPieces,
                onPieceDrop: handlePieceDrop,
                onSquareClick: handleSquareClick,
                onSquareRightClick: handleSquareRightClick,
                squareStyles,
                darkSquareStyle: { backgroundColor: boardSquareColors.dark },
                lightSquareStyle: { backgroundColor: boardSquareColors.light },
                boardStyle: {
                  width: "100%",
                  height: "100%",
                },
                allowDragOffBoard: true,
              }}
            />
          </div>
          <div className="grid gap-3">
            <div className="rounded-2xl bg-surface-2 p-3">
              <p className="text-sm text-text-secondary mb-2">Piece palette</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {PIECE_PALETTE.map((piece) => (
                  <button
                    key={piece.value}
                    type="button"
                    draggable
                    data-piece={piece.value}
                    onDragStart={(event) => handlePaletteDragStart(event, piece.value)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => handlePaletteDrop(event, piece.value)}
                    onMouseEnter={() => handlePaletteHover(piece.value)}
                    onMouseLeave={() => handlePaletteLeave(piece.value)}
                    onClick={() => handlePaletteClick(piece.value)}
                    className={`rounded-xl border px-3 py-2 text-left text-sm font-medium transition ${selectedPiece === piece.value ? "border-brand bg-brand-dim text-brand" : hoveredPiece === piece.value ? "border-brand/60 bg-brand-dim/60 text-text-primary" : "border-transparent bg-surface-2 text-text-primary"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span>{piece.label}</span>
                      {removedCounts[piece.value] > 0 && (
                        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-secondary">
                          {removedCounts[piece.value]}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setSelectedPiece(null)} className="font-semibold">
                  Clear selection
                </Button>
                <Button size="sm" variant="outline" onClick={handleCopyFen} className="font-semibold">
                  <Copy className="w-4 h-4 mr-2" /> Copy FEN
                </Button>
              </div>
              {selectedPiece && (
                <div className="mt-3 rounded-2xl border border-brand bg-brand-dim p-3 text-sm text-brand">
                  Selected piece: {PIECE_PALETTE.find((piece) => piece.value === selectedPiece)?.label || selectedPiece}. Click a square or drop it onto the board to place it.
                </div>
              )}
            </div>
            <div className="rounded-2xl bg-surface-2 p-3">
              <Label htmlFor="editorFen" className="text-sm font-medium text-text-secondary">
                Load a FEN string
              </Label>
              <Textarea
                id="editorFen"
                value={fenInput}
                onChange={(event) => setFenInput(event.target.value)}
                placeholder="Enter FEN or use current position from the board above"
                rows={3}
                className="mt-2"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={handleSetFen} className="font-semibold">
                  Load FEN
                </Button>
                <Button size="sm" variant="outline" onClick={() => setFenInput(chessRef.current.fen())} className="font-semibold">
                  Use current board FEN
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-2xl border border-hair bg-surface-1 p-4 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm text-text-secondary uppercase tracking-[0.2em]">Analysis</p>
                <h2 className="text-lg font-semibold">Stockfish suggestions</h2>
              </div>
              {analysisLoading ? (
                <Button size="sm" variant="outline" onClick={handleStopAnalysis} className="font-semibold">
                  Stop Analysis
                </Button>
              ) : (
                <Button size="sm" onClick={handleAnalyzePosition} className="font-semibold">
                  <Zap className="w-4 h-4 mr-2" /> Analyze
                </Button>
              )}
            </div>
            <p className="text-sm text-text-secondary mb-1">
              Set up any position, then run a deep Stockfish analysis for the best moves and evaluation.
            </p>
            <p className="text-xs text-text-secondary mb-4">
              {freeUsesRemaining != null
                ? freeUsesRemaining > 0
                  ? `${freeUsesRemaining} free analysis${freeUsesRemaining === 1 ? "" : "es"} left, then ${analysisCost ?? 30} credits each.`
                  : `Your 5 free analyses are used up — each analysis now costs ${analysisCost ?? 30} credits.`
                : "First 5 analyses are free, then 30 credits each."}
            </p>

            <div className="grid gap-3">
              {analysisError === "insufficient_credits" ? (
                <div className="rounded-2xl bg-danger-dim border border-danger p-3 text-sm text-danger flex items-center justify-between gap-3">
                  <span>Out of free analyses and credits.</span>
                  <Button size="sm" variant="outline" onClick={() => navigate("/wallet")} className="font-semibold shrink-0">
                    Buy credits
                  </Button>
                </div>
              ) : analysisError ? (
                <div className="rounded-2xl bg-danger-dim border border-danger p-3 text-sm text-danger">
                  {analysisError}
                </div>
              ) : null}

              {analysis ? (
                <div className="rounded-2xl bg-white border border-hair p-4 text-sm text-text-primary">
                  <div className="mb-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-text-secondary">Best move</p>
                    <p className="text-2xl font-semibold mt-1">{analysis.move || "N/A"}</p>
                  </div>
                  <div className="grid gap-2 text-sm text-text-secondary">
                    <div className="flex items-center justify-between">
                      <span>Depth</span>
                      <span>{analysis.depth ?? "—"}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Evaluation</span>
                      <span>
                        {analysis.evaluation?.type === "cp"
                          ? `${analysis.evaluation.value / 100 >= 0 ? "+" : ""}${(analysis.evaluation.value / 100).toFixed(2)}`
                          : analysis.evaluation?.type === "mate"
                          ? `Mate ${analysis.evaluation.value}`
                          : "—"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Top moves</span>
                      <span>{Array.isArray(analysis.top_moves) ? analysis.top_moves.length : 0}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl bg-surface-2 border border-dashed border-hair p-4 text-sm text-text-secondary">
                  No analysis yet. Set up the board and tap Analyze.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-hair bg-surface-1 p-4 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm text-text-secondary uppercase tracking-[0.2em]">History</p>
                <h2 className="text-lg font-semibold">Analyzed positions</h2>
              </div>
              {analysisHistory.length > 0 && (
                <Button size="sm" variant="outline" onClick={handleClearHistory} className="font-semibold">
                  Clear
                </Button>
              )}
            </div>
            {analysisHistory.length === 0 ? (
              <div className="rounded-2xl bg-surface-2 border border-dashed border-hair p-4 text-sm text-text-secondary">
                Positions you analyze will show up here so you can come back to them.
              </div>
            ) : (
              <div className="grid gap-2 max-h-[320px] overflow-y-auto pr-1">
                {analysisHistory.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => handleSelectHistoryEntry(entry)}
                    className={`text-left rounded-xl border px-3 py-2 transition ${
                      activeHistoryId === entry.id
                        ? "border-brand bg-brand-dim"
                        : "border-hair bg-white hover:border-brand/60"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-text-primary">
                        {entry.analysis?.move || "N/A"}
                      </span>
                      <span className="text-[11px] text-text-secondary">
                        {new Date(entry.analyzedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-text-secondary">{entry.fen}</p>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-hair bg-surface-1 p-4 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm text-text-secondary uppercase tracking-[0.2em]">Position</p>
                <h2 className="text-lg font-semibold">Current FEN</h2>
              </div>
              <Button size="sm" variant="outline" onClick={handleCopyFen} className="font-semibold">
                <Copy className="w-4 h-4 mr-2" /> Copy
              </Button>
            </div>
            <Textarea value={boardPosition} readOnly rows={4} className="text-xs" />
            <p className="mt-3 text-xs text-text-secondary">
              Right-click a square to remove the piece. Use the piece palette to place pieces and drag to move them.
            </p>
          </div>

          {analysis && Array.isArray(analysis.top_moves) && analysis.top_moves.length > 0 && (
            <div className="rounded-2xl border border-hair bg-surface-1 p-4 shadow-sm">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-sm text-text-secondary uppercase tracking-[0.2em]">Top moves</p>
                  <h2 className="text-lg font-semibold">Next options</h2>
                </div>
                <Layers className="w-5 h-5 text-text-secondary" />
              </div>
              <div className="grid gap-2">
                {analysis.top_moves.slice(0, 5).map((move, index) => {
                  const moveLabel = move.Move ?? move.move ?? "N/A";
                  const evalLabel =
                    typeof move.Mate === "number"
                      ? `Mate ${move.Mate}`
                      : typeof move.Centipawn === "number"
                      ? `${move.Centipawn / 100 >= 0 ? "+" : ""}${(move.Centipawn / 100).toFixed(2)}`
                      : move.evaluation ?? move.score ?? "—";
                  return (
                    <div key={`${moveLabel}-${index}`} className="rounded-xl border border-hair bg-white p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{index + 1}. {moveLabel}</span>
                        <span className="text-xs text-text-secondary">{evalLabel}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
