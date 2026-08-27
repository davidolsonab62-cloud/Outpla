import { useState, useEffect, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAuth, API } from "@/App";
import { toast } from "sonner";
import axios from "axios";
import { Trophy, Target, Clock, TrendingUp, TrendingDown, Camera, Trash2, Share2, Copy, Check } from "lucide-react";
import { SkeletonHeaderCard, SkeletonStatsRow, SkeletonPanel } from "@/components/ui/skeletons";
import BackButton from "@/components/layout/BackButton";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB
const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;
const AVATAR_MAX_DIMENSION = 512;

export default function Profile() {
  const { userId } = useParams();
  const { user: currentUser, token, updateUser } = useAuth();
  const fileInputRef = useRef(null);
  // Tracks the user_id we last hydrated the form fields from, so the
  // hydration effect below only runs once per profile load - not every
  // time profileUser changes (which also happens after a save), which
  // would otherwise wipe out any in-progress, unsaved edits in other
  // fields/cards.
  const initializedUserIdRef = useRef(null);

  const [profileUser, setProfileUser] = useState(null);
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copiedLink, setCopiedLink] = useState(false);

  // account settings
  const [username, setUsername] = useState("");
  const [savingUsername, setSavingUsername] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  // challenge prefs
  const [prefMinRating, setPrefMinRating] = useState(800);
  const [prefMaxRating, setPrefMaxRating] = useState(2400);
  const [allowAnyRating, setAllowAnyRating] = useState(true);
  const [savingChessProfile, setSavingChessProfile] = useState(false);
  const [savingPrivacy, setSavingPrivacy] = useState(false);
  const [allowSpectators, setAllowSpectators] = useState(true);
  const [allowChatBroadcast, setAllowChatBroadcast] = useState(true);
  const [fideId, setFideId] = useState("");
  const [country, setCountry] = useState("");
  const [teamClub, setTeamClub] = useState("");
  const [chessTitle, setChessTitle] = useState("");
  const [chessBio, setChessBio] = useState("");
  const [boardColor, setBoardColor] = useState("default");

  const isOwnProfile = !userId || userId === currentUser?.user_id;
  const authHeader = { headers: { Authorization: `Bearer ${token}` } };

  useEffect(() => {
    const fetchProfile = async () => {
      try {
        const targetId = userId || currentUser?.user_id;
        const [userRes, gamesRes] = await Promise.all([
          axios.get(`${API}/users/${targetId}`),
          axios.get(`${API}/users/${targetId}/games`),
        ]);
        setProfileUser(userRes.data);
        setGames(gamesRes.data);
      } catch (error) {
        console.error("Failed to fetch profile:", error);
      } finally {
        setLoading(false);
      }
    };
    if (currentUser) fetchProfile();
  }, [userId, currentUser]);

  useEffect(() => {
    if (!profileUser) return;
    if (initializedUserIdRef.current === profileUser.user_id) return;
    initializedUserIdRef.current = profileUser.user_id;
    setUsername(profileUser.username || "");
    if (isOwnProfile) {
      const prefs = profileUser.challenge_preferences || {};
      setPrefMinRating(prefs.min_challenge_rating ?? 800);
      setPrefMaxRating(prefs.max_challenge_rating ?? 2400);
      setAllowAnyRating(prefs.allow_any_rating ?? true);
      setAllowSpectators(profileUser.allow_spectators ?? true);
      setAllowChatBroadcast(profileUser.allow_chat_broadcast ?? true);
      setFideId(profileUser.fide_id || "");
      setCountry(profileUser.country || "");
      setTeamClub(profileUser.team_club || "");
      setChessTitle(profileUser.chess_title || "");
      setChessBio(profileUser.chess_bio || "");
      setBoardColor(profileUser.board_preferences?.color || "default");
    }
  }, [profileUser, isOwnProfile]);

  const applyUpdatedUser = (data) => {
    // Merge, don't replace - a save endpoint that returns a partial user
    // object (e.g. just the fields it touched) would otherwise wipe out
    // every other field Profile.jsx already knew about the user.
    setProfileUser((prev) => ({ ...prev, ...data }));
    if (isOwnProfile) updateUser({ ...currentUser, ...data });
  };

  const saveUsername = async () => {
    const trimmed = username.trim();
    if (trimmed === profileUser?.username) return;
    if (trimmed.length < 3 || trimmed.length > 20) {
      toast.error("Username must be 3-20 characters");
      return;
    }
    if (!USERNAME_PATTERN.test(trimmed)) {
      toast.error("Username can only contain letters, numbers and underscores");
      return;
    }
    setSavingUsername(true);
    try {
      const res = await axios.put(`${API}/users/${profileUser.user_id}/profile`, { username: trimmed }, authHeader);
      applyUpdatedUser(res.data);
      toast.success("Username updated");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't update username");
    } finally {
      setSavingUsername(false);
    }
  };

  const savePassword = async () => {
    if (newPassword.length < 6) {
      toast.error("New password must be at least 6 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("New passwords don't match");
      return;
    }
    setSavingPassword(true);
    try {
      await axios.put(
        `${API}/users/${profileUser.user_id}/password`,
        { current_password: currentPassword, new_password: newPassword },
        authHeader
      );
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password updated");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't update password");
    } finally {
      setSavingPassword(false);
    }
  };

  const saveChessProfile = async () => {
    setSavingChessProfile(true);
    try {
      const res = await axios.put(
        `${API}/users/${profileUser.user_id}/profile`,
        {
          fide_id: fideId,
          country: country,
          team_club: teamClub,
          chess_title: chessTitle,
          chess_bio: chessBio,
        },
        authHeader
      );
      applyUpdatedUser(res.data);
      toast.success("Chess profile saved");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't save chess profile");
    } finally {
      setSavingChessProfile(false);
    }
  };

  // Downscales to AVATAR_MAX_DIMENSION on the longest side and re-encodes
  // as compressed JPEG, so a multi-megapixel phone photo doesn't turn into
  // a multi-megabyte base64 payload just because it happened to be under
  // the raw-file size cap.
  const resizeImageToDataUrl = (file, maxDimension = AVATAR_MAX_DIMENSION, quality = 0.85) =>
    new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          if (width >= height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(objectUrl);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Couldn't read that file"));
      };
      img.src = objectUrl;
    });

  const onPickAvatar = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // let the same file be re-picked later
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Pick an image file");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error("Image must be under 2MB");
      return;
    }

    setUploadingAvatar(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      const res = await axios.put(`${API}/users/${profileUser.user_id}/avatar`, { picture: dataUrl }, authHeader);
      applyUpdatedUser(res.data);
      toast.success("Profile picture updated");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't upload picture");
    } finally {
      setUploadingAvatar(false);
    }
  };

  const removeAvatar = async () => {
    setUploadingAvatar(true);
    try {
      const res = await axios.put(`${API}/users/${profileUser.user_id}/avatar`, { picture: null }, authHeader);
      applyUpdatedUser(res.data);
      toast.success("Profile picture removed");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't remove picture");
    } finally {
      setUploadingAvatar(false);
    }
  };

  const saveSettings = async () => {
    setSavingPrivacy(true);
    try {
      const res = await axios.put(
        `${API}/users/${profileUser.user_id}/settings`,
        {
          min_challenge_rating: prefMinRating,
          max_challenge_rating: prefMaxRating,
          allow_any_rating: allowAnyRating,
          allow_spectators: allowSpectators,
          allow_chat_broadcast: allowChatBroadcast,
          board_preferences: {
            color: boardColor,
          },
        },
        authHeader
      );
      applyUpdatedUser(res.data);
      toast.success("Settings saved");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't save settings");
    } finally {
      setSavingPrivacy(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto space-y-5">
        <SkeletonHeaderCard />
        <SkeletonStatsRow count={4} />
        <SkeletonPanel rows={3} title={false} />
      </div>
    );
  }

  const displayUser = profileUser || currentUser;
  const profileUrl = displayUser?.user_id ? `${window.location.origin}/profile/${displayUser.user_id}` : "";
  const winRate =
    displayUser?.games_played > 0 ? ((displayUser?.wins / displayUser?.games_played) * 100).toFixed(1) : 0;

  const handleShareProfile = async () => {
    if (!profileUrl) return;

    try {
      if (navigator.share) {
        await navigator.share({
          title: `${displayUser.username}'s Outpla profile`,
          text: `Check out ${displayUser.username} on Outpla`,
          url: profileUrl,
        });
        toast.success("Profile shared");
        return;
      }

      await navigator.clipboard.writeText(profileUrl);
      setCopiedLink(true);
      toast.success("Profile link copied");
      setTimeout(() => setCopiedLink(false), 1800);
    } catch (error) {
      if (error?.name === "AbortError") return;
      try {
        await navigator.clipboard.writeText(profileUrl);
        setCopiedLink(true);
        toast.success("Profile link copied");
        setTimeout(() => setCopiedLink(false), 1800);
      } catch (clipboardError) {
        toast.error("Unable to copy profile link");
      }
    }
  };

  const STAT_CARDS = [
    { icon: Trophy, color: "var(--brand)", value: displayUser?.rating || 1200, label: "Rating" },
    { icon: Clock, color: "var(--blue)", value: displayUser?.games_played || 0, label: "Games" },
    { icon: TrendingUp, color: "var(--green)", value: displayUser?.wins || 0, label: "Wins" },
    { icon: Target, color: "var(--orange)", value: `${winRate}%`, label: "Win rate" },
  ];

  const cardStyle = { background: "var(--surface-1)", border: "1px solid var(--hairline)" };
  const fieldStyle = {
    background: "var(--surface-2)",
    borderColor: "var(--hairline)",
    color: "var(--text-primary)",
  };

  return (
    <div className="sc-page max-w-4xl mx-auto">
      <div className="mb-4">
        <BackButton />
      </div>

      {/* Header */}
      <div className="flex flex-col md:flex-row items-center gap-6 rounded-2xl p-8 mb-5" style={cardStyle}>
        <div className="relative shrink-0">
          {displayUser?.picture ? (
            <img
              src={displayUser.picture}
              alt={displayUser.username}
              className="w-24 h-24 rounded-2xl object-cover"
              style={{ border: "1px solid var(--hairline)" }}
            />
          ) : (
            <div
              className="w-24 h-24 rounded-2xl flex items-center justify-center"
              style={{ background: "var(--brand-dim)" }}
            >
              <span className="font-display font-bold text-4xl" style={{ color: "var(--brand)" }}>
                {displayUser?.username?.charAt(0)?.toUpperCase() || "?"}
              </span>
            </div>
          )}

          {isOwnProfile && (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingAvatar}
              aria-label="Change profile picture"
              title="Change profile picture"
              className="absolute -bottom-2 -right-2 flex h-9 w-9 items-center justify-center rounded-xl"
              style={{ background: "var(--brand)", color: "var(--on-brand)", border: "2px solid var(--surface-1)" }}
            >
              <Camera className="w-4 h-4" />
            </button>
          )}
          <input ref={fileInputRef} type="file" accept="image/*" onChange={onPickAvatar} className="hidden" />
        </div>

        <div className="sc-reveal-stagger text-center md:text-left flex-1">
          <h1 className="sc-reveal-item font-display font-bold text-2xl mb-1" data-testid="profile-username">
            {displayUser?.username}
          </h1>
          <p className="sc-reveal-item" style={{ color: "var(--text-secondary)" }}>{displayUser?.email}</p>
          <div className="flex items-center gap-2 justify-center md:justify-start mt-2 flex-wrap">
            {displayUser?.is_admin && (
              <span
                className="inline-block px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide rounded-md"
                style={{ background: "var(--brand)", color: "var(--on-brand)" }}
              >
                Admin
              </span>
            )}
            {isOwnProfile && displayUser?.picture && (
              <button
                onClick={removeAvatar}
                disabled={uploadingAvatar}
                className="inline-flex items-center gap-1.5 text-[12px]"
                style={{ color: "var(--text-secondary)" }}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Remove picture
              </button>
            )}
          </div>

          {profileUrl && (
            <div
              className="mt-4 w-full max-w-xl rounded-xl border p-3"
              style={{ background: "var(--surface-2)", borderColor: "var(--hairline)" }}
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>
                  <Share2 className="w-3.5 h-3.5" />
                  Share profile
                </div>
                <button
                  onClick={handleShareProfile}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium"
                  style={{ background: "var(--brand)", color: "var(--on-brand)" }}
                >
                  {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedLink ? "Copied" : "Copy link"}
                </button>
              </div>
              <input
                readOnly
                value={profileUrl}
                className="w-full rounded-lg border px-3 py-2 text-xs font-mono"
                style={{ background: "var(--surface-1)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="sc-stagger grid grid-cols-2 md:grid-cols-4 gap-3.5 mb-5">
        {STAT_CARDS.map(({ icon: Icon, color, value, label }) => (
          <div key={label} className="rounded-2xl p-6 text-center" style={cardStyle}>
            <Icon className="w-7 h-7 mx-auto mb-2" style={{ color }} />
            <p className="font-display font-bold text-2xl" style={{ color }}>{value}</p>
            <p className="text-xs uppercase tracking-wide mt-1" style={{ color: "var(--text-secondary)" }}>
              {label}
            </p>
          </div>
        ))}
      </div>

      {/* Account settings (own profile only) */}
      {isOwnProfile && (
        <div className="grid md:grid-cols-2 gap-4 mb-5">
          <div className="rounded-2xl p-6" style={cardStyle}>
            <h2 className="font-display font-bold text-[16px] mb-4">Account</h2>
            <div className="space-y-2 mb-4">
              <Label style={{ color: "var(--text-secondary)" }}>Username</Label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="your_handle"
                style={fieldStyle}
                data-testid="username-input"
              />
              <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                3-20 characters. Letters, numbers and underscores only.
              </p>
            </div>
            <Button
              onClick={saveUsername}
              disabled={savingUsername || !username.trim() || username.trim() === displayUser?.username}
              style={{ background: "var(--brand)", color: "var(--on-brand)" }}
            >
              {savingUsername ? "Saving…" : "Save username"}
            </Button>
          </div>

          <div className="rounded-2xl p-6" style={cardStyle}>
            <h2 className="font-display font-bold text-[16px] mb-4">Chess profile</h2>
            <div className="space-y-3 mb-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label style={{ color: "var(--text-secondary)" }}>FIDE ID</Label>
                  <Input
                    value={fideId}
                    onChange={(e) => setFideId(e.target.value)}
                    placeholder="12345678"
                    style={fieldStyle}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label style={{ color: "var(--text-secondary)" }}>Country</Label>
                  <Input
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    placeholder="Country"
                    style={fieldStyle}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label style={{ color: "var(--text-secondary)" }}>Team / Club</Label>
                  <Input
                    value={teamClub}
                    onChange={(e) => setTeamClub(e.target.value)}
                    placeholder="Chess Club"
                    style={fieldStyle}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label style={{ color: "var(--text-secondary)" }}>Title</Label>
                  <Input
                    value={chessTitle}
                    onChange={(e) => setChessTitle(e.target.value)}
                    placeholder="FM / IM / GM"
                    style={fieldStyle}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label style={{ color: "var(--text-secondary)" }}>Chess bio</Label>
                <textarea
                  value={chessBio}
                  onChange={(e) => setChessBio(e.target.value)}
                  rows={4}
                  className="w-full rounded-2xl border px-4 py-3 text-sm resize-none"
                  style={{ background: "var(--surface-2)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
                />
              </div>
            </div>
            <Button
              onClick={saveChessProfile}
              disabled={savingChessProfile}
              style={{ background: "var(--brand)", color: "var(--on-brand)", marginTop: "1rem" }}
            >
              {savingChessProfile ? "Saving…" : "Save chess profile"}
            </Button>
          </div>
          <div className="rounded-2xl p-6" style={cardStyle}>
            <h2 className="font-display font-bold text-[16px] mb-4">Change password</h2>
            <div className="space-y-3 mb-4">
              <div className="space-y-1.5">
                <Label style={{ color: "var(--text-secondary)" }}>Current password</Label>
                <Input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="••••••••"
                  style={fieldStyle}
                />
              </div>
              <div className="space-y-1.5">
                <Label style={{ color: "var(--text-secondary)" }}>New password</Label>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  style={fieldStyle}
                />
              </div>
              <div className="space-y-1.5">
                <Label style={{ color: "var(--text-secondary)" }}>Confirm new password</Label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat new password"
                  style={fieldStyle}
                />
              </div>
            </div>
            <Button
              onClick={savePassword}
              disabled={savingPassword || !newPassword || !confirmPassword}
              style={{ background: "var(--brand)", color: "var(--on-brand)" }}
            >
              {savingPassword ? "Updating…" : "Update password"}
            </Button>
          </div>
        </div>
      )}

      {/* Wallet balance */}
      {isOwnProfile && displayUser?.wallet_balance && (
        <div className="rounded-2xl p-6 mb-5" style={cardStyle}>
          <h2 className="font-display font-bold text-[16px] mb-4">Wallet balance</h2>
          <div className="grid grid-cols-3 gap-2 sm:gap-3.5">
            {[
              { sym: "USDT", val: `$${displayUser.wallet_balance.USDT?.toFixed(2) || "0.00"}`, color: "var(--green)" },
              { sym: "BTC", val: displayUser.wallet_balance.BTC?.toFixed(6) || "0.000000", color: "var(--orange)" },
              { sym: "ETH", val: displayUser.wallet_balance.ETH?.toFixed(6) || "0.000000", color: "var(--brand)" },
            ].map((c) => (
              <div key={c.sym} className="p-3 sm:p-4 rounded-xl min-w-0" style={{ background: "var(--surface-2)" }}>
                <p className="text-sm mb-1" style={{ color: "var(--text-secondary)" }}>{c.sym}</p>
                <p className="font-mono text-base sm:text-xl font-bold truncate" style={{ color: c.color }}>{c.val}</p>
              </div>
            ))}
          </div>
          <Link to="/wallet" className="mt-4 inline-block">
            <Button variant="outline" style={{ borderColor: "var(--hairline)", color: "var(--text-primary)" }}>
              Manage wallet
            </Button>
          </Link>
        </div>
      )}

      {/* Challenge privacy & board appearance */}
      {isOwnProfile && (
        <div className="rounded-2xl p-6 mb-5" style={cardStyle}>
          <h2 className="font-display font-bold text-[16px] mb-4">Challenge privacy</h2>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="space-y-1.5">
              <Label style={{ color: "var(--text-secondary)" }}>Min rating</Label>
              <Input
                type="number"
                value={prefMinRating}
                onChange={(e) => setPrefMinRating(Number(e.target.value))}
                style={fieldStyle}
              />
            </div>
            <div className="space-y-1.5">
              <Label style={{ color: "var(--text-secondary)" }}>Max rating</Label>
              <Input
                type="number"
                value={prefMaxRating}
                onChange={(e) => setPrefMaxRating(Number(e.target.value))}
                style={fieldStyle}
              />
            </div>
          </div>
          <div className="grid gap-4 mb-4 md:grid-cols-2">
            <div className="flex items-center gap-3">
              <Switch checked={allowAnyRating} onCheckedChange={setAllowAnyRating} />
              <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                Allow challenges from any rating
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Switch checked={allowSpectators} onCheckedChange={setAllowSpectators} />
              <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                Allow spectators to watch your games
              </span>
            </div>
            <div className="flex items-center gap-3 md:col-span-2">
              <Switch checked={allowChatBroadcast} onCheckedChange={setAllowChatBroadcast} />
              <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                Allow spectators to participate in game chat
              </span>
            </div>
          </div>

          <h2 className="font-display font-bold text-[16px] mb-4 mt-6" style={{ borderTop: "1px solid var(--hairline)", paddingTop: "1.25rem" }}>
            Board appearance
          </h2>
          <div className="space-y-1.5 mb-4">
            <Label style={{ color: "var(--text-secondary)" }}>Board color</Label>
            <select
              value={boardColor}
              onChange={(e) => setBoardColor(e.target.value)}
              className="w-full rounded-2xl border px-4 py-3 text-sm"
              style={{ background: "var(--surface-2)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
            >
              <option value="default">Default</option>
              <option value="blue">Blue</option>
              <option value="green">Green</option>
              <option value="purple">Purple</option>
              <option value="brown">Brown</option>
            </select>
          </div>

          <Button onClick={saveSettings} disabled={savingPrivacy} style={{ background: "var(--brand)", color: "var(--on-brand)" }}>
            {savingPrivacy ? "Saving…" : "Save settings"}
          </Button>
        </div>
      )}

      {/* Recent games */}
      <div className="rounded-2xl overflow-hidden" style={cardStyle}>
        <div className="px-5 pt-[18px] pb-3.5">
          <h2 className="font-display font-bold text-[16px]">Recent games</h2>
        </div>
        {games.length === 0 ? (
          <div className="px-5 pb-10 text-center" style={{ borderTop: "1px solid var(--hairline)" }}>
            <Clock className="w-10 h-10 mx-auto my-4" style={{ color: "var(--text-muted)" }} />
            <p style={{ color: "var(--text-secondary)" }}>No games played yet</p>
          </div>
        ) : (
          games.map((game) => {
            const isWhite = game.white_player?.user_id === displayUser?.user_id;
            const opponent = isWhite ? game.black_player : game.white_player;
            const didWin = game.winner_id === displayUser?.user_id;
            const isDraw = game.result === "draw";
            const resultColor = didWin ? "var(--green)" : isDraw ? "var(--text-secondary)" : "var(--red)";

            return (
              <Link
                key={game.game_id}
                to={`/game/${game.game_id}?review=true`}
                className="flex items-center justify-between px-5 py-3.5 no-underline sc-nav-row"
                style={{ borderTop: "1px solid var(--hairline)", color: "var(--text-primary)" }}
                data-testid={`game-history-${game.game_id}`}
              >
                <div className="flex items-center gap-3.5">
                  <div
                    className="w-9 h-9 rounded-[9px] flex items-center justify-center shrink-0"
                    style={{ background: didWin ? "var(--green-dim)" : isDraw ? "var(--surface-2)" : "var(--red-dim)" }}
                  >
                    {didWin ? (
                      <TrendingUp className="w-4 h-4" style={{ color: "var(--green)" }} />
                    ) : isDraw ? (
                      <span style={{ color: "var(--text-secondary)" }}>=</span>
                    ) : (
                      <TrendingDown className="w-4 h-4" style={{ color: "var(--red)" }} />
                    )}
                  </div>
                  <div>
                    <p className="font-display font-bold text-[14px]">vs {opponent?.username || "Unknown"}</p>
                    <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                      {game.time_control} &middot; {game.game_type}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-sm" style={{ color: resultColor }}>
                    {didWin ? "Win" : isDraw ? "Draw" : "Loss"}
                  </p>
                  {game.stake_amount > 0 && (
                    <p className="text-sm font-mono" style={{ color: "var(--text-muted)" }}>
                      {game.stake_amount} {game.stake_currency}
                    </p>
                  )}
                </div>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
