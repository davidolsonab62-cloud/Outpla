import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth, API } from "@/App";
import { toast } from "sonner";
import axios from "axios";
import {
  Wallet as WalletIcon,
  ArrowUpRight,
  ArrowDownLeft,
  Clock,
  Copy,
  Check,
  QrCode,
  AlertTriangle,
  Coins,
} from "lucide-react";
import { SkeletonPanel } from "@/components/ui/skeletons";
import PageHeader from "@/components/layout/PageHeader";

const CURRENCIES = [
  { value: "USDT", symbol: "$", tone: "var(--green)", network: "TRC20 (Tron Network)" },
  { value: "BTC", symbol: "\u20BF", tone: "var(--orange)", network: "Bitcoin Network" },
  { value: "ETH", symbol: "\u039E", tone: "var(--brand)", network: "ERC20 (Ethereum Network)" },
];

const DEPOSIT_ADDRESSES = {
  BTC: "bc1qegzv05zl09fn4egtr3dm5j6m805gtkut6rsajj",
  ETH: "0xCEe068a3af0a54B0f664A85316E2ae78cef1cD76",
  USDT: "TLo5r4kXq71xwpaLJWXvVwG9QBe2dWa9Ue",
};

const getQRCodeUrl = (address) =>
  `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(address)}&bgcolor=ffffff&color=000000`;

const STATUS_STYLES = {
  pending: { color: "var(--orange)", bg: "var(--orange-dim)" },
  confirmed: { color: "var(--green)", bg: "var(--green-dim)" },
  rejected: { color: "var(--red)", bg: "var(--red-dim)" },
};

export default function Wallet() {
  const { user, token, updateUser } = useAuth();
  const [transactions, setTransactions] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [depositDialogOpen, setDepositDialogOpen] = useState(false);
  const [withdrawDialogOpen, setWithdrawDialogOpen] = useState(false);

  const [depositCurrency, setDepositCurrency] = useState("USDT");
  const [copiedAddress, setCopiedAddress] = useState(null);

  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawCurrency, setWithdrawCurrency] = useState("USDT");
  const [withdrawAddress, setWithdrawAddress] = useState("");
  const [withdrawMethod] = useState("crypto");
  const [withdrawing, setWithdrawing] = useState(false);

  const [buyCreditsDialogOpen, setBuyCreditsDialogOpen] = useState(false);
  const [creditPacks, setCreditPacks] = useState([]);
  const [selectedPackAmount, setSelectedPackAmount] = useState(null);
  const [customUsdtAmount, setCustomUsdtAmount] = useState("");
  const [buyingCredits, setBuyingCredits] = useState(false);

  useEffect(() => {
    fetchTransactions();
    fetchWithdrawals();
    fetchCreditPacks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchTransactions = async () => {
    try {
      const response = await axios.get(`${API}/wallet/transactions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setTransactions(response.data);
    } catch (error) {
      console.error("Failed to fetch transactions:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchWithdrawals = async () => {
    try {
      const response = await axios.get(`${API}/wallet/withdrawals`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setWithdrawals(response.data);
    } catch (error) {
      console.error("Failed to fetch withdrawals:", error);
    }
  };

  const fetchCreditPacks = async () => {
    try {
      const response = await axios.get(`${API}/credits/packs`);
      setCreditPacks(response.data.packs || []);
      if (response.data.packs?.length) {
        setSelectedPackAmount(response.data.packs[0].amount_usdt);
      }
    } catch (error) {
      console.error("Failed to fetch credit packs:", error);
    }
  };

  const buyCreditsUsdtAmount = customUsdtAmount
    ? parseFloat(customUsdtAmount)
    : selectedPackAmount;

  const handleBuyCredits = async () => {
    const amount = buyCreditsUsdtAmount;
    if (!amount || amount <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    if (amount > (user?.wallet_balance?.USDT || 0)) {
      toast.error("Insufficient USDT balance");
      return;
    }

    setBuyingCredits(true);
    try {
      const response = await axios.post(
        `${API}/credits/purchase`,
        { amount_usdt: amount },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      updateUser({
        ...user,
        wallet_balance: response.data.wallet_balance,
        credits_balance: response.data.credits_balance,
      });

      toast.success(`Purchased ${response.data.credits_purchased.toLocaleString()} credits`);
      setBuyCreditsDialogOpen(false);
      setCustomUsdtAmount("");
      fetchTransactions();
    } catch (error) {
      toast.error(error.response?.data?.detail || "Purchase failed");
    } finally {
      setBuyingCredits(false);
    }
  };

  const handleWithdraw = async () => {
    if (!withdrawAmount || parseFloat(withdrawAmount) <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    if (!withdrawAddress) {
      toast.error("Enter a wallet address");
      return;
    }

    setWithdrawing(true);
    try {
      const response = await axios.post(
        `${API}/wallet/withdraw`,
        {
          amount: parseFloat(withdrawAmount),
          currency: withdrawCurrency,
          wallet_address: withdrawAddress,
          withdrawal_method: withdrawMethod,
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      updateUser({ ...user, wallet_balance: response.data.wallet_balance });

      toast.success("Withdrawal request submitted. Pending admin confirmation.", { duration: 5000 });
      setWithdrawDialogOpen(false);
      setWithdrawAmount("");
      setWithdrawAddress("");
      fetchTransactions();
      fetchWithdrawals();
    } catch (error) {
      toast.error(error.response?.data?.detail || "Withdrawal failed");
    } finally {
      setWithdrawing(false);
    }
  };

  const copyAddress = (currency) => {
    navigator.clipboard.writeText(DEPOSIT_ADDRESSES[currency]);
    setCopiedAddress(currency);
    toast.success("Address copied to clipboard");
    setTimeout(() => setCopiedAddress(null), 3000);
  };

  const getCurrencyInfo = (currency) => CURRENCIES.find((c) => c.value === currency) || CURRENCIES[0];

  const TX_TYPE_LABELS = {
    credits_purchase: "Credits purchase",
    credits_purchase_refund: "Purchase refund",
  };
  const getTransactionLabel = (type) => TX_TYPE_LABELS[type] || type;

  const getTransactionIcon = (type) => {
    switch (type) {
      case "deposit":
      case "win":
      case "credits_purchase_refund":
        return <ArrowDownLeft className="w-4 h-4" style={{ color: "var(--green)" }} />;
      case "withdraw":
      case "credits_purchase":
        return <ArrowUpRight className="w-4 h-4" style={{ color: "var(--red)" }} />;
      case "stake":
        return <WalletIcon className="w-4 h-4" style={{ color: "var(--orange)" }} />;
      default:
        return <Clock className="w-4 h-4" style={{ color: "var(--text-secondary)" }} />;
    }
  };

  return (
    <div className="sc-page max-w-4xl mx-auto">
      <PageHeader title="Wallet" subtitle="Manage your crypto balance" testId="wallet-title" />

      {/* Balance cards */}
      <div className="grid md:grid-cols-3 gap-3.5 mb-6">
        {CURRENCIES.map((currency) => {
          const balance = user?.wallet_balance?.[currency.value] || 0;
          return (
            <div
              key={currency.value}
              className="rounded-2xl p-5"
              style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
              data-testid={`balance-${currency.value.toLowerCase()}`}
            >
              <div className="flex items-center justify-between mb-3">
                <div>
                  <span className="text-xs uppercase tracking-wide font-semibold" style={{ color: "var(--text-secondary)" }}>
                    {currency.value}
                  </span>
                  <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>{currency.network}</p>
                </div>
                <span className="text-xl" style={{ color: currency.tone }}>{currency.symbol}</span>
              </div>
              <p className="font-mono text-2xl font-bold" style={{ color: currency.tone, fontFamily: "'Space Grotesk', sans-serif" }}>
                {currency.value === "USDT" ? balance.toFixed(2) : balance.toFixed(6)}
              </p>
            </div>
          );
        })}
      </div>

      {/* Credits balance */}
      <div
        className="rounded-2xl p-5 mb-6 flex items-center justify-between"
        style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
        data-testid="balance-credits"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[9px] flex items-center justify-center" style={{ background: "var(--surface-2)" }}>
            <Coins className="w-5 h-5" style={{ color: "var(--gold, var(--brand))" }} />
          </div>
          <div>
            <span className="text-xs uppercase tracking-wide font-semibold" style={{ color: "var(--text-secondary)" }}>
              Credits
            </span>
            <p className="font-mono text-2xl font-bold" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              {(user?.credits_balance || 0).toLocaleString()}
            </p>
          </div>
        </div>
        <Dialog open={buyCreditsDialogOpen} onOpenChange={setBuyCreditsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="font-semibold px-6" style={{ background: "var(--brand)", color: "var(--on-brand)" }} data-testid="buy-credits-btn">
              Buy credits
            </Button>
          </DialogTrigger>
          <DialogContent
            className="max-w-md"
            style={{ background: "var(--surface-1)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
          >
            <DialogHeader>
              <DialogTitle style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Buy credits</DialogTitle>
            </DialogHeader>
            <div className="space-y-5 pt-4">
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                100 credits = $1. Paid from your USDT balance. Credits are separate from your wallet and can&apos;t be
                withdrawn, transferred, or used for staked games.
              </p>

              <div className="space-y-2">
                <Label style={{ color: "var(--text-secondary)" }}>Choose a pack</Label>
                <div className="grid grid-cols-3 gap-2">
                  {creditPacks.map((pack) => (
                    <button
                      key={pack.amount_usdt}
                      type="button"
                      onClick={() => {
                        setSelectedPackAmount(pack.amount_usdt);
                        setCustomUsdtAmount("");
                      }}
                      className="rounded-lg py-3 text-center"
                      style={{
                        background: !customUsdtAmount && selectedPackAmount === pack.amount_usdt ? "var(--brand)" : "var(--surface-2)",
                        color: !customUsdtAmount && selectedPackAmount === pack.amount_usdt ? "var(--on-brand)" : "var(--text-primary)",
                        border: "1px solid var(--hairline)",
                      }}
                      data-testid={`credit-pack-${pack.amount_usdt}`}
                    >
                      <p className="font-mono font-bold text-sm">{pack.credits.toLocaleString()}</p>
                      <p className="text-[11px]" style={{ opacity: 0.8 }}>${pack.amount_usdt}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label style={{ color: "var(--text-secondary)" }}>Or enter a custom USDT amount</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={customUsdtAmount}
                  onChange={(e) => setCustomUsdtAmount(e.target.value)}
                  placeholder="0.00"
                  className="font-mono"
                  style={{ background: "var(--surface-2)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
                  data-testid="custom-credits-amount-input"
                />
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {buyCreditsUsdtAmount > 0
                    ? `= ${Math.floor(buyCreditsUsdtAmount * 100).toLocaleString()} credits`
                    : "Enter an amount to see credits"}
                </p>
              </div>

              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Available: {(user?.wallet_balance?.USDT || 0).toFixed(2)} USDT
              </p>

              <Button
                onClick={handleBuyCredits}
                disabled={buyingCredits}
                className="w-full font-semibold"
                style={{ background: "var(--brand)", color: "var(--on-brand)" }}
                data-testid="confirm-buy-credits-btn"
              >
                {buyingCredits ? "Processing\u2026" : "Buy credits"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Actions */}
      <div className="flex gap-3 mb-6">
        <Dialog open={depositDialogOpen} onOpenChange={setDepositDialogOpen}>
          <DialogTrigger asChild>
            <Button className="font-semibold px-8" style={{ background: "var(--green)", color: "#08251A" }} data-testid="deposit-btn">
              <ArrowDownLeft className="w-4 h-4 mr-2" />
              Deposit
            </Button>
          </DialogTrigger>
          <DialogContent
            className="max-w-lg"
            style={{ background: "var(--surface-1)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
          >
            <DialogHeader>
              <DialogTitle style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Deposit funds</DialogTitle>
            </DialogHeader>

            <Tabs defaultValue="USDT" value={depositCurrency} onValueChange={setDepositCurrency} className="mt-4">
              <TabsList className="w-full grid grid-cols-3 mb-6" style={{ background: "var(--surface-2)" }}>
                {CURRENCIES.map((c) => (
                  <TabsTrigger key={c.value} value={c.value}>
                    <span className="flex items-center gap-2">
                      <span style={{ color: c.tone }}>{c.symbol}</span>
                      {c.value}
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>

              {CURRENCIES.map((currency) => (
                <TabsContent key={currency.value} value={currency.value} className="space-y-4">
                  <div
                    className="p-3 rounded-lg flex items-start gap-3"
                    style={{ background: "var(--red-dim)", border: "1px solid var(--red)" }}
                  >
                    <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: "var(--red)" }} />
                    <div>
                      <p className="text-sm font-semibold" style={{ color: "var(--red)" }}>Important</p>
                      <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                        Only send {currency.value} via {currency.network}. Sending via the wrong network results in
                        permanent loss of funds.
                      </p>
                    </div>
                  </div>

                  <div className="p-6 rounded-lg text-center" style={{ background: "var(--surface-2)" }}>
                    <div className="inline-block p-3 bg-white rounded-lg mb-4">
                      <img
                        src={getQRCodeUrl(DEPOSIT_ADDRESSES[currency.value])}
                        alt={`${currency.value} QR code`}
                        className="w-40 h-40"
                        data-testid={`qr-code-${currency.value.toLowerCase()}`}
                      />
                    </div>
                    <p className="text-xs" style={{ color: "var(--text-secondary)" }}>Scan QR code or copy address below</p>
                  </div>

                  <div className="p-4 rounded-lg" style={{ background: "var(--surface-2)", border: "1px solid var(--hairline)" }}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
                        {currency.value} deposit address
                      </span>
                      <QrCode className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
                    </div>
                    <div className="flex items-center gap-2">
                      <code
                        className="text-sm flex-1 break-all font-mono p-2 rounded"
                        style={{ color: "var(--brand)", background: "var(--surface-0)" }}
                      >
                        {DEPOSIT_ADDRESSES[currency.value]}
                      </code>
                      <Button
                        onClick={() => copyAddress(currency.value)}
                        variant="ghost"
                        size="sm"
                        className="shrink-0 h-10 px-3"
                        data-testid={`copy-address-btn-${currency.value.toLowerCase()}`}
                      >
                        {copiedAddress === currency.value ? (
                          <Check className="w-5 h-5" style={{ color: "var(--green)" }} />
                        ) : (
                          <Copy className="w-5 h-5" />
                        )}
                      </Button>
                    </div>
                  </div>

                  <Button
                    onClick={() => copyAddress(currency.value)}
                    className="w-full font-semibold"
                    style={{ background: "var(--brand)", color: "var(--on-brand)" }}
                  >
                    {copiedAddress === currency.value ? "Address copied" : `Copy ${currency.value} address`}
                  </Button>

                  <p className="text-xs text-center" style={{ color: "var(--text-muted)" }}>
                    Deposits typically confirm within 10-30 minutes depending on network congestion.
                  </p>
                </TabsContent>
              ))}
            </Tabs>
          </DialogContent>
        </Dialog>

        <Dialog open={withdrawDialogOpen} onOpenChange={setWithdrawDialogOpen}>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              className="font-semibold px-8"
              style={{ background: "var(--surface-1)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
              data-testid="withdraw-btn"
            >
              <ArrowUpRight className="w-4 h-4 mr-2" />
              Withdraw
            </Button>
          </DialogTrigger>
          <DialogContent
            className="max-w-md"
            style={{ background: "var(--surface-1)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
          >
            <DialogHeader>
              <DialogTitle style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Withdraw funds</DialogTitle>
            </DialogHeader>
            <div className="space-y-5 pt-4">
              <div className="space-y-2">
                <Label style={{ color: "var(--text-secondary)" }}>Currency</Label>
                <Select value={withdrawCurrency} onValueChange={setWithdrawCurrency}>
                  <SelectTrigger
                    style={{ background: "var(--surface-2)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
                    data-testid="withdraw-currency-select"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent style={{ background: "var(--surface-1)", borderColor: "var(--hairline)" }}>
                    {CURRENCIES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        <span style={{ color: c.tone }}>{c.value}</span>
                        <span className="text-xs ml-2" style={{ color: "var(--text-muted)" }}>({c.network.split(" ")[0]})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>Network: {getCurrencyInfo(withdrawCurrency).network}</p>
              </div>

              <div className="space-y-2">
                <Label style={{ color: "var(--text-secondary)" }}>Amount</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={withdrawAmount}
                  onChange={(e) => setWithdrawAmount(e.target.value)}
                  placeholder="0.00"
                  className="font-mono"
                  style={{ background: "var(--surface-2)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
                  data-testid="withdraw-amount-input"
                />
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Available: {user?.wallet_balance?.[withdrawCurrency]?.toFixed(6) || 0} {withdrawCurrency}
                </p>
              </div>

              <div className="space-y-2">
                <Label style={{ color: "var(--text-secondary)" }}>
                  Wallet address ({getCurrencyInfo(withdrawCurrency).network.split(" ")[0]})
                </Label>
                <Input
                  value={withdrawAddress}
                  onChange={(e) => setWithdrawAddress(e.target.value)}
                  placeholder="Enter destination address"
                  className="font-mono text-sm"
                  style={{ background: "var(--surface-2)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
                  data-testid="withdraw-address-input"
                />
              </div>

              <div className="p-3 rounded-lg" style={{ background: "var(--red-dim)", border: "1px solid var(--red)" }}>
                <p className="text-xs flex items-center gap-2" style={{ color: "var(--red)" }}>
                  <AlertTriangle className="w-4 h-4" />
                  Double-check the address and network. Wrong address means lost funds.
                </p>
              </div>

              <Button
                onClick={handleWithdraw}
                disabled={withdrawing}
                className="w-full font-semibold"
                style={{ background: "var(--brand)", color: "var(--on-brand)" }}
                data-testid="confirm-withdraw-btn"
              >
                {withdrawing ? "Processing\u2026" : "Submit withdrawal"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {loading ? (
        <div className="space-y-6">
          <SkeletonPanel rows={3} />
          <SkeletonPanel rows={2} />
        </div>
      ) : (
        <>
          {/* Deposit addresses quick view */}
          <div className="rounded-2xl p-6 mb-6" style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}>
            <h2 className="text-[16px] font-bold mb-4 flex items-center gap-2" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              <QrCode className="w-4 h-4" style={{ color: "var(--brand)" }} />
              Deposit addresses
            </h2>
            <div className="space-y-2.5">
              {CURRENCIES.map((currency) => (
                <div key={currency.value} className="flex items-center justify-between p-3 rounded-lg" style={{ background: "var(--surface-2)" }}>
                  <div className="flex items-center gap-3">
                    <span className="text-xl" style={{ color: currency.tone }}>{currency.symbol}</span>
                    <div>
                      <p className="font-semibold text-sm">{currency.value}</p>
                      <p className="text-xs" style={{ color: "var(--text-muted)" }}>{currency.network}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-mono hidden md:block" style={{ color: "var(--text-secondary)" }}>
                      {DEPOSIT_ADDRESSES[currency.value].slice(0, 12)}...{DEPOSIT_ADDRESSES[currency.value].slice(-8)}
                    </code>
                    <Button onClick={() => copyAddress(currency.value)} variant="ghost" size="sm">
                      {copiedAddress === currency.value ? (
                        <Check className="w-4 h-4" style={{ color: "var(--green)" }} />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Transaction history */}
          <div className="rounded-2xl overflow-hidden mb-6" style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}>
            <div className="px-5 pt-[18px] pb-3.5">
              <h2 className="text-[16px] font-bold" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Transaction history</h2>
            </div>
            {transactions.length === 0 ? (
              <div className="px-5 pb-10 text-center" style={{ borderTop: "1px solid var(--hairline)" }}>
                <Clock className="w-10 h-10 mx-auto my-4" style={{ color: "var(--text-muted)" }} />
                <p style={{ color: "var(--text-secondary)" }}>No transactions yet</p>
              </div>
            ) : (
              transactions.map((tx) => {
                const isPositive = tx.tx_type === "deposit" || tx.tx_type === "win" || tx.tx_type === "refund" || tx.tx_type === "credits_purchase_refund";
                return (
                  <div key={tx.tx_id} className="flex items-center justify-between px-5 py-3.5" style={{ borderTop: "1px solid var(--hairline)" }} data-testid={`tx-${tx.tx_id}`}>
                    <div className="flex items-center gap-3.5">
                      <div className="w-9 h-9 rounded-[9px] flex items-center justify-center" style={{ background: "var(--surface-2)" }}>
                        {getTransactionIcon(tx.tx_type)}
                      </div>
                      <div>
                        <p className="capitalize text-[14px] font-semibold">{getTransactionLabel(tx.tx_type)}</p>
                        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{new Date(tx.created_at).toLocaleDateString()}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-mono font-bold text-sm" style={{ color: isPositive ? "var(--green)" : "var(--red)" }}>
                        {isPositive ? "+" : ""}
                        {Math.abs(tx.amount).toFixed(tx.currency === "USDT" ? 2 : 6)} {tx.currency}
                      </p>
                      <p className="text-xs capitalize" style={{ color: "var(--text-muted)" }}>{tx.status}</p>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Withdrawal requests */}
          <div className="rounded-2xl overflow-hidden" style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}>
            <div className="flex items-center justify-between px-5 pt-[18px] pb-3.5">
              <h2 className="text-[16px] font-bold flex items-center gap-2" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                <ArrowUpRight className="w-4 h-4" style={{ color: "var(--brand)" }} />
                Withdrawal requests
              </h2>
              <Button onClick={fetchWithdrawals} variant="ghost" size="sm">Refresh</Button>
            </div>
            {withdrawals.length === 0 ? (
              <div className="px-5 pb-10 text-center" style={{ borderTop: "1px solid var(--hairline)" }}>
                <ArrowUpRight className="w-10 h-10 mx-auto my-4" style={{ color: "var(--text-muted)" }} />
                <p style={{ color: "var(--text-secondary)" }}>No withdrawal requests</p>
              </div>
            ) : (
              withdrawals.map((wd) => {
                const currencyInfo = getCurrencyInfo(wd.currency);
                const status = STATUS_STYLES[wd.status] || STATUS_STYLES.pending;
                return (
                  <div key={wd.withdrawal_id} className="px-5 py-3.5" style={{ borderTop: "1px solid var(--hairline)" }} data-testid={`withdrawal-${wd.withdrawal_id}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-[9px] flex items-center justify-center" style={{ background: "var(--surface-2)" }}>
                          <span style={{ color: currencyInfo.tone }}>{currencyInfo.symbol}</span>
                        </div>
                        <div>
                          <p className="font-mono font-bold text-sm">
                            {wd.amount.toFixed(wd.currency === "USDT" ? 2 : 6)} {wd.currency}
                          </p>
                          <p className="text-xs" style={{ color: "var(--text-muted)" }}>{new Date(wd.created_at).toLocaleString()}</p>
                        </div>
                      </div>
                      <span
                        className="px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase"
                        style={{ color: status.color, background: status.bg }}
                      >
                        {wd.status}
                      </span>
                    </div>
                    <div className="pl-[52px]">
                      <p className="text-xs font-mono break-all" style={{ color: "var(--text-secondary)" }}>&rarr; {wd.wallet_address}</p>
                      {wd.admin_note && <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Note: {wd.admin_note}</p>}
                      {wd.status === "pending" && (
                        <p className="text-xs mt-2 flex items-center gap-1" style={{ color: "var(--orange)" }}>
                          <Clock className="w-3 h-3" />
                          Awaiting admin confirmation
                        </p>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
