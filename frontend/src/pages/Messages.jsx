import { useEffect, useState } from "react";
import axios from "axios";
import { API, useAuth } from "@/App";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { toast } from "sonner";
import { MessageSquare, Mail } from "lucide-react";
import { SkeletonListRow } from "@/components/ui/skeletons";
import PageHeader from "@/components/layout/PageHeader";

export default function Messages() {
  const { user } = useAuth();
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadConversations();

    const handler = (e) => {
      const msg = e.detail;
      if (!selected) {
        setConversations((prev) => {
          const otherId = msg.from_user_id === user.user_id ? msg.to_user_id : msg.from_user_id;
          const existing = prev.find((c) => c.user_id === otherId);
          if (existing) {
            return prev.map((c) =>
              c.user_id === otherId
                ? { ...c, unread: (c.unread || 0) + 1, last_message: msg.message, last_timestamp: msg.timestamp }
                : c
            );
          }
          return [
            { user_id: otherId, username: msg.from_username || "Unknown", unread: 1, last_message: msg.message, last_timestamp: msg.timestamp },
            ...prev,
          ];
        });
      } else if (selected.user_id === msg.from_user_id || selected.user_id === msg.to_user_id) {
        setMessages((prev) => [...prev, msg]);
      }
    };

    window.addEventListener("direct_message", handler);
    return () => window.removeEventListener("direct_message", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, user.user_id]);

  const loadConversations = async () => {
    setLoading(true);
    try {
      const response = await axios.get(`${API}/conversations`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      });
      setConversations(response.data.conversations || []);
    } catch (error) {
      console.error("Failed to load conversations", error);
      toast.error("Unable to load messages");
    } finally {
      setLoading(false);
    }
  };

  const openConversation = async (conversation) => {
    setSelected(conversation);
    try {
      const response = await axios.get(`${API}/conversations/${conversation.user_id}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      });
      setMessages(response.data.messages || []);
      setConversations((prev) => prev.map((c) => (c.user_id === conversation.user_id ? { ...c, unread: 0 } : c)));
    } catch (error) {
      console.error("Failed to open conversation", error);
      toast.error("Unable to load conversation");
    }
  };

  const sendMessage = async () => {
    if (!selected || !draft.trim()) return;
    try {
      const response = await axios.post(
        `${API}/messages`,
        { to_user_id: selected.user_id, message: draft },
        { headers: { Authorization: `Bearer ${localStorage.getItem("token")}` } }
      );
      setMessages((prev) => [...prev, response.data.message]);
      setDraft("");
      setConversations((prev) =>
        prev.map((c) =>
          c.user_id === selected.user_id
            ? { ...c, last_message: response.data.message.message, last_timestamp: response.data.message.timestamp }
            : c
        )
      );
    } catch (error) {
      console.error("Send message failed", error);
      toast.error("Failed to send message");
    }
  };

  return (
    <div className="sc-page max-w-6xl mx-auto">
      <PageHeader title="Messages" />

      <div className="grid grid-cols-12 gap-5">
        {/* Conversation list */}
        <div
          className="col-span-12 md:col-span-4 rounded-2xl overflow-hidden"
          style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
        >
          <div className="flex items-center gap-2 p-4" style={{ borderBottom: "1px solid var(--hairline)" }}>
            <Mail className="w-4 h-4" style={{ color: "var(--brand)" }} />
            <span className="font-semibold text-sm">Conversations</span>
          </div>
          <div className="max-h-[calc(100vh-260px)] overflow-y-auto">
            {loading ? (
              <>
                <SkeletonListRow trailingWidth={0} />
                <SkeletonListRow trailingWidth={0} />
                <SkeletonListRow trailingWidth={0} />
              </>
            ) : conversations.length ? (
              conversations.map((conversation) => (
                <button
                  key={conversation.user_id}
                  onClick={() => openConversation(conversation)}
                  className="w-full text-left p-4"
                  style={{
                    borderTop: "1px solid var(--hairline)",
                    background: selected?.user_id === conversation.user_id ? "var(--surface-2)" : "transparent",
                  }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar className="h-9 w-9 shrink-0">
                        {conversation.picture ? (
                          <AvatarImage src={conversation.picture} alt={conversation.username} />
                        ) : (
                          <AvatarFallback>{(conversation.username || "?")[0]?.toUpperCase() || "?"}</AvatarFallback>
                        )}
                      </Avatar>
                      <div className="min-w-0">
                        <div className="font-semibold text-sm truncate">{conversation.username}</div>
                        <div className="text-sm truncate" style={{ color: "var(--text-secondary)" }}>
                          {conversation.last_message || "No messages yet"}
                        </div>
                      </div>
                    </div>
                    {conversation.unread ? (
                      <span
                        className="rounded-full text-xs font-bold px-2 py-0.5 shrink-0"
                        style={{ background: "var(--brand)", color: "var(--on-brand)" }}
                      >
                        {conversation.unread}
                      </span>
                    ) : null}
                  </div>
                </button>
              ))
            ) : (
              <div className="p-6 text-sm" style={{ color: "var(--text-secondary)" }}>No conversations yet.</div>
            )}
          </div>
        </div>

        {/* Thread */}
        <div
          className="col-span-12 md:col-span-8 rounded-2xl flex flex-col"
          style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
        >
          <div className="p-4 flex items-center gap-2" style={{ borderBottom: "1px solid var(--hairline)" }}>
            <MessageSquare className="w-4 h-4" style={{ color: "var(--brand)" }} />
            <div>
              <div className="font-semibold text-sm">{selected ? selected.username : "Select a conversation"}</div>
              {selected && (
                <div className="text-sm" style={{ color: "var(--text-secondary)" }}>
                  Chat with {selected.username}
                </div>
              )}
            </div>
          </div>

          <div className="flex-1 p-4 overflow-y-auto space-y-3 min-h-[200px]">
            {selected ? (
              messages.length ? (
                messages.map((message, index) => {
                  const mine = message.from_user_id === user.user_id;
                  return (
                    <div
                      key={index}
                      className={`max-w-[80%] p-3 rounded-xl ${mine ? "ml-auto" : ""}`}
                      style={{
                        background: mine ? "var(--brand-dim)" : "var(--surface-2)",
                      }}
                    >
                      <div className="flex items-start gap-3 mb-2">
                        {!mine && (
                          <Avatar className="h-8 w-8 shrink-0">
                            {message.picture ? (
                              <AvatarImage src={message.picture} alt={message.from_username || "User"} />
                            ) : (
                              <AvatarFallback>{(message.from_username || "?")[0]?.toUpperCase() || "?"}</AvatarFallback>
                            )}
                          </Avatar>
                        )}
                        <div>
                          <div className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>
                            {message.from_username || message.from_user_id}
                          </div>
                          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                            {new Date(message.timestamp).toLocaleString()}
                          </div>
                        </div>
                      </div>
                      <div className="text-sm break-words">{message.message}</div>
                    </div>
                  );
                })
              ) : (
                <div className="text-sm" style={{ color: "var(--text-secondary)" }}>No messages in this conversation yet.</div>
              )
            ) : (
              <div className="text-sm" style={{ color: "var(--text-secondary)" }}>Choose a conversation to start chatting.</div>
            )}
          </div>

          <div className="p-4" style={{ borderTop: "1px solid var(--hairline)" }}>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              {["😀", "😂", "❤️", "🔥", "👍", "🎉", "😮", "😢"].map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setDraft((prev) => prev + emoji)}
                  className="rounded-full border border-hair px-2 py-1 text-sm"
                  style={{ background: "var(--surface-2)", color: "var(--text-primary)" }}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <div className="flex gap-3">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={selected ? "Type a message..." : "Select a conversation first"}
                disabled={!selected}
                style={{ background: "var(--surface-2)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
              />
              <Button
                disabled={!selected || !draft.trim()}
                onClick={sendMessage}
                style={{ background: "var(--brand)", color: "var(--on-brand)" }}
              >
                Send
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
