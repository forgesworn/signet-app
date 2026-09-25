import type { IdentityDocument } from '../types';
import { Icon } from '../components/Icon';

interface Props {
  documents: IdentityDocument[];
  onAddDocument: () => void;
  onSelectDocument: (id: string) => void;
}

const DOC_TYPE_LABELS: Record<string, string> = {
  passport: 'Passport',
  driving_licence: 'Driving Licence',
  national_id: 'National ID',
  birth_certificate: 'Birth Certificate',
};

function docTypeLabel(documentType: string): string {
  return DOC_TYPE_LABELS[documentType] ?? documentType;
}

function docTypeIcon(documentType: string): string {
  switch (documentType) {
    case 'passport':
      return 'PP';
    case 'driving_licence':
      return 'DL';
    case 'national_id':
      return 'ID';
    case 'birth_certificate':
      return 'BC';
    default:
      return 'ID';
  }
}

function maskDocumentNumber(documentNumber: string): string {
  if (documentNumber.length <= 4) return documentNumber;
  return '•••• ' + documentNumber.slice(-4);
}

export function MyDocuments({ documents, onAddDocument, onSelectDocument }: Props) {
  if (documents.length === 0) {
    return (
      <div className="fade-in" role="main">
        <div className="empty-state">
          <div className="empty-state-icon"><Icon name="idCard" size={36} /></div>
          <h3 className="empty-state-title">No documents yet</h3>
          <p className="empty-state-text">
            Add your identity documents here. When you visit a verifier, they'll confirm what you've entered.
          </p>
          <button className="btn btn-primary" onClick={onAddDocument}>
            Add a document
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in" role="main">
      <div className="section">
        <div className="section-title">My Documents</div>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {documents.map((doc, i) => (
            <button
              key={doc.id}
              onClick={() => onSelectDocument(doc.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                width: '100%',
                padding: '14px 16px',
                background: 'none',
                border: 'none',
                borderBottom: i < documents.length - 1 ? '1px solid var(--border)' : 'none',
                cursor: 'pointer',
                textAlign: 'left',
                color: 'var(--text-primary)',
              }}
            >
              {/* Icon */}
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-card-alt)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  color: 'var(--text-muted)',
                  letterSpacing: '0.05em',
                  flexShrink: 0,
                }}
              >
                {docTypeIcon(doc.documentType)}
              </div>

              {/* Details */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>
                  {docTypeLabel(doc.documentType)}
                </div>
                <div
                  style={{
                    fontSize: '0.85rem',
                    color: 'var(--text-secondary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {doc.fullName}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 1 }}>
                  {maskDocumentNumber(doc.documentNumber)}
                </div>
              </div>

              {/* Country */}
              <div
                style={{
                  fontSize: '0.85rem',
                  color: 'var(--text-muted)',
                  flexShrink: 0,
                }}
              >
                {doc.country}
              </div>

              {/* Chevron */}
              <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', flexShrink: 0 }}>›</div>
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        <button className="btn btn-secondary" onClick={onAddDocument}>
          Add another document
        </button>
      </div>
    </div>
  );
}
