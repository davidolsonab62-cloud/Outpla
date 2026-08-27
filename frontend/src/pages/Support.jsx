import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Mail, User, MessageSquareText } from "lucide-react";
import { useAuth } from "@/App";
import BackButton from "@/components/layout/BackButton";

const SUPPORT_EMAIL = "outplasupport@gmail.com";

export default function Support() {
  const { user } = useAuth();

  const [form, setForm] = useState({
    name: user?.username || "",
    email: user?.email || "",
    subject: "",
    message: "",
  });
  const [sent, setSent] = useState(false);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();

    const subject = encodeURIComponent(form.subject || "Outpla Support Request");
    const body = encodeURIComponent(
      `Hello Outpla Support,\n\n` +
        `My name: ${form.name || "Not provided"}\n` +
        `Email: ${form.email || "Not provided"}\n\n` +
        `Issue details:\n${form.message || "No details provided."}`
    );

    window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
    setSent(true);
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <BackButton />

      <div className="mt-8 rounded-2xl border border-hair bg-surface-1 p-6 md:p-8 shadow-sm">
        <div className="sc-reveal-stagger mb-8">
          <p className="sc-reveal-item text-sm font-semibold uppercase tracking-[0.18em] mb-3" style={{ color: "var(--brand)" }}>
            Customer Support
          </p>
          <h1 className="sc-reveal-item text-3xl md:text-4xl font-bold">How can we help?</h1>
          <p className="sc-reveal-item mt-3 text-base" style={{ color: "var(--text-secondary)" }}>
            Introduce yourself, describe the issue, and send your message directly to our support team.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid gap-5 md:grid-cols-2">
            <label className="block">
              <span className="mb-2 flex items-center gap-2 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
                <User className="w-4 h-4" /> Your name
              </span>
              <input
                name="name"
                value={form.name}
                onChange={handleChange}
                placeholder="Your name"
                className="w-full rounded-xl border px-3 py-2.5 outline-none transition focus:ring-2"
                style={{
                  background: "var(--surface-2)",
                  borderColor: "var(--hairline)",
                  color: "var(--text-primary)",
                }}
              />
            </label>

            <label className="block">
              <span className="mb-2 flex items-center gap-2 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
                <Mail className="w-4 h-4" /> Email address
              </span>
              <input
                type="email"
                name="email"
                value={form.email}
                onChange={handleChange}
                placeholder="you@example.com"
                className="w-full rounded-xl border px-3 py-2.5 outline-none transition focus:ring-2"
                style={{
                  background: "var(--surface-2)",
                  borderColor: "var(--hairline)",
                  color: "var(--text-primary)",
                }}
                required
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-2 flex items-center gap-2 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
              <MessageSquareText className="w-4 h-4" /> Subject
            </span>
            <input
              name="subject"
              value={form.subject}
              onChange={handleChange}
              placeholder="Brief summary of your issue"
              className="w-full rounded-xl border px-3 py-2.5 outline-none transition focus:ring-2"
              style={{
                background: "var(--surface-2)",
                borderColor: "var(--hairline)",
                color: "var(--text-primary)",
              }}
            />
          </label>

          <label className="block">
            <span className="mb-2 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
              Describe your problem
            </span>
            <textarea
              name="message"
              value={form.message}
              onChange={handleChange}
              rows={8}
              placeholder="Tell us what happened, when it started, and any error messages you saw..."
              className="w-full rounded-xl border px-3 py-2.5 outline-none transition focus:ring-2"
              style={{
                background: "var(--surface-2)",
                borderColor: "var(--hairline)",
                color: "var(--text-primary)",
              }}
              required
            />
          </label>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="text-sm" style={{ color: "var(--text-secondary)" }}>
              Sending to: <span className="font-medium" style={{ color: "var(--text-primary)" }}>{SUPPORT_EMAIL}</span>
            </div>
            <Button type="submit" className="px-6">
              Send to Support
            </Button>
          </div>
        </form>

        {sent && (
          <div className="mt-6 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm" style={{ color: "var(--text-primary)" }}>
            Your email app should open with a pre-filled support message. If it does not, email us directly at {SUPPORT_EMAIL}.
          </div>
        )}
      </div>
    </div>
  );
}

