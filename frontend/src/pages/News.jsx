import { Link } from "react-router-dom";
import PageHeader from "@/components/layout/PageHeader";

const POSTS = [
  {
    tag: "Product",
    title: "Tournaments now run around the clock",
    date: "Aug 1, 2026",
    body: "Arena tournaments now start automatically every few hours across blitz, bullet and rapid time controls.",
  },
  {
    tag: "Platform",
    title: "Faster withdrawals",
    date: "Jul 24, 2026",
    body: "Withdrawal requests are now reviewed and settled significantly faster, with clearer status tracking in your wallet.",
  },
  {
    tag: "Fair play",
    title: "Improved anti-cheat detection",
    date: "Jul 12, 2026",
    body: "Our engine-correlation and move-timing checks have been upgraded to keep rated, staked games honest.",
  },
];

export default function News() {
  return (
    <div className="sc-page max-w-3xl mx-auto">
      <PageHeader title="News" subtitle="Latest announcements and platform updates" />

      <div className="sc-stagger flex flex-col gap-4">
        {POSTS.map((post) => (
          <article
            key={post.title}
            className="rounded-2xl p-6"
            style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
          >
            <div className="flex items-center gap-3 mb-2.5">
              <span
                className="text-[11px] font-semibold px-2.5 py-1 rounded-full"
                style={{ background: "var(--brand-dim)", color: "var(--brand)" }}
              >
                {post.tag}
              </span>
              <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>{post.date}</span>
            </div>
            <h2 className="font-display font-bold text-[17px] mb-2">{post.title}</h2>
            <p className="text-[14px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              {post.body}
            </p>
          </article>
        ))}
      </div>

      <div className="mt-8">
        <Link to="/" className="text-[13px] no-underline" style={{ color: "var(--brand)" }}>
          ← Back to home
        </Link>
      </div>
    </div>
  );
}
