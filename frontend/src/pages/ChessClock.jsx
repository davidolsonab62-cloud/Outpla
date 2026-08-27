import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth, API } from "@/App";
import { ArrowLeft, Bookmark, Clock, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";
import { toast } from "sonner";
import axios from "axios";

const DEFAULT_MINUTES = 5;

// Phase 4e: built-in defaults, mirroring Lobby.jsx's TIME_CONTROLS so the
// same presets are familiar across the app. "Custom Chess Clock presets
// beyond the defaults" (the spec's Phase 4e item) means presets saved
// beyond this list - see the saved-presets section below.
const DEFAULT_CLOCK_PRESETS = [
  { label: "1 min", minutes: 1 },
  { label: "3 min", minutes: 3 },
  { label: "5 min", minutes: 5 },
  { label: "10 min", minutes: 10 },
  { label: "15 min", minutes: 15 },
];

const formatCountdown = (secs) => {
  const m = Math.floor(secs / 60).toString().padStart(2, "0");
  const s = (secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
};

const isMobileViewport = () =>
  typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches;

const enterFullscreen = (el) => {
  if (!el) return;
  const request =
    el.requestFullscreen ||
    el.webkitRequestFullscreen || // iOS/older Safari, Chrome fallback
    el.msRequestFullscreen; // old Edge/IE
  if (request) {
    // Fullscreen must be requested synchronously from a user gesture, and
    // some browsers (notably iOS Safari on non-video elements) reject it —
    // swallow the rejection rather than surface an unhandled promise error.
    Promise.resolve(request.call(el)).catch(() => {});
  }
};

const exitFullscreen = () => {
  if (typeof document === "undefined") return;
  const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
  if (!isFullscreen) return;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (exit) {
    Promise.resolve(exit.call(document)).catch(() => {});
  }
};

export default function ChessClock() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [whiteDuration, setWhiteDuration] = useState(DEFAULT_MINUTES);
  const [blackDuration, setBlackDuration] = useState(DEFAULT_MINUTES);
  const [whiteTimeRemaining, setWhiteTimeRemaining] = useState(DEFAULT_MINUTES * 60);
  const [blackTimeRemaining, setBlackTimeRemaining] = useState(DEFAULT_MINUTES * 60);
  const [activeClock, setActiveClock] = useState("white");
  const [clockRunning, setClockRunning] = useState(false);
  const [clockWinner, setClockWinner] = useState(null);
  const [simulatedFullscreen, setSimulatedFullscreen] = useState(false);
  const intervalRef = useRef(null);
  const pageRef = useRef(null);

  // Phase 4e: saved custom presets beyond DEFAULT_CLOCK_PRESETS. Loaded
  // once on mount so the "X of Y free saves left" copy and per-save cost
  // are visible before the user commits, same spirit as Phase 5's other
  // gated actions.
  const [savedPresets, setSavedPresets] = useState([]);
  const [presetStatus, setPresetStatus] = useState(null);
  const [presetSaving, setPresetSaving] = useState(false);

  const applyPreset = useCallback((minutes) => {
    setClockRunning(false);
    setClockWinner(null);
    setActiveClock("white");
    setSimulatedFullscreen(false);
    exitFullscreen();
    setWhiteDuration(minutes);
    setBlackDuration(minutes);
    setWhiteTimeRemaining(minutes * 60);
    setBlackTimeRemaining(minutes * 60);
  }, []);

  const refreshPresets = useCallback(() => {
    if (!token) return;
    axios
      .get(`${API}/clock-presets`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => {
        setSavedPresets(response.data.presets || []);
        setPresetStatus(response.data);
      })
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    refreshPresets();
  }, [refreshPresets]);

  const saveCurrentAsPreset = useCallback(async () => {
    if (!token) {
      toast.error("Log in to save custom presets");
      return;
    }
    const name = window.prompt("Name this preset (e.g. \"My blitz\"):");
    if (!name || !name.trim()) return;

    setPresetSaving(true);
    try {
      const response = await axios.post(
        `${API}/clock-presets`,
        { name: name.trim(), white_minutes: whiteDuration, black_minutes: blackDuration, increment_seconds: 0 },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (response.data.paid) {
        toast.success(`Preset saved — ${response.data.credits_charged} credits charged.`);
      } else {
        toast.success("Preset saved");
      }
      refreshPresets();
    } catch (error) {
      const detail = error?.response?.data?.detail;
      if (error?.response?.status === 402 && detail?.error === "insufficient_credits") {
        toast.error(`Not enough credits — an extra preset costs ${detail.cost} credits (you have ${detail.credits_balance}).`, {
          action: { label: "Buy credits", onClick: () => navigate("/wallet") },
        });
        return;
      }
      toast.error(typeof detail === "string" ? detail : "Failed to save preset");
    } finally {
      setPresetSaving(false);
    }
  }, [token, whiteDuration, blackDuration, navigate, refreshPresets]);

  const deletePreset = useCallback(async (presetId) => {
    if (!token) return;
    try {
      await axios.delete(`${API}/clock-presets/${presetId}`, { headers: { Authorization: `Bearer ${token}` } });
      setSavedPresets((prev) => prev.filter((p) => p.preset_id !== presetId));
    } catch (error) {
      toast.error("Failed to delete preset");
    }
  }, [token]);

  const resetClock = useCallback(() => {
    setClockRunning(false);
    setWhiteTimeRemaining(whiteDuration * 60);
    setBlackTimeRemaining(blackDuration * 60);
    setClockWinner(null);
    setActiveClock("white");
    setSimulatedFullscreen(false);
    exitFullscreen();
  }, [whiteDuration, blackDuration]);

  const startPauseClock = useCallback(() => {
    if (clockWinner) return;
    setClockRunning((prev) => {
      const next = !prev;
      if (next && isMobileViewport()) {
        // True fullscreen where the browser allows it (Android/desktop)...
        enterFullscreen(pageRef.current);
        // ...and a full-viewport in-page layout everywhere else (notably
        // iOS Safari, which blocks the Fullscreen API on non-video elements
        // and only offers real fullscreen via home-screen PWA install, which
        // is app-wide rather than scoped to this screen).
        setSimulatedFullscreen(true);
      } else if (!next) {
        exitFullscreen();
        setSimulatedFullscreen(false);
      }
      return next;
    });
  }, [clockWinner]);

  const handleTimeClick = useCallback(
    (side) => {
      if (clockWinner) return;
      // Real chess clock convention: you can only tap your OWN side while it's
      // ticking. Tapping it stops your clock and hands the turn to the opponent.
      if (!clockRunning || side !== activeClock) return;
      setActiveClock(side === "white" ? "black" : "white");
    },
    [clockWinner, clockRunning, activeClock]
  );

  useEffect(() => {
    if (!clockRunning || clockWinner) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      setWhiteTimeRemaining((prev) => {
        if (activeClock !== "white" || clockWinner) return prev;
        if (prev <= 1) {
          setClockWinner("black");
          setClockRunning(false);
          setSimulatedFullscreen(false);
          exitFullscreen();
          return 0;
        }
        return prev - 1;
      });

      setBlackTimeRemaining((prev) => {
        if (activeClock !== "black" || clockWinner) return prev;
        if (prev <= 1) {
          setClockWinner("white");
          setClockRunning(false);
          setSimulatedFullscreen(false);
          exitFullscreen();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [clockRunning, activeClock, clockWinner]);

  useEffect(() => {
    setWhiteTimeRemaining(whiteDuration * 60);
  }, [whiteDuration]);

  useEffect(() => {
    setBlackTimeRemaining(blackDuration * 60);
  }, [blackDuration]);

  if (simulatedFullscreen) {
    return (
      <div
        ref={pageRef}
        className="fixed inset-0 z-[999] flex flex-col bg-surface-1"
        style={{ height: "100dvh" }}
      >
        {/* Black's clock — flipped so it reads right-side-up to the player
            sitting across the board, like a real clock's second face. */}
        <button
          type="button"
          onClick={() => handleTimeClick("black")}
          className={`flex-1 flex flex-col items-center justify-center gap-2 bg-black transition-opacity ${
            activeClock === "black" ? "opacity-100 shadow-[inset_0_0_0_4px_var(--brand)]" : "opacity-40"
          }`}
          style={{ transform: "rotate(180deg)" }}
        >
          <p className="text-sm uppercase tracking-[0.3em] text-white/50">Black</p>
          <p className="text-6xl font-bold tabular-nums text-white">{formatCountdown(blackTimeRemaining)}</p>
        </button>

        {/* Center control strip: exit + pause, always upright */}
        <div className="flex items-center justify-center gap-3 py-2 bg-surface-1 border-y border-hair">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setClockRunning(false);
              setSimulatedFullscreen(false);
              exitFullscreen();
            }}
          >
            <ArrowLeft className="w-4 h-4 mr-1" /> Exit
          </Button>
          <Button size="sm" onClick={startPauseClock} className="font-semibold">
            {clockRunning ? (
              <><Pause className="w-4 h-4 mr-1" /> Pause</>
            ) : (
              <><Play className="w-4 h-4 mr-1" /> Resume</>
            )}
          </Button>
        </div>

        {clockWinner && (
          <div className="px-4 py-2 text-center text-sm text-danger bg-danger-dim">
            Time expired for {clockWinner === "white" ? "White" : "Black"}. {clockWinner === "white" ? "Black" : "White"} wins.
          </div>
        )}

        {/* White's clock, upright for the player on this side */}
        <button
          type="button"
          onClick={() => handleTimeClick("white")}
          className={`flex-1 flex flex-col items-center justify-center gap-2 bg-white transition-opacity ${
            activeClock === "white" ? "opacity-100 shadow-[inset_0_0_0_4px_var(--brand)]" : "opacity-40"
          }`}
        >
          <p className="text-sm uppercase tracking-[0.3em] text-black/50">White</p>
          <p className="text-6xl font-bold tabular-nums text-black">{formatCountdown(whiteTimeRemaining)}</p>
        </button>
      </div>
    );
  }

  return (
    <div ref={pageRef} className="sc-page max-w-4xl mx-auto">
      <PageHeader title="Chess clock" subtitle="Tap your time to switch the active side. Reset and start/pause from here." />


      <div className="grid gap-5 lg:grid-cols-[minmax(320px,420px)_1fr]">
        <div className="rounded-2xl border border-hair bg-surface-1 p-4 shadow-sm">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm text-text-secondary uppercase tracking-[0.2em]">Live clock</p>
              <h2 className="text-lg font-semibold">Tap a side to switch</h2>
            </div>
            <div className="inline-flex items-center gap-2 rounded-full border border-hair bg-surface-2 px-3 py-1 text-xs text-text-secondary">
              <Clock className="w-4 h-4" /> Active: {activeClock === "white" ? "White" : "Black"}
            </div>
          </div>

          <div className="grid gap-3">
            <button
              type="button"
              onClick={() => handleTimeClick("white")}
              className={`rounded-3xl border p-4 text-left transition ${activeClock === "white" ? "border-brand bg-brand-dim" : "border-hair bg-surface-2"}`}
              style={{ width: "100%" }}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.22em] text-text-secondary">White</p>
                  <p className="text-4xl font-semibold mt-2">{formatCountdown(whiteTimeRemaining)}</p>
                </div>
                <span className="text-sm text-text-secondary">{whiteDuration} min</span>
              </div>
            </button>

            <button
              type="button"
              onClick={() => handleTimeClick("black")}
              className={`rounded-3xl border p-4 text-left transition ${activeClock === "black" ? "border-brand bg-brand-dim" : "border-hair bg-surface-2"}`}
              style={{ width: "100%" }}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.22em] text-text-secondary">Black</p>
                  <p className="text-4xl font-semibold mt-2">{formatCountdown(blackTimeRemaining)}</p>
                </div>
                <span className="text-sm text-text-secondary">{blackDuration} min</span>
              </div>
            </button>
          </div>

          <div className="mt-5 grid gap-3">
            {/* Phase 4e: quick-select defaults, mirroring Lobby's time
                controls. Tapping one sets both sides and resets the clock. */}
            <div className="flex flex-wrap gap-2">
              {DEFAULT_CLOCK_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => applyPreset(preset.minutes)}
                  className="rounded-full border border-hair bg-surface-2 px-3 py-1 text-xs text-text-secondary hover:bg-surface-1 hover:text-ink transition"
                >
                  {preset.label}
                </button>
              ))}
              {savedPresets.map((preset) => (
                <span
                  key={preset.preset_id}
                  className="inline-flex items-center gap-1 rounded-full border border-brand/40 bg-brand-dim px-3 py-1 text-xs text-brand"
                >
                  <button
                    type="button"
                    onClick={() => applyPreset(preset.white_minutes)}
                    className="hover:underline"
                  >
                    {preset.name} ({preset.white_minutes}m)
                  </button>
                  <button
                    type="button"
                    onClick={() => deletePreset(preset.preset_id)}
                    aria-label={`Delete ${preset.name}`}
                    className="text-brand/60 hover:text-danger"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </span>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={saveCurrentAsPreset}
                disabled={presetSaving}
                className="h-auto rounded-full px-3 py-1 text-xs"
              >
                <Bookmark className="w-3 h-3 mr-1" />
                {presetSaving
                  ? "Saving…"
                  : presetStatus && presetStatus.remaining_free <= 0
                  ? `Save as preset (${presetStatus.extra_preset_cost ?? "?"} cr)`
                  : "Save as preset"}
              </Button>
            </div>
            {presetStatus && presetStatus.remaining_free > 0 && (
              <p className="text-xs text-text-secondary">
                {presetStatus.remaining_free} of {presetStatus.free_limit} free custom preset saves left.
              </p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <label className="rounded-2xl bg-surface-2 p-3 text-sm text-text-secondary">
                White minutes
                <Input
                  type="number"
                  min="1"
                  value={whiteDuration}
                  onChange={(event) => setWhiteDuration(Math.max(1, Number(event.target.value)))}
                  className="mt-2 bg-transparent"
                />
              </label>
              <label className="rounded-2xl bg-surface-2 p-3 text-sm text-text-secondary">
                Black minutes
                <Input
                  type="number"
                  min="1"
                  value={blackDuration}
                  onChange={(event) => setBlackDuration(Math.max(1, Number(event.target.value)))}
                  className="mt-2 bg-transparent"
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={startPauseClock} className="font-semibold">
                {clockRunning ? (
                  <><Pause className="w-4 h-4 mr-2" /> Pause</>
                ) : (
                  <><Play className="w-4 h-4 mr-2" /> Start</>
                )}
              </Button>
              <Button variant="outline" onClick={resetClock} className="font-semibold">
                <RotateCcw className="w-4 h-4 mr-2" /> Reset
              </Button>
            </div>
            {clockWinner && (
              <div className="rounded-2xl bg-danger-dim border border-danger p-3 text-sm text-danger">
                Time expired for {clockWinner === "white" ? "White" : "Black"}. {clockWinner === "white" ? "Black" : "White"} wins.
              </div>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-hair bg-surface-1 p-4 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm text-text-secondary uppercase tracking-[0.2em]">Tips</p>
              <h2 className="text-lg font-semibold">How to use</h2>
            </div>
            <ArrowLeft className="w-4 h-4 text-text-secondary" />
          </div>
          <div className="grid gap-3 text-sm text-text-secondary">
            <p>Tap the time on your side to switch the active clock. The player whose time is active is the one that ticks down.</p>
            <p>Use the duration controls to set the starting time before beginning.</p>
            <p>Pause anytime to stop both clocks.</p>
            <p>Reset restores both clocks to the selected durations.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
