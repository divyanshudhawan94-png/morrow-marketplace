"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

interface AccountUser {
  id: string;
  email?: string;
  mobileNumber?: string;
  roles: string[];
  storeId?: string;
}

interface SellerApplication {
  id: string;
  name: string;
  status: "pending" | "approved" | "rejected" | "suspended";
}

const apiUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readUserResponse(value: unknown): AccountUser {
  if (
    !isRecord(value) ||
    !isRecord(value.user) ||
    typeof value.user.id !== "string" ||
    (value.user.email !== undefined && typeof value.user.email !== "string") ||
    (value.user.mobileNumber !== undefined &&
      typeof value.user.mobileNumber !== "string") ||
    (typeof value.user.email !== "string" &&
      typeof value.user.mobileNumber !== "string") ||
    !Array.isArray(value.user.roles)
  ) {
    throw new Error("The account service returned an invalid response.");
  }
  const roles: string[] = [];
  for (const role of value.user.roles) {
    if (typeof role !== "string") {
      throw new Error("The account service returned an invalid response.");
    }
    roles.push(role);
  }
  return {
    id: value.user.id,
    ...(typeof value.user.email === "string" ? { email: value.user.email } : {}),
    ...(typeof value.user.mobileNumber === "string"
      ? { mobileNumber: value.user.mobileNumber }
      : {}),
    roles,
    ...(typeof value.user.storeId === "string" ? { storeId: value.user.storeId } : {}),
  };
}

function readApplicationResponse(value: unknown): SellerApplication | null {
  if (!isRecord(value)) {
    throw new Error("The account service returned an invalid store response.");
  }
  if (value.store === null) return null;
  if (
    !isRecord(value.store) ||
    typeof value.store.id !== "string" ||
    typeof value.store.name !== "string" ||
    (value.store.status !== "pending" &&
      value.store.status !== "approved" &&
      value.store.status !== "rejected" &&
      value.store.status !== "suspended")
  ) {
    throw new Error("The account service returned an invalid store response.");
  }
  return {
    id: value.store.id,
    name: value.store.name,
    status: value.store.status,
  };
}

async function getErrorMessage(response: Response): Promise<string> {
  if (
    response.headers.get("content-type")?.includes("application/json")
  ) {
    const result: unknown = await response.json();
    if (isRecord(result) && typeof result.error === "string") return result.error;
  }
  return "The request could not be completed.";
}

export default function AccountPage() {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [application, setApplication] = useState<SellerApplication | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    async function loadAccount() {
      if (!apiUrl) {
        setError("The account service is not configured.");
        setCheckingSession(false);
        return;
      }
      try {
        const response = await fetch(`${apiUrl}/auth/me`, {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) return;
        if (!response.ok) {
          throw new Error(await getErrorMessage(response));
        }

        const accountUser = readUserResponse(await response.json());
        setUser(accountUser);

        if (accountUser.roles.includes("customer")) {
          const storeResponse = await fetch(`${apiUrl}/seller/application`, {
            credentials: "include",
            cache: "no-store",
            signal: controller.signal,
          });
          if (!storeResponse.ok) {
            throw new Error(await getErrorMessage(storeResponse));
          }
          setApplication(readApplicationResponse(await storeResponse.json()));
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not connect to the account service.",
          );
        }
      } finally {
        if (!controller.signal.aborted) setCheckingSession(false);
      }
    }

    void loadAccount();
    return () => controller.abort();
  }, []);

  async function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiUrl) {
      setError("The account service is not configured.");
      return;
    }
    setSubmitting(true);
    setError("");
    setNotice("");
    const formData = new FormData(event.currentTarget);

    try {
      const response = await fetch(`${apiUrl}/auth/${mode === "login" ? "login" : "register"}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: formData.get("email"),
          password: formData.get("password"),
        }),
      });
      if (!response.ok) {
        setError(await getErrorMessage(response));
        return;
      }

      const accountUser = readUserResponse(await response.json());
      setUser(accountUser);
      setNotice(mode === "register" ? "Your account is ready." : "You are signed in.");

      if (accountUser.roles.includes("customer")) {
        const storeResponse = await fetch(`${apiUrl}/seller/application`, {
          credentials: "include",
          cache: "no-store",
        });
        if (storeResponse.ok) {
          setApplication(readApplicationResponse(await storeResponse.json()));
        }
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not connect to the account service. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogout() {
    if (!apiUrl) {
      setError("The account service is not configured.");
      return;
    }
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${apiUrl}/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        setError(await getErrorMessage(response));
        return;
      }
      setUser(null);
      setApplication(null);
      setNotice("You are signed out.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not connect to the account service. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSellerApplication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiUrl) {
      setError("The account service is not configured.");
      return;
    }
    setSubmitting(true);
    setError("");
    setNotice("");
    const formData = new FormData(event.currentTarget);

    try {
      const response = await fetch(`${apiUrl}/seller/application`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: formData.get("storeName") }),
      });
      if (!response.ok) {
        setError(await getErrorMessage(response));
        return;
      }
      const submittedStore = readApplicationResponse(await response.json());
      if (!submittedStore) {
        throw new Error("The account service returned an invalid store response.");
      }
      setApplication(submittedStore);
      setUser((current) =>
        current ? { ...current, storeId: submittedStore.id } : current,
      );
      setNotice("Application received. Complete business verification before store approval.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not connect to the account service. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="account-page">
      <header className="account-header">
        <Link className="wordmark" href="/">morrow<span>.</span></Link>
        <Link className="button button-dark dashboard-home-link" href="/">Home</Link>
      </header>

      <section className="account-panel" aria-labelledby="account-title">
        <p className="eyebrow">YOUR MORROW ACCOUNT</p>
        {checkingSession ? (
          <p className="account-description" role="status">Checking your account…</p>
        ) : user ? (
          <>
            <h1 id="account-title">Good to see you.</h1>
            <p className="account-description">{user.email ?? user.mobileNumber}</p>
            <div className="role-list" aria-label="Account roles">
              {user.roles.map((role) => <span className="role-chip" key={role}>{role.replace("_", " ")}</span>)}
            </div>

            {user.roles.includes("customer") && (
              <div className="account-order-links">
                <Link className="account-dashboard-link" href="/account/orders">View your orders ↗</Link>
                <Link className="account-dashboard-link" href="/cart">Open your cart ↗</Link>
              </div>
            )}

            {user.roles.includes("customer") && (
              <div className="seller-box">
                <h2>Have a store of your own?</h2>
                {application ? (
                  <p className="application-status">
                    <span className={`status-dot status-${application.status}`}></span>
                    {application.name} — {application.status}
                  </p>
                ) : (
                  <form className="account-form" onSubmit={handleSellerApplication}>
                    <label htmlFor="storeName">Store name</label>
                    <input id="storeName" name="storeName" required minLength={2} maxLength={80} />
                    <button className="button button-dark" type="submit" disabled={submitting || !apiUrl}>
                      {submitting ? "Sending…" : "Apply to sell"} <span aria-hidden="true">↗</span>
                    </button>
                  </form>
                )}
              </div>
            )}

            {user.roles.includes("super_admin") && (
              <p className="account-description">Administrative account. Privileged actions require server-side authorization.</p>
            )}
            {user.storeId && (
              <Link className="account-dashboard-link" href="/seller">Open seller verification and store space ↗</Link>
            )}
            {user.roles.includes("super_admin") && (
              <Link className="account-dashboard-link" href="/admin">Open administration ↗</Link>
            )}
            <button className="text-button" type="button" onClick={handleLogout} disabled={submitting || !apiUrl}>
              Sign out
            </button>
          </>
        ) : (
          <>
            <h1 id="account-title">{mode === "login" ? "Welcome back." : "Make yourself at home."}</h1>
            <p className="account-description">
              {mode === "login"
                ? "Sign in to keep your good finds close."
                : "Create an account to start your Morrow story."}
            </p>
            <form className="account-form" onSubmit={handleAuth}>
              <label htmlFor="email">Email address</label>
              <input id="email" name="email" type="email" autoComplete="email" required maxLength={254} />
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                minLength={mode === "register" ? 12 : 1}
                maxLength={128}
              />
              {mode === "register" && <p className="form-hint">Use at least 12 characters.</p>}
              <button className="button button-dark" type="submit" disabled={submitting || !apiUrl}>
                {submitting
                  ? "One moment…"
                  : mode === "login"
                    ? "Sign in"
                    : "Create account"}
                <span aria-hidden="true">↗</span>
              </button>
            </form>
            <p className="mode-switch">
              {mode === "login" ? "New to Morrow?" : "Already have an account?"}{" "}
              <button
                type="button"
                onClick={() => {
                  setMode(mode === "login" ? "register" : "login");
                  setError("");
                }}
              >
                {mode === "login" ? "Create an account" : "Sign in"}
              </button>
            </p>
            {mode === "login" && (
              <p className="mode-switch">
                Customer? <Link href="/login">Sign in with mobile OTP</Link>
              </p>
            )}
          </>
        )}
        {error && <p className="form-message form-error" role="alert">{error}</p>}
        {notice && <p className="form-message form-notice" role="status">{notice}</p>}
      </section>

      <footer className="account-footer">Thoughtful finds. Independent minds.</footer>
    </main>
  );
}
