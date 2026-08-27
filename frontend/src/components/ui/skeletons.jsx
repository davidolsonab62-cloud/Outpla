import { cn } from "@/lib/utils";

/**
 * Base shimmer block. Built on the design tokens (surface-2 on surface-1)
 * so it looks right in both themes without any extra props.
 *
 *   <SkeletonBlock className="h-4 w-24" />
 */
export function SkeletonBlock({ className = "", style = {}, ...props }) {
  return (
    <div
      className={cn("sc-skeleton rounded-md", className)}
      style={style}
      {...props}
    />
  );
}

/** A stat-card placeholder — matches .stat-card in the design system. */
export function SkeletonStatCard() {
  return (
    <div
      className="rounded-2xl p-[18px]"
      style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
    >
      <SkeletonBlock className="h-3 w-16 mb-3" />
      <SkeletonBlock className="h-6 w-20" />
    </div>
  );
}

/** A row of N stat cards. */
export function SkeletonStatsRow({ count = 4 }) {
  return (
    <div className="grid gap-3.5" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonStatCard key={i} />
      ))}
    </div>
  );
}

/** A single list row — matches .row-item (avatar + label + trailing value/button). */
export function SkeletonListRow({ trailingWidth = 70 }) {
  return (
    <div
      className="flex items-center gap-3 px-5 py-3.5"
      style={{ borderTop: "1px solid var(--hairline)" }}
    >
      <SkeletonBlock className="h-[30px] w-[30px] rounded-[9px] shrink-0" />
      <SkeletonBlock className="h-4 flex-1 max-w-[160px]" />
      <SkeletonBlock className="h-4 w-16 hidden sm:block" />
      <SkeletonBlock className="h-7 rounded-lg shrink-0" style={{ width: trailingWidth }} />
    </div>
  );
}

/** A full panel of skeleton rows, with a header bar. */
export function SkeletonPanel({ rows = 3, title = true }) {
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}>
      {title && (
        <div className="flex items-center justify-between px-5 pt-[18px] pb-3.5">
          <SkeletonBlock className="h-4 w-32" />
          <SkeletonBlock className="h-3 w-14" />
        </div>
      )}
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonListRow key={i} />
      ))}
    </div>
  );
}

/** Placeholder for a chessboard-shaped image (mini board thumbnails, etc). */
export function SkeletonBoard({ className = "" }) {
  return <SkeletonBlock className={cn("aspect-square rounded-[10px]", className)} />;
}

/** Placeholder for a profile/header card. */
export function SkeletonHeaderCard() {
  return (
    <div
      className="flex items-center gap-5 rounded-2xl p-6"
      style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
    >
      <SkeletonBlock className="h-[76px] w-[76px] rounded-2xl shrink-0" />
      <div className="flex-1">
        <SkeletonBlock className="h-5 w-40 mb-2" />
        <SkeletonBlock className="h-3.5 w-56" />
      </div>
    </div>
  );
}

/** Generic text line(s), for prose-shaped placeholders. */
export function SkeletonText({ lines = 1, className = "" }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonBlock
          key={i}
          className={cn("h-3.5", className)}
          style={{ width: i === lines - 1 ? "60%" : "100%" }}
        />
      ))}
    </div>
  );
}
