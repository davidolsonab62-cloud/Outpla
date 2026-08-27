import BackButton from "./BackButton";

/**
 * Shared header for app-style pages: back button beside a left-aligned
 * title, optional subtitle, optional right-aligned action children.
 * Not every page fits this shape — pages with a centered "hero" title
 * should not use this component (see BackButton used inline instead).
 */
export default function PageHeader({ title, subtitle, children, testId }) {
  return (
    <div className="sc-reveal-stagger flex items-center justify-between gap-3 mb-6">
      <div className="flex items-center gap-2 min-w-0">
        <BackButton />
        <div className="min-w-0">
          <h1
            className="sc-reveal-item text-[22px] font-bold flex items-center gap-2"
            style={{ fontFamily: "'Space Grotesk', sans-serif" }}
            data-testid={testId}
          >
            {title}
          </h1>
          {subtitle && (
            <p className="sc-reveal-item text-[13px] mt-1" style={{ color: "var(--text-secondary)" }}>
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {children && <div className="sc-reveal-item flex items-center gap-2 shrink-0">{children}</div>}
    </div>
  );
}
