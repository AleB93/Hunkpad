#!/usr/bin/env bash
# Builds the sample repository shown in demo mode: a small TypeScript shop
# backend with history, branches, tags, a remote, and uncommitted work.
# Usage: bash demo/make-repo.sh <folder>   (the folder is recreated)
set -euo pipefail
ROOT="$1"
rm -rf "$ROOT" && mkdir -p "$ROOT"
REPO="$ROOT/acme-store"
git init -q --bare -b main "$ROOT/origin.git"
git init -q -b main "$REPO"
cd "$REPO"
git config user.name "Sam Rivera"; git config user.email "sam@example.com"
git config commit.gpgsign false
git remote add origin "$ROOT/origin.git"

T=$(($(date +%s) - 9 * 86400))  # commit dates: the last 9 days, spaced out below
commit() { # commit <author> <email> <hours-offset> <message>
  T=$((T + $3 * 3600))
  GIT_AUTHOR_NAME="$1" GIT_AUTHOR_EMAIL="$2" GIT_AUTHOR_DATE="@$T" GIT_COMMITTER_DATE="@$T" \
    git commit -q -m "$4"
}

mkdir -p src/cart src/payments src/http tests
cat > package.json <<'EOF'
{
  "name": "acme-store",
  "version": "1.2.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "test": "vitest run",
    "lint": "eslint src"
  }
}
EOF
cat > README.md <<'EOF'
# acme-store

Backend for the Acme online store: catalogue, cart and checkout.

```bash
npm install
npm run dev
```
EOF
cat > .gitignore <<'EOF'
node_modules/
.env
EOF
mkdir -p config
cat > config/dev.json <<'EOF'
{
  "port": 3000,
  "database": "postgres://localhost/acme",
  "logLevel": "info"
}
EOF
git add -A; commit "Sam Rivera" sam@example.com 0 "Initial project layout"

cat > src/cart/cart.ts <<'EOF'
import { Money, add, multiply, zero } from "../money";

export interface CartItem {
  sku: string;
  name: string;
  unitPrice: Money;
  quantity: number;
}

export class Cart {
  private items = new Map<string, CartItem>();

  add(item: CartItem) {
    const existing = this.items.get(item.sku);
    if (existing) existing.quantity += item.quantity;
    else this.items.set(item.sku, { ...item });
  }

  remove(sku: string) {
    this.items.delete(sku);
  }

  get lines(): CartItem[] {
    return [...this.items.values()];
  }

  subtotal(): Money {
    let total = zero("EUR");
    for (const item of this.items.values()) {
      total = add(total, multiply(item.unitPrice, item.quantity));
    }
    return total;
  }

  isEmpty() {
    return this.items.size === 0;
  }
}
EOF
cat > src/money.ts <<'EOF'
export interface Money {
  cents: number;
  currency: string;
}

export const zero = (currency: string): Money => ({ cents: 0, currency });

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error("currency mismatch");
  return { cents: a.cents + b.cents, currency: a.currency };
}

export function multiply(m: Money, n: number): Money {
  return { cents: Math.round(m.cents * n), currency: m.currency };
}

export function format(m: Money): string {
  return `${(m.cents / 100).toFixed(2)} ${m.currency}`;
}
EOF
git add -A; commit "Sam Rivera" sam@example.com 5 "Add cart and money helpers"

cat > src/cart/discounts.ts <<'EOF'
import { Money, multiply } from "../money";

export type Discount =
  | { kind: "percent"; value: number }
  | { kind: "fixed"; amount: Money };

export function applyDiscount(subtotal: Money, d: Discount): Money {
  switch (d.kind) {
    case "percent":
      return multiply(subtotal, 1 - d.value / 100);
    case "fixed":
      return { cents: Math.max(0, subtotal.cents - d.amount.cents), currency: subtotal.currency };
  }
}
EOF
git add -A; commit "Priya Nair" priya@example.com 20 "Support percent and fixed discounts"

cat > src/payments/stripe.ts <<'EOF'
import { Money } from "../money";

export interface PaymentResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export async function charge(amount: Money, token: string): Promise<PaymentResult> {
  const res = await fetch("https://api.stripe.example/v1/charges", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.STRIPE_KEY}` },
    body: new URLSearchParams({
      amount: String(amount.cents),
      currency: amount.currency.toLowerCase(),
      source: token,
    }),
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const body = (await res.json()) as { id: string };
  return { ok: true, id: body.id };
}
EOF
git add -A; commit "Priya Nair" priya@example.com 26 "Charge cards through Stripe"

cat > src/http/routes.ts <<'EOF'
import { Cart } from "../cart/cart";
import { charge } from "../payments/stripe";

const carts = new Map<string, Cart>();

export function cartFor(session: string): Cart {
  let cart = carts.get(session);
  if (!cart) carts.set(session, (cart = new Cart()));
  return cart;
}

export async function checkout(session: string, token: string) {
  const cart = cartFor(session);
  if (cart.isEmpty()) return { status: 400, body: { error: "Cart is empty" } };
  const result = await charge(cart.subtotal(), token);
  if (!result.ok) return { status: 402, body: { error: result.error } };
  carts.delete(session);
  return { status: 200, body: { orderId: result.id } };
}
EOF
cat > tests/cart.test.ts <<'EOF'
import { describe, expect, it } from "vitest";
import { Cart } from "../src/cart/cart";

const eur = (cents: number) => ({ cents, currency: "EUR" });

describe("Cart", () => {
  it("sums its lines", () => {
    const cart = new Cart();
    cart.add({ sku: "mug", name: "Mug", unitPrice: eur(1200), quantity: 2 });
    cart.add({ sku: "tee", name: "T-shirt", unitPrice: eur(2500), quantity: 1 });
    expect(cart.subtotal()).toEqual(eur(4900));
  });
});
EOF
git add -A; commit "Sam Rivera" sam@example.com 30 "Checkout route and first cart test"
git tag -a v1.2.0 -m "v1.2.0"
git push -q -u origin main

# A feature branch someone else pushed.
git checkout -q -b feature/gift-cards
cat > src/payments/giftCards.ts <<'EOF'
import { Money } from "../money";

const balances = new Map<string, Money>();

export function redeem(code: string, amount: Money): Money {
  const balance = balances.get(code);
  if (!balance) throw new Error("Unknown gift card");
  const used = Math.min(balance.cents, amount.cents);
  balances.set(code, { ...balance, cents: balance.cents - used });
  return { cents: amount.cents - used, currency: amount.currency };
}
EOF
git add -A; commit "Priya Nair" priya@example.com 6 "Gift cards: redeem against a balance"
git push -q -u origin feature/gift-cards
git checkout -q main
git branch -q fix/rounding
git branch -q release/1.2

cat >> src/money.ts <<'EOF'

export function isZero(m: Money): boolean {
  return m.cents === 0;
}
EOF
git add -A; commit "Jordan Lee" jordan@example.com 10 "money: add isZero"
cat > tests/discounts.test.ts <<'EOF'
import { expect, it } from "vitest";
import { applyDiscount } from "../src/cart/discounts";

it("never goes below zero", () => {
  const total = applyDiscount({ cents: 500, currency: "EUR" }, { kind: "fixed", amount: { cents: 900, currency: "EUR" } });
  expect(total.cents).toBe(0);
});
EOF
git add -A; commit "Jordan Lee" jordan@example.com 3 "Test that fixed discounts stop at zero"
git push -q origin main
cat > CHANGELOG.md <<'EOF'
# Changelog

## 1.3.0 (unreleased)

- Discounts on the whole cart.
EOF
git add -A; commit "Sam Rivera" sam@example.com 4 "Start the 1.3.0 changelog"
# One local commit not pushed yet (↑1).

# ---- uncommitted work -------------------------------------------------------

# Staged: a shipping module.
cat > src/cart/shipping.ts <<'EOF'
import { Money } from "../money";

/** Free shipping from 50 EUR, otherwise a flat rate. */
export function shippingFor(subtotal: Money): Money {
  const free = subtotal.cents >= 5000;
  return { cents: free ? 0 : 490, currency: subtotal.currency };
}
EOF
git add src/cart/shipping.ts

# Unstaged edits across several blocks.
cat > src/cart/cart.ts <<'EOF'
import { Money, add, multiply, zero } from "../money";
import { Discount, applyDiscount } from "./discounts";
import { shippingFor } from "./shipping";

export interface CartItem {
  sku: string;
  name: string;
  unitPrice: Money;
  quantity: number;
}

export class Cart {
  private items = new Map<string, CartItem>();
  private discount: Discount | null = null;

  add(item: CartItem) {
    if (item.quantity <= 0) throw new Error("Quantity must be positive");
    const existing = this.items.get(item.sku);
    if (existing) existing.quantity += item.quantity;
    else this.items.set(item.sku, { ...item });
  }

  remove(sku: string) {
    this.items.delete(sku);
  }

  setDiscount(discount: Discount | null) {
    this.discount = discount;
  }

  get lines(): CartItem[] {
    return [...this.items.values()];
  }

  subtotal(): Money {
    let total = zero("EUR");
    for (const item of this.items.values()) {
      total = add(total, multiply(item.unitPrice, item.quantity));
    }
    return this.discount ? applyDiscount(total, this.discount) : total;
  }

  /** What the customer pays: discounted subtotal plus shipping. */
  total(): Money {
    const subtotal = this.subtotal();
    return add(subtotal, shippingFor(subtotal));
  }

  isEmpty() {
    return this.items.size === 0;
  }
}
EOF
cat > src/http/routes.ts <<'EOF'
import { Cart } from "../cart/cart";
import { charge } from "../payments/stripe";
import { logger } from "../logger";

const carts = new Map<string, Cart>();

export function cartFor(session: string): Cart {
  let cart = carts.get(session);
  if (!cart) carts.set(session, (cart = new Cart()));
  return cart;
}

export async function checkout(session: string, token: string) {
  const cart = cartFor(session);
  if (cart.isEmpty()) return { status: 400, body: { error: "Cart is empty" } };
  const result = await charge(cart.total(), token);
  if (!result.ok) {
    logger.warn("payment failed", { session, error: result.error });
    return { status: 402, body: { error: result.error } };
  }
  carts.delete(session);
  return { status: 200, body: { orderId: result.id } };
}
EOF
cat > src/logger.ts <<'EOF'
type Level = "debug" | "info" | "warn" | "error";

function log(level: Level, message: string, data?: Record<string, unknown>) {
  console[level](JSON.stringify({ level, message, ...data, at: new Date().toISOString() }));
}

export const logger = {
  info: (m: string, d?: Record<string, unknown>) => log("info", m, d),
  warn: (m: string, d?: Record<string, unknown>) => log("warn", m, d),
  error: (m: string, d?: Record<string, unknown>) => log("error", m, d),
};
EOF
perl -pi -e 's/1\.2\.0/1.3.0-dev/' package.json
cat > .env <<'EOF'
STRIPE_KEY=sk_test_demo
EOF
rm tests/discounts.test.ts
perl -pi -e 's/"info"/"debug"/; s/3000/3001/' config/dev.json

# Old mtimes for the Time view, recent for the files being worked on.
ago() { perl -e '$t = time - shift; utime $t, $t, @ARGV' "$@"; }
ago 200000 package.json .env
ago 7200 src/http/routes.ts src/logger.ts
ago 1500 src/cart/shipping.ts
ago 120 src/cart/cart.ts

# Show a real-looking remote URL (nothing is fetched or pushed in the demo).
git remote set-url origin https://github.com/acme/acme-store.git

# ---- Hunkpad data: tab colour, favourites, kept local, a script, comments ----
NOW=$(($(date +%s) * 1000))
mkdir -p .hunkpad
printf '# Hunkpad data: local to this machine, never committed.\n*\n' > .hunkpad/.gitignore
cat > .hunkpad/state.json <<EOF
{
  "version": 1,
  "color": "#4c8eda",
  "favourites": ["branch:main", "branch:feature/gift-cards"],
  "changeGroups": [],
  "hunks": { "active": null, "hunks": [] },
  "keptLocal": ["config/dev.json"],
  "scripts": [{ "id": "s1", "name": "test", "path": "$REPO/package.json", "npm": "test" }],
  "comments": [
    {
      "id": "c1", "path": "src/cart/cart.ts", "line": 17,
      "anchor": "if (item.quantity <= 0) throw new Error(\"Quantity must be positive\");",
      "text": "Should this be a 400 from the route instead of a throw?",
      "created": $((NOW - 3600000)), "resolved": false
    },
    {
      "id": "c2", "path": "src/http/routes.ts", "line": 18,
      "anchor": "logger.warn(\"payment failed\", { session, error: result.error });",
      "text": "Don't log the session id: it is a bearer token.",
      "created": $((NOW - 1800000)), "resolved": false
    }
  ]
}
EOF

# A second repository, for the tab row.
WEB="$ROOT/storefront-web"
git init -q -b main "$WEB"
cd "$WEB"
git config user.name "Sam Rivera"; git config user.email "sam@example.com"; git config commit.gpgsign false
printf '# storefront-web\n' > README.md
git add -A; commit "Sam Rivera" sam@example.com 1 "Initial commit"
mkdir -p .hunkpad
printf '*\n' > .hunkpad/.gitignore
printf '{ "version": 1, "color": "#3fb950" }\n' > .hunkpad/state.json

# App settings: two Git users, and the open tabs of the first one.
node -e '
const [file, repo, web] = process.argv.slice(1);
const users = {
  users: [
    { id: "work", label: "Work", authorName: "Sam Rivera", authorEmail: "sam@acme.example", color: "#4c8eda" },
    { id: "personal", label: "Personal", authorName: "Sam", authorEmail: "sam@example.com", color: "#a371f7" },
  ],
  active: "work",
};
const values = {
  gitUsers: JSON.stringify(users),
  "userTabs:work": JSON.stringify({ paths: [repo, web], active: repo }),
};
require("fs").writeFileSync(file, JSON.stringify({ version: 1, values }, null, 2));
' "$ROOT/settings.json" "$REPO" "$WEB"
