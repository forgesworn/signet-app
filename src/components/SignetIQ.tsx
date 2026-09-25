import { useState } from 'react';
import type { IQBreakdownItem } from '../lib/badge-fetch';

interface SignetIQProps {
  score: number;
  breakdown?: IQBreakdownItem[];
}

const THRESHOLDS = [
  { value: 50, label: 'Peer-verified' },
  { value: 100, label: 'Passport-level' },
  { value: 150, label: 'Multi-professional' },
];

function getScoreColor(score: number): string {
  if (score < 50) return 'var(--danger)';
  if (score < 100) return 'var(--warning)';
  return 'var(--accent)';
}

export function SignetIQ({ score, breakdown }: SignetIQProps) {
  const clamped = Math.max(0, Math.min(200, score));
  const barColor = getScoreColor(clamped);
  const pct = Math.round((clamped / 200) * 100);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="card section">
      <div className="section-title">Signet IQ</div>

      {/* Large score number */}
      <div
        style={{
          fontSize: 48,
          fontWeight: 800,
          color: barColor,
          lineHeight: 1,
          marginBottom: 10,
        }}
      >
        {clamped}
        <span
          style={{
            fontSize: 16,
            fontWeight: 500,
            color: 'var(--text-muted)',
            marginLeft: 4,
          }}
        >
          / 200
        </span>
      </div>

      {/* Progress bar */}
      <div
        style={{
          height: 8,
          borderRadius: 4,
          background: 'var(--bg-input)',
          overflow: 'hidden',
          marginBottom: 6,
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 4,
            background: barColor,
            transition: 'width 0.4s ease, background 0.3s ease',
          }}
        />
      </div>
      <div
        style={{
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
          marginBottom: 8,
        }}
      >
        Trust score based on verification signals
      </div>

      {/* Explainer toggle */}
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          fontSize: '0.8rem',
          color: 'var(--accent)',
          cursor: 'pointer',
        }}
      >
        What does this mean?
      </button>

      {expanded && (
        <div style={{ marginTop: 12 }}>
          {/* Threshold markers */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginBottom: 12,
            }}
          >
            {THRESHOLDS.map((t) => (
              <div
                key={t.value}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                }}
              >
                <span style={{ fontSize: '0.85rem', fontWeight: 'bold' }}>
                  {t.value}
                </span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  {t.label}
                </span>
              </div>
            ))}
          </div>

          {/* Explanation */}
          <p
            style={{
              fontSize: '0.8rem',
              color: 'var(--text-secondary)',
              lineHeight: 1.5,
              margin: 0,
            }}
          >
            Signet IQ measures identity quality — how confident others can be
            that you are a real person. A score of 100 means the same confidence
            as someone checking your passport face-to-face. Scores above 100
            mean your identity is harder to fabricate than a government passport.
            Get verified by professionals or receive vouches from other Signet
            users to increase your score.
          </p>
        </div>
      )}

      {/* Score breakdown */}
      {breakdown && breakdown.length > 0 && (
        <div
          style={{
            borderTop: '1px solid var(--border)',
            paddingTop: 12,
            marginTop: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div
            style={{
              fontSize: '0.75rem',
              fontWeight: 600,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 4,
            }}
          >
            Score breakdown
          </div>
          {breakdown.map((item, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {item.label}
              </span>
              <span
                style={{
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  color: item.points > 0 ? 'var(--accent)' : 'var(--text-muted)',
                  whiteSpace: 'nowrap',
                }}
              >
                {item.points}/{item.max}
              </span>
            </div>
          ))}
          <div
            style={{
              borderTop: '1px solid var(--border)',
              paddingTop: 8,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
              Total
            </span>
            <span
              style={{
                fontSize: '0.85rem',
                fontWeight: 700,
                color: 'var(--accent)',
                whiteSpace: 'nowrap',
              }}
            >
              {Math.min(breakdown.reduce((acc, item) => acc + item.points, 0), 200)}/200
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
