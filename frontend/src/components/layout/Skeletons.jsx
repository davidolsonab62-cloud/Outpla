import { Skeleton } from "@/components/ui/skeleton";

/** Base bar — token-driven so it looks right in both themes (overrides the
 * shadcn default's bg-primary/10, which reads wrong against surface-1 cards). */
function Bar({ className = "", style = {}, ...props }) {
  return (
    <Skeleton
      className={className}
      style={{ backgroundColor: "var(--hairline)", ...style }}
      {...props}
    />
  );
}

/** A single stat-card skeleton — label bar + big number bar. */
export function SkeletonStat() {
  return (
    <div className="rounded-2xl p-[18px]" style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}>
      <Bar className="h-3 w-16 rounded" />
      <Bar className="h-6 w-20 rounded mt-3" />
    </div>
  );
}

export function SkeletonStatRow({ count = 4 }) {
  return (
    <div className="grid gap-3.5" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonStat key={i} />
      ))}
    </div>
  );
}

/** A row inside a list/table — avatar + a couple of text bars + trailing action. */
export function SkeletonRow({ showAction = true }) {
  return (
    <div
      className="flex items-center gap-3 px-5 py-3.5"
      style={{ borderTop: "1px solid var(--hairline)" }}
    >
      <Bar className="h-8 w-8 rounded-lg shrink-0" />
      <Bar className="h-3.5 w-28 rounded" />
      <Bar className="h-3.5 w-16 rounded hidden sm:block" />
      <Bar className="h-3.5 w-20 rounded hidden md:block" />
      <div className="flex-1" />
      {showAction && <Bar className="h-7 w-16 rounded-lg" />}
    </div>
  );
}

export function SkeletonList({ rows = 3, showAction = true }) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} showAction={showAction} />
      ))}
    </div>
  );
}

/** A panel wrapper with header bar + list rows, mirroring the real panel shape. */
export function SkeletonPanel({ rows = 3, title = true }) {
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}>
      {title && (
        <div className="flex items-center justify-between px-5 pt-[18px] pb-3.5">
          <Bar className="h-4 w-32 rounded" />
          <Bar className="h-3 w-14 rounded" />
        </div>
      )}
      <SkeletonList rows={rows} />
    </div>
  );
}

/** Full chessboard skeleton — an 8x8 grid of alternating dim squares, used while
 * a game is loading (no position to show yet). */
export function SkeletonBoard() {
  const squares = Array.from({ length: 64 });
  return (
    <div
      className="w-full grid rounded-lg overflow-hidden animate-pulse"
      style={{ gridTemplateColumns: "repeat(8, 1fr)", aspectRatio: "1", border: "1px solid var(--hairline)" }}
    >
      {squares.map((_, i) => {
        const row = Math.floor(i / 8);
        const isLight = (row + i) % 2 === 0;
        return (
          <div
            key={i}
            style={{ background: isLight ? "var(--sq-light)" : "var(--sq-dark)", opacity: 0.6 }}
          />
        );
      })}
    </div>
  );
}

/** Small circular/pill bar for avatars, badges, buttons — generic escape hatch. */
export function SkeletonBar({ className = "", ...props }) {
  return <Bar className={className} {...props} />;
}
