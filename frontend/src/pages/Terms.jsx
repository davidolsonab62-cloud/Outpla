import BackButton from "@/components/layout/BackButton";

export default function Terms() {
  return (
    <div className="max-w-4xl mx-auto">
      <BackButton />

      <div className="mt-8">
        <div className="sc-reveal-stagger mb-8">
          <h1 className="sc-reveal-item text-4xl font-bold mb-2">Terms of Service</h1>
          <p className="sc-reveal-item" style={{ color: "var(--text-secondary)" }}>
            Last updated: August 14, 2026
          </p>
        </div>

        <div className="space-y-8">
          <section>
            <h2 className="text-2xl font-semibold mb-4">1. Agreement to Terms</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              By accessing and using Outpla, you accept and agree to be bound by the terms and provision of this agreement. If you do not agree to abide by the above, please do not use this service.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">2. Use License</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              Permission is granted to temporarily download one copy of the materials (information or software) on Outpla for personal, non-commercial transitory viewing only. This is the grant of a license, not a transfer of title, and under this license you may not:
            </p>
            <ul style={{ color: "var(--text-secondary)" }} className="list-disc list-inside space-y-2 mb-4">
              <li>Modifying or copying the materials</li>
              <li>Using the materials for any commercial purpose or for any public display</li>
              <li>Attempting to decompile or reverse engineer any software contained on Outpla</li>
              <li>Removing any copyright or other proprietary notations from the materials</li>
              <li>Transferring the materials to another person or "mirroring" the materials on any other server</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">3. Disclaimer</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              The materials on Outpla are provided on an 'as is' basis. Outpla makes no warranties, expressed or implied, and hereby disclaims and negates all other warranties including, without limitation, implied warranties or conditions of merchantability, fitness for a particular purpose, or non-infringement of intellectual property or other violation of rights.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">4. Limitations</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              In no event shall Outpla or its suppliers be liable for any damages (including, without limitation, damages for loss of data or profit, or due to business interruption) arising out of the use or inability to use the materials on Outpla.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">5. Accuracy of Materials</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              The materials appearing on Outpla could include technical, typographical, or photographic errors. Outpla does not warrant that any of the materials on its website are accurate, complete, or current. Outpla may make changes to the materials contained on its website at any time without notice.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">6. Links</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              Outpla has not reviewed all of the sites linked to its website and is not responsible for the contents of any such linked site. The inclusion of any link does not imply endorsement by Outpla of the site. Use of any such linked website is at the user's own risk.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">7. Modifications</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              Outpla may revise these terms of service for its website at any time without notice. By using this website, you are agreeing to be bound by the then current version of these terms of service.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">8. Governing Law</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              These terms and conditions are governed by and construed in accordance with the laws of the jurisdiction in which Outpla operates, and you irrevocably submit to the exclusive jurisdiction of the courts in that location.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">9. Contact Us</h2>
            <p style={{ color: "var(--text-secondary)" }} className="mb-4">
              If you have any questions about these Terms of Service, please contact us at support@outpla.com.
            </p>
          </section>
        </div>
      </div>
      </div>
  );
}
