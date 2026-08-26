"use client";

// Notifications enable flow (FindIt pattern, iOS-aware): on iPhone, Web Push
// only works AFTER the app is added to the Home Screen — so this component
// walks that order: install first, then enable, then test.
import { useEffect, useState } from "react";
import { Bell, BellOff, Share } from "lucide-react";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function NotificationsSection() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [devices, setDevices] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tested, setTested] = useState(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      setIsIOS(/iPhone|iPad|iPod/.test(navigator.userAgent));
      setStandalone(
        window.matchMedia("(display-mode: standalone)").matches ||
          (navigator as { standalone?: boolean }).standalone === true
      );
      const ok = "serviceWorker" in navigator && "PushManager" in window;
      setSupported(ok);
      if (ok) {
        try {
          const reg = await navigator.serviceWorker.register("/sw.js");
          const sub = await reg.pushManager.getSubscription();
          setSubscribed(Boolean(sub));
        } catch {
          /* stays unsubscribed */
        }
      }
      const res = await fetch("/api/push");
      if (res.ok) setDevices(((await res.json()) as { devices: number }).devices);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const enable = async () => {
    setBusy(true);
    setError("");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notifications were blocked in the browser.");
      const { publicKey } = (await (await fetch("/api/push")).json()) as { publicKey: string | null };
      if (!publicKey) throw new Error("Push isn't configured on the server.");
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      const res = await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "subscribe", subscription: sub.toJSON() }),
      });
      if (!res.ok) throw new Error("Couldn't save the subscription.");
      setSubscribed(true);
      setDevices((d) => d + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't enable notifications.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setSubscribed(false);
      setDevices((d) => Math.max(0, d - 1));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    await fetch("/api/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "test" }),
    });
    setTested(true);
    setBusy(false);
  };

  if (supported === null) return <p className="text-xs text-faint">Checking…</p>;

  // iPhone Safari (not installed): push physically can't work yet — guide the install.
  if (isIOS && !standalone) {
    return (
      <div className="rounded-xl border border-edge bg-card px-3 py-2.5 text-xs text-muted">
        <p className="mb-1 flex items-center gap-1.5 font-semibold text-ink">
          <Share size={13} aria-hidden /> Add to Home Screen first
        </p>
        On iPhone, notifications only work for the installed app: tap
        <span className="font-semibold"> Share → Add to Home Screen</span>, open Secretary
        from the icon, then come back here to enable them.
      </div>
    );
  }

  if (!supported) {
    return <p className="text-xs text-muted">This browser doesn&rsquo;t support push notifications.</p>;
  }

  return (
    <div>
      <div className="flex items-center gap-3">
        {subscribed ? (
          <>
            <Bell size={16} className="flex-none text-ok" aria-hidden />
            <p className="min-w-0 flex-1 text-sm">
              On for this device
              {devices > 1 ? <span className="text-xs text-faint"> · {devices} devices total</span> : null}
            </p>
            <button
              onClick={() => void test()}
              disabled={busy}
              className="flex-none rounded-full bg-accent px-3.5 py-1.5 text-xs font-bold text-bg disabled:opacity-50"
            >
              {tested ? "Sent — check your phone" : "Send a test"}
            </button>
            <button
              onClick={() => void disable()}
              disabled={busy}
              title="Turn off on this device"
              className="flex-none rounded-full border border-edge px-3 py-1.5 text-xs text-muted hover:text-ink disabled:opacity-50"
            >
              <BellOff size={12} aria-hidden />
            </button>
          </>
        ) : (
          <>
            <BellOff size={16} className="flex-none text-muted" aria-hidden />
            <p className="min-w-0 flex-1 text-sm text-muted">Off on this device</p>
            <button
              onClick={() => void enable()}
              disabled={busy}
              className="flex-none rounded-full bg-accent px-4 py-1.5 text-xs font-bold text-bg disabled:opacity-50"
            >
              {busy ? "Enabling…" : "Enable notifications"}
            </button>
          </>
        )}
      </div>
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}
