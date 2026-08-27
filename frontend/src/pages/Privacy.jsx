import BackButton from "@/components/layout/BackButton";

export default function Privacy() {
  return (
    <div className="max-w-4xl mx-auto">
      <BackButton />

      <div className="mt-8">
        <div className="sc-reveal-stagger mb-8">
          <h1 className="sc-reveal-item text-4xl font-bold mb-2">Privacy Policy</h1>
          <p className="sc-reveal-item" style={{ color: "var(--text-secondary)" }}>
            Last updated: August 14, 2026
          </p>
        </div>

        <div className="space-y-8">
          <section>
            <h2 className="text-2xl font-semibold mb-4">1. Introduction</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              Outpla ("we", "us", "our", or "Company") operates the Outpla website and mobile application. This page informs you of our policies regarding the collection, use, and disclosure of personal data when you use our Service and the choices you have associated with that data.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">2. Information Collection and Use</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              We collect several different types of information for various purposes to provide and improve our Service to you.
            </p>
            <h3 className="text-lg font-semibold mb-3 mt-4">Types of Data Collected:</h3>
            <ul style={{ color: "var(--text-secondary)" }} className="list-disc list-inside space-y-2 mb-4">
              <li>Personal Data: Username, email address, profile picture, chess rating, and gameplay statistics</li>
              <li>Usage Data: Pages visited, time spent on pages, and interactions with the Service</li>
              <li>Financial Data: Payment information processed through secure third-party payment providers</li>
              <li>Device Data: IP address, browser type, and device information</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">3. Use of Data</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              Outpla uses the collected data for various purposes:
            </p>
            <ul style={{ color: "var(--text-secondary)" }} className="list-disc list-inside space-y-2 mb-4">
              <li>To provide and maintain our Service</li>
              <li>To notify you about changes to our Service</li>
              <li>To allow you to participate in interactive features of our Service</li>
              <li>To provide customer support</li>
              <li>To gather analysis or valuable information so we can improve our Service</li>
              <li>To monitor the usage of our Service</li>
              <li>To detect, prevent and address technical and security issues</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">4. Security of Data</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              The security of your data is important to us, but remember that no method of transmission over the Internet or method of electronic storage is 100% secure. While we strive to use commercially acceptable means to protect your Personal Data, we cannot guarantee its absolute security.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">5. Changes to This Privacy Policy</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              We may update our Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page and updating the "Last updated" date at the top of this Privacy Policy.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">6. Contact Us</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              If you have any questions about this Privacy Policy, please contact us at privacy@outpla.com.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">7. GDPR and Data Subject Rights</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              If you are a resident of the European Economic Area (EEA), you have certain data protection rights. We aim to take reasonable steps to allow you to correct, amend, delete, or limit the use of your Personal Data.
            </p>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              You have the right to:
            </p>
            <ul style={{ color: "var(--text-secondary)" }} className="list-disc list-inside space-y-2 mb-4">
              <li>Request access to your Personal Data</li>
              <li>Request correction of inaccurate data</li>
              <li>Request erasure of your data</li>
              <li>Object to processing of your data</li>
              <li>Request restriction of processing</li>
              <li>Request data portability</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
