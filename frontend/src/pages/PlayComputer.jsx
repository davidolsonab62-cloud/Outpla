import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useAuth, API } from "@/App";
import { resolveBoardPrefs } from "@/utils/boardPrefs";
import { toast } from "sonner";
import axios from "axios";
import {
  ChevronLeft,
  Trophy,
  Cpu,
  RotateCcw,
  Volume2,
  VolumeX,
  Smartphone,
  Settings,
  Zap,
  Clock,
  Target,
  Play,
} from "lucide-react";
import {
  moveFeedback,
  getSettings,
  saveSettings,
} from "@/utils/soundEffects";

// Difficulty settings with ELO and Stockfish depth
const DIFFICULTY_LEVELS = [
  { id: "beginner", name: "Beginner", elo: 800, depth: 2, color: "#3CCB7F", delay: [1000, 1500] },
  { id: "intermediate", name: "Intermediate", elo: 1200, depth: 5, color: "#4C8DFF", delay: [800, 1200] },
  { id: "advanced", name: "Advanced", elo: 1600, depth: 10, color: "#7C5CFC", delay: [600, 1000] },
  { id: "master", name: "Master", elo: 2000, depth: 15, color: "#FF5C5C", delay: [500, 800] },
];

// Normalize the backend's /computer/move response into a consistent shape,
// used both when the computer calculates its own move and for standalone
// position analysis (no move being made).
function normalizeAnalysisResponse(result, fallbackDepth) {
  const evaluation = result.evaluation ?? result.score ?? null;
  const normalizedEvaluation = evaluation
    ? typeof evaluation === "object"
      ? evaluation
      : { type: "cp", value: Number(evaluation) }
    : null;
  const normalizedTopMoves = Array.isArray(result.top_moves)
    ? result.top_moves.map((item) => {
        if (typeof item === "string") {
          return { move: item, score: null };
        }
        return {
          Move: item.Move ?? item.move ?? item.uci ?? null,
          Eval: item.Eval ?? item.score ?? item.evaluation ?? null,
          score: item.score ?? item.Eval ?? null,
          move: item.move ?? item.Move ?? item.uci ?? null,
        };
      })
    : [];
  return {
    move: result.move || result.best_move || null,
    source: result.source || result.category || "stockfish",
    evaluation: normalizedEvaluation,
    top_moves: normalizedTopMoves,
    book_moves: Array.isArray(result.book_moves) ? result.book_moves : [],
    depth: result.depth || fallbackDepth,
    skill_level: result.skill_level || result.skillLevel || null,
  };
}

export default function PlayComputer() {
  const { user, token } = useAuth();
  // Same lookup Game.jsx uses, so a theme/color saved on Profile shows up
  // here too instead of only in real games.
  const { boardSquareColors, theme: boardThemeName, color: boardColorName } = resolveBoardPrefs(user);
  const navigate = useNavigate();
  const location = useLocation();

  const queryParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const initialFenFromUrl = queryParams.get("fen") || "";
  const defaultFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const [startingFen, setStartingFen] = useState(initialFenFromUrl || defaultFen);

  // Game state
  const [gameStarted, setGameStarted] = useState(false);
  const [difficulty, setDifficulty] = useState(null);
  const [playerColor, setPlayerColor] = useState("white");
  const [chessInstance, setChessInstance] = useState(() => new Chess());
  const [position, setPosition] = useState(initialFenFromUrl || defaultFen);
  const [gameOver, setGameOver] = useState(false);
  const [result, setResult] = useState(null);
  const [lastMove, setLastMove] = useState(null);
  const [moveHistory, setMoveHistory] = useState([]);
  const [computerThinking, setComputerThinking] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [savedComputerMatch, setSavedComputerMatch] = useState(null);
  const [savedMatchCountdown, setSavedMatchCountdown] = useState(0);
  const boardWrapperRef = useRef(null);

  // Click-to-move state
  const [selectedSquare, setSelectedSquare] = useState(null);
  const [possibleMoves, setPossibleMoves] = useState([]);

  // Settings
  const [settings, setSettings] = useState(() => getSettings());
  const [showSettings, setShowSettings] = useState(false);

  const updateSettings = (key, value) => {
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    saveSettings(newSettings);
  };

  // Holds the expiry for the *current* game, fixed at game start (or at
  // restore time, carried over from the saved payload). Deliberately NOT
  // recomputed on every save — earlier this reset to Date.now() + 24h on
  // every move, which meant an active game effectively never expired as
  // long as you moved at least once a day. A fixed expiry from game start
  // is simpler to reason about and matches "resume within 24h of starting,
  // then it's gone" rather than "resume forever if you keep playing."
  const gameExpiresAtRef = useRef(null);

  const saveComputerMatch = useCallback((state) => {
    if (!gameExpiresAtRef.current) {
      gameExpiresAtRef.current = Date.now() + 24 * 60 * 60 * 1000;
    }
    const payload = {
      ...state,
      analysis,
      expiresAt: gameExpiresAtRef.current,
      savedAt: Date.now(),
    };
    localStorage.setItem("currentComputerMatch", JSON.stringify(payload));
    setSavedComputerMatch(payload);
  }, [analysis]);

  const clearComputerMatch = useCallback(() => {
    localStorage.removeItem("currentComputerMatch");
    setSavedComputerMatch(null);
    gameExpiresAtRef.current = null;
  }, []);


  // Restore-from-refresh and default-position-on-mount used to be two
  // separate effects. Both ran on initial mount, but the second one
  // ("if no game has started, load the URL/default FEN") closed over
  // `gameStarted` as it was in the render that scheduled it -- still
  // `false`, even though the restore effect above had *just* called
  // setGameStarted(true) moments earlier in the same effect flush. State
  // updates from one effect aren't visible to a sibling effect's closure
  // until the next render, so the second effect always ran with the stale
  // `false` value and unconditionally overwrote `position`/`startingFen`
  // back to the default FEN right after the first effect had just
  // restored the saved game -- clobbering it on every single mount,
  // independent of the save's age. That's why a refresh reset the board
  // even seconds after a move. Merging them into one effect removes the
  // race entirely: there's only one outcome to compute per mount.
  useEffect(() => {
    const raw = localStorage.getItem("currentComputerMatch");
    let restored = false;

    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.expiresAt && parsed.expiresAt > Date.now()) {
          gameExpiresAtRef.current = parsed.expiresAt;
          setSavedComputerMatch(parsed);
          setSavedMatchCountdown(Math.max(0, Math.floor((parsed.expiresAt - Date.now()) / 1000)));
          setDifficulty(parsed.difficulty);
          setPlayerColor(parsed.playerColor);
          setChessInstance(new Chess(parsed.position));
          setPosition(parsed.position);
          setMoveHistory(parsed.moveHistory || []);
          setLastMove(parsed.lastMove || null);
          setGameStarted(true);
          setGameOver(parsed.gameOver || false);
          setResult(parsed.result || null);
          restored = true;
        } else {
          clearComputerMatch();
        }
      } catch (err) {
        console.error("Failed to restore saved computer match:", err, raw);
        clearComputerMatch();
      }
    }

    if (!restored) {
      const fen = initialFenFromUrl || defaultFen;
      const chess = new Chess();
      try {
        if (fen === "start") {
          chess.reset();
        } else {
          chess.load(fen);
        }
        setStartingFen(fen);
        setPosition(fen);
      } catch (error) {
        toast.error("The position from Board Editor was invalid. Loaded the standard start position instead.");
        setStartingFen(defaultFen);
        setPosition(defaultFen);
      }
    }
    // Runs once on mount only. resetGame() (the "New Game" flow) already
    // sets position/startingFen itself when it flips gameStarted back to
    // false, so this doesn't need to stay reactive to that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cross-tab sync: if another tab starts a new game, ends this one, or
  // otherwise writes to the same localStorage key, pick that up here
  // instead of silently diverging and then stomping it on our next save.
  // The `storage` event only fires in *other* tabs, never the tab that
  // made the write, so this can't loop back on itself.
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.key !== "currentComputerMatch") return;

      // Whatever changed elsewhere invalidates any in-progress click-to-move
      // selection here — the board it was computed against may no longer
      // be the current one.
      setSelectedSquare(null);
      setPossibleMoves([]);

      if (!e.newValue) {
        // Cleared elsewhere — game ended/aborted/expired in another tab.
        setGameStarted(false);
        setDifficulty(null);
        setSavedComputerMatch(null);
        gameExpiresAtRef.current = null;
        return;
      }

      try {
        const parsed = JSON.parse(e.newValue);
        gameExpiresAtRef.current = parsed.expiresAt;
        setSavedComputerMatch(parsed);
        setDifficulty(parsed.difficulty);
        setPlayerColor(parsed.playerColor);
        setChessInstance(new Chess(parsed.position));
        setPosition(parsed.position);
        setMoveHistory(parsed.moveHistory || []);
        setLastMove(parsed.lastMove || null);
        setGameStarted(true);
        setGameOver(parsed.gameOver || false);
        setResult(parsed.result || null);
      } catch (err) {
        // Ignore malformed writes from elsewhere rather than crashing this tab.
        console.error("Failed to sync computer match from another tab:", err);
      }
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  useEffect(() => {
    if (!savedComputerMatch) {
      setSavedMatchCountdown(0);
      return;
    }

    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.floor((savedComputerMatch.expiresAt - Date.now()) / 1000));
      setSavedMatchCountdown(remaining);
      if (remaining <= 0) {
        clearComputerMatch();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [savedComputerMatch, clearComputerMatch]);

  // Get best move from Stockfish via backend
  const getComputerMove = useCallback(async () => {
    if (!difficulty || gameOver) return null;

    setComputerThinking(true);
    setAnalysisLoading(true);

    try {
      const response = await axios.post(
        `${API}/computer/move`,
        {
          fen: chessInstance.fen(),
          depth: difficulty.depth,
          analysis: true,
          multi_pv: 3,
        },
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }
      );

      const normalized = normalizeAnalysisResponse(response.data, difficulty.depth);
      setAnalysis(normalized);

      // Random delay to simulate human thinking
      const [minDelay, maxDelay] = difficulty.delay;
      const delay = Math.random() * (maxDelay - minDelay) + minDelay;
      await new Promise(resolve => setTimeout(resolve, delay));

      return normalized.move;
    } catch (error) {
      console.error("Failed to get computer move:", error);
      // Fallback: make a random legal move
      const moves = chessInstance.moves();
      const fallbackMove = moves[Math.floor(Math.random() * moves.length)];
      const fallbackState = {
        move: fallbackMove,
        source: "random_fallback",
        evaluation: null,
        top_moves: [],
        book_moves: [],
      };
      setAnalysis(fallbackState);
      return fallbackMove;
    } finally {
      setComputerThinking(false);
      setAnalysisLoading(false);
    }
  }, [difficulty, gameOver, chessInstance, token]);

  // Standalone position analysis — independent of the computer calculating
  // its own move. Used on the pre-game screen so that arriving here (e.g.
  // via "Next" from Board Editor) analyzes the loaded position right away,
  // and can be cancelled mid-flight.
  const analysisAbortRef = useRef(null);

  const analyzePosition = useCallback(async (fen) => {
    if (!fen) return;

    analysisAbortRef.current?.abort();
    const controller = new AbortController();
    analysisAbortRef.current = controller;

    setAnalysisLoading(true);
    try {
      const response = await axios.post(
        `${API}/computer/move`,
        {
          fen,
          depth: 12,
          analysis: true,
          multi_pv: 3,
        },
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        }
      );
      const normalized = normalizeAnalysisResponse(response.data, 12);
      setAnalysis(normalized);
    } catch (error) {
      if (axios.isCancel(error) || error.code === "ERR_CANCELED" || error.name === "CanceledError") {
        // Analysis was intentionally stopped — nothing to report.
        return;
      }
      console.error("Failed to analyze position:", error);
      toast.error("Failed to analyze position.");
    } finally {
      if (analysisAbortRef.current === controller) {
        analysisAbortRef.current = null;
        setAnalysisLoading(false);
      }
    }
  }, [token]);

  const stopAnalysis = useCallback(() => {
    analysisAbortRef.current?.abort();
    analysisAbortRef.current = null;
    setAnalysisLoading(false);
  }, []);

  // Analyze the loaded starting position automatically on the pre-game
  // screen (this is what "Next" from Board Editor lands on).
  useEffect(() => {
    if (gameStarted || !startingFen) return;
    analyzePosition(startingFen);
    return () => {
      analysisAbortRef.current?.abort();
      analysisAbortRef.current = null;
      setAnalysisLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameStarted, startingFen]);

  // Make computer move
  const makeComputerMove = useCallback(async () => {
    if (gameOver) return;

    const moveStr = await getComputerMove();
    if (!moveStr) return;

    try {
      const move = chessInstance.move(moveStr);
      if (move) {
        setPosition(chessInstance.fen());
        setMoveHistory(prev => {
          const next = [...prev, move.san];
          saveComputerMatch({
            difficulty,
            playerColor,
            position: chessInstance.fen(),
            moveHistory: next,
            lastMove: { from: move.from, to: move.to },
            gameOver: chessInstance.isCheckmate() || chessInstance.isDraw(),
            result: chessInstance.isCheckmate() ? {
              winner: chessInstance.turn() === 'w' ? 'black' : 'white',
              reason: 'checkmate'
            } : chessInstance.isDraw() ? { winner: 'draw', reason: 'draw' } : null,
          });
          return next;
        });
        setLastMove({ from: move.from, to: move.to });

        // Play sound
        if (chessInstance.isCheckmate()) {
          moveFeedback('gameEnd', settings);
          setGameOver(true);
          setResult({
            winner: chessInstance.turn() === 'w' ? 'black' : 'white',
            reason: "checkmate"
          });
        } else if (chessInstance.isDraw()) {
          moveFeedback('gameEnd', settings);
          setGameOver(true);
          setResult({ winner: "draw", reason: "draw" });
        } else if (chessInstance.isCheck()) {
          moveFeedback('check', settings);
        } else if (move.captured) {
          moveFeedback('capture', settings);
        } else {
          moveFeedback('move', settings);
        }
      }
    } catch (error) {
      console.error("Computer move error:", error);
    }
  }, [getComputerMove, chessInstance, difficulty, playerColor, saveComputerMatch, gameOver, settings]);

  const currentTurn = chessInstance.turn();

  // Check if it's computer's turn and make move
  useEffect(() => {
    if (!gameStarted || gameOver) return;

    const isComputerTurn =
      (playerColor === "white" && currentTurn === "b") ||
      (playerColor === "black" && currentTurn === "w");

    if (isComputerTurn && !computerThinking) {
      makeComputerMove();
    }
  }, [gameStarted, gameOver, playerColor, currentTurn, computerThinking, makeComputerMove]);

  // Start game
  const startGame = (selectedDifficulty, color) => {
    setDifficulty(selectedDifficulty);
    setPlayerColor(color);
    const initialFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    setChessInstance(new Chess());
    setPosition(initialFen);
    setGameOver(false);
    setResult(null);
    setLastMove(null);
    setMoveHistory([]);
    setSelectedSquare(null);
    setPossibleMoves([]);
    setGameStarted(true);
    setAnalysis(null);

    // New game — mint a fresh 24h window rather than inheriting one from
    // whatever game (if any) preceded this.
    gameExpiresAtRef.current = null;
    saveComputerMatch({
      difficulty: selectedDifficulty,
      playerColor: color,
      position: initialFen,
      moveHistory: [],
      lastMove: null,
      gameOver: false,
      result: null,
    });

    moveFeedback('gameStart', settings);
    toast.success(`Game started vs ${selectedDifficulty.name} (${selectedDifficulty.elo} ELO)`, { duration: 3000 });

    // If player is black, computer moves first
    if (color === "black") {
      setTimeout(() => makeComputerMove(), 500);
    }
  };

  // Reset game
  const resetGame = () => {
    setGameStarted(false);
    setDifficulty(null);
    setChessInstance(new Chess());
    setPosition(initialFenFromUrl || defaultFen);
    setGameOver(false);
    setResult(null);
    setLastMove(null);
    setMoveHistory([]);
    setAnalysis(null);
    clearComputerMatch();
  };

  const handleOfferDraw = () => {
    saveComputerMatch({
      difficulty,
      playerColor,
      position: chessInstance.fen(),
      moveHistory,
      lastMove,
      gameOver: true,
      result: { winner: "draw", reason: "draw_agreed" },
    });
    setGameOver(true);
    setResult({ winner: "draw", reason: "draw_agreed" });
    toast.success("Draw agreed. Game over.", { duration: 3000 });
  };

  const handleAbort = () => {
    saveComputerMatch({
      difficulty,
      playerColor,
      position: chessInstance.fen(),
      moveHistory,
      lastMove,
      gameOver: true,
      result: { winner: "draw", reason: "aborted" },
    });
    setGameOver(true);
    setResult({ winner: "draw", reason: "aborted" });
    toast.error("Game aborted.", { duration: 3000 });
  };

  const handleRematch = () => {
    if (!difficulty) return;
    setGameOver(false);
    setResult(null);
    setLastMove(null);
    setMoveHistory([]);
    setAnalysis(null);
    startGame(difficulty, playerColor);
    toast.success("Rematch started.", { duration: 3000 });
  };

  // Execute player move
  const executeMove = (sourceSquare, targetSquare, promotion = "q") => {
    setSelectedSquare(null);
    setPossibleMoves([]);

    if (gameOver || computerThinking) return false;

    const isPlayerTurn =
      (playerColor === "white" && chessInstance.turn() === "w") ||
      (playerColor === "black" && chessInstance.turn() === "b");

    if (!isPlayerTurn) {
      toast.error("Wait for computer to move!");
      return false;
    }

    try {
      const move = chessInstance.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: promotion,
      });

      if (move === null) return false;

      setPosition(chessInstance.fen());
      setMoveHistory(prev => {
        const next = [...prev, move.san];
        saveComputerMatch({
          difficulty,
          playerColor,
          position: chessInstance.fen(),
          moveHistory: next,
          lastMove: { from: sourceSquare, to: targetSquare },
          gameOver: chessInstance.isCheckmate() || chessInstance.isDraw(),
          result: chessInstance.isCheckmate()
            ? { winner: playerColor, reason: "checkmate" }
            : chessInstance.isDraw()
            ? { winner: "draw", reason: "draw" }
            : null,
        });
        return next;
      });
      setLastMove({ from: sourceSquare, to: targetSquare });

      // Play sound and check game end
      if (chessInstance.isCheckmate()) {
        moveFeedback('gameEnd', settings);
        setGameOver(true);
        setResult({ winner: playerColor, reason: "checkmate" });
      } else if (chessInstance.isDraw()) {
        moveFeedback('gameEnd', settings);
        setGameOver(true);
        setResult({ winner: "draw", reason: "draw" });
      } else if (chessInstance.isCheck()) {
        moveFeedback('check', settings);
      } else if (move.captured) {
        moveFeedback('capture', settings);
      } else {
        moveFeedback('move', settings);
      }

      return true;
    } catch (error) {
      console.error("Move error:", error);
      return false;
    }
  };

  const onPieceDrop = ({ piece, sourceSquare, targetSquare }) => {
    return executeMove(sourceSquare, targetSquare, "q");
  };

  const onSquareClick = ({ piece: clickedPiece, square }) => {
    if (gameOver || computerThinking) return;

    const isPlayerTurn =
      (playerColor === "white" && chessInstance.turn() === "w") ||
      (playerColor === "black" && chessInstance.turn() === "b");

    if (!isPlayerTurn) return;

    if (selectedSquare) {
      const safePossibleMoves = Array.isArray(possibleMoves) ? possibleMoves : [];
      if (safePossibleMoves.includes(square)) {
        executeMove(selectedSquare, square, "q");
      } else {
        const piece = chessInstance.get(square);
        const playerPieceColor = playerColor === "white" ? "w" : "b";
        if (piece && piece.color === playerPieceColor) {
          setSelectedSquare(square);
          const moves = chessInstance.moves({ square, verbose: true });
          setPossibleMoves(moves.map(m => m.to));
        } else {
          setSelectedSquare(null);
          setPossibleMoves([]);
        }
      }
    } else {
      const piece = chessInstance.get(square);
      const playerPieceColor = playerColor === "white" ? "w" : "b";
      if (piece && piece.color === playerPieceColor) {
        setSelectedSquare(square);
        const moves = chessInstance.moves({ square, verbose: true });
        setPossibleMoves(moves.map(m => m.to));
      }
    }
  };

  // Custom square styles
  const customSquareStyles = {};
  if (lastMove) {
    customSquareStyles[lastMove.from] = { backgroundColor: "rgba(124, 92, 252, 0.38)" };
    customSquareStyles[lastMove.to] = { backgroundColor: "rgba(124, 92, 252, 0.55)" };
  }
  if (selectedSquare) {
    customSquareStyles[selectedSquare] = {
      backgroundColor: "rgba(76, 141, 255, 0.45)",
      boxShadow: "inset 0 0 0 3px rgba(76, 141, 255, 0.85)",
    };
  }
  possibleMoves.forEach(square => {
    const piece = chessInstance.get(square);
    if (piece) {
      customSquareStyles[square] = {
        ...customSquareStyles[square],
        backgroundColor: "rgba(255, 92, 92, 0.38)",
        boxShadow: "inset 0 0 0 3px rgba(255, 92, 92, 0.6)",
      };
    } else {
      customSquareStyles[square] = {
        ...customSquareStyles[square],
        background: "radial-gradient(circle at center, rgba(60, 203, 127, 0.65) 25%, transparent 25%)",
      };
    }
  });

  const boardOrientation = playerColor;

  // h:mm for the save countdown — raw seconds stopped being readable once
  // the TTL went from 30s to 24h.
  const formatCountdown = (totalSeconds) => {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}:${String(minutes).padStart(2, "0")}`;
  };

  // Difficulty selection screen
  if (!gameStarted) {
    return (
      <div>
        <div className="max-w-2xl mx-auto">
        <div className="sc-reveal-stagger text-center mb-8">
          <div className="sc-reveal-item flex items-center justify-center gap-3 mb-4">
            <Cpu className="w-12 h-12" style={{ color: "var(--brand)" }} />
          </div>
          <h1 className="sc-reveal-item text-3xl font-bold mb-2" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
            Play vs computer
          </h1>
          <p className="sc-reveal-item" style={{ color: "var(--text-secondary)" }}>Practice your skills against our AI opponent</p>
        </div>

          {/* Position Analysis — shown when a custom position was loaded (e.g. via "Next" from Board Editor) */}
          {initialFenFromUrl && (
            <div className="bg-surface-1 border border-hair rounded-sm p-6 mb-6">
              <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
                <div>
                  <h2 className="text-ink font-semibold flex items-center gap-2">
                    <Zap className="w-5 h-5 text-brand" />
                    Position Analysis
                  </h2>
                  <p className="text-ink-secondary text-xs mt-1">Stockfish suggestions for the position you set up</p>
                </div>
                {analysisLoading ? (
                  <Button size="sm" variant="outline" onClick={stopAnalysis} className="border-hair text-ink hover:bg-surface-2">
                    Stop Analysis
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => analyzePosition(startingFen)} className="bg-brand text-brand-on hover:bg-brand-hover">
                    <Zap className="w-4 h-4 mr-2" /> Analyze
                  </Button>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
                <div className="mx-auto w-full" style={{ maxWidth: 160, aspectRatio: "1 / 1" }}>
                  <Chessboard
                    key={`${boardThemeName}-${boardColorName}`}
                    options={{
                      id: "PreGameAnalysisChessboard",
                      position: startingFen,
                      boardOrientation: playerColor,
                      allowDragging: false,
                      showNotation: false,
                      darkSquareStyle: { backgroundColor: boardSquareColors.dark },
                      lightSquareStyle: { backgroundColor: boardSquareColors.light },
                      boardStyle: {
                        width: "100%",
                        height: "100%",
                      },
                    }}
                  />
                </div>

                <div className="text-sm font-mono text-ink-secondary">
                  {analysisLoading && !analysis ? (
                    <p className="text-brand text-xs">Analyzing…</p>
                  ) : analysis ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-surface-2 rounded-sm p-3">
                          <p className="text-ink-secondary text-[11px] uppercase mb-1">Best Move</p>
                          <p className="text-ink text-lg font-semibold">{analysis.move || "—"}</p>
                        </div>
                        <div className="bg-surface-2 rounded-sm p-3">
                          <p className="text-ink-secondary text-[11px] uppercase mb-1">Evaluation</p>
                          <p className="text-ink text-lg font-semibold">
                            {analysis.evaluation?.type === "cp"
                              ? `${analysis.evaluation.value / 100 >= 0 ? "+" : ""}${(analysis.evaluation.value / 100).toFixed(2)}`
                              : analysis.evaluation?.type === "mate"
                              ? `Mate in ${analysis.evaluation.value}`
                              : "—"}
                          </p>
                        </div>
                      </div>
                      {analysis.top_moves && analysis.top_moves.length > 0 && (
                        <div className="bg-surface-2 rounded-sm p-3">
                          <p className="text-ink-secondary text-[11px] uppercase mb-2">Top Moves</p>
                          <div className="grid gap-2">
                            {analysis.top_moves.map((item, index) => (
                              <div key={index} className="flex items-center justify-between gap-2">
                                <span className="text-ink text-sm">{index + 1}. {item.Move || item.move}</span>
                                <span className="text-ink-secondary text-[11px]">{item.Eval || item.score || "—"}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-ink-muted text-sm">Analysis unavailable. Tap Analyze to try again.</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Difficulty Selection */}
          <div className="bg-surface-1 border border-hair rounded-sm p-6 mb-6">
            <h2 className="text-ink font-semibold mb-4 flex items-center gap-2">
              <Target className="w-5 h-5 text-brand" />
              Select Difficulty
            </h2>
            <div className="grid grid-cols-2 gap-4">
              {DIFFICULTY_LEVELS.map((level) => (
                <button
                  key={level.id}
                  onClick={() => setDifficulty(level)}
                  className={`p-4 rounded-sm border transition-all ${
                    difficulty?.id === level.id
                      ? `border-[${level.color}] bg-[${level.color}]/10`
                      : "border-hair hover:border-hair"
                  }`}
                  style={{
                    borderColor: difficulty?.id === level.id ? level.color : undefined,
                    backgroundColor: difficulty?.id === level.id ? `${level.color}10` : undefined,
                  }}
                  data-testid={`difficulty-${level.id}`}
                >
                  <div className="text-left">
                    <p className="text-ink font-semibold">{level.name}</p>
                    <p className="text-sm font-mono" style={{ color: level.color }}>
                      {level.elo} ELO
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Color Selection */}
          {difficulty && (
            <div className="bg-surface-1 border border-hair rounded-sm p-6 mb-6">
              <h2 className="text-ink font-semibold mb-4 flex items-center gap-2">
                <Zap className="w-5 h-5 text-brand" />
                Choose Your Color
              </h2>
              <div className="grid grid-cols-2 gap-4">
                <button
                  onClick={() => startGame(difficulty, "white")}
                  className="p-6 rounded-sm border border-hair hover:border-brand transition-all group"
                  data-testid="play-as-white"
                >
                  <div className="w-16 h-16 mx-auto mb-3 bg-white rounded-sm flex items-center justify-center group-hover:shadow-[0_0_20px_rgba(255,255,255,0.3)]">
                    <span className="text-3xl">♔</span>
                  </div>
                  <p className="text-ink font-semibold">Play as White</p>
                  <p className="text-ink-secondary text-sm">You move first</p>
                </button>
                <button
                  onClick={() => startGame(difficulty, "black")}
                  className="p-6 rounded-sm border border-hair hover:border-brand transition-all group"
                  data-testid="play-as-black"
                >
                  <div className="w-16 h-16 mx-auto mb-3 bg-surface-2 rounded-sm flex items-center justify-center border border-hair group-hover:shadow-[0_0_20px_rgba(0,0,0,0.5)]">
                    <span className="text-3xl text-ink">♚</span>
                  </div>
                  <p className="text-ink font-semibold">Play as Black</p>
                  <p className="text-ink-secondary text-sm">Computer moves first</p>
                </button>
              </div>
            </div>
          )}

          <p className="text-center text-ink-muted text-sm">
            No stakes • Results don't affect your balance • Practice mode only
          </p>
        </div>
      </div>
    );
  }

  // Game screen
  return (
    <div>
      <div
        className="rounded-2xl mb-4 px-4 py-3 flex items-center justify-between flex-wrap gap-3"
        style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
      >
        <Button onClick={resetGame} variant="ghost" size="sm">
          <ChevronLeft className="w-4 h-4 mr-1" />
          New game
        </Button>

        <div className="flex items-center gap-3">
          <div
            className="flex items-center gap-2 px-3 py-1 rounded-lg"
            style={{ background: "var(--surface-2)", border: "1px solid var(--hairline)" }}
          >
            <Cpu className="w-4 h-4" style={{ color: difficulty?.color }} />
            <span className="text-sm font-mono" style={{ color: difficulty?.color }}>
              {difficulty?.name} ({difficulty?.elo})
            </span>
          </div>

          {/* Settings */}
          <div className="relative">
            <Button onClick={() => setShowSettings(!showSettings)} variant="ghost" size="sm">
              <Settings className="w-4 h-4" />
            </Button>

            {showSettings && (
              <div
                className="absolute right-0 top-full mt-2 w-64 rounded-xl shadow-lg z-50"
                style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
              >
                <div className="p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {settings.soundEnabled ? (
                        <Volume2 className="w-4 h-4" style={{ color: "var(--green)" }} />
                      ) : (
                        <VolumeX className="w-4 h-4" style={{ color: "var(--text-secondary)" }} />
                      )}
                      <Label className="text-sm" style={{ color: "var(--text-secondary)" }}>Sound</Label>
                    </div>
                    <Switch checked={settings.soundEnabled} onCheckedChange={(v) => updateSettings('soundEnabled', v)} />
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Smartphone className="w-4 h-4" style={{ color: settings.vibrationEnabled ? "var(--green)" : "var(--text-secondary)" }} />
                      <Label className="text-sm" style={{ color: "var(--text-secondary)" }}>Vibration</Label>
                    </div>
                    <Switch checked={settings.vibrationEnabled} onCheckedChange={(v) => updateSettings('vibrationEnabled', v)} />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto">
        <div className="grid lg:grid-cols-[1fr,280px] gap-6">
          {/* Chess Board */}
          <div>
            {/* Computer info */}
            <div className={`flex items-center justify-between mb-3 bg-surface-1 border p-3 rounded-sm ${
              computerThinking ? "border-brand" : "border-hair"
            }`}>
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-sm flex items-center justify-center ${
                  computerThinking ? "bg-brand-dim" : "bg-surface-2"
                }`}>
                  <Cpu className={`w-5 h-5 ${computerThinking ? "text-brand animate-pulse" : "text-ink-secondary"}`} />
                </div>
                <div>
                  <p className="text-ink font-semibold">{difficulty?.name} Bot</p>
                  <p className="text-sm font-mono" style={{ color: difficulty?.color }}>
                    {difficulty?.elo} ELO
                  </p>
                </div>
              </div>
              {computerThinking && (
                <span className="text-xs bg-brand-dim text-brand px-2 py-1 rounded-sm animate-pulse">
                  Thinking...
                </span>
              )}
            </div>

            {/* Board */}
            <div
              ref={boardWrapperRef}
              className="relative bg-surface-1 p-2 md:p-4 rounded-sm border border-hair overflow-hidden flex items-center justify-center w-full max-w-full"
              style={{
                width: "100%",
                maxWidth: "100%",
                // clip to the available viewport so the board can never spill
                // over the player card below it on short/mobile screens
                maxHeight: "calc(100vh - 220px)",
                margin: "0 auto"
              }}
            >
              <div
                style={{
                  width: "100%",
                  maxWidth: "min(760px, calc(100vw - 40px), calc(100vh - 260px))",
                  // keep a square aspect while respecting available viewport space
                  aspectRatio: "1",
                  height: "auto",
                  margin: "0 auto",
                  display: "block",
                  maxHeight: "calc(100vh - 260px)",
                  // chrome (corners/shadow/clip) lives here, not on the library's boardStyle
                  overflow: "hidden",
                }}
              >
                <Chessboard
                  key={`${boardThemeName}-${boardColorName}`}
                  options={{
                    id: "ComputerChessboard",
                    position: position,
                    onPieceDrop: onPieceDrop,
                    onSquareClick: onSquareClick,
                    boardOrientation: boardOrientation,
                    darkSquareStyle: { backgroundColor: boardSquareColors.dark },
                    lightSquareStyle: { backgroundColor: boardSquareColors.light },
                    squareStyles: customSquareStyles,
                    boardStyle: {
                      width: "100%",
                      height: "100%",
                    },
                    animationDurationInMs: 150,
                    allowDragging: !gameOver && !computerThinking,
                    showNotation: true,
                  }}
                />
              </div>
            </div>

            {/* Player info */}
            <div className="flex items-center justify-between mt-3 bg-surface-1 border border-hair p-3 rounded-sm">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-sm bg-brand-dim flex items-center justify-center">
                  <span className="text-brand font-bold">
                    {user?.username?.charAt(0)?.toUpperCase() || "Y"}
                  </span>
                </div>
                <div>
                  <p className="text-ink font-semibold">{user?.username || "You"}</p>
                  <p className="text-brand text-sm font-mono">{user?.rating || 1200} ELO</p>
                </div>
              </div>
            </div>

            <div className="mt-4 bg-surface-1 border border-hair rounded-sm p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-ink font-semibold text-sm">Computer Analysis</h3>
                  <p className="text-ink-secondary text-xs">Best move, evaluation, and top candidate lines</p>
                </div>
                {analysisLoading ? (
                  <span className="text-brand text-xs">Analyzing...</span>
                ) : (
                  <span className="text-ink-secondary text-xs">
                    {analysis?.source ? `Source: ${analysis.source}` : "Ready"}
                  </span>
                )}
              </div>
              {analysis ? (
                <div className="space-y-3 text-sm font-mono text-ink-secondary">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-surface-2 rounded-sm p-3">
                      <p className="text-ink-secondary text-[11px] uppercase mb-1">Best Move</p>
                      <p className="text-ink text-lg font-semibold">{analysis.move || "—"}</p>
                    </div>
                    <div className="bg-surface-2 rounded-sm p-3">
                      <p className="text-ink-secondary text-[11px] uppercase mb-1">Evaluation</p>
                      <p className="text-ink text-lg font-semibold">
                        {analysis.evaluation?.type === "cp"
                          ? `${analysis.evaluation.value / 100 >= 0 ? "+" : ""}${(analysis.evaluation.value / 100).toFixed(2)}`
                          : analysis.evaluation?.type === "mate"
                          ? `Mate in ${analysis.evaluation.value}`
                          : "—"}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    <div className="bg-surface-2 rounded-sm p-3">
                      <p className="text-ink-secondary text-[11px] uppercase mb-1">Quality</p>
                      <p className="text-ink text-sm">
                        {Array.isArray(analysis.book_moves) && analysis.book_moves.includes(analysis.move)
                          ? "Book move"
                          : analysis.source === "stockfish"
                          ? "Stockfish suggestion"
                          : "Fallback move"}
                      </p>
                    </div>
                    {analysis.book_moves && analysis.book_moves.length > 0 && (
                      <div className="bg-surface-2 rounded-sm p-3">
                        <p className="text-ink-secondary text-[11px] uppercase mb-1">Opening Book</p>
                        <p className="text-ink text-sm">{analysis.book_moves.join(", ")}</p>
                      </div>
                    )}
                  </div>
                  {analysis.top_moves && analysis.top_moves.length > 0 && (
                    <div className="bg-surface-2 rounded-sm p-3">
                      <p className="text-ink-secondary text-[11px] uppercase mb-2">Top Moves</p>
                      <div className="grid grid-cols-1 gap-2">
                        {analysis.top_moves.map((item, index) => (
                          <div key={index} className="rounded-sm bg-surface-1 p-2">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-ink text-sm">{item.Move || item.move}</p>
                              <span className="text-ink-secondary text-[11px]">
                                {item.Eval || item.score || "—"}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-ink-secondary text-sm">Play a move to see the computer's best choice and top candidate moves.</p>
              )}
            </div>
          </div>

          {/* Side Panel */}
          <div className="space-y-4">
            {/* Game Over Modal */}
            {gameOver && (
              <div className="bg-surface-1 border border-brand rounded-sm p-6 text-center">
                <Trophy className={`w-12 h-12 mx-auto mb-3 ${
                  result?.winner === playerColor ? "text-brand" : "text-ink-muted"
                }`} />
                <h2 className="text-xl font-bold text-ink mb-2">
                  {result?.winner === playerColor
                    ? "You Won!"
                    : result?.winner === "draw"
                    ? "Draw!"
                    : "Computer Wins"}
                </h2>
                <p className="text-ink-secondary mb-4 capitalize">{result?.reason}</p>
                <div className="space-y-2">
                  <Button
                    onClick={handleRematch}
                    className="w-full bg-brand text-brand-on hover:bg-brand-hover"
                    data-testid="rematch-btn"
                  >
                    <RotateCcw className="w-4 h-4 mr-2" />
                    Rematch
                  </Button>
                  <Button
                    onClick={resetGame}
                    variant="outline"
                    className="w-full border-hair text-ink hover:bg-surface-2"
                  >
                    Change Difficulty
                  </Button>
                </div>
              </div>
            )}

            {/* Move History */}
            <div className="bg-surface-1 border border-hair rounded-sm">
              <div className="p-3 border-b border-hair">
                <h3 className="text-ink font-semibold text-sm">Move History</h3>
              </div>
              <div className="p-3 max-h-[300px] overflow-y-auto">
                {moveHistory.length === 0 ? (
                  <p className="text-ink-muted text-sm text-center py-4">No moves yet</p>
                ) : (
                  <div className="grid grid-cols-2 gap-1 text-sm font-mono">
                    {moveHistory.map((move, i) => (
                      <div
                        key={i}
                        className={`px-2 py-1 rounded ${
                          i % 2 === 0 ? "text-ink" : "text-ink-secondary"
                        }`}
                      >
                        {i % 2 === 0 && <span className="text-ink-muted mr-2">{Math.floor(i/2) + 1}.</span>}
                        {move}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Controls */}
            <div className="bg-surface-1 border border-hair rounded-sm p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-ink font-semibold text-sm">Game Controls</h3>
                  <p className="text-ink-secondary text-xs">Draw, abort, or rematch your practice game.</p>
                </div>
                {savedMatchCountdown > 0 && (
                  <span className="text-brand text-xs font-mono">
                    {formatCountdown(savedMatchCountdown)} left
                  </span>
                )}
              </div>
              <div className="space-y-3">
                {!gameOver ? (
                  <>
                    <Button
                      onClick={handleOfferDraw}
                      className="w-full bg-brand text-brand-on hover:bg-brand-hover"
                    >
                      Offer Draw
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleAbort}
                      className="w-full border-hair text-ink hover:bg-surface-2"
                    >
                      Abort Game
                    </Button>
                  </>
                ) : (
                  <Button
                    onClick={handleRematch}
                    className="w-full bg-brand text-brand-on hover:bg-brand-hover"
                  >
                    Rematch
                  </Button>
                )}
              </div>
            </div>

            {/* Info */}
            <div className="bg-surface-1 border border-hair rounded-sm p-4">
              <p className="text-ink-muted text-xs text-center">
                Practice mode • No stakes • Results don't affect your rating
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
