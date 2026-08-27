import React from "react";
import { useParams, Link } from "react-router-dom";
import studies from "@/utils/studies";
import BackButton from "@/components/layout/BackButton";

function toEmbedUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const hostname = u.hostname.toLowerCase();
    const pathname = u.pathname.toLowerCase();

    if (hostname.includes("youtube.com")) {
      if (pathname === "/results" || pathname.startsWith("/results/")) return null;

      const v = u.searchParams.get("v");
      if (v) return `https://www.youtube.com/embed/${v}`;

      const segments = u.pathname.split("/").filter(Boolean);
      if (segments[0] === "shorts" && segments[1]) {
        return `https://www.youtube.com/embed/${segments[1]}`;
      }
      if (segments[0] === "embed" && segments[1]) {
        return `https://www.youtube.com/embed/${segments[1]}`;
      }
    }

    if (hostname === "youtu.be") {
      const id = u.pathname.replace("/", "");
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
  } catch (e) {
    return null;
  }
  return null;
}

function isYoutubeUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().includes("youtube.com") || u.hostname.toLowerCase() === "youtu.be";
  } catch (e) {
    return false;
  }
}

export default function StudyDetail() {
  const { id } = useParams();
  const study = studies.find((s) => s.id === id);

  if (!study) {
    return (
      <div className="max-w-4xl mx-auto">
        <h2 className="text-xl font-semibold">Study not found</h2>
        <p className="text-ink-secondary">The requested study does not exist.</p>
        <Link to="/study" className="mt-4 inline-block text-brand">Back to studies</Link>
      </div>
    );
  }

  const embed = toEmbedUrl(study.youtube_url);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-2">
        <BackButton />
      </div>
      <div className="sc-reveal-stagger mb-4">
        <h1 className="sc-reveal-item text-2xl font-heading">{study.title}</h1>
        <div className="sc-reveal-item text-sm text-ink-secondary">{study.category}</div>
      </div>

      <div className="grid gap-6">
        <div className="p-4 rounded-lg border border-hair bg-surface-1">
          <div className="text-ink-secondary mb-2">{study.description}</div>
          {embed ? (
            <div className="mt-4">
              <div className="aspect-w-16 aspect-h-9">
                <iframe
                  title={study.title}
                  src={embed}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="w-full h-80 rounded-md"
                />
              </div>
              <div className="mt-2">
                <a href={study.youtube_url} target="_blank" rel="noreferrer" className="text-brand">
                  Open on YouTube
                </a>
              </div>
            </div>
          ) : isYoutubeUrl(study.youtube_url) ? (
            <div className="mt-4 rounded-md border border-hair bg-surface-2 p-4">
              <p className="text-ink-secondary mb-3">This study links to a relevant GothamChess YouTube topic. Open it to watch the lesson.</p>
              <a href={study.youtube_url} target="_blank" rel="noreferrer" className="inline-block rounded-md bg-brand px-4 py-2 text-on-brand">
                Watch lesson on YouTube
              </a>
            </div>
          ) : (
            <div className="text-ink-secondary">No video available for this study.</div>
          )}
        </div>

        <div>
          <Link to="/study" className="text-brand">Back to studies</Link>
        </div>
      </div>
    </div>
  );
}
