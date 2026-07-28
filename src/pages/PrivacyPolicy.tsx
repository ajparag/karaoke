// =============================================================================
// PrivacyPolicy.tsx — Privacy Policy page
// =============================================================================
// CHANGELOG
// v1 — NEW. Static content page describing what KaraokeParty collects and
//   why, based on the app's actual data flows: Supabase auth, real-time mic
//   analysis (never recorded/stored), score submission, party mode, IP-based
//   geolocation for anonymous users, and third-party services (Modal for
//   vocal separation, Google Sign-In, JioSaavn/Gaana/YouTube for search).
//
//   NOT LEGAL ADVICE. Placeholders marked [BRACKETS] need to be filled in
//   (legal entity name, jurisdiction, contact email, effective date) and the
//   whole document should get a lawyer's review before going live —
//   especially the retention and children's-privacy sections, and whether
//   GDPR/CCPA-specific language is required for your user base.
// =============================================================================

import { Link } from 'react-router-dom';
import { ArrowLeft, Mic } from 'lucide-react';

// ─── Content data ───────────────────────────────────────────────────────────
// Kept as data rather than inline JSX so the copy is easy to review/edit
// independently of the layout.

interface Section {
  heading: string;
  body: (string | { subheading: string; items: string[] })[];
}

const EFFECTIVE_DATE = '1st August 2026';
const LEGAL_ENTITY = 'Padmajak Innovations';
const CONTACT_EMAIL = 'parag.airun@gmail.com';

const sections: Section[] = [
  {
    heading: '1. Introduction',
    body: [
      `This Privacy Policy explains how KaraokeParty ("we", "us", operated by ${LEGAL_ENTITY}) collects, uses, and protects information when you use karaokeparty.in (the "Service"). By using the Service, you agree to the practices described here.`,
      `Last updated: ${EFFECTIVE_DATE}.`,
    ],
  },
  {
    heading: '2. Information We Collect',
    body: [
      {
        subheading: 'Account information',
        items: [
          'If you sign in with email and password: your email address and a chosen username.',
          'If you sign in with Google: your name, email address, and profile picture, as provided by Google.',
          'You can use most of the Service without an account — search, sing, and get scored — but signing in lets your scores count toward your personal history and the public leaderboard under your name.',
        ],
      },
      {
        subheading: 'Microphone audio',
        items: [
          'When you sing, we access your microphone to analyse pitch, timing, and vocal characteristics in real time, entirely in your browser.',
          'Your voice is never recorded, uploaded, or stored — the analysis happens live and only the resulting numeric score is kept.',
          'You can deny or revoke microphone access at any time through your browser settings; scoring simply won\'t work without it.',
        ],
      },
      {
        subheading: 'Performance and score data',
        items: [
          'Song title, artist, and the score, rating, and accuracy/flow/expression breakdown for each performance.',
          'How much of the song you sang and technical signals like background noise level — used only to improve and calibrate the scoring system over time.',
          'The display name you choose to appear on the leaderboard for each score, which you can set per performance.',
        ],
      },
      {
        subheading: 'Location',
        items: [
          'If you submit a score without an account, we estimate your city and country from your IP address using a third-party geolocation service, and store that with the score to show on the leaderboard.',
          'We do not store your raw IP address once a signed-in submission is linked to your account; for anonymous submissions it is kept briefly to prevent duplicate/abusive submissions.',
        ],
      },
      {
        subheading: 'Party mode',
        items: [
          'If you host or join a party: the party name, join code, songs added, and the name entered by each participant.',
          'A random identifier is stored in your browser (not tied to your identity) so the app can tell which songs in a shared queue you personally added.',
        ],
      },
      {
        subheading: 'Local device storage',
        items: [
          'Separated audio stems (instrumental/vocals) for songs you\'ve sung are cached on your own device using your browser\'s local storage, so replaying a song is instant and doesn\'t reprocess audio. This cache never leaves your device.',
          'Lyrics for recently viewed songs are cached locally in the same way.',
        ],
      },
    ],
  },
  {
    heading: '3. How We Use Your Information',
    body: [
      'To provide the core Service: searching songs, separating vocals, scoring your singing, and showing results.',
      'To operate the public and party leaderboards.',
      'To improve scoring accuracy over time using aggregated, anonymised performance signals.',
      'To detect abuse (e.g. spam submissions) and keep the Service reliable.',
      'To communicate with you about your account, if you\'ve signed up (e.g. password reset emails).',
    ],
  },
  {
    heading: '4. Third-Party Services We Use',
    body: [
      'We rely on a small number of third-party services to run KaraokeParty. Each only receives the minimum data needed to do its job:',
      {
        subheading: '',
        items: [
          'Supabase — our backend provider, hosting your account data, scores, and party data in a managed database.',
          'Google Sign-In — if you choose to sign in with Google, Google handles authentication and shares your name, email, and profile picture with us.',
          'Modal — processes song audio (which you or another user searched for) to separate vocals from instrumentals using GPU computation. Audio is processed and discarded; we don\'t control Modal\'s own retention beyond the processing window.',
          'JioSaavn, Gaana, and YouTube — used as search and streaming sources to find and play the songs you search for. Your search queries are sent to whichever source is used.',
          'A geolocation service — used only to estimate city/country from IP address for anonymous score submissions, as described above.',
        ],
      },
      'We do not sell your personal information to anyone, and we do not run third-party advertising on the Service.',
    ],
  },
  {
    heading: '5. Cookies and Local Storage',
    body: [
      'We use your browser\'s local storage and session storage to keep you signed in, remember your theme preference (light/dark), cache audio and lyrics for performance, and carry information between pages during a session (e.g. which song you selected).',
      'We don\'t use third-party advertising or tracking cookies.',
    ],
  },
  {
    heading: '6. Data Retention and Deletion',
    body: [
      'Account data and scores are kept for as long as your account is active.',
      'If you\'re signed in, you can delete individual scores from your History page at any time.',
      `To delete your account entirely, or to request a copy of your data, contact us at ${CONTACT_EMAIL}.`,
      'Locally cached audio and lyrics can be cleared at any time by clearing your browser\'s site data for karaokeparty.in.',
    ],
  },
  {
    heading: '7. Children\'s Privacy',
    body: [
      'KaraokeParty is intended for general audiences and is not directed at children under 13 (or the relevant minimum age in your jurisdiction). We do not knowingly collect personal information from children under that age. If you believe a child has provided us with personal information, please contact us and we will remove it.',
    ],
  },
  {
    heading: '8. Your Rights and Choices',
    body: [
      'You can use the Service anonymously without ever creating an account.',
      'You can choose what display name (if any) appears on the leaderboard for each score.',
      'You can delete individual scores, or your entire account, at any time.',
      'You can deny microphone access, though this will prevent scoring from working.',
      `Depending on where you live, you may have additional rights over your personal data (such as access, correction, or portability) under laws like GDPR or CCPA. To exercise these, contact us at ${CONTACT_EMAIL}.`,
    ],
  },
  {
    heading: '9. Security',
    body: [
      'We use industry-standard practices to protect your data, including encrypted connections (HTTPS) and access controls on our database. No method of transmission or storage is 100% secure, and we can\'t guarantee absolute security.',
    ],
  },
  {
    heading: '10. Changes to This Policy',
    body: [
      'We may update this policy from time to time. If we make material changes, we\'ll update the "Last updated" date above and, where appropriate, notify signed-in users.',
    ],
  },
  {
    heading: '11. Contact Us',
    body: [
      `Questions about this policy or your data? Reach us at ${CONTACT_EMAIL}.`,
    ],
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-background">
      <header className="glass border-b border-border p-4 sticky top-0 z-50">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <Link to="/"><button className="p-2 rounded-full hover:bg-muted transition-colors" aria-label="Back to home"><ArrowLeft className="w-5 h-5" /></button></Link>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg gradient-primary flex items-center justify-center shrink-0">
              <Mic className="w-3.5 h-3.5 text-primary-foreground" />
            </div>
            <h1 className="font-semibold text-base">Privacy Policy</h1>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-4 md:p-6 space-y-6">

        <p className="text-sm text-muted-foreground leading-relaxed">
          KaraokeParty lets you sing along to any song, get scored by AI, and compete on
          leaderboards — solo or with friends in a party. This page explains what
          information we collect to make that work, and how it's used.
        </p>

        {sections.map((section) => (
          <section key={section.heading} className="rounded-2xl border border-border bg-card p-4 md:p-5">
            <h2 className="font-semibold text-base mb-3">{section.heading}</h2>
            <div className="space-y-3">
              {section.body.map((item, i) =>
                typeof item === 'string' ? (
                  <p key={i} className="text-sm text-muted-foreground leading-relaxed">{item}</p>
                ) : (
                  <div key={i}>
                    {item.subheading && (
                      <p className="text-sm font-medium text-foreground mb-1.5">{item.subheading}</p>
                    )}
                    <ul className="space-y-1.5 list-disc list-outside pl-4">
                      {item.items.map((line, j) => (
                        <li key={j} className="text-sm text-muted-foreground leading-relaxed">{line}</li>
                      ))}
                    </ul>
                  </div>
                )
              )}
            </div>
          </section>
        ))}

        <p className="text-xs text-muted-foreground/60 text-center pb-4">
          KaraokeParty · karaokeparty.in
        </p>

      </main>
    </div>
  );
}
