import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Music2, Instagram, Facebook, Youtube, ExternalLink } from "lucide-react";

/**
 * Shared "Stream" dialog: picking a platform just opens that platform's own
 * website in a new tab, where the user can go live themselves. There is no
 * OAuth connect step and no backend call - this dialog is a pure link-out,
 * on purpose, so it never depends on any streaming integration existing.
 *
 * (An earlier version of this dialog did real OAuth connect + go-live calls
 * against /api/stream/* - that was replaced with this simpler link-out by
 * request. The backend endpoints may still exist unused; this component no
 * longer calls them.)
 */
const PLATFORMS = [
  { id: "tiktok", label: "TikTok", icon: Music2, color: "#FE2C55", url: "https://www.tiktok.com/live" },
  { id: "instagram", label: "Instagram", icon: Instagram, color: "#E1306C", url: "https://www.instagram.com/" },
  { id: "facebook", label: "Facebook", icon: Facebook, color: "#1877F2", url: "https://www.facebook.com/live/producer" },
  { id: "youtube", label: "YouTube", icon: Youtube, color: "#FF0000", url: "https://www.youtube.com/live_dashboard" },
];

export default function StreamMenuDialog({ open, onOpenChange }) {
  const handleSelect = (platform) => {
    // New tab, not a full navigation - the user's chess game/session stays
    // open behind it instead of getting stranded on the platform's site.
    window.open(platform.url, "_blank", "noopener,noreferrer");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        style={{ background: "var(--surface-1)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
      >
        <DialogHeader>
          <DialogTitle style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Stream</DialogTitle>
        </DialogHeader>
        <p className="text-sm -mt-1" style={{ color: "var(--text-secondary)" }}>
          Pick where you want to go live - opens the platform's site in a new tab.
        </p>
        <div className="space-y-3 pt-2">
          {PLATFORMS.map((platform) => {
            const { id, label, icon: Icon, color } = platform;
            return (
              <button
                key={id}
                type="button"
                onClick={() => handleSelect(platform)}
                className="w-full flex items-center gap-4 rounded-2xl p-4 text-left transition-colors"
                style={{ background: "var(--surface-2)", border: "1px solid var(--hairline)" }}
                data-testid={`stream-${id}-btn`}
              >
                <div
                  className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
                >
                  <Icon className="w-5 h-5" style={{ color }} />
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-[15px]">{label}</p>
                  <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                    Open {label} in a new tab
                  </p>
                </div>
                <ExternalLink className="w-4 h-4 shrink-0" style={{ color: "var(--text-secondary)" }} />
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
