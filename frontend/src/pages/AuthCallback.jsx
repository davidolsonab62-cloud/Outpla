import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { API, useAuth } from "@/App";
import { toast } from "sonner";

export default function AuthCallback() {
  const navigate = useNavigate();
  const { updateUser } = useAuth();
  const hasProcessed = useRef(false);

  useEffect(() => {
    // Use ref to prevent double processing in StrictMode
    if (hasProcessed.current) return;
    hasProcessed.current = true;

    const processAuth = async () => {
      const queryString = window.location.search || window.location.hash.replace("#", "?");
      const params = new URLSearchParams(queryString);
      const sessionId = params.get("session_id");
      const code = params.get("code");

      try {
        if (code) {
          const callbackUrl = `${window.location.origin}/callback`;
          const googleResponse = await axios.get(`${API}/auth/google/callback`, {
            params: {
              code,
              redirect_uri: callbackUrl,
            },
            withCredentials: true,
          });

          const nextUrl = googleResponse?.data?.redirect_url;
          if (nextUrl) {
            window.location.href = nextUrl;
            return;
          }
        }

        if (!sessionId) {
          toast.error("Invalid authentication response");
          navigate("/login");
          return;
        }

        const response = await axios.post(
          `${API}/auth/session`,
          { session_id: sessionId },
          { withCredentials: true }
        );

        const { access_token: accessToken, user: userData } = response.data;

        if (accessToken) {
          localStorage.setItem("token", accessToken);
        } else {
          localStorage.removeItem("token");
        }

        updateUser(userData, accessToken);

        toast.success("Welcome to Outpla!");
        window.history.replaceState(null, "", "/lobby");
        navigate("/lobby", { replace: true, state: { user: userData } });
      } catch (error) {
        console.error("Auth callback error:", error);
        toast.error("Authentication failed. Please try again.");
        navigate("/login");
      }
    };

    processAuth();
  }, [navigate, updateUser]);

  return (
    <div className="min-h-screen bg-surface-1 flex items-center justify-center">
      <div className="text-center">
        <div className="w-16 h-16 spinner mx-auto mb-4" />
        <p className="text-ink-secondary">Completing sign in...</p>
      </div>
    </div>
  );
}
