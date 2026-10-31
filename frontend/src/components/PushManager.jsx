import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/App";
import {
  isNativeApp,
  webPushSupported,
  subscribeWebPush,
  enableWebPush,
  initNativePush,
} from "@/utils/pushNotifications";

const DISMISS_KEY = "outpla_push_prompt_dismissed_at";
const REASK_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const recentlyDismissed = () => {
  const t = Number(localStorage.getItem(DISMISS_KEY) || 0);
  return t && Date.now() - t < REASK_AFTER_MS;
};

export default function PushManager() {
  const { user, token } = useAuth();
  const navigate = useNavigate();
  const [showPrompt, setShowPrompt] = useState(false);
  const [busy, setBusy] = useState(false);

  // Register / refresh this device's subscription whenever a user is signed in
  useEffect(() => {
    if (!user || !token) return undefined;

    if (isNativeApp()) {
      initNativePush(token, navigate);
      return undefined;
    }
    if (!webPushSupported()) return undefined;

    if (Notification.permission === "granted") {
      subscribeWebPush(token).catch((e) => console.warn("push: subscribe failed", e));
      return undefined;
    }
    if (Notification.permission === "default" && !recentlyDismissed()) {
      const t = setTimeout(() => setShowPrompt(true), 4000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [user, token, navigate]);

  // Notification tapped while the app is already open -> navigate inside the SPA
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return undefined;
    const onMsg = (e) => {
      if (e.data?.type === "outpla:navigate" && e.data.url) navigate(e.data.url);
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, [navigate]);

  if (!showPrompt) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setShowPrompt(false);
  };
  const enable = async () => {
    setBusy(true);
    try {
      await enableWebPush(token);
    } catch (e) {
      console.warn("push: enable failed", e);
    }
    setBusy(false);
    setShowPrompt(false);
  };

  return (
    <div
      role="dialog"
      aria-label="Enable notifications"
      style={{
        position: "fixed", left: 16, right: 16, bottom: 16, zIndex: 60,
        maxWidth: 420, margin: "0 auto", padding: 16, borderRadius: 16,
        background: "var(--surface-1, #14121f)", color: "var(--text-primary, #fff)",
        border: "1px solid var(--hairline, rgba(255,255,255,.12))",
        boxShadow: "0 12px 40px rgba(0,0,0,.45)",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>🔔 Never miss a move</div>
      <div style={{ fontSize: 14, opacity: 0.8, marginBottom: 12 }}>
        Get notified when it&apos;s your turn, when someone challenges you, or when your tournament match is ready.
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={dismiss} style={{ padding: "8px 14px", borderRadius: 10, background: "transparent", color: "inherit", border: "1px solid var(--hairline, rgba(255,255,255,.2))" }}>
          Not now
        </button>
        <button onClick={enable} disabled={busy} style={{ padding: "8px 14px", borderRadius: 10, background: "var(--brand, #7C5CFC)", color: "#fff", border: 0, fontWeight: 600 }}>
          {busy ? "Enabling…" : "Enable"}
        </button>
      </div>
    </div>
  );
}
