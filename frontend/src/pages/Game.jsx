import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useAuth, API } from "@/App";
import { toast } from "sonner";
import axios from "axios";
import io from "socket.io-client";
import {
  Flag,
  Clock,
  MessageSquare,
  Send,
  ChevronLeft,
  Trophy,
  X,
  Zap,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  FastForward,
  Rewind,
  Volume2,
  VolumeX,
  Smartphone,
  Settings,
  RotateCcw,
} from "lucide-react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import {
  moveFeedback,
  getSettings,
  saveSettings,
} from "@/utils/soundEffects";
import { SkeletonBlock, SkeletonBoard, SkeletonPanel } from "@/components/ui/skeletons";
import { resolveBoardPrefs } from "@/utils/boardPrefs";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || window.location.origin;

// Phase 4e: mirrors EXTRA_TIME_SECONDS on the backend - display only, so
// the button label matches what /games/{id}/add-time actually applies.
// The backend value is always authoritative.
const EXTRA_TIME_SECONDS_DISPLAY = 60;

export default function Game() {
  const { gameId } = useParams();
  const location = useLocation();
  const { user, token, refreshUser } = useAuth();
  const navigate = useNavigate();
  const searchParams = new URLSearchParams(location.search);
  const reviewMode = searchParams.get("review") === "true";
  const importedPgnParam = searchParams.get("pgn") || "";
  const isImportedPgn = !!importedPgnParam || gameId?.startsWith("imported-pgn");

  const decodePGNParam = useCallback((value) => {
    if (!value) return "";

    try {
      const decoded = decodeURIComponent(value);
      try {
        return decodeURIComponent(escape(atob(decoded)));
      } catch {
        return decoded;
      }
    } catch {
      try {
        return atob(value);
      } catch {
        return value;
      }
    }
  }, []);

  const [game, setGame] = useState(null);
  const [chessInstance, setChessInstance] = useState(() => new Chess());
  const [position, setPosition] = useState("start");
  const [loading, setLoading] = useState(true);
  const [playerColor, setPlayerColor] = useState(null);
  const [whiteTime, setWhiteTime] = useState(600);
  const [blackTime, setBlackTime] = useState(600);
  const [messages, setMessages] = useState([]);
  const [drawOffer, setDrawOffer] = useState(null);
  const [chatInput, setChatInput] = useState("");
  const [showChat, setShowChat] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [result, setResult] = useState(null);
  const [lastMove, setLastMove] = useState(null);
  const [moveHistory, setMoveHistory] = useState([]);
  const [currentMoveIndex, setCurrentMoveIndex] = useState(-1);
  const [isReplayMode, setIsReplayMode] = useState(false);
  const [moveStartTime, setMoveStartTime] = useState(null);
  const [tournamentRedirectSeconds, setTournamentRedirectSeconds] = useState(null);

  // Measured pixel size for the chessboard, replacing the previous
  // CSS-only sizing (width:100% + aspectRatio + calc(100vw...)), which
  // react-chessboard's own internal sizing pass wasn't reliably respecting
  // — the board would render wider than the viewport and get hard-clipped
  // by `overflow-x: hidden` on <html>. Measuring the real container width
  // and passing it as an explicit number sidesteps that entirely.
  const boardContainerRef = useRef(null);
  const [boardSize, setBoardSize] = useState(360);

  useLayoutEffect(() => {
    const el = boardContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const computeSize = (containerWidth) => {
      const capped = Math.min(
        containerWidth,
        760,
        window.innerWidth - 40,
        window.innerHeight - 260
      );
      return Math.max(200, Math.floor(capped));
    };

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width;
      if (width) setBoardSize(computeSize(width));
    });
    observer.observe(el);
    setBoardSize(computeSize(el.clientWidth));

    return () => observer.disconnect();
  }, []);

  const spectatorChatAllowed =
    playerColor !== "spectator" ||
    (game?.white_player?.allow_chat_broadcast !== false && game?.black_player?.allow_chat_broadcast !== false);
  const [socketConnected, setSocketConnected] = useState(false);
  
  // Click-to-move state
  const [selectedSquare, setSelectedSquare] = useState(null);
  const [possibleMoves, setPossibleMoves] = useState([]);
  
  // Threefold repetition tracking
  const [positionHistory, setPositionHistory] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState(null);
  const [deepAnalysis, setDeepAnalysis] = useState(null);
  const [deepAnalysisLoading, setDeepAnalysisLoading] = useState(false);
  const [deepAnalysisError, setDeepAnalysisError] = useState(null);

  // Sound and vibration settings
  const [settings, setSettings] = useState(() => getSettings());
  const [showSettings, setShowSettings] = useState(false);

  // Update settings handler
  const updateSettings = (key, value) => {
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    saveSettings(newSettings);
  };

  const socketRef = useRef(null);
  const timerRef = useRef(null);

  // useAuth's user object updates in place when Profile saves settings, so
  // this re-resolves on the next render with no page reload needed.
  const { boardSquareColors, theme, color } = resolveBoardPrefs(user);

  // Fetch game data
  // NOTE: guards use refs (not state) so fetchAnalysis keeps a stable identity across
  // renders. Previously this useCallback depended on `analysis`/`analysisLoading`, both of
  // which it sets itself -> new function reference every call -> the effects below that
  // depend on fetchAnalysis re-fired immediately -> infinite request loop (visible as a
  // flood of repeated GET .../analysis calls / 503s in the console).
  const analysisLoadingRef = useRef(false);
  const analysisDoneRef = useRef(false); // true once we have a definitive result for this game

  useEffect(() => {
    analysisDoneRef.current = false; // reset the guard whenever we switch games
  }, [gameId]);

  const canShowAnalysis = reviewMode || game?.status === "completed";

  const loadImportedPGN = useCallback((pgnText) => {
    if (!pgnText || !pgnText.trim()) {
      setLoading(false);
      return;
    }

    try {
      const importedChess = new Chess();
      importedChess.loadPgn(pgnText);

      const history = importedChess.history({ verbose: false });
      const replay = new Chess();
      const positions = [replay.fen()];

      history.forEach((move) => {
        replay.move(move);
        positions.push(replay.fen());
      });

      const finalFen = positions[positions.length - 1] || importedChess.fen();
      setGame({
        status: "completed",
        fen: finalFen,
        moves: history,
        initial_fen: "start",
        white_player: { username: "Imported PGN" },
        black_player: { username: "Imported PGN" },
      });
      setChessInstance(importedChess);
      setPosition(finalFen);
      setMoveHistory(history);
      setCurrentMoveIndex(history.length - 1);
      setIsReplayMode(true);
      setPlayerColor("spectator");
      setLastMove(
        history.length > 0
          ? { from: history[history.length - 1].slice(0, 2), to: history[history.length - 1].slice(2, 4) }
          : null
      );
      setGameOver(false);
      setResult(null);
      setLoading(false);
    } catch (error) {
      console.error("Failed to load imported PGN:", error);
      toast.error("Unable to load this PGN on the board.");
      setLoading(false);
      navigate("/import-pgn");
    }
  }, [navigate]);

  const fetchAnalysis = useCallback(async (force = false) => {
    if (!gameId || !token || !canShowAnalysis || isImportedPgn) return;
    if (analysisLoadingRef.current && !force) return;
    // If we already have a definitive answer (success or engine unavailable), don't keep retrying
    if (analysisDoneRef.current && !force) return;

    analysisLoadingRef.current = true;
    setAnalysisLoading(true);
    setAnalysisError(null);

    try {
      const response = await axios.get(`${API}/games/${gameId}/analysis`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const analysisData = response.data.analysis || response.data;
      setAnalysis(analysisData);
      analysisDoneRef.current = true; // got a real response, stop auto-retrying

      // Show error only if engine is not available
      if (analysisData?.engine_available === false) {
        setAnalysisError(analysisData?.error || "Stockfish engine not available on server");
      }
    } catch (error) {
      console.warn("Analysis fetch failed:", error);
      const detail = error?.response?.data?.detail;
      if (error?.response?.status === 402 && detail?.error === "insufficient_credits") {
        toast.error(`Not enough credits — the game review costs ${detail.cost} credits (you have ${detail.credits_balance}).`, {
          action: { label: "Buy credits", onClick: () => navigate("/wallet") },
        });
        setAnalysisError("insufficient_credits");
        setAnalysis(null);
        analysisDoneRef.current = true; // definitive answer - don't auto-retry a paywall
        analysisLoadingRef.current = false;
        setAnalysisLoading(false);
        return;
      }
      const message = detail?.detail || detail || error?.response?.data?.error || error?.message || "Stockfish analysis unavailable";
      setAnalysisError(message);
      setAnalysis(null);
      // don't set analysisDoneRef here — let the user retry via the Refresh button
    } finally {
      analysisLoadingRef.current = false;
      setAnalysisLoading(false);
    }
  }, [gameId, token]);

  // Deep/cloud re-analysis (depth 20) of one of the user's own completed
  // games - a separate paid unlock from the standard review above (Phase
  // 4a). Unlike fetchAnalysis, this always POSTs: the endpoint itself is
  // idempotent (no second charge if already unlocked) and returns the
  // result directly, so there's no separate "check first" GET needed here.
  const runDeepAnalysis = useCallback(async () => {
    if (!gameId || !token) return;
    setDeepAnalysisLoading(true);
    setDeepAnalysisError(null);
    try {
      const response = await axios.post(
        `${API}/games/${gameId}/deep-analysis`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setDeepAnalysis(response.data.analysis);
    } catch (error) {
      console.warn("Deep analysis failed:", error);
      const detail = error?.response?.data?.detail;
      if (error?.response?.status === 402 && detail?.error === "insufficient_credits") {
        toast.error(`Not enough credits — deep analysis costs ${detail.cost} credits (you have ${detail.credits_balance}).`, {
          action: { label: "Buy credits", onClick: () => navigate("/wallet") },
        });
        setDeepAnalysisError("insufficient_credits");
      } else {
        const message = detail?.detail || detail || error?.message || "Deep analysis unavailable";
        setDeepAnalysisError(message);
      }
    } finally {
      setDeepAnalysisLoading(false);
    }
  }, [gameId, token, navigate]);

  const fetchGame = useCallback(async () => {
    if (isImportedPgn) {
      const decodedPgn = decodePGNParam(importedPgnParam);
      if (decodedPgn) {
        loadImportedPGN(decodedPgn);
      }
      return;
    }

    try {
      const response = await axios.get(`${API}/games/${gameId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const gameData = response.data;
      setGame(gameData);
      // Ensure timers are synced from DB when loading game
      // Only overwrite local timers when socket is NOT connected (server-authoritative when disconnected)
      const socketConnectedNow = socketRef.current?.connected;
      if (!socketConnectedNow) {
        if (gameData.white_time !== undefined) setWhiteTime(gameData.white_time);
        if (gameData.black_time !== undefined) setBlackTime(gameData.black_time);
      }

      // Set player color
      if (gameData.white_player?.user_id === user?.user_id) {
        setPlayerColor("white");
      } else if (gameData.black_player?.user_id === user?.user_id) {
        setPlayerColor("black");
      } else {
        // Spectator mode
        setPlayerColor("spectator");
      }

      // Load position from initial FEN for review mode, otherwise use current game FEN
      const chess = new Chess();
      const startingFen = gameData.initial_fen && gameData.initial_fen !== "start"
        ? gameData.initial_fen
        : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

      if (reviewMode) {
        chess.load(startingFen);
      } else if (gameData.fen && gameData.fen !== startingFen) {
        chess.load(gameData.fen);
      }

      setMoveHistory(gameData.moves || []);
      setCurrentMoveIndex((gameData.moves || []).length - 1);

      if (reviewMode && gameData.moves && gameData.moves.length > 0) {
        setIsReplayMode(true);

        const reviewChess = new Chess();
        reviewChess.load(startingFen);
        gameData.moves.forEach((move) => {
          if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) {
            reviewChess.move({
              from: move.substring(0, 2),
              to: move.substring(2, 4),
              promotion: move.length === 5 ? move[4] : undefined,
            });
          } else {
            reviewChess.move(move);
          }
        });

        setChessInstance(reviewChess);
        setPosition(reviewChess.fen());

        const lastMoveStr = gameData.moves[gameData.moves.length - 1];
        if (lastMoveStr && lastMoveStr.length >= 4) {
          setLastMove({
            from: lastMoveStr.substring(0, 2),
            to: lastMoveStr.substring(2, 4),
          });
        }
      } else {
        setChessInstance(chess);
        setPosition(chess.fen());
      }

      // Set times (only when socket is not connected)
      if (!socketRef.current?.connected) {
        setWhiteTime(gameData.white_time);
        setBlackTime(gameData.black_time);
      }

      // Set last move for highlighting
      if (gameData.moves && gameData.moves.length > 0) {
        const lastMoveStr = gameData.moves[gameData.moves.length - 1];
        if (lastMoveStr && lastMoveStr.length >= 4) {
          setLastMove({
            from: lastMoveStr.substring(0, 2),
            to: lastMoveStr.substring(2, 4)
          });
        }
      }

      // Check if game is over
      if (gameData.status === "completed") {
        setGameOver(true);
        setResult({
          winner: gameData.result,
          reason: gameData.end_reason,
        });
      }

      // Set move start time for timing tracking
      if (gameData.status === "active") {
        setMoveStartTime(Date.now());
      }

      if ((reviewMode || gameData.status === "completed") && user?.user_id) {
        const isParticipant = [
          gameData.white_player?.user_id,
          gameData.black_player?.user_id
        ].includes(user.user_id);
        if (isParticipant) {
          fetchAnalysis();
        }
      }

      setLoading(false);
    } catch (error) {
      console.error("Failed to load game:", error);
      toast.error("Failed to load game");
      navigate("/lobby");
    }
  }, [gameId, user?.user_id, navigate, reviewMode, fetchAnalysis, token, isImportedPgn, importedPgnParam, decodePGNParam, loadImportedPGN]);

  // Initialize socket with robust reconnection for real-time sync
  useEffect(() => {
    if (reviewMode) {
      return;
    }

    // Configure Socket.IO with polling fallback for proxy environments
    socketRef.current = io(BACKEND_URL, {
      // Start with polling (more reliable through proxies), upgrade to websocket
      transports: ["polling", "websocket"],
      // Reconnection settings
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
      // Path for socket.io (no trailing slash)
      path: "/socket.io",
      // Don't auto connect until handlers are registered
      autoConnect: false,
    });

    socketRef.current.on("connect", () => {
      console.log("🔌 Socket connected:", socketRef.current.id, "Transport:", socketRef.current.io.engine.transport.name);
      setSocketConnected(true);
      // Join game room on connect/reconnect
      socketRef.current.emit("join_user_room", { user_id: user?.user_id });
      socketRef.current.emit("join_game", { game_id: gameId, user_id: user?.user_id });
      console.log("📤 Emitted join_game event for:", gameId);
      // Immediately refresh the game state after joining the room so the creator sees any opponent joins that happened before connect
      fetchGame();
      toast.success("Connected to game server", { duration: 2000 });
    });

    socketRef.current.on("disconnect", () => {
      console.log("Socket disconnected");
      setSocketConnected(false);
      toast.error("Disconnected from game server", { duration: 2000 });
    });

    socketRef.current.on("connect_error", (error) => {
      console.error("Socket connection error:", error);
      setSocketConnected(false);
    });

    socketRef.current.on("reconnect", (attemptNumber) => {
      console.log("Reconnected after", attemptNumber, "attempts");
      // Rejoin game room and sync state
      socketRef.current.emit("join_user_room", { user_id: user?.user_id });
      socketRef.current.emit("join_game", { game_id: gameId, user_id: user?.user_id });
      fetchGame(); // Resync game state on reconnection
      toast.success("Reconnected to game", { duration: 2000 });
    });

    socketRef.current.on("reconnect_attempt", (attemptNumber) => {
      console.log("Reconnection attempt:", attemptNumber);
    });

    socketRef.current.on("joined_game", (data) => {
      console.log("Joined game room:", data.game_id);
    });

    // Handle game state sync on reconnection
    socketRef.current.on("game_sync", (data) => {
      if (data.game_id === gameId && !isReplayMode) {
        console.log("Syncing game state:", data);
        const chess = new Chess();
        chess.load(data.fen);
        setChessInstance(chess);
        setPosition(data.fen);
        setMoveHistory(data.moves || []);
        setCurrentMoveIndex((data.moves?.length || 0) - 1);
        
        // Update game status
        setGame(prev => ({
          ...prev,
          fen: data.fen,
          current_turn: data.current_turn,
          status: data.status
        }));
        
        // Set last move highlight if there are moves
        if (data.moves && data.moves.length > 0) {
          const lastMoveStr = data.moves[data.moves.length - 1];
          if (lastMoveStr && lastMoveStr.length >= 4) {
            setLastMove({
              from: lastMoveStr.substring(0, 2),
              to: lastMoveStr.substring(2, 4)
            });
          }
        }
      }
    });

    socketRef.current.on("move_made", (data) => {
      console.log("🎯 move_made event received from socket:", data, "gameId:", gameId, "isReplayMode:", isReplayMode);
      if (data.game_id === gameId && !isReplayMode) {
        console.log("✅ Processing move_made - updating board state");
        try {
          const chess = new Chess();
          chess.load(data.fen);
          
          // Batch critical state updates with flushSync to prevent concurrent rendering errors
          flushSync(() => {
            setChessInstance(chess);
            setPosition(data.fen);
            setMoveHistory(prev => [...prev, data.move]);
            setCurrentMoveIndex(prev => prev + 1);
            
            // Update game state
            setGame((prev) => ({
              ...prev,
              fen: data.fen,
              current_turn: data.current_turn,
            }));

            // Update timers if provided by server
            if (data.white_time !== undefined) setWhiteTime(data.white_time);
            if (data.black_time !== undefined) setBlackTime(data.black_time);

            // Set last move highlight
            if (data.move && data.move.length >= 4) {
              setLastMove({
                from: data.move.substring(0, 2),
                to: data.move.substring(2, 4)
              });
            }

            // Reset move start time
            setMoveStartTime(Date.now());
          });

          // Check for game end and play sounds (after state is updated)
          if (chess.isCheckmate()) {
            const winner = chess.turn() === "w" ? "black" : "white";
            setGameOver(true);
            setResult({ winner, reason: "checkmate" });
            moveFeedback('gameEnd', settings);
          } else if (chess.isDraw()) {
            setGameOver(true);
            setResult({ winner: "draw", reason: "draw" });
            moveFeedback('gameEnd', settings);
          } else if (chess.isCheck()) {
            moveFeedback('check', settings);
            toast("Check!", { icon: "♔" });
          } else {
            // Normal move or capture sound
            const lastMoveObj = chess.history({ verbose: true }).pop();
            if (lastMoveObj?.captured) {
              moveFeedback('capture', settings);
            } else {
              moveFeedback('move', settings);
            }
          }
        } catch (error) {
          console.error("Error processing move_made event:", error);
          toast.error("Error updating game state");
        }
      }
    });

    // Handle game started - when opponent joins
    socketRef.current.on("game_started", (data) => {
      if (data.game_id === gameId) {
        console.log("Game started event received:", data);
        try {
          flushSync(() => {
            setGame(data);
            setGameOver(false);
            setMoveStartTime(Date.now());
          });
          
          // Play opponent joined sound and vibrate
          moveFeedback('opponentJoined', settings);
          
          toast.success("Opponent joined! Game starting...", { 
            duration: 3000,
            icon: "🎮"
          });
          
          // Refresh game data to get latest state
          fetchGame();
        } catch (error) {
          console.error("Error processing game_started event:", error);
        }
      }
    });

    socketRef.current.on("draw_offered", (data) => {
      if (data.game_id === gameId) {
        setDrawOffer(data.from);
        if (data.from !== user?.user_id) {
          toast(`${data.from} offered a draw`, { duration: 5000 });
        } else {
          toast("Draw offer sent", { duration: 2000 });
        }
      }
    });

    socketRef.current.on("draw_declared", (data) => {
      if (data.game_id === gameId) {
        try {
          flushSync(() => {
            setGameOver(true);
            setResult({ winner: "draw", reason: data.reason || "draw_agreed" });
            setDrawOffer(null);
          });
          toast.info("Game ended in a draw", { duration: 4000 });
        } catch (error) {
          console.error("Error processing draw_declared event:", error);
        }
      }
    });

    socketRef.current.on("draw_cancelled", (data) => {
      if (data.game_id === gameId) {
        setDrawOffer(null);
        toast("Draw offer cancelled", { duration: 2000 });
      }
    });

    // Phase 4e: a takeback_token was spent - sync both boards to the
    // restored position/turn/clocks. Mirrors move_made's state shape so
    // the same chess.js reload logic applies.
    socketRef.current.on("takeback_applied", (data) => {
      if (data.game_id === gameId && !isReplayMode) {
        try {
          const chess = new Chess();
          chess.load(data.fen);
          flushSync(() => {
            setChessInstance(chess);
            setPosition(data.fen);
            setMoveHistory(data.moves || []);
            setCurrentMoveIndex((data.moves?.length || 0) - 1);
            setGame((prev) => ({ ...prev, fen: data.fen, current_turn: data.current_turn }));
            if (data.white_time !== undefined) setWhiteTime(data.white_time);
            if (data.black_time !== undefined) setBlackTime(data.black_time);
            setLastMove(null);
          });
          toast.info(data.by === user?.user_id ? "Move taken back" : "Opponent took back their last move", { duration: 3000 });
        } catch (error) {
          console.error("Error processing takeback_applied event:", error);
        }
      }
    });

    // Phase 4e: an extra_time purchase landed on one side's clock.
    socketRef.current.on("clock_time_added", (data) => {
      if (data.game_id === gameId) {
        if (data.white_time !== undefined) setWhiteTime(data.white_time);
        if (data.black_time !== undefined) setBlackTime(data.black_time);
        const who = data.by === user?.user_id ? "You" : "Opponent";
        toast.info(`${who} added ${data.seconds_added}s to the ${data.color} clock`, { duration: 3000 });
      }
    });

    socketRef.current.on("chat_history", (data) => {
      if (data.game_id === gameId) {
        setMessages(data.messages || []);
      }
    });

    // Handle player joined - auto-update when new player joins
    socketRef.current.on("player_joined", (data) => {
      if (data.game_id === gameId) {
        console.log("Player joined event:", data);
        
        // Play notification sound and vibrate
        moveFeedback('opponentJoined', settings);
        
        toast.success(`${data.username} joined the game!`, { 
          duration: 3000,
          icon: "👋"
        });
        
        // Fetch latest game state immediately
        fetchGame();
      }
    });

    // Handle game ended - resignation, checkmate, draw
    socketRef.current.on("game_ended", (data) => {
      if (data.game_id === gameId) {
        console.log("Game ended event:", data);
        try {
          flushSync(() => {
            setGameOver(true);
            setResult({
              winner: data.result,
              reason: data.reason,
            });
          });
          
          // Play game end sound
          moveFeedback('gameEnd', settings);
          
          // Show appropriate toast
          if (data.reason === "resignation") {
            toast.info(`Game ended by resignation`, { duration: 4000 });
          } else if (data.reason === "threefold_repetition") {
            toast.info("Draw by threefold repetition!", { duration: 4000 });
          }
        } catch (error) {
          console.error("Error processing game_ended event:", error);
        }
      }
    });

    // Handle threefold repetition draw
    socketRef.current.on("draw_declared", (data) => {
      if (data.game_id === gameId) {
        console.log("Draw declared:", data);
        setGameOver(true);
        setResult({ winner: "draw", reason: data.reason || "draw" });
        toast.info(`Draw: ${data.reason}`, { duration: 4000 });
      }
    });

    // The server pairs a tournament player into their next match the
    // instant their current one ends - often faster than the post-game
    // leaderboard countdown below. Jump straight there when it happens,
    // for both white and black, instead of making them wait out the
    // countdown or manually find their new board.
    socketRef.current.on("tournament_match_assigned", (data) => {
      if (data.game_id && data.game_id !== gameId) {
        toast.success("Next match found - taking you to the board!", { duration: 2000 });
        navigate(`/game/${data.game_id}`);
      }
    });

    socketRef.current.on("chat_message", (data) => {
      setMessages((prev) => [...prev, data]);
    });

    // Now that handlers are registered, connect the socket
    socketRef.current.connect();

    socketRef.current.on("time_sync", (data) => {
      setWhiteTime(data.white_time);
      setBlackTime(data.black_time);
    });

    return () => {
      if (socketRef.current) {
        socketRef.current.emit("leave_game", { game_id: gameId });
        socketRef.current.disconnect();
      }
      // Clear current game ID when leaving
      localStorage.removeItem("currentGameId");
    };
  }, [gameId, isReplayMode, fetchGame, reviewMode]);

  // Polling-based sync as fallback when socket is not connected
  // This ensures real-time updates even without WebSocket
  const pollingRef = useRef(null);
  
  useEffect(() => {
    // Only poll when game is active and socket is not connected
    if (game?.status === "active" && !gameOver && !isReplayMode) {
      // Clear any existing poll
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
      
      // Poll every 1 second for opponent moves if socket disconnected
      pollingRef.current = setInterval(async () => {
        if (!socketConnected) {
          try {
            const res = await axios.get(`${API}/games/${gameId}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            
            const gameData = res.data;
            
            // Only update if FEN has changed (opponent made a move)
            if (gameData.fen !== position) {
              console.log("Polling detected move, syncing...");
              const chess = new Chess();
              chess.load(gameData.fen);
              setChessInstance(chess);
              setPosition(gameData.fen);
              setMoveHistory(gameData.moves || []);
              setCurrentMoveIndex((gameData.moves?.length || 0) - 1);
              setGame(gameData);
              
              // Set last move highlight
              if (gameData.moves && gameData.moves.length > 0) {
                const lastMoveStr = gameData.moves[gameData.moves.length - 1];
                if (lastMoveStr && lastMoveStr.length >= 4) {
                  setLastMove({
                    from: lastMoveStr.substring(0, 2),
                    to: lastMoveStr.substring(2, 4)
                  });
                }
              }
              
              // Check for game end
              if (chess.isCheckmate()) {
                const winner = chess.turn() === "w" ? "black" : "white";
                setGameOver(true);
                setResult({ winner, reason: "checkmate" });
              } else if (chess.isDraw()) {
                setGameOver(true);
                setResult({ winner: "draw", reason: "draw" });
              }
            }
          } catch (error) {
            console.error("Polling error:", error);
          }
        }
      }, 1000); // Poll every second
    }
    
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, [game?.status, gameOver, isReplayMode, socketConnected, position, gameId, token]);

  // Auto-refresh game state periodically while socket-connected
  useEffect(() => {
    if (game?.status !== "active" || gameOver || isReplayMode || !socketConnected) {
      return;
    }

    const autoRefreshInterval = setInterval(() => {
      fetchGame();
    }, 5000);

    return () => clearInterval(autoRefreshInterval);
  }, [game?.status, gameOver, isReplayMode, socketConnected, fetchGame]);

  // Fetch game on mount
  useEffect(() => {
    if (isImportedPgn) {
      const decodedPgn = decodePGNParam(importedPgnParam);
      if (decodedPgn) {
        loadImportedPGN(decodedPgn);
      } else {
        setLoading(false);
      }
      return;
    }

    fetchGame();
  }, [fetchGame, isImportedPgn, importedPgnParam, decodePGNParam, loadImportedPGN]);

  useEffect(() => {
    if (reviewMode && !loading) {
      fetchAnalysis();
    }
  }, [reviewMode, loading, fetchAnalysis]);

  // Timer logic - Fixed: White starts first, black only after white's first move
  useEffect(() => {
    if (game?.status !== "active" || gameOver || isReplayMode) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    timerRef.current = setInterval(() => {
      const currentTurn = chessInstance.turn(); // 'w' or 'b'
      const totalMoves = moveHistory.length;
      
      // White's timer runs when it's white's turn
      if (currentTurn === 'w') {
        setWhiteTime((prev) => {
          if (prev <= 1) {
            endGame("black", "timeout");
            return 0;
          }
          return prev - 1;
        });
      } 
      // Black's timer ONLY runs after white has made at least 1 move (totalMoves >= 1)
      else if (currentTurn === 'b' && totalMoves >= 1) {
        setBlackTime((prev) => {
          if (prev <= 1) {
            endGame("white", "timeout");
            return 0;
          }
          return prev - 1;
        });
      }
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [game?.status, gameOver, isReplayMode, chessInstance, moveHistory.length]);

  // Emit periodic time updates to server so backend persists authoritative time
  useEffect(() => {
    if (!socketRef.current || !socketRef.current.connected) return;
    if (game?.status !== "active" || gameOver || isReplayMode) return;

    const timeUpdateInterval = setInterval(() => {
      try {
        socketRef.current.emit("time_update", {
          game_id: gameId,
          white_time: whiteTime,
          black_time: blackTime
        });
      } catch (e) {
        console.warn("Failed to emit time_update:", e);
      }
    }, 1000);

    return () => clearInterval(timeUpdateInterval);
  }, [gameId, game?.status, gameOver, isReplayMode, whiteTime, blackTime]);

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  // Get position key for threefold repetition (FEN without move counters)
  const getPositionKey = (fen) => {
    // FEN format: position activeColor castling enPassant halfmove fullmove
    // For repetition, we only care about: position activeColor castling enPassant
    const parts = fen.split(' ');
    return parts.slice(0, 4).join(' ');
  };

  // Check for threefold repetition
  const checkThreefoldRepetition = (newPositionHistory) => {
    const positionCounts = {};
    for (const pos of newPositionHistory) {
      positionCounts[pos] = (positionCounts[pos] || 0) + 1;
      if (positionCounts[pos] >= 3) {
        return true;
      }
    }
    return false;
  };

  // Core move execution function - used by both drag-drop and click-to-move
  const executeMove = (sourceSquare, targetSquare, promotion = "q") => {
    // Clear selection
    setSelectedSquare(null);
    setPossibleMoves([]);

    // Prevent moves in replay mode
    if (isReplayMode) {
      toast.error("Exit replay mode to make moves");
      return false;
    }
    
    // Prevent moves if game not active
    if (gameOver || game?.status !== "active") {
      console.log("Game not active:", game?.status);
      return false;
    }
    
    // Prevent moves if not your turn
    const isWhiteTurn = chessInstance.turn() === "w";
    if ((isWhiteTurn && playerColor !== "white") || (!isWhiteTurn && playerColor !== "black")) {
      toast.error("Not your turn!");
      return false;
    }

    // Prevent spectators from moving
    if (playerColor === "spectator") {
      toast.error("You are a spectator");
      return false;
    }

    if (!targetSquare || sourceSquare === targetSquare) {
      return false;
    }

    try {
      // Calculate move time
      const moveTime = moveStartTime ? (Date.now() - moveStartTime) / 1000 : 0;
      
      // Make move on local chess instance
      const move = chessInstance.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: promotion,
      });

      if (move === null) {
        console.log("Invalid move");
        return false;
      }

      const newFen = chessInstance.fen();
      console.log("Move made:", move.lan, "New FEN:", newFen);

      // Track position for threefold repetition
      const posKey = getPositionKey(newFen);
      const newPositionHistory = [...positionHistory, posKey];
      setPositionHistory(newPositionHistory);

      // Check for threefold repetition
      if (checkThreefoldRepetition(newPositionHistory)) {
        console.log("Threefold repetition detected!");
        endGame("draw", "threefold_repetition");
        // Emit threefold event via socket
        socketRef.current?.emit("threefold_repetition", {
          game_id: gameId,
          fen: newFen
        });
      }

      // Update local state immediately
      setPosition(newFen);
      setMoveHistory(prev => [...prev, move.lan]);
      setCurrentMoveIndex(prev => prev + 1);
      setLastMove({ from: sourceSquare, to: targetSquare });
      setMoveStartTime(Date.now());

      // Update game state
      setGame(prev => ({
        ...prev,
        fen: newFen,
        current_turn: chessInstance.turn() === "w" ? "white" : "black"
      }));

      // Send move to server
      axios.post(
        `${API}/games/${gameId}/move`,
        {
          game_id: gameId,
          move: move.lan,
          fen: newFen,
          move_time: moveTime,
          white_time: whiteTime,
          black_time: blackTime
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      ).then(() => {
        console.log("Move sent to server");
      }).catch((error) => {
        console.error("Failed to send move:", error);
        toast.error("Failed to send move to server");
      });

      // Emit via socket for real-time sync - only if connected
      if (socketRef.current && socketConnected) {
        console.log("Emitting game_move via socket:", move.lan);
        socketRef.current.emit("game_move", {
          game_id: gameId,
          move: move.lan,
          fen: newFen,
          current_turn: chessInstance.turn() === "w" ? "white" : "black"
        });
      } else {
        console.warn("Socket not connected, game_move not emitted. Relying on polling and REST API.");
      }

      // Play appropriate sound and haptic feedback
      if (chessInstance.isCheckmate()) {
        moveFeedback('gameEnd', settings);
        endGame(playerColor, "checkmate");
      } else if (chessInstance.isDraw()) {
        moveFeedback('gameEnd', settings);
        endGame("draw", "draw");
      } else if (chessInstance.isCheck()) {
        moveFeedback('check', settings);
        toast("Check!", { icon: "♔" });
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

  // react-chessboard v5.10.0 passes { piece, sourceSquare, targetSquare } object
  const onPieceDrop = ({ piece, sourceSquare, targetSquare }) => {
    return executeMove(sourceSquare, targetSquare, "q");
  };

  // Handle square click for click-to-move
  // react-chessboard v5.10.0 passes { piece, square } object
  const onSquareClick = ({ piece: clickedPiece, square }) => {
    // Prevent interaction in replay mode or if game is over
    if (isReplayMode || gameOver || game?.status !== "active") {
      return;
    }

    // Prevent spectators
    if (playerColor === "spectator") {
      return;
    }

    // Check if it's the player's turn
    const isWhiteTurn = chessInstance.turn() === "w";
    const isMyTurnNow = (isWhiteTurn && playerColor === "white") || (!isWhiteTurn && playerColor === "black");
    
    if (!isMyTurnNow) {
      if (selectedSquare) {
        setSelectedSquare(null);
        setPossibleMoves([]);
      }
      return;
    }

    // If a square is already selected
    if (selectedSquare) {
      // Try to move to the clicked square
      if (possibleMoves.includes(square)) {
        executeMove(selectedSquare, square, "q");
      } else {
        // Check if clicking on own piece to reselect
        const piece = chessInstance.get(square);
        if (piece && ((piece.color === 'w' && playerColor === "white") || (piece.color === 'b' && playerColor === "black"))) {
          // Select new piece
          setSelectedSquare(square);
          const moves = chessInstance.moves({ square, verbose: true });
          setPossibleMoves(moves.map(m => m.to));
        } else {
          // Deselect
          setSelectedSquare(null);
          setPossibleMoves([]);
        }
      }
    } else {
      // No square selected, check if clicking on own piece
      const piece = chessInstance.get(square);
      if (piece && ((piece.color === 'w' && playerColor === "white") || (piece.color === 'b' && playerColor === "black"))) {
        setSelectedSquare(square);
        const moves = chessInstance.moves({ square, verbose: true });
        setPossibleMoves(moves.map(m => m.to));
      }
    }
  };

  // Handle right-click to deselect
  // react-chessboard v5.10.0 passes { piece, square } object
  const onSquareRightClick = ({ piece, square }) => {
    setSelectedSquare(null);
    setPossibleMoves([]);
  };

  const endGame = async (winner, reason) => {
    if (gameOver) return;

    try {
      await axios.post(
        `${API}/games/${gameId}/end`,
        { result: winner, reason },
        { headers: { Authorization: `Bearer ${token}` } }
      );
    } catch (error) {
      console.error("Failed to end game:", error);
    }

    setGameOver(true);
    setResult({ winner, reason });
    // Clear current game ID when game ends
    localStorage.removeItem("currentGameId");
  };

  const handleResign = async () => {
    if (!window.confirm("Are you sure you want to resign? You will lose the game.")) {
      return;
    }

    try {
      await axios.post(
        `${API}/games/${gameId}/resign`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      toast.info("You resigned");
    } catch (error) {
      toast.error("Failed to resign");
    }
  };

  const handleOfferDraw = async () => {
    try {
      await axios.post(`${API}/games/${gameId}/draw/offer`, {}, { headers: { Authorization: `Bearer ${token}` } });
      // server will emit draw_offered
    } catch (error) {
      console.error("Failed to offer draw:", error);
      toast.error("Failed to offer draw");
    }
  };

  const handleAcceptDraw = async () => {
    try {
      await axios.post(`${API}/games/${gameId}/draw/accept`, {}, { headers: { Authorization: `Bearer ${token}` } });
      // server will emit draw_declared
    } catch (error) {
      console.error("Failed to accept draw:", error);
      toast.error("Failed to accept draw");
    }
  };

  const handleCancelDraw = async () => {
    try {
      await axios.post(`${API}/games/${gameId}/draw/cancel`, {}, { headers: { Authorization: `Bearer ${token}` } });
    } catch (error) {
      console.error("Failed to cancel draw:", error);
      toast.error("Failed to cancel draw");
    }
  };

  const handleAbort = async () => {
    if (!window.confirm("Are you sure you want to abort/abandon this game? This may incur penalties.")) return;
    try {
      await axios.post(`${API}/games/${gameId}/abandon`, {}, { headers: { Authorization: `Bearer ${token}` } });
      toast.info("Game abandoned");
    } catch (error) {
      console.error("Failed to abandon game:", error);
      toast.error("Failed to abandon game");
    }
  };

  const sendMessage = () => {
    if (!chatInput.trim()) return;
    if (playerColor === "spectator" && !spectatorChatAllowed) {
      toast.error("Spectator chat is disabled for this game");
      return;
    }

    socketRef.current?.emit("chat_message", {
      game_id: gameId,
      message: chatInput,
      username: user?.username,
    });

    setChatInput("");
  };

  // Replay functions
  const enterReplayMode = useCallback(() => {
    requestAnimationFrame(() => {
      const chess = new Chess();
      const startingFen = game?.initial_fen && game.initial_fen !== "start"
        ? game.initial_fen
        : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
      chess.load(startingFen);
      moveHistory.forEach((move) => {
        if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) {
          chess.move({
            from: move.substring(0, 2),
            to: move.substring(2, 4),
            promotion: move.length === 5 ? move[4] : undefined,
          });
        } else {
          chess.move(move);
        }
      });
      setChessInstance(chess);
      setPosition(chess.fen());
      setIsReplayMode(true);
      setCurrentMoveIndex(moveHistory.length - 1);
    });
  }, [game?.initial_fen, moveHistory]);

  const exitReplayMode = useCallback(() => {
    requestAnimationFrame(() => {
      setIsReplayMode(false);

      // Restore the board to the latest current game position using initial FEN if available
      const chess = new Chess();
      const startingFen = game?.initial_fen && game.initial_fen !== "start"
        ? game.initial_fen
        : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
      chess.load(startingFen);
      moveHistory.forEach((move) => {
        if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) {
          chess.move({
            from: move.substring(0, 2),
            to: move.substring(2, 4),
            promotion: move.length === 5 ? move[4] : undefined,
          });
        } else {
          chess.move(move);
        }
      });
      setChessInstance(chess);
      setPosition(chess.fen());
      setCurrentMoveIndex(moveHistory.length - 1);
    });
  }, [game?.initial_fen, moveHistory]);

  const goBackToLobby = useCallback(() => {
    // Clean up replay mode if active
    if (isReplayMode) {
      setIsReplayMode(false);
    }
    // Navigate to lobby
    navigate("/lobby");
  }, [isReplayMode, navigate]);

  const goToTournamentStandings = useCallback(() => {
    if (isReplayMode) {
      setIsReplayMode(false);
    }
    // Send them straight into this tournament's leaderboard dialog rather
    // than just the "My Tournaments" list - Tournaments.jsx opens it
    // automatically when it sees ?leaderboard=<tournament_id>.
    navigate(`/tournaments?leaderboard=${game?.tournament_id}`);
  }, [isReplayMode, navigate, game?.tournament_id]);

  const isTournamentMatch = !!game?.tournament_id;

  // Phase 4c: spend a "rematch token" to instantly re-challenge the
  // opponent from a just-finished CASUAL game. Server structurally blocks
  // this for staked games (stake_amount > 0), so the button only ever
  // shows for casual ones. Creates a fresh challenge the opponent still
  // has to accept - navigate to the queue/lobby rather than the new game
  // directly, since it isn't live until they do.
  const [rematchLoading, setRematchLoading] = useState(false);
  const [rematchSent, setRematchSent] = useState(false);
  const [rematchCost, setRematchCost] = useState(null);
  const [deepAnalysisCost, setDeepAnalysisCost] = useState(null);

  // Phase 5: show cost before the user commits, for the two Phase 4a/4c
  // gated actions on this page that are a discrete opt-in button click
  // (unlike the standard review, which auto-fetches once per game and is
  // idempotently free after the first view - there's no separate "commit"
  // moment to show a price ahead of).
  useEffect(() => {
    if (!token) return;
    axios
      .get(`${API}/credits/feature-costs/rematch_token`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => setRematchCost(response.data.cost))
      .catch(() => {});
    axios
      .get(`${API}/credits/feature-costs/deep_analysis`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => setDeepAnalysisCost(response.data.cost))
      .catch(() => {});
  }, [token]);

  const requestRematch = useCallback(async () => {
    if (!gameId) return;
    setRematchLoading(true);
    try {
      await axios.post(`${API}/games/${gameId}/rematch`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      toast.success("Rematch challenge sent");
      setRematchSent(true);
      refreshUser();
    } catch (error) {
      console.error("Rematch request failed", error);
      const detail = error?.response?.data?.detail;
      if (error?.response?.status === 402 && detail?.error === "insufficient_credits") {
        toast.error(`Not enough credits — a rematch token costs ${detail.cost} credits (you have ${detail.credits_balance}).`, {
          action: { label: "Buy credits", onClick: () => navigate("/wallet") },
        });
        return;
      }
      toast.error(typeof detail === "string" ? detail : "Failed to send rematch challenge");
    } finally {
      setRematchLoading(false);
    }
  }, [gameId, token, navigate, refreshUser]);

  // Phase 4e: takeback/extra-time. Casual (unstaked) games only, per the
  // spec's literal "stake_amount == 0" reading - tournament games are NOT
  // separately excluded (server enforces this structurally - see
  // _require_casual_untracked_game); !game?.stake_amount below just keeps
  // the buttons from showing where they'd always be rejected, same spirit
  // as the rematch button above.
  const [takebackLoading, setTakebackLoading] = useState(false);
  const [addTimeLoading, setAddTimeLoading] = useState(false);
  const [takebackCost, setTakebackCost] = useState(null);
  const [extraTimeCost, setExtraTimeCost] = useState(null);

  const canUseCasualUtility = !game?.stake_amount;

  // Phase 5: show cost before the user commits, same as every other
  // gated action - fetched once via the generic cost-preview endpoint
  // rather than only surfacing the price after a 402.
  useEffect(() => {
    if (!token || !canUseCasualUtility) return;
    axios
      .get(`${API}/credits/feature-costs/takeback_token`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => setTakebackCost(response.data.cost))
      .catch(() => {});
    axios
      .get(`${API}/credits/feature-costs/extra_time`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => setExtraTimeCost(response.data.cost))
      .catch(() => {});
  }, [token, canUseCasualUtility]);

  // Only the player who just moved can take it back, and only before the
  // opponent has replied - i.e. it's currently the OPPONENT's turn, not
  // mine. Computed the same way the server does (current_turn is whoever
  // moves next).
  const canTakeback =
    canUseCasualUtility &&
    game?.status === "active" &&
    moveHistory.length > 0 &&
    playerColor &&
    playerColor !== "spectator" &&
    game?.current_turn &&
    game.current_turn !== playerColor;

  const requestTakeback = useCallback(async () => {
    if (!gameId) return;
    setTakebackLoading(true);
    try {
      await axios.post(`${API}/games/${gameId}/takeback`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      // server emits takeback_applied, which updates the board
      refreshUser();
    } catch (error) {
      console.error("Takeback request failed", error);
      const detail = error?.response?.data?.detail;
      if (error?.response?.status === 402 && detail?.error === "insufficient_credits") {
        toast.error(`Not enough credits — a takeback costs ${detail.cost} credits (you have ${detail.credits_balance}).`, {
          action: { label: "Buy credits", onClick: () => navigate("/wallet") },
        });
        return;
      }
      toast.error(typeof detail === "string" ? detail : "Failed to take back move");
    } finally {
      setTakebackLoading(false);
    }
  }, [gameId, token, navigate, refreshUser]);

  const addExtraTime = useCallback(async () => {
    if (!gameId) return;
    setAddTimeLoading(true);
    try {
      await axios.post(`${API}/games/${gameId}/add-time`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      // server emits clock_time_added, which updates the clock
      refreshUser();
    } catch (error) {
      console.error("Add time request failed", error);
      const detail = error?.response?.data?.detail;
      if (error?.response?.status === 402 && detail?.error === "insufficient_credits") {
        toast.error(`Not enough credits — extra time costs ${detail.cost} credits (you have ${detail.credits_balance}).`, {
          action: { label: "Buy credits", onClick: () => navigate("/wallet") },
        });
        return;
      }
      toast.error(typeof detail === "string" ? detail : "Failed to add time");
    } finally {
      setAddTimeLoading(false);
    }
  }, [gameId, token, navigate, refreshUser]);

  // Once a tournament match ends, the result has already been recorded and
  // (for league tournaments) the player's next paired match is created
  // automatically server-side. Give them a moment to see the result, then
  // send them to "My Tournaments" so they can see the updated leaderboard
  // and pick up their next match. Opening Replay cancels the countdown.
  useEffect(() => {
    if (!gameOver || !isTournamentMatch || isReplayMode) {
      setTournamentRedirectSeconds(null);
      return;
    }

    setTournamentRedirectSeconds(5);
    const interval = setInterval(() => {
      setTournamentRedirectSeconds((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [gameOver, isTournamentMatch, isReplayMode]);

  useEffect(() => {
    if (tournamentRedirectSeconds === 0) {
      goToTournamentStandings();
    }
  }, [tournamentRedirectSeconds, goToTournamentStandings]);

  const goToMove = useCallback((index) => {
    if (index < -1 || index >= moveHistory.length) return;
    
    // Use requestAnimationFrame to make the update non-blocking
    requestAnimationFrame(() => {
      const chess = new Chess();
      const startingFen = game?.initial_fen && game.initial_fen !== "start"
        ? game.initial_fen
        : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
      chess.load(startingFen);

      for (let i = 0; i <= index; i++) {
        if (moveHistory[i]) {
          const move = moveHistory[i];
          if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) {
            chess.move({ from: move.substring(0, 2), to: move.substring(2, 4), promotion: move.length === 5 ? move[4] : undefined });
          } else {
            chess.move(move);
          }
        }
      }
      setChessInstance(chess);
      setPosition(chess.fen());
      setCurrentMoveIndex(index);

      // Update last move highlight
      if (index >= 0 && moveHistory[index]) {
        const move = moveHistory[index];
        if (move.length >= 4) {
          setLastMove({
            from: move.substring(0, 2),
            to: move.substring(2, 4)
          });
        }
      } else {
        setLastMove(null);
      }
    });
  }, [game?.initial_fen, moveHistory]);

  const goToStart = useCallback(() => goToMove(-1), [goToMove]);
  const goToEnd = useCallback(() => goToMove(moveHistory.length - 1), [goToMove, moveHistory.length]);
  const goBack = useCallback(() => goToMove(currentMoveIndex - 1), [goToMove, currentMoveIndex]);
  const goForward = useCallback(() => goToMove(currentMoveIndex + 1), [goToMove, currentMoveIndex]);

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto flex flex-col lg:flex-row gap-5">
        <div className="flex-1 max-w-[600px] mx-auto lg:mx-0 w-full">
          <div className="flex items-center justify-between mb-3">
            <SkeletonBlock className="h-4 w-32" />
            <SkeletonBlock className="h-9 w-20 rounded-lg" />
          </div>
          <SkeletonBoard className="w-full" />
          <div className="flex items-center justify-between mt-3">
            <SkeletonBlock className="h-4 w-32" />
            <SkeletonBlock className="h-9 w-20 rounded-lg" />
          </div>
        </div>
        <div className="w-full lg:w-[300px] shrink-0 space-y-4">
          <SkeletonPanel rows={3} />
        </div>
      </div>
    );
  }

  const currentTurn = chessInstance.turn();
  const isMyTurn =
    (currentTurn === "w" && playerColor === "white") ||
    (currentTurn === "b" && playerColor === "black");

  const safePossibleMoves = Array.isArray(possibleMoves) ? possibleMoves : [];
  const installHint = typeof analysis?.error === "string" && analysis.error.includes("install");

  const opponent = playerColor === "white" ? game?.black_player : game?.white_player;
  const myPlayer = playerColor === "white" ? game?.white_player : game?.black_player;

  // Custom square styles for highlighting
  const customSquareStyles = {};
  
  // Last move highlight (gold)
  if (lastMove) {
    customSquareStyles[lastMove.from] = {
      backgroundColor: "rgba(124, 92, 252, 0.38)",
    };
    customSquareStyles[lastMove.to] = {
      backgroundColor: "rgba(124, 92, 252, 0.55)",
    };
  }
  
  // Selected square highlight (blue)
  if (selectedSquare) {
    customSquareStyles[selectedSquare] = {
      backgroundColor: "rgba(76, 141, 255, 0.45)",
      boxShadow: "inset 0 0 0 3px rgba(76, 141, 255, 0.85)",
    };
  }
  
  // Possible moves highlight (green dots or circles)
  safePossibleMoves.forEach(square => {
    const piece = chessInstance.get(square);
    if (piece) {
      // Capture square - red tint with ring
      customSquareStyles[square] = {
        ...customSquareStyles[square],
        backgroundColor: "rgba(255, 92, 92, 0.38)",
        boxShadow: "inset 0 0 0 3px rgba(255, 92, 92, 0.6)",
      };
    } else {
      // Empty square - green dot indicator
      customSquareStyles[square] = {
        ...customSquareStyles[square],
        background: customSquareStyles[square]?.backgroundColor 
          ? `radial-gradient(circle at center, rgba(60, 203, 127, 0.65) 25%, transparent 25%), ${customSquareStyles[square].backgroundColor}`
          : "radial-gradient(circle at center, rgba(60, 203, 127, 0.65) 25%, transparent 25%)",
      };
    }
  });

  // Determine board orientation
  const boardOrientation = playerColor === "black" ? "black" : "white";

  return (
    <div className="max-w-6xl mx-auto">
      {/* In-page toolbar: back to lobby, pot, replay/live indicator, settings.
          The site nav itself now lives in AppShell/Sidebar. */}
      <div
        className="rounded-2xl mb-4 px-4 py-3 flex items-center justify-between flex-wrap gap-3"
        style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
      >
        <div className="flex items-center gap-4">
          <Button
            onClick={goBackToLobby}
            variant="ghost"
            size="sm"
            data-testid="back-to-lobby-btn"
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            Lobby
          </Button>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Stake Amount Display */}
          {game?.stake_amount > 0 && (
            <div className="px-4 py-1.5 rounded-lg" style={{ background: "var(--brand-dim)", border: "1px solid var(--brand)" }}>
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4" style={{ color: "var(--brand)" }} />
                <span className="font-mono text-sm font-bold" style={{ color: "var(--brand)" }}>
                  Pot: {(game.stake_amount * 2).toFixed(2)} {game.stake_currency}
                </span>
              </div>
            </div>
          )}

          {/* Replay Mode Indicator */}
          {isReplayMode && (
            <div className="px-3 py-1 rounded-lg" style={{ background: "var(--blue-dim)", border: "1px solid var(--blue)" }}>
              <span className="text-sm" style={{ color: "var(--blue)" }}>Replay mode</span>
            </div>
          )}

          {/* Connection Status Indicator */}
          <div
            className="flex items-center gap-2 px-3 py-1 rounded-lg"
            style={{
              background: socketConnected ? "var(--green-dim)" : "var(--brand-dim)",
              border: `1px solid ${socketConnected ? "var(--green)" : "var(--brand)"}`,
            }}
          >
            <div
              className="w-2 h-2 rounded-full animate-pulse"
              style={{ background: socketConnected ? "var(--green)" : "var(--brand)" }}
            />
            <span className="text-xs font-mono" style={{ color: socketConnected ? "var(--green)" : "var(--brand)" }}>
              {socketConnected ? "LIVE" : "SYNC"}
            </span>
          </div>

          {/* Settings Button */}
          <div className="relative">
            <Button
              onClick={() => setShowSettings(!showSettings)}
              variant="ghost"
              size="sm"
              data-testid="game-settings-btn"
            >
              <Settings className="w-4 h-4" />
            </Button>

            {/* Settings Dropdown */}
            {showSettings && (
              <div
                className="absolute right-0 top-full mt-2 w-64 rounded-xl shadow-lg z-50"
                style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
              >
                <div className="p-4" style={{ borderBottom: "1px solid var(--hairline)" }}>
                  <h3 className="font-semibold text-sm">Game settings</h3>
                </div>
                <div className="p-4 space-y-4">
                  {/* Sound Toggle */}
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

                  {/* Vibration Toggle */}
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

      <div className="overflow-hidden">
        <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-[minmax(0,1fr),minmax(280px,320px)]">
          {/* Main Game Area */}
          <div className="min-w-0">
            {/* Opponent info */}
            <div className={`flex items-center justify-between mb-3 bg-surface-1 border p-3 md:p-4 rounded-sm transition-all ${
              !isMyTurn && game?.status === "active" && !isReplayMode ? "border-brand shadow-[0_0_15px_rgba(212,175,55,0.2)]" : "border-hair"
            }`}>
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-10 h-10 md:w-12 md:h-12 rounded-sm flex items-center justify-center shrink-0 ${
                  !isMyTurn && game?.status === "active" && !isReplayMode ? "bg-brand-dim" : "bg-surface-2"
                }`}>
                  <span className={`font-bold text-lg ${
                    !isMyTurn && game?.status === "active" && !isReplayMode ? "text-brand" : "text-ink-secondary"
                  }`}>
                    {opponent?.username?.charAt(0)?.toUpperCase() || "?"}
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="text-ink font-semibold text-sm md:text-base truncate">
                      {opponent?.username || "Waiting..."}
                    </p>
                    {!isMyTurn && game?.status === "active" && !isReplayMode && (
                      <span className="text-[10px] md:text-xs bg-brand-dim text-brand px-2 py-0.5 rounded-sm uppercase tracking-wider animate-pulse shrink-0">
                        Thinking
                      </span>
                    )}
                  </div>
                  <p className="text-brand text-xs md:text-sm font-mono font-bold">
                    {opponent?.rating || 1200} ELO
                  </p>
                </div>
              </div>
              <div
                className={`font-mono text-xl md:text-2xl font-bold px-3 md:px-4 py-2 rounded-sm transition-all shrink-0 ${
                  !isMyTurn && game?.status === "active" && !isReplayMode
                    ? "bg-brand text-brand-on"
                    : "bg-surface-2 text-ink-secondary"
                } ${(playerColor === "white" ? blackTime : whiteTime) < 30 ? "timer-low" : ""}`}
                data-testid="opponent-timer"
              >
                {formatTime(playerColor === "white" ? blackTime : whiteTime)}
              </div>
            </div>

            {/* Chess Board */}
            <div
              ref={boardContainerRef}
              className="relative bg-surface-1 p-2 md:p-4 rounded-sm border border-hair overflow-hidden flex items-center justify-center w-full max-w-full"
              data-testid="chess-board-container"
              style={{
                width: "100%",
                maxWidth: "100%",
                // allow the board to grow but not overflow the viewport on tall or short screens
                maxHeight: "calc(100vh - 220px)",
                margin: "0 auto"
              }}
            >
              <div
                style={{
                  width: boardSize,
                  height: boardSize,
                  margin: "0 auto",
                  display: "block",
                  // chrome (corners/shadow/clip) lives here, not on the library's boardStyle
                  overflow: "hidden",
                }}
              >
                <Chessboard
                  // react-chessboard doesn't reliably re-render square colors when
                  // only style props change on an already-mounted instance, so the
                  // key is tied to the saved preferences to force a clean remount
                  // whenever the user picks a new theme/color (e.g. after saving
                  // on the Profile page) instead of requiring a full page reload.
                  key={`theme-${theme}-color-${color}`}
                  options={{
                    id: "PlayableChessboard",
                    position: position,
                    onPieceDrop: onPieceDrop,
                    onSquareClick: onSquareClick,
                    onSquareRightClick: onSquareRightClick,
                    boardOrientation: boardOrientation,
                    darkSquareStyle: { backgroundColor: boardSquareColors.dark },
                    lightSquareStyle: { backgroundColor: boardSquareColors.light },
                    squareStyles: customSquareStyles,
                    boardStyle: {
                      width: boardSize,
                      height: boardSize
                    },
                    animationDuration: 150,
                    arePiecesDraggable: !isReplayMode && !gameOver && game?.status === "active" && playerColor !== "spectator",
                  }}
                />
              </div>

              {/* Game Over Overlay */}
              {gameOver && !isReplayMode && (
                <div className="absolute inset-0 bg-black/80 flex items-center justify-center backdrop-blur-sm">
                  <div className="text-center p-8">
                    <Trophy
                      className={`w-16 h-16 mx-auto mb-4 ${
                        result?.winner === playerColor
                          ? "text-brand"
                          : result?.winner === "draw"
                          ? "text-ink-secondary"
                          : "text-danger"
                      }`}
                    />
                    <h2
                      className={`font-display font-bold text-3xl mb-2 ${
                        result?.winner === playerColor
                          ? "text-success glitch-text"
                          : result?.winner === "draw"
                          ? "text-ink"
                          : "text-danger"
                      }`}
                      data-testid="game-result-title"
                    >
                      {result?.winner === playerColor
                        ? "Victory!"
                        : result?.winner === "draw"
                        ? "Draw"
                        : "Defeat"}
                    </h2>
                    <p className="text-ink-secondary mb-4 capitalize">
                      by {result?.reason}
                    </p>
                    {game?.stake_amount > 0 && result?.winner === playerColor && (
                      <p className="text-success font-mono text-lg mb-4">
                        +{(game.stake_amount * 2 * 0.98).toFixed(2)}{" "}
                        {game.stake_currency}
                      </p>
                    )}
                    {isTournamentMatch && (
                      <p className="text-ink-secondary text-sm mb-4" data-testid="tournament-redirect-notice">
                        Result recorded.{" "}
                        {tournamentRedirectSeconds !== null && tournamentRedirectSeconds > 0
                          ? `Heading to the tournament leaderboard in ${tournamentRedirectSeconds}s…`
                          : "Your next paired match will appear automatically once it's ready."}
                      </p>
                    )}
                    <div className="flex gap-3 justify-center flex-wrap">
                      <Button
                        onClick={enterReplayMode}
                        variant="outline"
                        className="bg-transparent border-hair text-ink hover:bg-surface-2"
                      >
                        <Play className="w-4 h-4 mr-2" />
                        Replay
                      </Button>
                      {!isTournamentMatch && !game?.stake_amount && playerColor !== "spectator" && (
                        <Button
                          onClick={requestRematch}
                          disabled={rematchLoading || rematchSent}
                          variant="outline"
                          className="bg-transparent border-hair text-ink hover:bg-surface-2"
                          data-testid="rematch-btn"
                        >
                          <RotateCcw className="w-4 h-4 mr-2" />
                          {rematchSent
                            ? "Rematch sent"
                            : rematchLoading
                            ? "…"
                            : `Rematch${rematchCost != null ? ` (${rematchCost} cr)` : ""}`}
                        </Button>
                      )}
                      {isTournamentMatch ? (
                        <Button
                          onClick={goToTournamentStandings}
                          className="bg-brand text-brand-on hover:bg-brand-hover font-bold uppercase tracking-wider"
                          data-testid="back-to-tournament-result-btn"
                        >
                          <Trophy className="w-4 h-4 mr-2" />
                          View Leaderboard
                        </Button>
                      ) : (
                        <Button
                          onClick={goBackToLobby}
                          className="bg-brand text-brand-on hover:bg-brand-hover font-bold uppercase tracking-wider"
                          data-testid="back-to-lobby-result-btn"
                        >
                          Back to Lobby
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Player info */}
            <div className={`flex items-center justify-between mt-3 bg-surface-1 border p-3 md:p-4 rounded-sm transition-all ${
              isMyTurn && game?.status === "active" && !isReplayMode ? "border-success shadow-[0_0_15px_rgba(0,255,148,0.2)]" : "border-hair"
            }`}>
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-10 h-10 md:w-12 md:h-12 rounded-sm flex items-center justify-center shrink-0 ${
                  isMyTurn && game?.status === "active" && !isReplayMode ? "bg-success-dim" : "bg-brand-dim"
                }`}>
                  <span className={`font-bold text-lg ${
                    isMyTurn && game?.status === "active" && !isReplayMode ? "text-success" : "text-brand"
                  }`}>
                    {user?.username?.charAt(0)?.toUpperCase() || "Y"}
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="text-ink font-semibold text-sm md:text-base truncate">
                      {user?.username} (You)
                    </p>
                    {isMyTurn && game?.status === "active" && !isReplayMode && (
                      <span className="text-[10px] md:text-xs bg-success-dim text-success px-2 py-0.5 rounded-sm uppercase tracking-wider shrink-0">
                        Your Turn
                      </span>
                    )}
                  </div>
                  <p className="text-brand text-xs md:text-sm font-mono font-bold">
                    {myPlayer?.rating || user?.rating || 1200} ELO
                  </p>
                </div>
              </div>
              <div
                className={`font-mono text-xl md:text-2xl font-bold px-3 md:px-4 py-2 rounded-sm transition-all shrink-0 ${
                  isMyTurn && game?.status === "active" && !isReplayMode
                    ? "bg-success text-brand-on"
                    : "bg-surface-2 text-ink-secondary"
                } ${(playerColor === "white" ? whiteTime : blackTime) < 30 ? "timer-low" : ""}`}
                data-testid="player-timer"
              >
                {formatTime(playerColor === "white" ? whiteTime : blackTime)}
              </div>
            </div>

            {/* Game Actions */}
            {!gameOver && game?.status === "active" && !isReplayMode && (
              <div className="flex flex-wrap gap-3 mt-4">
                <Button
                  onClick={handleResign}
                  variant="outline"
                  className="bg-transparent border-danger text-danger hover:bg-danger-dim hover:border-danger"
                  data-testid="resign-btn"
                >
                  <Flag className="w-4 h-4 mr-2" />
                  Resign
                </Button>
                  {/* Draw / Abort controls */}
                  {!drawOffer && (
                    <Button
                      onClick={handleOfferDraw}
                      variant="outline"
                      className="bg-transparent border-hair text-ink hover:bg-surface-2"
                    >
                      Offer Draw
                    </Button>
                  )}

                  {drawOffer && drawOffer !== user?.user_id && (
                    <Button
                      onClick={handleAcceptDraw}
                      variant="outline"
                      className="bg-transparent border-info text-info hover:bg-info-dim"
                    >
                      Accept Draw
                    </Button>
                  )}

                  {drawOffer && drawOffer === user?.user_id && (
                    <Button
                      onClick={handleCancelDraw}
                      variant="outline"
                      className="bg-transparent border-yellow-400/20 text-yellow-300 hover:bg-yellow-400/10"
                    >
                      Cancel Draw
                    </Button>
                  )}

                  {/* Phase 4e: takeback/extra-time - casual (unstaked)
                      games only, tournament games included. Server
                      structurally enforces this too; canUseCasualUtility
                      just keeps the buttons from showing where they'd
                      always be rejected. */}
                  {canUseCasualUtility && canTakeback && (
                    <Button
                      onClick={requestTakeback}
                      disabled={takebackLoading}
                      variant="outline"
                      className="bg-transparent border-hair text-ink hover:bg-surface-2"
                    >
                      <RotateCcw className="w-4 h-4 mr-2" />
                      {takebackLoading ? "Taking back…" : `Takeback${takebackCost != null ? ` (${takebackCost} cr)` : ""}`}
                    </Button>
                  )}

                  {canUseCasualUtility && (
                    <Button
                      onClick={addExtraTime}
                      disabled={addTimeLoading}
                      variant="outline"
                      className="bg-transparent border-hair text-ink hover:bg-surface-2"
                    >
                      <Clock className="w-4 h-4 mr-2" />
                      {addTimeLoading ? "Adding…" : `+${EXTRA_TIME_SECONDS_DISPLAY}s${extraTimeCost != null ? ` (${extraTimeCost} cr)` : ""}`}
                    </Button>
                  )}

                  <Button
                    onClick={handleAbort}
                    variant="outline"
                    className="bg-transparent border-hair text-ink hover:bg-surface-2 lg:hidden"
                  >
                    Abort
                  </Button>
                <Button
                  onClick={() => setShowChat(!showChat)}
                  variant="outline"
                  className="bg-transparent border-hair text-ink hover:bg-surface-2 lg:hidden"
                >
                  <MessageSquare className="w-4 h-4 mr-2" />
                  Chat
                </Button>
              </div>
            )}

            {/* Replay Controls */}
            {(isReplayMode || gameOver) && moveHistory.length > 0 && (
              <div className="mt-4 bg-surface-1 border border-hair p-4 rounded-sm">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-ink font-semibold text-sm">Game Replay</h3>
                  {isReplayMode && (
                    <Button
                      onClick={exitReplayMode}
                      size="sm"
                      variant="outline"
                      className="bg-transparent border-hair text-ink hover:bg-surface-2"
                    >
                      <X className="w-4 h-4 mr-1" />
                      Exit Replay
                    </Button>
                  )}
                  {!isReplayMode && gameOver && (
                    <Button
                      onClick={enterReplayMode}
                      size="sm"
                      className="bg-brand text-brand-on hover:bg-brand-hover"
                    >
                      <Play className="w-4 h-4 mr-1" />
                      Start Replay
                    </Button>
                  )}
                </div>
                {isReplayMode && (
                  <>
                    <div className="flex items-center justify-center gap-2 mb-3">
                      <Button
                        onClick={goToStart}
                        size="sm"
                        variant="outline"
                        className="bg-transparent border-hair text-ink hover:bg-surface-2"
                      >
                        <Rewind className="w-4 h-4" />
                      </Button>
                      <Button
                        onClick={goBack}
                        size="sm"
                        variant="outline"
                        className="bg-transparent border-hair text-ink hover:bg-surface-2"
                        disabled={currentMoveIndex < 0}
                      >
                        <SkipBack className="w-4 h-4" />
                      </Button>
                      <span className="text-ink-secondary font-mono text-sm px-3">
                        {currentMoveIndex + 1} / {moveHistory.length}
                      </span>
                      <Button
                        onClick={goForward}
                        size="sm"
                        variant="outline"
                        className="bg-transparent border-hair text-ink hover:bg-surface-2"
                        disabled={currentMoveIndex >= moveHistory.length - 1}
                      >
                        <SkipForward className="w-4 h-4" />
                      </Button>
                      <Button
                        onClick={goToEnd}
                        size="sm"
                        variant="outline"
                        className="bg-transparent border-hair text-ink hover:bg-surface-2"
                      >
                        <FastForward className="w-4 h-4" />
                      </Button>
                    </div>
                    <div className="w-full bg-surface-2 rounded-full h-2">
                      <div
                        className="bg-brand h-2 rounded-full transition-all"
                        style={{ width: `${moveHistory.length > 0 ? ((currentMoveIndex + 1) / moveHistory.length) * 100 : 0}%` }}
                      />
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Waiting for opponent */}
            {game?.status === "waiting" && (
              <div className="mt-4 bg-brand-dim border border-brand p-4 rounded-sm text-center">
                <div className="w-8 h-8 spinner mx-auto mb-2" />
                <p className="text-brand">Waiting for opponent to join...</p>
                {game?.stake_amount > 0 && (
                  <p className="text-ink-secondary text-sm mt-2">
                    Stake: {game.stake_amount} {game.stake_currency} locked in escrow
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            {/* Game Info Card */}
            <div className="bg-surface-1 border border-hair rounded-sm p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-ink font-semibold text-sm">Match Info</h3>
                <span className={`text-xs px-2 py-1 rounded-sm ${
                  game?.status === "active" ? "status-active" : 
                  game?.status === "waiting" ? "status-waiting" : "status-completed"
                }`}>
                  {game?.status?.toUpperCase()}
                </span>
              </div>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between items-center">
                  <span className="text-ink-secondary flex items-center gap-2">
                    <Clock className="w-4 h-4" /> Time Control
                  </span>
                  <span className="text-ink font-mono">{game?.time_control}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-secondary">Game Type</span>
                  <span className="text-ink capitalize">{game?.game_type}</span>
                </div>
                {game?.stake_amount > 0 && (
                  <>
                    <div className="border-t border-hair pt-3">
                      <div className="flex justify-between mb-2">
                        <span className="text-ink-secondary">Your Stake</span>
                        <span className="text-brand font-mono font-bold">
                          {game.stake_amount} {game.stake_currency}
                        </span>
                      </div>
                      <div className="flex justify-between mb-2">
                        <span className="text-ink-secondary">Total Pot</span>
                        <span className="text-ink font-mono">
                          {(game.stake_amount * 2).toFixed(2)} {game.stake_currency}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-ink-secondary">Winner Gets</span>
                        <span className="text-success font-mono font-bold">
                          {(game.stake_amount * 2 * 0.98).toFixed(2)} {game.stake_currency}
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Stockfish Analysis */}
            <div className="bg-surface-1 border border-hair rounded-sm p-4">
              {canShowAnalysis ? (
                <>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-ink font-semibold text-sm">Stockfish Review</h3>
                    <Button
                      onClick={() => fetchAnalysis(true)}
                      size="sm"
                      variant="outline"
                      className="bg-transparent border-hair text-ink hover:bg-surface-2"
                      disabled={analysisLoading}
                    >
                      Refresh
                    </Button>
                  </div>

                  {analysisLoading ? (
                    <div className="text-ink-secondary text-sm">Analyzing game, please wait...</div>
                  ) : analysis?.engine_available === false ? (
                    <div className="space-y-3">
                      <div className="bg-danger-dim border border-danger rounded-sm p-3">
                        <p className="text-sm text-danger font-semibold">Engine Unavailable</p>
                        <p className="text-xs text-ink-secondary mt-1">{analysis?.error || "Stockfish engine not available on server"}</p>
                      </div>
                      {!installHint && (
                        <Button
                          onClick={() => fetchAnalysis(true)}
                          size="sm"
                          className="w-full bg-brand text-brand-on hover:bg-brand-hover"
                        >
                          Try Again
                        </Button>
                      )}
                    </div>
                  ) : analysisError === "insufficient_credits" ? (
                    <div className="space-y-3">
                      <div className="bg-brand-dim border border-brand rounded-sm p-3">
                        <p className="text-sm text-ink font-semibold">Unlock this game's review</p>
                        <p className="text-xs text-ink-secondary mt-1">Spend a few credits to see blunder detection, accuracy, and move-by-move annotations for this game.</p>
                      </div>
                      <Button
                        onClick={() => navigate("/wallet")}
                        size="sm"
                        className="w-full bg-brand text-brand-on hover:bg-brand-hover"
                      >
                        Buy credits
                      </Button>
                    </div>
                  ) : analysisError ? (
                    <div className="space-y-2">
                      <div className="text-sm text-danger">{analysisError}</div>
                      <Button
                        onClick={() => fetchAnalysis(true)}
                        size="sm"
                        variant="outline"
                        className="bg-transparent border-hair text-ink hover:bg-surface-2"
                      >
                        Retry Analysis
                      </Button>
                    </div>
                  ) : analysis && analysis?.moves?.length > 0 ? (
                    <div className="space-y-3 text-sm font-mono">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="bg-surface-2 rounded-sm p-3">
                          <p className="text-ink-secondary text-xs uppercase">Best moves</p>
                          <p className="text-success text-lg font-semibold">{analysis.summary?.best ?? 0}</p>
                        </div>
                        <div className="bg-surface-2 rounded-sm p-3">
                          <p className="text-ink-secondary text-xs uppercase">Brilliancy</p>
                          <p className="text-ink text-lg font-semibold">{analysis.summary?.brilliant ?? 0}</p>
                        </div>
                        <div className="bg-surface-2 rounded-sm p-3">
                          <p className="text-ink-secondary text-xs uppercase">Inaccuracies</p>
                          <p className="text-brand text-lg font-semibold">{analysis.summary?.inaccuracy ?? 0}</p>
                        </div>
                        <div className="bg-surface-2 rounded-sm p-3">
                          <p className="text-ink-secondary text-xs uppercase">Mistakes</p>
                          <p className="text-warn text-lg font-semibold">{analysis.summary?.mistake ?? 0}</p>
                        </div>
                        <div className="bg-surface-2 rounded-sm p-3">
                          <p className="text-ink-secondary text-xs uppercase">Blunders</p>
                          <p className="text-danger text-lg font-semibold">{analysis.summary?.blunder ?? 0}</p>
                        </div>
                      </div>
                      <div className="bg-surface-2 rounded-sm p-3">
                        <p className="text-ink-secondary text-xs uppercase mb-3">Detailed moves</p>
                        <div className="space-y-2 max-h-[300px] overflow-y-auto">
                          {analysis.moves.slice(0, 8).map((item, idx) => (
                            <div key={idx} className="p-2 rounded-sm bg-surface-1 border border-hair">
                              <div className="flex items-start justify-between gap-2 mb-1">
                                <div className="flex-1">
                                  <p className="text-ink text-xs font-semibold">Move {item.move_index}: {item.move}</p>
                                  {item.best_move && item.best_move !== item.move && (
                                    <p className="text-ink-secondary text-[10px]">Better: {item.best_move}</p>
                                  )}
                                </div>
                                <span className={`px-2 py-1 rounded-sm text-[10px] font-semibold whitespace-nowrap ${
                                  item.category === 'best' ? 'bg-success-dim text-success' :
                                  item.category === 'brilliant' ? 'bg-success-dim text-success' :
                                  item.category === 'inaccuracy' ? 'bg-brand-dim text-brand' :
                                  item.category === 'mistake' ? 'bg-warn-dim text-warn' :
                                  item.category === 'blunder' ? 'bg-danger-dim text-danger' :
                                  'bg-surface-2 text-ink-secondary'
                                }`}>
                                  {item.category?.toUpperCase()}
                                </span>
                              </div>
                              {(item.eval_before || item.eval_after) && (
                                <div className="text-[10px] text-ink-secondary grid grid-cols-2 gap-1">
                                  {item.eval_before && (
                                    <p>Before: {item.eval_before.type === 'cp' ? (item.eval_before.value / 100).toFixed(1) : item.eval_before.type === 'mate' ? `M${item.eval_before.value}` : '0'}</p>
                                  )}
                                  {item.eval_after && (
                                    <p>After: {item.eval_after.type === 'cp' ? (item.eval_after.value / 100).toFixed(1) : item.eval_after.type === 'mate' ? `M${item.eval_after.value}` : '0'}</p>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-ink-secondary text-sm">
                      Stockfish review is available only for completed games or in review mode.
                    </div>
                  )}
                </>
              ) : (
                <div className="text-ink-secondary text-sm">
                  Stockfish review is available only for completed games or in review mode.
                </div>
              )}
            </div>

            {/* Deep/cloud analysis (Phase 4a) — own games only, separate
                paid unlock from the standard review above. */}
            {canShowAnalysis && !isImportedPgn && playerColor && (
              <div className="bg-surface-1 border border-hair rounded-sm p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-ink font-semibold text-sm">Deep Analysis</h3>
                  {deepAnalysis && (
                    <Button
                      onClick={runDeepAnalysis}
                      size="sm"
                      variant="outline"
                      className="bg-transparent border-hair text-ink hover:bg-surface-2"
                      disabled={deepAnalysisLoading}
                    >
                      Refresh
                    </Button>
                  )}
                </div>

                {deepAnalysisLoading ? (
                  <div className="text-ink-secondary text-sm">Running deep analysis, please wait...</div>
                ) : deepAnalysisError === "insufficient_credits" ? (
                  <div className="space-y-3">
                    <div className="bg-brand-dim border border-brand rounded-sm p-3">
                      <p className="text-sm text-ink font-semibold">Unlock deeper analysis</p>
                      <p className="text-xs text-ink-secondary mt-1">
                        Go beyond the standard review with a much deeper engine pass on this game.
                        {deepAnalysisCost != null ? ` Costs ${deepAnalysisCost} credits.` : ""}
                      </p>
                    </div>
                    <Button
                      onClick={() => navigate("/wallet")}
                      size="sm"
                      className="w-full bg-brand text-brand-on hover:bg-brand-hover"
                    >
                      Buy credits
                    </Button>
                  </div>
                ) : deepAnalysisError ? (
                  <div className="space-y-2">
                    <div className="text-sm text-danger">{deepAnalysisError}</div>
                    <Button
                      onClick={runDeepAnalysis}
                      size="sm"
                      variant="outline"
                      className="bg-transparent border-hair text-ink hover:bg-surface-2"
                    >
                      Retry
                    </Button>
                  </div>
                ) : deepAnalysis ? (
                  <div className="space-y-3 text-sm font-mono">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-surface-2 rounded-sm p-3">
                        <p className="text-ink-secondary text-xs uppercase">Depth</p>
                        <p className="text-ink text-lg font-semibold">{deepAnalysis.depth}</p>
                      </div>
                      <div className="bg-surface-2 rounded-sm p-3">
                        <p className="text-ink-secondary text-xs uppercase">Blunders</p>
                        <p className="text-danger text-lg font-semibold">{deepAnalysis.summary?.blunder ?? 0}</p>
                      </div>
                    </div>
                    <p className="text-xs text-ink-secondary">
                      {deepAnalysis.summary?.best ?? 0} best · {deepAnalysis.summary?.mistake ?? 0} mistakes · {deepAnalysis.summary?.inaccuracy ?? 0} inaccuracies
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-ink-secondary text-sm">
                      Get a deeper Stockfish pass (depth {`>`}12) on this game beyond the standard review.
                    </p>
                    <Button
                      onClick={runDeepAnalysis}
                      size="sm"
                      className="w-full bg-brand text-brand-on hover:bg-brand-hover"
                    >
                      {`Run Deep Analysis${deepAnalysisCost != null ? ` (${deepAnalysisCost} cr)` : ""}`}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Move History */}
            <div className="bg-surface-1 border border-hair rounded-sm">
              <div className="p-3 border-b border-hair flex items-center justify-between">
                <h3 className="text-ink font-semibold text-sm">Move History</h3>
                <span className="text-ink-muted text-xs">{moveHistory.length} moves</span>
              </div>
              <ScrollArea className="h-40 md:h-48 p-3">
                <div className="grid grid-cols-2 gap-1 font-mono text-sm">
                  {moveHistory.map((move, index) => (
                    <div
                      key={index}
                      onClick={() => isReplayMode && goToMove(index)}
                      className={`px-2 py-1 rounded-sm cursor-pointer transition-colors ${
                        index === currentMoveIndex
                          ? "bg-brand-dim text-brand"
                          : index % 2 === 0 ? "bg-surface-2 hover:bg-surface-2" : "hover:bg-surface-2"
                      }`}
                    >
                      {index % 2 === 0 && (
                        <span className="text-ink-muted mr-2">
                          {Math.floor(index / 2) + 1}.
                        </span>
                      )}
                      <span className={index === currentMoveIndex ? "text-brand" : "text-ink"}>
                        {move}
                      </span>
                    </div>
                  ))}
                </div>
                {moveHistory.length === 0 && (
                  <p className="text-ink-muted text-center py-4 text-sm">
                    No moves yet
                  </p>
                )}
              </ScrollArea>
            </div>

            {/* Chat */}
            <div className={`bg-surface-1 border border-hair rounded-sm ${showChat ? "block" : "hidden lg:block"}`}>
              <div className="p-3 border-b border-hair flex items-center justify-between">
                <h3 className="text-ink font-semibold text-sm">Game Chat</h3>
                <button
                  onClick={() => setShowChat(false)}
                  className="lg:hidden text-ink-secondary hover:text-ink"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <ScrollArea className="h-32 md:h-40 p-3">
                <div className="space-y-2">
                  {messages.map((msg, index) => (
                    <div key={index} className="flex items-start gap-3 text-sm">
                      <Avatar className="h-8 w-8">
                        {msg.picture ? (
                          <AvatarImage src={msg.picture} alt={msg.username} />
                        ) : (
                          <AvatarFallback>{(msg.username || "?")[0]?.toUpperCase() || "?"}</AvatarFallback>
                        )}
                      </Avatar>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-ink">{msg.username}</div>
                        <div className="text-ink-secondary break-words">{msg.message}</div>
                      </div>
                    </div>
                  ))}
                  {messages.length === 0 && (
                    <p className="text-ink-muted text-center py-4 text-sm">No messages yet</p>
                  )}
                </div>
              </ScrollArea>
              <div className="p-3 border-t border-hair">
                {playerColor === "spectator" && !spectatorChatAllowed ? (
                  <div className="rounded-xl bg-surface-2 border border-hair p-3 text-sm text-ink-secondary">
                    Spectator chat is turned off for this game. You can still watch moves and follow the board.
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2 mb-3">
                      {["😀", "😂", "❤️", "🔥", "👍", "🎉", "😮", "😢"].map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => setChatInput((prev) => prev + emoji)}
                          className="rounded-full border border-hair px-2 py-1 text-sm"
                          style={{ background: "var(--surface-2)", color: "var(--text-primary)" }}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Input
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                        placeholder="Type a message..."
                        className="bg-surface-2 border-hair text-ink text-sm h-9"
                        data-testid="chat-input"
                      />
                      <Button
                        onClick={sendMessage}
                        size="sm"
                        className="bg-brand text-brand-on hover:bg-brand-hover h-9 px-3"
                        data-testid="send-chat-btn"
                      >
                        <Send className="w-4 h-4" />
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
