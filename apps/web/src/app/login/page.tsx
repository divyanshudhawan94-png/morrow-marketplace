"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

const apiUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function getErrorMessage(response: Response): Promise<string> {
  if (response.headers.get("content-type")?.includes("application/json")) {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.error === "string") return body.error;
  }
  return "The request could not be completed.";
}

function safeDestination(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/cart";
  }
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return "/cart";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/cart";
  }
}

function secondsRemaining(timestamp: string | null, now: number): number {
  if (!timestamp) return 0;
  const remaining = Math.ceil((Date.parse(timestamp) - now) / 1000);
  return Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
}

export default function CustomerMobileLoginPage() {
  const [mobileNumber, setMobileNumber] = useState("");
  const [otp, setOtp] = useState("");
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [resendAvailableAt, setResendAvailableAt] = useState<string | null>(null);
  const [destination, setDestination] = useState("/cart");
  const [now, setNow] = useState(Date.now());
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setDestination(safeDestination(new URLSearchParams(window.location.search).get("next")));
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const codeExpiresIn = secondsRemaining(expiresAt, now);
  const canResendIn = secondsRemaining(resendAvailableAt, now);

  async function requestCode(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!apiUrl) {
      setError("The account service is not configured.");
      return;
    }
    if (!/^[6-9]\d{9}$/.test(mobileNumber)) {
      setError("Enter a valid 10-digit Indian mobile number.");
      return;
    }
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${apiUrl}/auth/customer-otp`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobileNumber }),
      });
      if (!response.ok) throw new Error(await getErrorMessage(response));
      const body: unknown = await response.json();
      if (
        !isRecord(body) ||
        typeof body.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(body.expiresAt)) ||
        typeof body.resendAvailableAt !== "string" ||
        !Number.isFinite(Date.parse(body.resendAvailableAt))
      ) {
        throw new Error("The login service returned an invalid response.");
      }
      setExpiresAt(body.expiresAt);
      setResendAvailableAt(body.resendAvailableAt);
      setOtp("");
      setNotice("If this number can use customer mobile login, a code has been issued.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not request a verification code.");
    } finally {
      setWorking(false);
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiUrl) {
      setError("The account service is not configured.");
      return;
    }
    if (!/^\d{6}$/.test(otp)) {
      setError("Enter the six-digit verification code.");
      return;
    }
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${apiUrl}/auth/customer-otp/verify`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobileNumber, otp }),
      });
      if (!response.ok) throw new Error(await getErrorMessage(response));
      window.location.assign(destination);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not verify the code.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <main className="account-page">
      <header className="account-header">
        <Link className="wordmark" href="/">morrow<span>.</span></Link>
        <Link className="text-link" href="/account">Email sign in ↗</Link>
      </header>
      <section className="account-panel" aria-labelledby="mobile-login-title">
        <p className="eyebrow">CUSTOMER SIGN IN</p>
        <h1 id="mobile-login-title">{expiresAt ? "Check your phone." : "Welcome to Morrow."}</h1>
        <p className="account-description">
          Sign in or create your customer account with a one-time code sent to your Indian mobile number.
        </p>
        {!expiresAt ? (
          <form className="account-form" onSubmit={(event) => void requestCode(event)}>
            <label htmlFor="mobileNumber">10-digit Indian mobile number</label>
            <input
              id="mobileNumber"
              name="mobileNumber"
              type="tel"
              autoComplete="tel-national"
              inputMode="numeric"
              pattern="[6-9][0-9]{9}"
              maxLength={10}
              required
              value={mobileNumber}
              onChange={(event) => setMobileNumber(event.target.value.replace(/\D/g, "").slice(0, 10))}
            />
            <button className="button button-dark" type="submit" disabled={working || !apiUrl}>
              {working ? "Requesting code…" : "Continue with mobile"} <span aria-hidden="true">↗</span>
            </button>
          </form>
        ) : (
          <form className="account-form" onSubmit={(event) => void verifyCode(event)}>
            <p className="account-description">Enter the code for +91 {mobileNumber}.</p>
            <label htmlFor="otp">6-digit verification code</label>
            <input
              id="otp"
              name="otp"
              type="text"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={otp}
              onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))}
            />
            <p className="form-hint" role="status">
              {codeExpiresIn > 0
                ? `Code expires in ${Math.floor(codeExpiresIn / 60)}:${String(codeExpiresIn % 60).padStart(2, "0")}.`
                : "This code has expired. Request a new one to continue."}
            </p>
            <button
              className="button button-dark"
              type="submit"
              disabled={working || !apiUrl || codeExpiresIn === 0}
            >
              {working ? "Verifying…" : "Verify and continue"} <span aria-hidden="true">↗</span>
            </button>
            <button
              className="text-button"
              type="button"
              disabled={working || canResendIn > 0}
              onClick={() => void requestCode()}
            >
              {canResendIn > 0
                ? `Request another code in ${canResendIn}s`
                : "Request another code"}
            </button>
            <button
              className="text-button"
              type="button"
              disabled={working}
              onClick={() => {
                setExpiresAt(null);
                setResendAvailableAt(null);
                setOtp("");
                setError("");
                setNotice("");
              }}
            >
              Use a different mobile number
            </button>
          </form>
        )}
        {error && <p className="form-message form-error" role="alert">{error}</p>}
        {notice && <p className="form-message form-notice" role="status">{notice}</p>}
      </section>
      <footer className="account-footer">Thoughtful finds. Independent minds.</footer>
    </main>
  );
}
