// In-app QR scanner. Needed on iPhone: the Camera app always opens links in Safari, whose storage
// is separate from the Home Screen app (which is the only place iOS delivers notifications).
import { html, useEffect, useRef, useState } from '../lib/ui.js';
import { Icon } from './common.js';
import { decodePairingFragment } from '../core/secure-channel.js';

let jsQrPromise;
function loadJsQr() {
  if (globalThis.jsQR) return Promise.resolve(globalThis.jsQR);
  if (!jsQrPromise) {
    jsQrPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../../vendor/jsqr/jsQR.js', import.meta.url).href;
      s.onload = () => (globalThis.jsQR ? resolve(globalThis.jsQR) : reject(new Error('QR decoder failed to load')));
      s.onerror = () => reject(new Error('QR decoder failed to load'));
      document.head.appendChild(s);
    });
  }
  return jsQrPromise;
}

export function extractFragment(text) {
  const i = String(text || '').indexOf('#');
  const frag = i >= 0 ? text.slice(i) : text;
  return decodePairingFragment(frag) ? frag : null;
}

export function QrScanner({ onResult, onClose }) {
  const video = useRef(null);
  const [error, setError] = useState(null);
  const [hint, setHint] = useState('Point your camera at the QR code on your computer');
  useEffect(() => {
    let stream;
    let stopped = false;
    let timer;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
    const found = (text) => {
      const frag = extractFragment(text);
      if (!frag) {
        setHint('That is not a Pocket Pilot pairing code');
        return false;
      }
      stopped = true;
      navigator.vibrate?.(30);
      onResult(frag);
      return true;
    };
    const tick = async () => {
      if (stopped) return;
      const v = video.current;
      try {
        if (v && v.readyState >= 2 && v.videoWidth) {
          if (detector) {
            const codes = await detector.detect(v);
            if (codes[0] && found(codes[0].rawValue)) return;
          } else {
            const jsQR = await loadJsQr();
            const scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
            canvas.width = Math.round(v.videoWidth * scale);
            canvas.height = Math.round(v.videoHeight * scale);
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            if (code && found(code.data)) return;
          }
        }
      } catch (err) {
        setError(err.message);
      }
      timer = setTimeout(tick, 200);
    };
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (stopped) return;
        video.current.srcObject = stream;
        await video.current.play().catch(() => {});
        tick();
      } catch (err) {
        setError(err.name === 'NotAllowedError' ? 'Camera access was denied. Allow it in your browser settings, or paste the link instead.' : `Camera unavailable: ${err.message}`);
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  return html`<div class="scanner" role="dialog" aria-label="Scan pairing QR code">
    <video ref=${video} playsinline muted autoplay></video>
    <div class="finder"><span></span></div>
    <div class="scanner-top"><button class="icon-btn" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button></div>
    <div class="scanner-hint">${error ? html`<div class="errpart">${error}</div>` : hint}</div>
  </div>`;
}
