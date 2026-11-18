"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface MorrowHeaderProps {
  home?: boolean;
}

const apiUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export default function MorrowHeader({ home = false }: MorrowHeaderProps) {
  const [isCustomer, setIsCustomer] = useState(false);
  const [accountError, setAccountError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function checkCustomerSession() {
      if (!apiUrl) {
        setAccountError(true);
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
          throw new Error("Could not check the signed-in account.");
        }
        const body: unknown = await response.json();
        if (
          !isRecord(body) ||
          !isRecord(body.user) ||
          !Array.isArray(body.user.roles) ||
          !body.user.roles.every((role) => typeof role === "string")
        ) {
          throw new Error("The account service returned an invalid response.");
        }
        setIsCustomer(body.user.roles.includes("customer"));
      } catch {
        if (!controller.signal.aborted) setAccountError(true);
      }
    }

    void checkCustomerSession();
    return () => controller.abort();
  }, []);

  return (
    <header className={home ? "site-header" : "catalog-header"}>
      <Link className="wordmark" href="/" aria-label="Morrow home">
        morrow<span>.</span>
      </Link>
      <nav className="main-nav" aria-label="Main navigation">
        {home ? (
          <>
            <a href="#discover">Discover</a>
            <a href="#about">Our approach</a>
          </>
        ) : (
          <Link href="/catalog">Collection</Link>
        )}
      </nav>
      <nav className="account-nav" aria-label="Account navigation">
        {isCustomer && (
          <>
            <Link className="account-nav-link" href="/account/orders">
              My Orders
            </Link>
            <Link className="account-nav-link" href="/cart">
              Your cart
            </Link>
          </>
        )}
        <Link className={home ? "account-link" : "account-nav-link"} href="/account">
          Your account <span aria-hidden="true">↗</span>
        </Link>
        {accountError && (
          <span className="header-account-status" role="status">
            Account status unavailable
          </span>
        )}
      </nav>
    </header>
  );
}
