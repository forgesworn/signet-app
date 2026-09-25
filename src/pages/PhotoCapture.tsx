import { useState, useRef, useCallback, useEffect } from 'react';
import type { SignetIdentity } from '../types';
import { uploadToBlossom, DEFAULT_BLOSSOM_URL } from '../lib/blossom';
import { encryptPhoto } from '../lib/photo-crypto';
import type { SigningBackend } from '../lib/signing-backend';

interface Props {
  identity: SignetIdentity;
  backend: SigningBackend;
  blossomConsent: boolean;
  onSetBlossomConsent: (consent: boolean) => Promise<void>;
  onUpdatePhoto: (photoHash: string, blossomUrl: string, photoKey: string) => Promise<void>;
  onBack: () => void;
  /** Default Blossom server from user preferences */
  defaultBlossomUrl?: string;
}

type Step = 'consent' | 'camera' | 'preview' | 'uploading' | 'done';

export function PhotoCapture({ identity, backend, blossomConsent, onSetBlossomConsent, onUpdatePhoto, onBack, defaultBlossomUrl }: Props) {
  const [step, setStep] = useState<Step>(blossomConsent ? 'camera' : 'consent');
  const [error, setError] = useState<string | null>(null);
  const [blossomUrl, setBlossomUrl] = useState(identity.blossomUrl || (defaultBlossomUrl ?? DEFAULT_BLOSSOM_URL));
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  }, []);

  const startCamera = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 640 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch {
      setError('Could not access camera. Please allow camera access.');
    }
  }, []);

  useEffect(() => {
    if (step === 'camera') {
      startCamera();
    }
    return () => stopCamera();
  }, [step, startCamera, stopCamera]);

  const handleConsent = () => {
    onSetBlossomConsent(true);
    setStep('camera');
  };

  const handleCapture = () => {
    if (!videoRef.current) return;
    const canvas = document.createElement('canvas');
    const video = videoRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        setCapturedBlob(blob);
        setPreviewUrl(URL.createObjectURL(blob));
        stopCamera();
        setStep('preview');
      },
      'image/jpeg',
      0.85,
    );
  };

  const handleRetake = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setCapturedBlob(null);
    setPreviewUrl(null);
    setStep('camera');
  };

  const handleUpload = async () => {
    if (!capturedBlob) return;
    setError(null);
    setStep('uploading');

    // Validate Blossom URL
    if (!/^https:\/\//i.test(blossomUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)([:\/]|$)/i.test(blossomUrl)) {
      setError('Blossom URL must use https://');
      setStep('preview');
      return;
    }

    try {
      // Encrypt the JPEG before uploading — Blossom only sees ciphertext
      const plainBytes = new Uint8Array(await capturedBlob.arrayBuffer());
      const { encryptedBlob, keyHex } = await encryptPhoto(plainBytes);
      const encryptedBlobObj = new Blob([encryptedBlob as BlobPart], { type: 'application/octet-stream' });
      const hash = await uploadToBlossom(encryptedBlobObj, blossomUrl, backend, blossomConsent);
      await onUpdatePhoto(hash, blossomUrl, keyHex);
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 200) : 'Upload failed');
      setStep('preview');
    }
  };

  // Cleanup preview URL on unmount
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  return (
    <div className="fade-in" role="main" style={{ maxWidth: 480, margin: '0 auto', width: '100%' }}>

      {/* Consent */}
      {step === 'consent' && (
        <div className="section">
          <h2 style={{ marginBottom: 8 }}>Photo for venue entry</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 16 }}>
            Your photo is encrypted on your device before uploading to Blossom. The decryption key
            is included in your venue entry QR, which expires every 30 seconds. The steward sees your
            photo at the gate, then the key is gone.
          </p>
          <div className="card" style={{ marginBottom: 16, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            <div style={{ marginBottom: 8 }}>
              <strong>Blossom never sees your photo.</strong> Only encrypted data is stored.
              Without the key, the file is unreadable.
            </div>
            <div>
              <strong>You control access.</strong> Delete your photo any time and the encrypted
              blob becomes permanently unreadable.
            </div>
          </div>
          <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleConsent}>
            I understand — continue
          </button>
        </div>
      )}

      {/* Camera */}
      {step === 'camera' && (
        <div className="section">
          <h2 style={{ marginBottom: 8 }}>Take a selfie</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 16 }}>
            Hold at arm's length. Remove sunglasses. Ensure good lighting.
          </p>

          <div style={{
            position: 'relative',
            width: '100%',
            maxWidth: 360,
            margin: '0 auto 16px',
            borderRadius: 'var(--radius)',
            overflow: 'hidden',
            background: '#000',
            aspectRatio: '1',
          }}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                transform: 'scaleX(-1)',
              }}
            />
          </div>

          {error && (
            <div style={{
              marginBottom: 16,
              padding: '10px 14px',
              background: 'var(--bg-input)',
              border: '1px solid var(--danger)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 13,
              color: 'var(--danger)',
            }}>
              {error}
            </div>
          )}

          <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleCapture}>
            Capture
          </button>
        </div>
      )}

      {/* Preview */}
      {step === 'preview' && previewUrl && (
        <div className="section">
          <h2 style={{ marginBottom: 8 }}>Review photo</h2>

          <div style={{
            width: '100%',
            maxWidth: 360,
            margin: '0 auto 16px',
            borderRadius: 'var(--radius)',
            overflow: 'hidden',
          }}>
            <img
              src={previewUrl}
              alt="Captured selfie"
              style={{ width: '100%', display: 'block', transform: 'scaleX(-1)' }}
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
              Blossom server
            </label>
            <input
              className="input"
              type="url"
              value={blossomUrl}
              onChange={e => setBlossomUrl(e.target.value.slice(0, 256))}
              placeholder="https://blossom.example.com"
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
          </div>

          {error && (
            <div style={{
              marginBottom: 16,
              padding: '10px 14px',
              background: 'var(--bg-input)',
              border: '1px solid var(--danger)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 13,
              color: 'var(--danger)',
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleUpload}>
              Upload to Blossom
            </button>
            <button className="btn btn-secondary" style={{ width: '100%' }} onClick={handleRetake}>
              Retake
            </button>
          </div>
        </div>
      )}

      {/* Uploading */}
      {step === 'uploading' && (
        <div className="section" style={{ textAlign: 'center', padding: '48px 0' }}>
          <div style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            border: '3px solid var(--border)',
            borderTopColor: 'var(--accent)',
            animation: 'spin 1s linear infinite',
            margin: '0 auto 16px',
          }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Encrypting and uploading...
          </span>
        </div>
      )}

      {/* Done */}
      {step === 'done' && (
        <div className="section" style={{ textAlign: 'center' }}>
          <div style={{
            width: 64,
            height: 64,
            borderRadius: '50%',
            background: 'var(--success)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 28,
            margin: '0 auto 20px',
          }}>
            &#10003;
          </div>
          <h2 style={{ marginBottom: 8 }}>Photo uploaded</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 24 }}>
            Your encrypted photo is on Blossom. The decryption key will be included in each venue entry QR.
          </p>
          <button className="btn btn-primary" style={{ width: '100%' }} onClick={onBack}>
            Back to venue entry
          </button>
        </div>
      )}
    </div>
  );
}
