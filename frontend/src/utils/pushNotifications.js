import axios from "axios";
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || window.location.origin;
const API = `${BACKEND_URL}/api`;

export const isNativeApp = () => Capacitor.isNativePlatform();

export const webPushSupported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

const authCfg = (token) => ({
  headers: { Authorization: `Bearer ${token}` },
  withCredentials: true,
});

function urlBase64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/* ------------------------------ Web / PWA ------------------------------ */
export async function subscribeWebPush(token) {
  const { data: cfg } = await axios.get(`${API}/push/config`);
  if (!cfg.web_enabled || !cfg.vapid_public_key) return false;

  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  const key = urlBase64ToUint8Array(cfg.vapid_public_key);
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch (e) {
      // An old subscription made with a different key blocks re-subscribing
      const old = await reg.pushManager.getSubscription();
      if (old) await old.unsubscribe();
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
  }
  await axios.post(`${API}/push/subscribe`, { subscription: sub.toJSON() }, authCfg(token));
  return true;
}

/** Must be called from a click handler (iOS and some browsers require a user gesture). */
export async function enableWebPush(token) {
  if (!webPushSupported()) return "unsupported";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm;
  await subscribeWebPush(token);
  return "granted";
}

/* --------------------------- Android (Capacitor) ------------------------ */
let nativeListenersAdded = false;

export async function initNativePush(token, navigate) {
  try {
    if (!nativeListenersAdded) {
      nativeListenersAdded = true;

      await PushNotifications.addListener("registration", async (t) => {
        try {
          await axios.post(
            `${API}/push/register-device`,
            { token: t.value, platform: Capacitor.getPlatform() },
            authCfg(localStorage.getItem("token") || token)
          );
        } catch (e) {
          console.error("push: could not register device token", e);
        }
      });
      await PushNotifications.addListener("registrationError", (e) =>
        console.error("push: registration error", e)
      );
      await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
        const url = action?.notification?.data?.url;
        if (url) navigate(url);
      });
      try {
        await PushNotifications.createChannel({
          id: "outpla_default",
          name: "Game activity",
          description: "Moves, challenges, messages and tournaments",
          importance: 5,
          visibility: 1,
        });
      } catch (e) {
        /* channels only exist on Android 8+ */
      }
    }

    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") {
      perm = await PushNotifications.requestPermissions();
    }
    if (perm.receive === "granted") await PushNotifications.register();
  } catch (e) {
    console.error("push: native init failed", e);
  }
}
