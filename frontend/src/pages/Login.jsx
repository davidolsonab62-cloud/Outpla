import { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/App";
import { toast } from "sonner";
import { Eye, EyeOff, Mail, Lock } from "lucide-react";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from || "/lobby";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      await login(email, password);
      toast.success("Welcome back!");
      navigate(from, { replace: true });
      window.location.href = from;
    } catch (error) {
      const detail = error.response?.data?.detail;
      const message = Array.isArray(detail)
        ? (detail[0]?.msg || "Login failed")
        : (typeof detail === "string" ? detail : "Login failed");
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    const redirectUrl = `${window.location.origin}/callback`;

    try {
      const response = await fetch(`${process.env.REACT_APP_BACKEND_URL || "http://127.0.0.1:8000"}/api/auth/google/start?redirect_uri=${encodeURIComponent(redirectUrl)}`);
      const data = await response.json();
      if (!data?.redirect_url) {
        throw new Error("Google sign-in is unavailable right now.");
      }
      window.location.href = data.redirect_url;
    } catch (error) {
      toast.error(error.message || "Google sign-in is unavailable right now.");
    }
  };

  return (
    <div className="min-h-screen bg-surface-0 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        {/* Logo */}
        <Link to="/" className="flex items-center justify-center mb-8">
          <img src="/outpla-logo.png" alt="Outpla" className="h-12 w-auto object-contain" />
        </Link>

        {/* Login Card */}
        <div className="bg-surface-1 border border-hair p-8 rounded-2xl shadow-sm">
          <div className="sc-reveal-stagger">
            <h1
              className="sc-reveal-item font-display font-bold text-2xl text-ink text-center mb-2"
              data-testid="login-title"
            >
              Welcome Back
            </h1>
            <p className="sc-reveal-item text-ink-secondary text-center mb-8">
              Sign in to continue playing
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-ink-secondary">
                Email
              </Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-ink-muted" />
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Enter your email"
                  required
                  className="bg-surface-2 border-hair focus:border-brand text-ink placeholder:text-ink-muted rounded-xl h-12 pl-10"
                  data-testid="login-email-input"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-ink-secondary">
                Password
              </Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-ink-muted" />
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
                  className="bg-surface-2 border-hair focus:border-brand text-ink placeholder:text-ink-muted rounded-xl h-12 pl-10 pr-10"
                  data-testid="login-password-input"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink-secondary"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="w-full bg-brand text-brand-on hover:bg-brand-hover font-semibold py-6 rounded-xl"
              data-testid="login-submit-btn"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <div className="w-4 h-4 spinner" />
                  Signing in...
                </span>
              ) : (
                "Sign In"
              )}
            </Button>
          </form>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-hair" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-surface-1 px-2 text-ink-muted">Or</span>
            </div>
          </div>

          <Button
            onClick={handleGoogleLogin}
            variant="outline"
            className="w-full bg-transparent border border-hair text-ink hover:bg-surface-2 hover:border-hair py-6 rounded-xl"
            data-testid="google-login-btn"
          >
            <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24">
              <path
                fill="currentColor"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="currentColor"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="currentColor"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="currentColor"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            Continue with Google
          </Button>

          <p className="text-ink-secondary text-center mt-6 text-sm">
            Don't have an account?{" "}
            <Link
              to="/register"
              className="text-brand hover:underline"
              data-testid="register-link"
            >
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
