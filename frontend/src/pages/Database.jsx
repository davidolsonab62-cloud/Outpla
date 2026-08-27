import { Database as DatabaseIcon, Users, Trophy, BarChart3 } from "lucide-react";
import BackButton from "@/components/layout/BackButton";

export default function DatabaseInfo() {
  const stats = [
    { icon: Users, label: "Active Players", value: "25,000+" },
    { icon: Trophy, label: "Games Played", value: "500,000+" },
    { icon: BarChart3, label: "Rating Range", value: "800-2800 ELO" },
    { icon: DatabaseIcon, label: "Database Records", value: "1M+" },
  ];

  return (
    <div className="max-w-4xl mx-auto">
      <BackButton />

      <div className="mt-8">
        <div className="sc-reveal-stagger mb-8">
          <h1 className="sc-reveal-item text-4xl font-bold mb-2">Outpla Database</h1>
          <p className="sc-reveal-item" style={{ color: "var(--text-secondary)" }}>
            Comprehensive chess game library and player statistics
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-12">
          {stats.map((stat, i) => {
            const Icon = stat.icon;
            return (
              <div
                key={i}
                className="rounded-lg border border-hair bg-surface-1 p-4 text-center"
              >
                <Icon className="w-6 h-6 mx-auto mb-2" style={{ color: "var(--brand)" }} />
                <p style={{ color: "var(--text-secondary)" }} className="text-sm mb-1">
                  {stat.label}
                </p>
                <p className="text-2xl font-bold text-[#D4AF37]">{stat.value}</p>
              </div>
            );
          })}
        </div>

        <div className="space-y-8">
          <section>
            <h2 className="text-2xl font-semibold mb-4">Database Overview</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              Outpla maintains a comprehensive database of chess games played on our platform. This database includes:
            </p>
            <ul style={{ color: "var(--text-secondary)" }} className="list-disc list-inside space-y-2 mb-4">
              <li>Complete game records with move sequences and timestamps</li>
              <li>Player profiles with ratings and statistics</li>
              <li>Tournament results and leaderboards</li>
              <li>Opening repertoires and analysis</li>
              <li>Puzzle solutions and performance metrics</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">Data Access</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              Players can access their own game data through their profile and dashboard. Advanced analytics include:
            </p>
            <ul style={{ color: "var(--text-secondary)" }} className="list-disc list-inside space-y-2 mb-4">
              <li>Win/loss statistics by time control</li>
              <li>Performance rating evolution</li>
              <li>Opening success rates</li>
              <li>Head-to-head records</li>
              <li>Puzzle solving progress</li>
              <li>Tournament performance history</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">Data Retention</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              We retain game data indefinitely to maintain the integrity of player ratings and historical records. Players can request data deletion for their account, which will be handled according to our privacy policy.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">PGN Export</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              Players can export their games in standard PGN (Portable Game Notation) format for analysis in external chess engines and databases. This allows for deeper analysis and study of your games.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">Rating System</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              Outpla uses the Glicko-2 rating system, which takes into account:
            </p>
            <ul style={{ color: "var(--text-secondary)" }} className="list-disc list-inside space-y-2 mb-4">
              <li>Win/loss results against rated opponents</li>
              <li>Rating deviation (uncertainty in the rating)</li>
              <li>Volatility (consistency of performance)</li>
              <li>Time since last rated game</li>
            </ul>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              Ratings are updated after each rated game and are recalculated weekly to maintain accuracy.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">Public Leaderboards</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              Outpla maintains public leaderboards for each time control (Blitz, Rapid, Classical) showing the top-rated players. These leaderboards are updated in real-time and reflect current player performance.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">API Access</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              Developers can access limited API endpoints to retrieve public game data and player statistics. Please visit our developer documentation for API specifications and rate limits.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">Contact Support</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              For questions about the database, data access, or API integration, please contact our support team at database@outpla.com.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
