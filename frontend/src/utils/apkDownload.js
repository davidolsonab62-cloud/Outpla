import { toast } from "sonner";
import { Capacitor } from "@capacitor/core";

/* Where the APK lives. Default: served from the same site (put the file in
   frontend/public/downloads/outpla.apk). Override with REACT_APP_APK_URL
   to point at a GitHub Release / S3 / CDN link instead. */
export const APK_URL = process.env.REACT_APP_APK_URL || "/downloads/outpla.apk";
export const APK_FILENAME = "Outpla.apk";

/* True when running inside the installed Android/iOS app (Capacitor).
   The download button is hidden there - they already have the app. */
export function isNativeApp() {
  try {
    // 1. Official Capacitor check (works once the bridge is up)
    if (Capacitor.isNativePlatform()) return true;
    // 2. Raw global injected by the native bridge
    if (window.Capacitor?.isNativePlatform?.()) return true;
    // 3. Fallbacks: the app's origin, and Android's WebView user-agent marker.
    //    (Chrome and Custom Tabs do not contain "; wv)".)
    if (window.location.protocol === "capacitor:") return true;
    if (/; wv\)/.test(navigator.userAgent) && /Android/.test(navigator.userAgent)) return true;
    return false;
  } catch {
    return false;
  }
}

export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

/* Checks the file really exists before starting the download. A CRA/SPA
   server answers unknown paths with index.html (HTTP 200), so we also reject
   text/html responses - otherwise users would "download" a web page. */
async function apkIsAvailable() {
  try {
    const res = await fetch(APK_URL, { method: "HEAD", cache: "no-store" });
    if (!res.ok) return false;
    const type = (res.headers.get("content-type") || "").toLowerCase();
    return !type.includes("text/html");
  } catch {
    // Cross-origin hosts may block HEAD/CORS; let the browser try directly.
    return /^https?:\/\//i.test(APK_URL);
  }
}

export async function downloadApk() {
  if (isIOS()) {
    toast.info("The Android app can't be installed on iPhone. Open Outpla in Safari and use Share > Add to Home Screen.");
    return;
  }
  const ok = await apkIsAvailable();
  if (!ok) {
    toast.error("The app download isn't available yet. Please try again soon.");
    return;
  }
  const a = document.createElement("a");
  a.href = APK_URL;
  a.download = APK_FILENAME;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast.success("Download started. Open the file to install - you may need to allow installs from this source.");
}
