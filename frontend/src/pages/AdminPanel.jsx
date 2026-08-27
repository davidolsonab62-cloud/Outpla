import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useAuth, API } from "@/App";
import { toast } from "sonner";
import axios from "axios";
import {
  Users,
  Trophy,
  DollarSign,
  Settings,
  Ban,
  Check,
  Edit,
  Shield,
  AlertTriangle,
  Calendar,
  Eye,
  X,
  Wallet,
  Clock,
  CheckCircle,
  XCircle,
} from "lucide-react";
import { SkeletonStatsRow, SkeletonPanel } from "@/components/ui/skeletons";
import PageHeader from "@/components/layout/PageHeader";


export default function AdminPanel() {
  const { user, token } = useAuth();
  const navigate = useNavigate();

  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [settings, setSettings] = useState(null);
  const [flaggedPlayers, setFlaggedPlayers] = useState([]);
  const [securityAlerts, setSecurityAlerts] = useState([]);
  const [tournaments, setTournaments] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [creditCosts, setCreditCosts] = useState([]);
  const [editedCosts, setEditedCosts] = useState({});
  const [savingCostKey, setSavingCostKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");

  // Balance adjustment
  const [balanceDialogOpen, setBalanceDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [balanceAmount, setBalanceAmount] = useState("");
  const [balanceCurrency, setBalanceCurrency] = useState("USDT");

  // Settings
  const [newArbiterFee, setNewArbiterFee] = useState("");

  // Tournament creation
  const [tournamentDialogOpen, setTournamentDialogOpen] = useState(false);
  const [newTournament, setNewTournament] = useState({
    name: "",
    time_control: "3+2",
    entry_fee: 5,
    entry_currency: "USDT",
    min_players: 4,
    max_players: 64,
    tournament_type: "arena",
    duration_minutes: 60
  });

  // Withdrawal management
  const [withdrawalNoteDialogOpen, setWithdrawalNoteDialogOpen] = useState(false);
  const [selectedWithdrawal, setSelectedWithdrawal] = useState(null);
  const [withdrawalAction, setWithdrawalAction] = useState(null);
  const [adminNote, setAdminNote] = useState("");
  const [processingWithdrawal, setProcessingWithdrawal] = useState(false);

  useEffect(() => {
    if (!user?.is_admin) {
      navigate("/lobby");
      return;
    }
    fetchAdminData();
  }, [user, navigate]);

  const fetchAdminData = async () => {
    try {
      const [statsRes, usersRes, settingsRes, flaggedRes, alertsRes, tournamentsRes, withdrawalsRes, creditCostsRes] = await Promise.all([
        axios.get(`${API}/admin/stats`, { headers: { Authorization: `Bearer ${token}` } }),
        axios.get(`${API}/admin/users`, { headers: { Authorization: `Bearer ${token}` } }),
        axios.get(`${API}/admin/settings`, { headers: { Authorization: `Bearer ${token}` } }),
        axios.get(`${API}/admin/flagged-players`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => ({ data: [] })),
        axios.get(`${API}/admin/security-alerts`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => ({ data: [] })),
        axios.get(`${API}/tournaments`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => ({ data: [] })),
        axios.get(`${API}/admin/withdrawals`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => ({ data: [] })),
        axios.get(`${API}/admin/credit-feature-costs`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => ({ data: [] })),
      ]);

      setStats(statsRes.data);
      setUsers(usersRes.data);
      setSettings(settingsRes.data);
      setFlaggedPlayers(flaggedRes.data);
      setSecurityAlerts(alertsRes.data);
      setTournaments(tournamentsRes.data);
      setWithdrawals(withdrawalsRes.data);
      setCreditCosts(creditCostsRes.data);
      setNewArbiterFee((settingsRes.data.arbiter_fee * 100).toString());
    } catch (error) {
      console.error("Failed to fetch admin data:", error);
      toast.error("Failed to load admin data");
    } finally {
      setLoading(false);
    }
  };

  // Withdrawal management handlers
  const handleConfirmWithdrawal = async (withdrawal) => {
    setSelectedWithdrawal(withdrawal);
    setWithdrawalAction("confirm");
    setAdminNote("");
    setWithdrawalNoteDialogOpen(true);
  };

  const handleRejectWithdrawal = async (withdrawal) => {
    setSelectedWithdrawal(withdrawal);
    setWithdrawalAction("reject");
    setAdminNote("");
    setWithdrawalNoteDialogOpen(true);
  };

  const processWithdrawalAction = async () => {
    if (!selectedWithdrawal || !withdrawalAction) return;
    
    setProcessingWithdrawal(true);
    try {
      const endpoint = withdrawalAction === "confirm" 
        ? `${API}/admin/withdrawals/${selectedWithdrawal.withdrawal_id}/confirm`
        : `${API}/admin/withdrawals/${selectedWithdrawal.withdrawal_id}/reject`;
      
      await axios.put(
        endpoint,
        { admin_note: adminNote },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      toast.success(
        withdrawalAction === "confirm" 
          ? "Withdrawal confirmed successfully" 
          : "Withdrawal rejected, balance refunded"
      );
      
      setWithdrawalNoteDialogOpen(false);
      setSelectedWithdrawal(null);
      setWithdrawalAction(null);
      setAdminNote("");
      fetchAdminData();
    } catch (error) {
      toast.error(error.response?.data?.detail || `Failed to ${withdrawalAction} withdrawal`);
    } finally {
      setProcessingWithdrawal(false);
    }
  };

  const pendingWithdrawalsCount = withdrawals.filter(w => w.status === "pending").length;

  const handleBanUser = async (userId, isBanned) => {
    try {
      await axios.put(
        `${API}/admin/users/${userId}/${isBanned ? "unban" : "ban"}`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      toast.success(isBanned ? "User unbanned" : "User banned");
      fetchAdminData();
    } catch (error) {
      toast.error("Failed to update user status");
    }
  };

  const handleClearFlag = async (userId) => {
    try {
      await axios.put(
        `${API}/admin/users/${userId}/clear-flag`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      toast.success("Flag cleared");
      fetchAdminData();
    } catch (error) {
      toast.error("Failed to clear flag");
    }
  };

  const handleAdjustBalance = async () => {
    if (!selectedUser || !balanceAmount) return;

    try {
      await axios.put(
        `${API}/admin/users/${selectedUser.user_id}/balance`,
        {
          currency: balanceCurrency,
          amount: parseFloat(balanceAmount),
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      toast.success("Balance adjusted");
      setBalanceDialogOpen(false);
      setBalanceAmount("");
      fetchAdminData();
    } catch (error) {
      toast.error("Failed to adjust balance");
    }
  };

  const handleUpdateSettings = async () => {
    try {
      await axios.put(
        `${API}/admin/settings`,
        {
          arbiter_fee: parseFloat(newArbiterFee) / 100,
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      toast.success("Settings updated");
      fetchAdminData();
    } catch (error) {
      toast.error("Failed to update settings");
    }
  };

  const handleSaveCreditCost = async (feature_key, category) => {
    const raw = editedCosts[feature_key];
    const cost = parseInt(raw, 10);
    if (Number.isNaN(cost) || cost < 0) {
      toast.error("Cost must be a whole number, 0 or greater");
      return;
    }
    setSavingCostKey(feature_key);
    try {
      await axios.put(
        `${API}/admin/credit-feature-costs/${feature_key}`,
        { cost, category: category || null },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      toast.success(`${feature_key} cost updated`);
      setEditedCosts((prev) => {
        const next = { ...prev };
        delete next[feature_key];
        return next;
      });
      fetchAdminData();
    } catch (error) {
      toast.error("Failed to update cost");
    } finally {
      setSavingCostKey(null);
    }
  };

  const handleCreateTournament = async () => {
    try {
      await axios.post(
        `${API}/tournaments`,
        newTournament,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      toast.success("Tournament created");
      setTournamentDialogOpen(false);
      fetchAdminData();
    } catch (error) {
      toast.error("Failed to create tournament");
    }
  };

  const handleStartTournament = async (tournamentId) => {
    try {
      await axios.post(
        `${API}/tournaments/${tournamentId}/start`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      toast.success("Tournament started");
      fetchAdminData();
    } catch (error) {
      toast.error(error.response?.data?.detail || "Failed to start tournament");
    }
  };

  const handleEndTournament = async (tournamentId) => {
    try {
      await axios.post(
        `${API}/tournaments/${tournamentId}/end`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      toast.success("Tournament ended");
      fetchAdminData();
    } catch (error) {
      toast.error(error.response?.data?.detail || "Failed to end tournament");
    }
  };

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto space-y-5">
        <SkeletonStatsRow count={4} />
        <SkeletonPanel rows={4} />
      </div>
    );
  }

  return (
    <div className="sc-page max-w-6xl mx-auto">
      <PageHeader
        title={
          <>
            Admin panel
            <span
              className="text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-md"
              style={{ background: "var(--brand)", color: "var(--on-brand)" }}
            >
              Admin
            </span>
          </>
        }
        subtitle="Platform stats, users, and moderation"
      />

      <div className="max-w-7xl mx-auto">
        {/* Tabs */}
        <div className="flex flex-wrap gap-2 mb-8 bg-surface-1 p-1 rounded-sm w-fit">
          {[
            { id: "overview", label: "Overview", icon: Trophy },
            { id: "users", label: "Users", icon: Users },
            { id: "withdrawals", label: "Withdrawals", icon: Wallet, badge: pendingWithdrawalsCount },
            { id: "anticheat", label: "Anti-Cheat", icon: Shield },
            { id: "tournaments", label: "Tournaments", icon: Calendar },
            { id: "credits", label: "Credits", icon: DollarSign },
            { id: "settings", label: "Settings", icon: Settings },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-sm transition-colors relative ${
                activeTab === tab.id
                  ? "bg-brand text-brand-on"
                  : "text-ink-secondary hover:text-ink"
              }`}
              data-testid={`admin-tab-${tab.id}`}
            >
              <tab.icon className="w-4 h-4" />
              <span className="hidden sm:inline">{tab.label}</span>
              {tab.badge > 0 && (
                <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-ink text-xs rounded-full flex items-center justify-center">
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Overview Tab */}
        {activeTab === "overview" && (
          <div>
            <h2 className="font-display font-bold text-2xl text-ink mb-6">
              Platform Overview
            </h2>

            <div className="grid md:grid-cols-4 gap-4 mb-8">
              <div className="bg-surface-1 border border-hair p-6 rounded-sm">
                <Users className="w-8 h-8 text-info mb-2" />
                <p className="text-3xl font-bold text-ink font-mono">
                  {stats?.total_users || 0}
                </p>
                <p className="text-ink-secondary text-sm">Total Users</p>
              </div>
              <div className="bg-surface-1 border border-hair p-6 rounded-sm">
                <Trophy className="w-8 h-8 text-brand mb-2" />
                <p className="text-3xl font-bold text-ink font-mono">
                  {stats?.total_games || 0}
                </p>
                <p className="text-ink-secondary text-sm">Total Games</p>
              </div>
              <div className="bg-surface-1 border border-hair p-6 rounded-sm">
                <Shield className="w-8 h-8 text-danger mb-2" />
                <p className="text-3xl font-bold text-danger font-mono">
                  {stats?.flagged_players || 0}
                </p>
                <p className="text-ink-secondary text-sm">Flagged Players</p>
              </div>
              <div className="bg-surface-1 border border-hair p-6 rounded-sm">
                <DollarSign className="w-8 h-8 text-green-400 mb-2" />
                <p className="text-3xl font-bold text-green-400 font-mono">
                  ${stats?.total_revenue?.USDT?.toFixed(2) || "0.00"}
                </p>
                <p className="text-ink-secondary text-sm">Platform Revenue</p>
              </div>
            </div>

            {/* Quick Actions */}
            <div className="grid md:grid-cols-3 gap-4">
              <div className="bg-surface-1 border border-hair rounded-sm p-4">
                <h3 className="text-ink font-semibold mb-2">Active Games</h3>
                <p className="text-3xl font-mono text-success">{stats?.active_games || 0}</p>
              </div>
              <div className="bg-surface-1 border border-hair rounded-sm p-4">
                <h3 className="text-ink font-semibold mb-2">Active Tournaments</h3>
                <p className="text-3xl font-mono text-brand">{stats?.active_tournaments || 0}</p>
              </div>
              <div className="bg-surface-1 border border-hair rounded-sm p-4">
                <h3 className="text-ink font-semibold mb-2">Banned Users</h3>
                <p className="text-3xl font-mono text-danger">{stats?.banned_players || 0}</p>
              </div>
            </div>
          </div>
        )}

        {/* Users Tab */}
        {activeTab === "users" && (
          <div>
            <h2 className="font-display font-bold text-2xl text-ink mb-6">
              User Management
            </h2>

            <div className="bg-surface-1 border border-hair rounded-sm">
              <Table className="min-w-[640px]">
                <TableHeader>
                  <TableRow className="border-hair hover:bg-transparent">
                    <TableHead className="text-ink-secondary">User</TableHead>
                    <TableHead className="text-ink-secondary">Email</TableHead>
                    <TableHead className="text-ink-secondary text-center">Rating</TableHead>
                    <TableHead className="text-ink-secondary text-center">USDT</TableHead>
                    <TableHead className="text-ink-secondary text-center">Status</TableHead>
                    <TableHead className="text-ink-secondary text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((u) => (
                    <TableRow
                      key={u.user_id}
                      className="border-hair hover:bg-surface-2"
                    >
                      <TableCell className="font-medium text-ink">
                        <div className="flex items-center gap-2">
                          {u.username}
                          {u.is_admin && (
                            <Badge className="bg-brand-dim text-brand border-brand">Admin</Badge>
                          )}
                          {u.is_flagged && (
                            <Badge className="bg-danger-dim text-danger border-danger">Flagged</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-ink-secondary">{u.email}</TableCell>
                      <TableCell className="text-center font-mono text-brand">{u.rating}</TableCell>
                      <TableCell className="text-center font-mono text-green-400">
                        ${u.wallet_balance?.USDT?.toFixed(2) || "0.00"}
                      </TableCell>
                      <TableCell className="text-center">
                        {u.is_banned ? (
                          <Badge className="bg-danger-dim text-danger border-danger">Banned</Badge>
                        ) : (
                          <Badge className="bg-success-dim text-success border-success">Active</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            onClick={() => {
                              setSelectedUser(u);
                              setBalanceDialogOpen(true);
                            }}
                            variant="ghost"
                            size="sm"
                            className="text-ink-secondary hover:text-brand"
                          >
                            <Edit className="w-4 h-4" />
                          </Button>
                          {!u.is_admin && (
                            <Button
                              onClick={() => handleBanUser(u.user_id, u.is_banned)}
                              variant="ghost"
                              size="sm"
                              className={u.is_banned ? "text-success" : "text-danger"}
                            >
                              {u.is_banned ? <Check className="w-4 h-4" /> : <Ban className="w-4 h-4" />}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {/* Anti-Cheat Tab */}
        {activeTab === "anticheat" && (
          <div>
            <h2 className="font-display font-bold text-2xl text-ink mb-6">
              Anti-Cheat Dashboard
            </h2>

            {/* Flagged Players */}
            <div className="bg-surface-1 border border-hair rounded-sm mb-6">
              <div className="p-4 border-b border-hair flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-danger" />
                <h3 className="text-ink font-semibold">Flagged Players ({flaggedPlayers.length})</h3>
              </div>
              {flaggedPlayers.length === 0 ? (
                <div className="p-8 text-center">
                  <Shield className="w-12 h-12 text-success mx-auto mb-4" />
                  <p className="text-ink-secondary">No flagged players</p>
                </div>
              ) : (
                <div className="divide-y divide-hair">
                  {flaggedPlayers.map((flag) => (
                    <div key={flag.flag_id} className="p-4">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-ink font-semibold">{flag.user?.username}</span>
                            <span className="text-ink-muted text-sm">({flag.user?.email})</span>
                          </div>
                          <div className="space-y-1">
                            {flag.reasons?.map((reason, idx) => (
                              <p key={idx} className="text-danger text-sm flex items-center gap-2">
                                <AlertTriangle className="w-3 h-3" />
                                {reason}
                              </p>
                            ))}
                          </div>
                          <p className="text-ink-muted text-xs mt-2">
                            Flagged: {new Date(flag.created_at).toLocaleString()}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            onClick={() => handleClearFlag(flag.user_id)}
                            variant="outline"
                            size="sm"
                            className="bg-transparent border-success text-success hover:bg-success-dim"
                          >
                            <Check className="w-4 h-4 mr-1" />
                            Clear
                          </Button>
                          <Button
                            onClick={() => handleBanUser(flag.user_id, false)}
                            variant="outline"
                            size="sm"
                            className="bg-transparent border-danger text-danger hover:bg-danger-dim"
                          >
                            <Ban className="w-4 h-4 mr-1" />
                            Ban
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Security Alerts */}
            <div className="bg-surface-1 border border-hair rounded-sm">
              <div className="p-4 border-b border-hair flex items-center gap-2">
                <Shield className="w-5 h-5 text-warn" />
                <h3 className="text-ink font-semibold">Security Alerts</h3>
              </div>
              {securityAlerts.length === 0 ? (
                <div className="p-8 text-center">
                  <Shield className="w-12 h-12 text-ink-muted mx-auto mb-4" />
                  <p className="text-ink-secondary">No security alerts</p>
                </div>
              ) : (
                <div className="divide-y divide-hair max-h-64 overflow-y-auto">
                  {securityAlerts.map((alert) => (
                    <div key={alert.alert_id} className="p-4 flex items-center justify-between">
                      <div>
                        <p className="text-ink text-sm">
                          <span className="text-warn">{alert.type}</span>
                          {alert.type === "multiple_accounts" && (
                            <span className="text-ink-secondary"> - {alert.accounts_count} accounts from IP {alert.ip}</span>
                          )}
                        </p>
                        <p className="text-ink-muted text-xs">
                          {new Date(alert.created_at).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Withdrawals Tab */}
        {activeTab === "withdrawals" && (
          <div>
            <h2 className="font-display font-bold text-2xl text-ink mb-6">
              Withdrawal Management
            </h2>

            {/* Pending Withdrawals */}
            <div className="bg-surface-1 border border-hair rounded-sm mb-6">
              <div className="p-4 border-b border-hair flex items-center gap-2">
                <Clock className="w-5 h-5 text-brand" />
                <h3 className="text-ink font-semibold">
                  Pending Withdrawals ({withdrawals.filter(w => w.status === "pending").length})
                </h3>
              </div>
              
              {withdrawals.filter(w => w.status === "pending").length === 0 ? (
                <div className="p-8 text-center">
                  <Wallet className="w-12 h-12 text-ink-muted mx-auto mb-4" />
                  <p className="text-ink-secondary">No pending withdrawals</p>
                </div>
              ) : (
                <Table className="min-w-[640px]">
                  <TableHeader>
                    <TableRow className="border-hair">
                      <TableHead className="text-ink-secondary">User</TableHead>
                      <TableHead className="text-ink-secondary">Amount</TableHead>
                      <TableHead className="text-ink-secondary">Method</TableHead>
                      <TableHead className="text-ink-secondary">Wallet Address</TableHead>
                      <TableHead className="text-ink-secondary">Date</TableHead>
                      <TableHead className="text-ink-secondary text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {withdrawals.filter(w => w.status === "pending").map((withdrawal) => (
                      <TableRow key={withdrawal.withdrawal_id} className="border-hair">
                        <TableCell>
                          <div>
                            <p className="text-ink font-medium">{withdrawal.username}</p>
                            <p className="text-ink-muted text-xs">{withdrawal.user_id}</p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-brand font-mono font-bold">
                            {withdrawal.amount.toFixed(2)} {withdrawal.currency}
                          </span>
                        </TableCell>
                        <TableCell className="text-ink-secondary">{withdrawal.withdrawal_method}</TableCell>
                        <TableCell>
                          <span className="text-ink-secondary font-mono text-xs">
                            {withdrawal.wallet_address.slice(0, 10)}...{withdrawal.wallet_address.slice(-6)}
                          </span>
                        </TableCell>
                        <TableCell className="text-ink-muted text-xs">
                          {new Date(withdrawal.created_at).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              onClick={() => handleConfirmWithdrawal(withdrawal)}
                              size="sm"
                              className="bg-success text-brand-on hover:bg-success"
                              data-testid={`confirm-withdrawal-${withdrawal.withdrawal_id}`}
                            >
                              <CheckCircle className="w-4 h-4 mr-1" />
                              Confirm
                            </Button>
                            <Button
                              onClick={() => handleRejectWithdrawal(withdrawal)}
                              size="sm"
                              variant="outline"
                              className="border-danger text-danger hover:bg-danger-dim"
                              data-testid={`reject-withdrawal-${withdrawal.withdrawal_id}`}
                            >
                              <XCircle className="w-4 h-4 mr-1" />
                              Reject
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>

            {/* Recent Withdrawals History */}
            <div className="bg-surface-1 border border-hair rounded-sm">
              <div className="p-4 border-b border-hair flex items-center gap-2">
                <Wallet className="w-5 h-5 text-ink-secondary" />
                <h3 className="text-ink font-semibold">Withdrawal History</h3>
              </div>
              
              {withdrawals.filter(w => w.status !== "pending").length === 0 ? (
                <div className="p-8 text-center">
                  <p className="text-ink-secondary">No completed withdrawals yet</p>
                </div>
              ) : (
                <Table className="min-w-[700px]">
                  <TableHeader>
                    <TableRow className="border-hair">
                      <TableHead className="text-ink-secondary">User</TableHead>
                      <TableHead className="text-ink-secondary">Amount</TableHead>
                      <TableHead className="text-ink-secondary">Status</TableHead>
                      <TableHead className="text-ink-secondary">Wallet Address</TableHead>
                      <TableHead className="text-ink-secondary">Date</TableHead>
                      <TableHead className="text-ink-secondary">Note</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {withdrawals.filter(w => w.status !== "pending").map((withdrawal) => (
                      <TableRow key={withdrawal.withdrawal_id} className="border-hair">
                        <TableCell>
                          <p className="text-ink">{withdrawal.username}</p>
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-ink-secondary">
                            {withdrawal.amount.toFixed(2)} {withdrawal.currency}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge className={
                            withdrawal.status === "confirmed"
                              ? "bg-success-dim text-success border-success"
                              : "bg-danger-dim text-danger border-danger"
                          }>
                            {withdrawal.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <span className="text-ink-secondary font-mono text-xs">
                            {withdrawal.wallet_address.slice(0, 10)}...{withdrawal.wallet_address.slice(-6)}
                          </span>
                        </TableCell>
                        <TableCell className="text-ink-muted text-xs">
                          {new Date(withdrawal.updated_at || withdrawal.created_at).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-ink-secondary text-xs max-w-[150px] truncate">
                          {withdrawal.admin_note || "-"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        )}

        {/* Tournaments Tab */}
        {activeTab === "tournaments" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-display font-bold text-2xl text-ink">Tournament Management</h2>
              <Button
                onClick={() => setTournamentDialogOpen(true)}
                className="bg-brand text-brand-on hover:bg-brand-hover font-bold"
              >
                Create Tournament
              </Button>
            </div>

            <div className="grid gap-4">
              {tournaments.map((tournament) => (
                <div
                  key={tournament.tournament_id}
                  className="bg-surface-1 border border-hair rounded-sm p-4"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-ink font-semibold">{tournament.name}</h3>
                        <Badge className={
                          tournament.status === "active" 
                            ? "bg-success-dim text-success border-success" 
                            : tournament.status === "upcoming"
                            ? "bg-brand-dim text-brand border-brand"
                            : "bg-surface-2 text-ink-secondary border-hair"
                        }>
                          {tournament.status}
                        </Badge>
                      </div>
                      <p className="text-ink-secondary text-sm">
                        {tournament.time_control} • {tournament.current_players}/{tournament.max_players} players • 
                        Prize Pool: {tournament.prize_pool} {tournament.entry_currency}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {tournament.status === "upcoming" && (
                        <Button
                          onClick={() => handleStartTournament(tournament.tournament_id)}
                          size="sm"
                          className="bg-success text-brand-on hover:bg-success"
                        >
                          Start
                        </Button>
                      )}
                      {tournament.status === "active" && (
                        <Button
                          onClick={() => handleEndTournament(tournament.tournament_id)}
                          size="sm"
                          variant="outline"
                          className="border-danger text-danger hover:bg-danger-dim"
                        >
                          End
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Settings Tab */}
        {activeTab === "credits" && (
          <div>
            <h2 className="font-display font-bold text-2xl text-ink mb-2">
              Credit Feature Costs
            </h2>
            <p className="text-ink-muted text-sm mb-6">
              Costs apply immediately - no deploy needed. A feature stays blocked (500 on spend) until it has a
              cost here.
            </p>

            <div className="bg-surface-1 border border-hair rounded-sm">
              <Table className="min-w-[560px]">
                <TableHeader>
                  <TableRow className="border-hair hover:bg-transparent">
                    <TableHead className="text-ink-secondary">Feature key</TableHead>
                    <TableHead className="text-ink-secondary">Category</TableHead>
                    <TableHead className="text-ink-secondary text-center">Cost (credits)</TableHead>
                    <TableHead className="text-ink-secondary text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {creditCosts.map((c) => {
                    const isEdited = editedCosts[c.feature_key] !== undefined;
                    const displayValue = isEdited ? editedCosts[c.feature_key] : String(c.cost);
                    return (
                      <TableRow key={c.feature_key} className="border-hair hover:bg-surface-2">
                        <TableCell className="font-mono text-ink">{c.feature_key}</TableCell>
                        <TableCell className="text-ink-secondary">
                          {c.category ? (
                            <Badge className="bg-brand-dim text-brand border-brand">{c.category}</Badge>
                          ) : (
                            <span className="text-ink-muted">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          <Input
                            type="number"
                            min="0"
                            step="1"
                            value={displayValue}
                            onChange={(e) =>
                              setEditedCosts((prev) => ({ ...prev, [c.feature_key]: e.target.value }))
                            }
                            className="bg-surface-2 border-hair text-ink font-mono text-center w-24 mx-auto"
                            data-testid={`credit-cost-input-${c.feature_key}`}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            onClick={() => handleSaveCreditCost(c.feature_key, c.category)}
                            disabled={!isEdited || savingCostKey === c.feature_key}
                            variant="ghost"
                            size="sm"
                            className="text-ink-secondary hover:text-brand"
                            data-testid={`credit-cost-save-${c.feature_key}`}
                          >
                            {savingCostKey === c.feature_key ? "Saving…" : "Save"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {creditCosts.length === 0 && (
                    <TableRow className="border-hair hover:bg-transparent">
                      <TableCell colSpan={4} className="text-center text-ink-muted py-8">
                        No feature costs configured yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {activeTab === "settings" && (
          <div>
            <h2 className="font-display font-bold text-2xl text-ink mb-6">
              Platform Settings
            </h2>

            <div className="bg-surface-1 border border-hair rounded-sm p-6 max-w-md">
              <div className="space-y-6">
                <div className="space-y-2">
                  <Label className="text-ink-secondary">Arbiter Fee (%)</Label>
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={newArbiterFee}
                    onChange={(e) => setNewArbiterFee(e.target.value)}
                    className="bg-surface-2 border-hair text-ink font-mono"
                  />
                  <p className="text-ink-muted text-xs">
                    Current: {(settings?.arbiter_fee * 100).toFixed(1)}%
                  </p>
                </div>

                <Button
                  onClick={handleUpdateSettings}
                  className="bg-brand text-brand-on hover:bg-brand-hover font-bold uppercase tracking-wider"
                >
                  Save Settings
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Balance Adjustment Dialog */}
      <Dialog open={balanceDialogOpen} onOpenChange={setBalanceDialogOpen}>
        <DialogContent className="bg-surface-1 border-hair text-ink max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display font-bold text-xl">
              Adjust Balance - {selectedUser?.username}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-6 pt-4">
            <div className="space-y-2">
              <Label className="text-ink-secondary">Currency</Label>
              <Select value={balanceCurrency} onValueChange={setBalanceCurrency}>
                <SelectTrigger className="bg-surface-2 border-hair text-ink">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface-2 border-hair">
                  <SelectItem value="USDT" className="text-ink hover:bg-surface-2">USDT</SelectItem>
                  <SelectItem value="BTC" className="text-ink hover:bg-surface-2">BTC</SelectItem>
                  <SelectItem value="ETH" className="text-ink hover:bg-surface-2">ETH</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-ink-secondary">Amount (+ or -)</Label>
              <Input
                type="number"
                step="0.01"
                value={balanceAmount}
                onChange={(e) => setBalanceAmount(e.target.value)}
                placeholder="10 or -10"
                className="bg-surface-2 border-hair text-ink font-mono"
              />
              <p className="text-ink-muted text-xs">
                Current: {selectedUser?.wallet_balance?.[balanceCurrency]?.toFixed(6) || 0} {balanceCurrency}
              </p>
            </div>

            <Button
              onClick={handleAdjustBalance}
              className="w-full bg-brand text-brand-on hover:bg-brand-hover font-bold uppercase tracking-wider"
            >
              Adjust Balance
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create Tournament Dialog */}
      <Dialog open={tournamentDialogOpen} onOpenChange={setTournamentDialogOpen}>
        <DialogContent className="bg-surface-1 border-hair text-ink max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display font-bold text-xl">Create Tournament</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label className="text-ink-secondary">Name</Label>
              <Input
                value={newTournament.name}
                onChange={(e) => setNewTournament({...newTournament, name: e.target.value})}
                placeholder="Tournament Name"
                className="bg-surface-2 border-hair text-ink"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-ink-secondary">Time Control</Label>
                <Select
                  value={newTournament.time_control}
                  onValueChange={(v) => setNewTournament({...newTournament, time_control: v})}
                >
                  <SelectTrigger className="bg-surface-2 border-hair text-ink">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-surface-2 border-hair">
                    <SelectItem value="1+1" className="text-ink">1+1 Bullet</SelectItem>
                    <SelectItem value="3+2" className="text-ink">3+2 Blitz</SelectItem>
                    <SelectItem value="5+3" className="text-ink">5+3 Blitz</SelectItem>
                    <SelectItem value="10+5" className="text-ink">10+5 Rapid</SelectItem>
                    <SelectItem value="15+10" className="text-ink">15+10 Rapid</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-ink-secondary">Entry Fee (USDT)</Label>
                <Input
                  type="number"
                  value={newTournament.entry_fee}
                  onChange={(e) => setNewTournament({...newTournament, entry_fee: parseFloat(e.target.value)})}
                  className="bg-surface-2 border-hair text-ink font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-ink-secondary">Min Players</Label>
                <Input
                  type="number"
                  value={newTournament.min_players}
                  onChange={(e) => setNewTournament({...newTournament, min_players: parseInt(e.target.value)})}
                  className="bg-surface-2 border-hair text-ink font-mono"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-ink-secondary">Max Players</Label>
                <Input
                  type="number"
                  value={newTournament.max_players}
                  onChange={(e) => setNewTournament({...newTournament, max_players: parseInt(e.target.value)})}
                  className="bg-surface-2 border-hair text-ink font-mono"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-ink-secondary">Duration (minutes)</Label>
              <Input
                type="number"
                value={newTournament.duration_minutes}
                onChange={(e) => setNewTournament({...newTournament, duration_minutes: parseInt(e.target.value)})}
                className="bg-surface-2 border-hair text-ink font-mono"
              />
            </div>

            <Button
              onClick={handleCreateTournament}
              className="w-full bg-brand text-brand-on hover:bg-brand-hover font-bold uppercase tracking-wider"
            >
              Create Tournament
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Withdrawal Confirmation Dialog */}
      <Dialog open={withdrawalNoteDialogOpen} onOpenChange={setWithdrawalNoteDialogOpen}>
        <DialogContent className="bg-surface-1 border-hair text-ink max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display font-bold text-xl">
              {withdrawalAction === "confirm" ? "Confirm Withdrawal" : "Reject Withdrawal"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            {selectedWithdrawal && (
              <div className="bg-surface-2 p-4 rounded-sm space-y-2">
                <div className="flex justify-between">
                  <span className="text-ink-secondary">User:</span>
                  <span className="text-ink font-medium">{selectedWithdrawal.username}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-secondary">Amount:</span>
                  <span className="text-brand font-mono font-bold">
                    {selectedWithdrawal.amount.toFixed(2)} {selectedWithdrawal.currency}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-secondary">Wallet:</span>
                  <span className="text-ink-secondary font-mono text-xs">
                    {selectedWithdrawal.wallet_address.slice(0, 8)}...{selectedWithdrawal.wallet_address.slice(-6)}
                  </span>
                </div>
              </div>
            )}

            {withdrawalAction === "reject" && (
              <div className="bg-danger-dim border border-danger p-3 rounded-sm">
                <p className="text-danger text-sm">
                  Rejecting this withdrawal will refund {selectedWithdrawal?.amount.toFixed(2)} {selectedWithdrawal?.currency} back to the user's wallet.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-ink-secondary">Admin Note (optional)</Label>
              <Input
                value={adminNote}
                onChange={(e) => setAdminNote(e.target.value)}
                placeholder={withdrawalAction === "confirm" 
                  ? "e.g., Sent to wallet, tx: 0x..." 
                  : "e.g., Invalid wallet address"
                }
                className="bg-surface-2 border-hair text-ink"
              />
            </div>

            <div className="flex gap-3">
              <Button
                onClick={() => setWithdrawalNoteDialogOpen(false)}
                variant="outline"
                className="flex-1 border-hair text-ink hover:bg-surface-2"
                disabled={processingWithdrawal}
              >
                Cancel
              </Button>
              <Button
                onClick={processWithdrawalAction}
                disabled={processingWithdrawal}
                className={`flex-1 font-bold ${
                  withdrawalAction === "confirm"
                    ? "bg-success text-brand-on hover:bg-success"
                    : "bg-danger text-ink hover:bg-danger"
                }`}
              >
                {processingWithdrawal ? "Processing..." : withdrawalAction === "confirm" ? "Confirm" : "Reject & Refund"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
